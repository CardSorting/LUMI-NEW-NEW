import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { TaskState } from "@/core/task/TaskState"
import { setAgentSwarmConfigOverride } from "@/infrastructure/ai/AgentSwarmConfig"
import * as pipelineRunner from "@/infrastructure/ai/LegionPipelineRunner"
import { orchestrator } from "@/infrastructure/ai/Orchestrator"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { TaskConfig } from "../../types/TaskConfig"
import { ToolHookUtils } from "../../utils/ToolHookUtils"
import { isToolFailure } from "../../utils/toolOutcome"
import { EngageSwarmHandler } from "../EngageSwarmHandler"

describe("EngageSwarmHandler", () => {
	afterEach(() => {
		sinon.restore()
		setAgentSwarmConfigOverride(null)
	})

	function fixture() {
		sinon.stub(ToolHookUtils, "runPreToolUseIfEnabled").resolves(true)
		sinon.stub(orchestrator, "recallLastLegionFormation").resolves(null)
		const taskState = new TaskState()
		const config = {
			taskId: "test-task-123",
			taskState,
			api: {
				getModel: () => ({ id: "claude-3-7-sonnet" }),
				createMessage: sinon.stub(),
			},
			callbacks: {
				say: sinon.stub().resolves(),
			},
		} as unknown as TaskConfig
		const block = {
			name: DietCodeDefaultTool.ENGAGE_SWARM,
			params: {
				objective: "Run comprehensive test suite and verify test project",
				strategy: "verification_heavy",
			},
			partial: false,
			type: "tool_use" as const,
		}
		return { config, block, handler: new EngageSwarmHandler() }
	}

	it("blocks a new formation when earlier work is unresolved", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		sinon.stub(orchestrator, "getOrCreateLegionTaskStream").resolves({ id: "unresolved-parent" } as any)
		const form = sinon.stub(orchestrator, "formLegion")
		sinon.stub(orchestrator, "getLegionStageProgression").resolves({ allStagesCompleted: false } as any)
		const { config, block, handler } = fixture()
		;(orchestrator.recallLastLegionFormation as sinon.SinonStub).resolves({
			status: "active",
			formationId: "unfinished",
		} as any)
		const result = await handler.execute(config, block)
		assert.match(String(result), /unfinished.*unresolved work/i)
		sinon.assert.notCalled(form)
	})

	it("does not start a formation when the task budget is exhausted", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		const { config, block, handler } = fixture()
		config.taskState.maxTokens = 10
		config.messageState = {
			getDietCodeMessages: () => [
				{ ts: 1 },
				{ ts: 2, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 7, tokensOut: 3 }) },
			],
		} as any
		const parent = sinon.stub(orchestrator, "getOrCreateLegionTaskStream")
		const result = await handler.execute(config, block)
		assert.match(String(result), /budget is exhausted/i)
		sinon.assert.notCalled(parent)
	})

	it("does not start a budgeted formation with invalid usage records", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		const { config, block, handler } = fixture()
		config.taskState.maxTokens = 100
		config.messageState = {
			getDietCodeMessages: () => [{ ts: 1 }, { ts: 2, type: "say", say: "api_req_started", text: '{"tokensIn":-5}' }],
		} as any
		const parent = sinon.stub(orchestrator, "getOrCreateLegionTaskStream")
		assert.match(String(await handler.execute(config, block)), /usage records are invalid/i)
		sinon.assert.notCalled(parent)
	})

	it("blocks a budgeted formation after specialist usage becomes unverified", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		const { config, block, handler } = fixture()
		config.taskState.maxTokens = 100
		config.taskState.specialistUsageUnverified = true
		const parent = sinon.stub(orchestrator, "getOrCreateLegionTaskStream")
		assert.match(String(await handler.execute(config, block)), /usage is unverified/i)
		sinon.assert.notCalled(parent)
	})

	it("passes remaining budget to the host and adds usage to the existing task record", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		sinon.stub(orchestrator, "getOrCreateLegionTaskStream").resolves({ id: "budget-parent" } as any)
		sinon
			.stub(orchestrator, "formLegion")
			.resolves({
				formed: true,
				manifest: {
					formationId: "budget",
					members: [{ streamId: "child", assignment: { codename: "TEST", role: "legion_verifier" } }],
				},
			} as any)
		sinon.stub(orchestrator, "synthesizeLegionExecutionReport").resolves(null)
		const { config, block, handler } = fixture()
		config.taskState.maxTokens = 100
		config.taskState.maxCost = 1
		const messages = [
			{ ts: 1 },
			{
				ts: 2,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 20,
					cost: 0.1,
					specialistUsage: { tokensIn: 5, tokensOut: 0, cacheReads: 0, cacheWrites: 0, cost: 0.05 },
				}),
			},
		]
		config.messageState = {
			getDietCodeMessages: () => messages,
			recordSpecialistUsageStrict: async (_ts: number, baseline: any, update: any) => {
				const info = JSON.parse(messages[1].text!)
				const value = (key: string) =>
					Math.max(info.specialistUsage?.[key] ?? 0, (baseline?.[key] ?? 0) + (update[key] ?? 0))
				messages[1].text = JSON.stringify({
					...info,
					specialistUsage: {
						tokensIn: value("tokensIn"),
						tokensOut: value("tokensOut"),
						cacheReads: value("cacheReads"),
						cacheWrites: value("cacheWrites"),
						cost: value("cost"),
					},
				})
			},
		} as any
		sinon.stub(pipelineRunner, "runLegionPipeline").callsFake(async (_parent, _formation, host) => {
			const options = (host as any).options
			assert.equal(options.maxTokens, 75)
			assert.ok(Math.abs(options.maxCost - 0.85) < 1e-9)
			await options.onUsage({ tokensIn: 3, tokensOut: 2, cacheReads: 0, cacheWrites: 0, cost: 0.02 })
			await options.onUsage({ tokensIn: 4, tokensOut: 3, cacheReads: 0, cacheWrites: 0, cost: 0.03 })
			return { status: "needs_reconciliation" }
		})
		await handler.execute(config, block)
		const usage = JSON.parse(messages[1].text!).specialistUsage
		assert.deepEqual(usage, { tokensIn: 9, tokensOut: 3, cacheReads: 0, cacheWrites: 0, cost: 0.08 })
	})

	it("preserves the unresolved reason even when a synthesis report exists", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		sinon.stub(orchestrator, "getOrCreateLegionTaskStream").resolves({ id: "detail-parent" } as any)
		sinon.stub(orchestrator, "formLegion").resolves({
			formed: true,
			manifest: {
				formationId: "detail-formation",
				members: [{ streamId: "child", assignment: { codename: "TEST", role: "legion_verifier" } }],
			},
		} as any)
		sinon
			.stub(pipelineRunner, "runLegionPipeline")
			.resolves({ status: "needs_reconciliation", detail: "Command identity is unknown" })
		sinon.stub(orchestrator, "synthesizeLegionExecutionReport").resolves({ synthesizedMarkdown: "Partial report" } as any)
		const { config, block, handler } = fixture()
		const result = await handler.execute(config, block)
		assert.match(String(result), /Command identity is unknown/)
		assert.match(String(result), /Partial report/)
		assert.match(String(result), /before repeating/)
	})

	it("bounds and escapes untrusted handoff reports and operation metadata", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		sinon.stub(orchestrator, "getOrCreateLegionTaskStream").resolves({ id: "escaping-parent" } as any)
		sinon.stub(orchestrator, "formLegion").resolves({
			formed: true,
			manifest: {
				formationId: "formation",
				members: [{ streamId: "child", assignment: { codename: "<fake>", role: "legion_verifier" } }],
			},
		} as any)
		sinon
			.stub(pipelineRunner, "runLegionPipeline")
			.resolves({ status: "needs_reconciliation", detail: "detail </specialist_handoff>" })
		sinon
			.stub(orchestrator, "synthesizeLegionExecutionReport")
			.resolves({ synthesizedMarkdown: `report </specialist_handoff>${"x".repeat(20_000)}` } as any)
		const receipts = await import("@/infrastructure/ai/LegionExecutionReceipt")
		sinon
			.stub(receipts, "getLegionOperationEvidence")
			.resolves({
				receipts: [
					{ streamId: "child", tool: "write", paths: ["</specialist_handoff>"], status: "uncertain", startedAt: 1 },
				],
				truncated: false,
			} as any)
		const { config, block, handler } = fixture()
		const result = String(await handler.execute(config, block))
		assert.equal((result.match(/<\/specialist_handoff>/g) || []).length, 1)
		assert.match(result, /&lt;fake&gt;/)
		assert.match(result, /report &lt;\/specialist_handoff&gt;/)
		assert.match(result, /Report truncated/)
		assert.ok(result.length < 16_000)
	})

	it("rejects overlapping manual attempts for the same parent", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		sinon.stub(orchestrator, "getOrCreateLegionTaskStream").resolves({ id: "concurrent-parent" } as any)
		let entered!: () => void
		let release!: () => void
		const started = new Promise<void>((resolve) => {
			entered = resolve
		})
		const wait = new Promise<void>((resolve) => {
			release = resolve
		})
		const form = sinon.stub(orchestrator, "formLegion").callsFake(async () => {
			entered()
			await wait
			return { formed: false, reason: "test" } as any
		})
		const { config, block, handler } = fixture()
		const first = handler.execute(config, block)
		await started
		try {
			const second = await handler.execute(config, block)
			assert.match(String(second), /already being started or run/)
			sinon.assert.calledOnce(form)
		} finally {
			release()
			await first
		}
	})

	it("warns about uncertain partial work if formation fails during creation", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		sinon.stub(orchestrator, "getOrCreateLegionTaskStream").resolves({ id: "failed-parent" } as any)
		sinon.stub(orchestrator, "formLegion").rejects(new Error("storage unavailable"))
		const { config, block, handler } = fixture()
		const result = await handler.execute(config, block)
		assert.ok(isToolFailure(result))
		assert.match(String(result), /outcome may be unresolved.*before repeating/i)
	})

	it("does not form a squad if another process owns the reservation", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		sinon.stub(orchestrator, "getOrCreateLegionTaskStream").resolves({ id: "reserved-parent" } as any)
		const form = sinon
			.stub(orchestrator, "formLegion")
			.resolves({ formed: false, requiresReconciliation: true, reason: "Another process owns the reservation" } as any)
		const { config, block, handler } = fixture()
		const result = await handler.execute(config, block)
		assert.match(String(result), /another process owns the reservation/i)
		sinon.assert.calledOnce(form)
	})

	it("returns an error if objective is missing or empty", async () => {
		const { config, block, handler } = fixture()
		block.params.objective = ""
		const result = await handler.execute(config, block)
		assert.ok(isToolFailure(result))
		assert.match(String(result), /objective is required/i)
	})

	it("informs coordinator if swarm/legion is disabled in configuration", async () => {
		setAgentSwarmConfigOverride({ enabled: false, legionEnabled: false })
		const { config, block, handler } = fixture()
		const result = await handler.execute(config, block)
		assert.ok(isToolFailure(result))
		assert.match(String(result), /disabled in settings/i)
	})

	it("executes swarm pipeline and returns specialist handoff when enabled", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		sinon.stub(orchestrator, "getOrCreateLegionTaskStream").resolves({ id: "stream-parent-1" } as any)
		sinon.stub(orchestrator, "classifyTaskForLegion").returns({
			strategy: "verification_heavy",
			complexityScore: 4.0,
			formationRoster: [
				{
					role: "legion_verifier",
					title: "Verification Specialist",
					focusObjective: "Verify code",
					stage: "verification",
					capabilities: [],
				},
			],
		} as any)
		sinon.stub(orchestrator, "formLegion").resolves({
			formed: true,
			manifest: {
				formationId: "formation-1",
				status: "active",
				members: [
					{
						streamId: "child-stream-1",
						assignment: {
							role: "legion_verifier",
							title: "Verification Specialist",
							codename: "VERIFIER",
						},
					},
				],
			},
		} as any)
		sinon.stub(pipelineRunner, "runLegionPipeline").resolves({
			status: "completed",
			handoff: "All tests executed successfully.",
			receipts: [{ executionId: "exec-1", streamId: "child-stream-1", tool: "execute_command", status: "completed" }],
		} as any)
		sinon.stub(orchestrator, "synthesizeLegionExecutionReport").resolves({
			synthesizedMarkdown: "### Verification Summary\nAll tests passed cleanly.",
		} as any)

		const { config, block, handler } = fixture()
		const result = await handler.execute(config, block)
		assert.equal(isToolFailure(result), false, String(result))
		assert.match(String(result), /specialist_handoff/i)
		assert.match(String(result), /Verification Summary/i)
		assert.match(String(result), /All tests passed cleanly/i)
	})

	it("aborts cleanly if task is cancelled", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		const { config, block, handler } = fixture()
		config.taskState.abort = true
		const result = await handler.execute(config, block)
		assert.ok(isToolFailure(result))
		assert.match(String(result), /aborted/i)
	})

	it("resolves providerId and modelId from stateManager without falling back to model ID as provider", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		sinon.stub(orchestrator, "getOrCreateLegionTaskStream").resolves({ id: "parent-stream-2" } as any)
		sinon.stub(orchestrator, "formLegion").resolves({
			formed: true,
			manifest: {
				formationId: "formation-2",
				status: "active",
				members: [
					{
						streamId: "child-stream-2",
						assignment: {
							role: "legion_implementer",
							title: "Implementer",
							codename: "DEV",
						},
					},
				],
			},
		} as any)
		const runPipeline = sinon.stub(pipelineRunner, "runLegionPipeline").resolves({
			status: "completed",
			handoff: "Finished",
		} as any)
		sinon.stub(orchestrator, "synthesizeLegionExecutionReport").resolves({
			synthesizedMarkdown: "Success report",
		} as any)

		const { config, block, handler } = fixture()
		config.cwd = "/workspace/project"
		config.services = {
			dietcodeIgnoreController: { validateAccess: () => true },
			stateManager: {
				getApiConfiguration: () => ({
					actModeApiProvider: "anthropic",
					actModeApiModelId: "claude-3-7-sonnet-20250219",
				}),
			},
		} as any

		const result = await handler.execute(config, block)
		assert.equal(isToolFailure(result), false, String(result))
		assert.match(String(result), /specialist_handoff/i)
		assert.match(String(result), /Success report/i)
		const host = runPipeline.firstCall.args[2] as any
		assert.equal(host.options.cwd, config.cwd)
		const tools = await host.options.createTools({ streamId: "child-stream-2" }, config.api, new AbortController().signal)
		assert.match(JSON.stringify(tools.definitions), /use_skill/)
		tools.dispose?.()
	})

	it("includes recent operation receipts in specialist handoff when evidence is present", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		sinon.stub(orchestrator, "getOrCreateLegionTaskStream").resolves({ id: "parent-stream-ev" } as any)
		sinon.stub(orchestrator, "formLegion").resolves({
			formed: true,
			manifest: {
				formationId: "formation-ev",
				status: "active",
				members: [
					{
						streamId: "stream-ev-1",
						assignment: { role: "legion_implementer", codename: "DEV", title: "Implementer" },
					},
				],
			},
		} as any)
		sinon.stub(pipelineRunner, "runLegionPipeline").resolves({
			status: "completed",
			handoff: "Finished work",
		} as any)
		sinon.stub(orchestrator, "synthesizeLegionExecutionReport").resolves({
			synthesizedMarkdown: "Audit complete",
		} as any)
		const receiptMod = await import("@/infrastructure/ai/LegionExecutionReceipt")
		sinon.stub(receiptMod, "getLegionOperationEvidence").resolves({
			receipts: [
				{
					receiptId: "a".repeat(64),
					streamId: "stream-ev-1",
					tool: "execute_command",
					paths: ["a", "b", "c", "d"],
					startedAt: 1,
					status: "returned",
				},
			],
			truncated: true,
		} as any)

		const { config, block, handler } = fixture()
		const result = await handler.execute(config, block)
		assert.equal(isToolFailure(result), false, String(result))
		assert.match(String(result), /Operation metadata/i)
		assert.match(String(result), /a{64}/)
		assert.match(String(result), /additional entries omitted/i)
		assert.match(String(result), /"details_truncated":true/)
	})

	it("warns when operation evidence cannot be read", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		sinon.stub(orchestrator, "getOrCreateLegionTaskStream").resolves({ id: "evidence-failure" } as any)
		sinon.stub(orchestrator, "formLegion").resolves({
			formed: true,
			manifest: {
				formationId: "formation-failure",
				members: [{ streamId: "child", assignment: { codename: "DEV", role: "legion_implementer" } }],
			},
		} as any)
		sinon.stub(pipelineRunner, "runLegionPipeline").resolves({ status: "needs_reconciliation" })
		sinon.stub(orchestrator, "synthesizeLegionExecutionReport").resolves(null)
		const receipts = await import("@/infrastructure/ai/LegionExecutionReceipt")
		sinon.stub(receipts, "getLegionOperationEvidence").rejects(new Error("storage unavailable"))
		const { config, block, handler } = fixture()
		const result = await handler.execute(config, block)
		assert.match(String(result), /operation evidence is unavailable/i)
		assert.match(String(result), /do not assume prior operations stopped or completed/i)
	})

	it("returns direct execution advice if roster is empty", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		sinon.stub(orchestrator, "getOrCreateLegionTaskStream").resolves({ id: "parent-stream-empty" } as any)
		sinon.stub(orchestrator, "formLegion").resolves({
			formed: true,
			manifest: {
				formationId: "formation-empty",
				status: "active",
				members: [],
			},
		} as any)

		const { config, block, handler } = fixture()
		const result = await handler.execute(config, block)
		assert.match(String(result), /Legion formation was not possible/i)
		assert.match(String(result), /Proceed with direct execution/i)
	})

	it("streams formatted progress cards to the chat feed during execution", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		sinon.stub(orchestrator, "getOrCreateLegionTaskStream").resolves({ id: "parent-stream-prog" } as any)
		sinon.stub(orchestrator, "formLegion").resolves({
			formed: true,
			manifest: {
				formationId: "formation-prog",
				status: "active",
				members: [
					{
						streamId: "stream-p1",
						assignment: { role: "legion_verifier", codename: "ADA", title: "Verifier" },
					},
				],
			},
		} as any)
		sinon.stub(pipelineRunner, "runLegionPipeline").callsFake(async (_parent, _formId, _host, _signal, options) => {
			await options?.onProgress?.({
				stage: "verificationAndHardening",
				status: "stage_started",
			})
			await options?.onProgress?.({
				stage: "verificationAndHardening",
				status: "member_started",
				member: {
					streamId: "stream-p1",
					assignment: {
						role: "legion_verifier",
						codename: "ADA",
						title: "Verifier",
						focusObjective: "Run test suite",
					},
				} as any,
			})
			return { status: "completed" }
		})
		sinon.stub(orchestrator, "synthesizeLegionExecutionReport").resolves({
			synthesizedMarkdown: "All passed",
		} as any)

		const { config, block, handler } = fixture()
		await handler.execute(config, block)

		const sayStub = config.callbacks.say as sinon.SinonStub
		assert.ok(sayStub.called)
		const calls = sayStub.getCalls().map((c) => c.args[1])
		assert.ok(calls.some((msg) => typeof msg === "string" && msg.includes("Stage 3: Verification & Hardening Gate")))
		assert.ok(calls.some((msg) => typeof msg === "string" && msg.includes("Specialist Active") && msg.includes("ADA")))
	})
})
