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
		assert.equal(isToolFailure(result), false)
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
		sinon.stub(pipelineRunner, "runLegionPipeline").resolves({
			status: "completed",
			handoff: "Finished",
		} as any)
		sinon.stub(orchestrator, "synthesizeLegionExecutionReport").resolves({
			synthesizedMarkdown: "Success report",
		} as any)

		const { config, block, handler } = fixture()
		config.services = {
			stateManager: {
				getApiConfiguration: () => ({
					actModeApiProvider: "anthropic",
					actModeApiModelId: "claude-3-7-sonnet-20250219",
				}),
			},
		} as any

		const result = await handler.execute(config, block)
		assert.equal(isToolFailure(result), false)
		assert.match(String(result), /specialist_handoff/i)
		assert.match(String(result), /Success report/i)
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
		sinon
			.stub(receiptMod, "getLegionOperationEvidence")
			.resolves([{ executionId: "exec-101", streamId: "stream-ev-1", tool: "execute_command", status: "completed" }] as any)

		const { config, block, handler } = fixture()
		const result = await handler.execute(config, block)
		assert.equal(isToolFailure(result), false)
		assert.match(String(result), /Recent operation metadata/i)
		assert.match(String(result), /exec-101/i)
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
