import { strict as assert } from "node:assert"
import * as coreApi from "@core/api"
import * as skills from "@core/context/instructions/user-instructions/skills"
import { PromptRegistry } from "@core/prompts/system-prompt"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import { buildCompletionGateOptionsFromSettings } from "@shared/audit/auditGateOptions"
import * as gatePolicy from "@shared/audit/auditGatePolicyLoader"
import { MAX_COMPLETION_GATE_BLOCK_COUNT } from "@shared/audit/gatePolicy"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { formatResponse } from "@/core/prompts/responses"
import { HostProvider } from "@/hosts/host-provider"
import { orchestrator } from "@/infrastructure/ai/Orchestrator"
import { setRoadmapConfigOverride } from "@/services/roadmap/RoadmapConfig"
import { ApiFormat } from "@/shared/proto/dietcode/models"
import { Logger } from "@/shared/services/Logger"
import { DietCodeDefaultTool } from "@/shared/tools"
import { TaskState } from "../../../TaskState"
import * as completionGates from "../../subagentCompletionGates"
import { ToolExecutorCoordinator } from "../../ToolExecutorCoordinator"
import { PartialPatchError } from "../../utils/FileProviderOperations"
import { SubagentBuilder } from "../SubagentBuilder"
import { SubagentRunner } from "../SubagentRunner"

const VALID_SUBAGENT_COMPLETION_RESULT =
	"Subagent completed the assigned scope successfully. All verification steps passed and the deliverable is ready for review."

function initializeHostProvider() {
	HostProvider.reset()
	HostProvider.initialize(
		() => ({}) as never,
		() => ({}) as never,
		() => ({}) as never,
		() => ({}) as never,
		{
			workspaceClient: {},
			envClient: {
				getHostVersion: async () => ({ platform: "test" }),
			},
			windowClient: {},
			diffClient: {},
		} as never,
		() => undefined,
		async () => "",
		async () => "",
		"",
		"",
	)
}

function createTaskConfig(nativeToolCallEnabled: boolean): TaskConfig {
	return {
		taskId: "task-1",
		ulid: "ulid-1",
		cwd: "/tmp",
		mode: "act",
		strictPlanModeEnabled: false,
		yoloModeToggled: false,
		doubleCheckCompletionEnabled: false,
		auditCompletionGateEnabled: false,
		auditCompletionGateThreshold: 50,
		auditCompletionGateCriticalOnly: false,
		auditActModeAdvisoryEnabled: true,
		auditAdvisoryEscalationEnabled: true,
		auditPlanRegressionGateEnabled: true,
		auditToolOutputAdvisoryEnabled: true,
		auditFileWriteAdvisoryEnabled: true,
		auditIntentThresholdAdjustmentsEnabled: true,
		auditIntentThresholdOverrides: "{}",
		auditSarifHookExportEnabled: true,
		auditWorkspaceArtifactsEnabled: true,
		vscodeTerminalExecutionMode: "vscodeTerminal",
		enableParallelToolCalling: false,
		isSubagentExecution: false,
		context: {},
		taskState: new TaskState(),
		messageState: {},
		api: {
			getModel: () => ({
				id: "anthropic/claude-sonnet-4.5",
				info: {
					contextWindow: 200_000,
					apiFormat: ApiFormat.ANTHROPIC_CHAT,
					supportsPromptCache: true,
				},
			}),
			createMessage: sinon.stub().callsFake(async function* () {}),
		},
		services: {
			stateManager: {
				getGlobalSettingsKey: (key: string) => {
					if (key === "mode") {
						return "act"
					}
					if (key === "customPrompt") {
						return undefined
					}
					return undefined
				},
				getGlobalStateKey: (key: string) => (key === "nativeToolCallEnabled" ? nativeToolCallEnabled : undefined),
				getApiConfiguration: () => ({
					actModeApiProvider: "anthropic",
					planModeApiProvider: "anthropic",
				}),
			},
		},
		browserSettings: {},
		focusChainSettings: {},
		autoApprovalSettings: {
			enableNotifications: false,
			actions: { executeSafeCommands: false, executeAllCommands: false },
		},
		autoApprover: { shouldAutoApproveTool: sinon.stub().returns([false, false]) },
		callbacks: {
			say: sinon.stub().resolves(undefined),
			ask: sinon.stub().resolves({ response: "yesButtonClicked" }),
			saveCheckpoint: sinon.stub().resolves(),
			sayAndCreateMissingParamError: sinon.stub().resolves("missing"),
			removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
			executeCommandTool: sinon.stub().resolves([false, "ok"]),
			cancelRunningCommandTool: sinon.stub().resolves(false),
			doesLatestTaskCompletionHaveNewChanges: sinon.stub().resolves(false),
			updateFCListFromToolResponse: sinon.stub().resolves(),
			shouldAutoApproveTool: sinon.stub().returns([true, true]),
			shouldAutoApproveToolWithPath: sinon.stub().resolves(false),
			postStateToWebview: sinon.stub().resolves(),
			reinitExistingTaskFromId: sinon.stub().resolves(),
			cancelTask: sinon.stub().resolves(),
			updateTaskHistory: sinon.stub().resolves([]),
			applyLatestBrowserSettings: sinon.stub().resolves(undefined),
			switchToActMode: sinon.stub().resolves(false),
			switchToPlanMode: sinon.stub().resolves(false),
			setActiveHookExecution: sinon.stub().resolves(),
			clearActiveHookExecution: sinon.stub().resolves(),
			getActiveHookExecution: sinon.stub().resolves(undefined),
			runUserPromptSubmitHook: sinon.stub().resolves({}),
		},
		coordinator: {
			getHandler: sinon.stub().callsFake((toolName: DietCodeDefaultTool) => {
				if (toolName === DietCodeDefaultTool.LIST_FILES) {
					return {
						execute: sinon.stub().resolves("ok"),
						getDescription: sinon.stub().returns("list_files"),
					}
				}

				return undefined
			}),
		},
	} as unknown as TaskConfig
}

function stubApiHandler(createMessage: sinon.SinonStub) {
	sinon.stub(coreApi, "buildApiHandler").returns({
		abort: sinon.stub(),
		getModel: () => ({
			id: "anthropic/claude-sonnet-4.5",
			info: {
				contextWindow: 200_000,
				apiFormat: ApiFormat.ANTHROPIC_CHAT,
				supportsPromptCache: true,
			},
		}),
		createMessage,
	} as never)
}

describe("SubagentRunner", () => {
	beforeEach(() => {
		setRoadmapConfigOverride({ enabled: false })
	})

	afterEach(() => {
		sinon.restore()
		HostProvider.reset()
		setRoadmapConfigOverride(null)
	})
	it("preserves command workspace options and links caller cancellation to the helper", async () => {
		const config = createTaskConfig(true)
		sinon.stub(coreApi, "buildApiHandler").returns(config.api as never)
		const runner = new SubagentRunner(config, new SubagentBuilder(config, "subagent"))
		const helper = (runner as any).createSubagentTaskConfig() as TaskConfig
		const controller = new AbortController()
		assert.equal(helper.executionOwner, runner.getExecutionOwner())
		const cwd = '/workspace/odd "name" $(literal)'
		await helper.callbacks.executeCommandTool("pwd", 1, { cwd, signal: controller.signal, interactive: true })
		const options = (config.callbacks.executeCommandTool as sinon.SinonStub).firstCall.args[2]
		assert.equal(options.cwd, cwd)
		assert.equal(options.interactive, false)
		assert.equal(options.suppressUserInteraction, true)
		assert.equal(options.signal.aborted, false)
		controller.abort()
		assert.equal(options.signal.aborted, true)
	})
	it("forwards command observation to the same owner with helper cancellation", async () => {
		const config = createTaskConfig(true)
		sinon.stub(coreApi, "buildApiHandler").returns(config.api as never)
		const read = sinon.stub().resolves({ execution_id: "run", status: "background" })
		config.callbacks.readCommandOutput = read
		const runner = new SubagentRunner(config, new SubagentBuilder(config, "subagent"))
		const helper = (runner as any).createSubagentTaskConfig() as TaskConfig
		const caller = new AbortController()
		await helper.callbacks.readCommandOutput!("run", 5, caller.signal)
		assert.equal(read.firstCall.args[0], "run")
		assert.equal(read.firstCall.args[1], 5)
		helper.taskState.abort = true
		assert.equal(read.firstCall.args[2].aborted, true)
		assert.equal(caller.signal.aborted, false)
		sinon.assert.notCalled(config.callbacks.executeCommandTool as sinon.SinonStub)
	})
	it("isolates helper editors and delegated approval without modifying the parent's UI", async () => {
		const config = createTaskConfig(true)
		sinon.stub(coreApi, "buildApiHandler").returns(config.api as never)
		const firstRunner = new SubagentRunner(config, new SubagentBuilder(config))
		const secondRunner = new SubagentRunner(config, new SubagentBuilder(config))
		const first = (firstRunner as any).createSubagentTaskConfig() as TaskConfig
		const second = (secondRunner as any).createSubagentTaskConfig() as TaskConfig
		assert.notEqual(first.services.diffViewProvider, second.services.diffViewProvider)
		assert.notEqual(first.services.diffViewProvider, config.services.diffViewProvider)
		assert.equal(await first.callbacks.shouldAutoApproveToolWithPath(DietCodeDefaultTool.FILE_EDIT, "assigned.ts"), true)
		assert.equal(await first.callbacks.shouldAutoApproveToolWithPath(DietCodeDefaultTool.FILE_EDIT, "/outside.ts"), false)
		await first.callbacks.ask("tool", "preview", true)
		await first.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")
		await assert.rejects(first.callbacks.ask("tool", "outside approval"), /outside its delegated/)
		sinon.assert.notCalled(config.callbacks.ask as sinon.SinonStub)
		sinon.assert.notCalled(config.callbacks.removeLastPartialMessageIfExistsWithType as sinon.SinonStub)
	})

	it("cancels the helper's file writer without cancelling the parent or another helper", async () => {
		const config = createTaskConfig(true)
		sinon.stub(coreApi, "buildApiHandler").returns(config.api as never)
		const firstRunner = new SubagentRunner(config, new SubagentBuilder(config))
		const secondRunner = new SubagentRunner(config, new SubagentBuilder(config))
		const first = (firstRunner as any).createSubagentTaskConfig() as TaskConfig
		const second = (secondRunner as any).createSubagentTaskConfig() as TaskConfig
		first.taskState.abort = true
		first.services.diffViewProvider.editType = "create"
		await assert.rejects(first.services.diffViewProvider.open("cancelled-helper.txt"), { name: "AbortError" })
		assert.equal(config.taskState.abortSignal.aborted, false)
		assert.equal(second.taskState.abortSignal.aborted, false)
	})

	it("emits native tool_use blocks with matching tool_result tool_use_id across turns", async () => {
		const createMessage = sinon.stub()
		createMessage.onFirstCall().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_1",
						name: DietCodeDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		createMessage.onSecondCall().callsFake(async function* (_systemPrompt: string, conversation: unknown[]) {
			const assistantMessage = conversation[1] as {
				role: string
				content: Array<{ type?: string; [key: string]: unknown }>
			}
			assert.equal(assistantMessage.role, "assistant")

			const toolUse = assistantMessage.content.find((block) => block.type === "tool_use")
			assert.ok(toolUse)
			assert.equal(toolUse.id, "toolu_subagent_1")
			assert.equal(toolUse.name, DietCodeDefaultTool.LIST_FILES)

			const userMessage = conversation[2] as { role: string; content: Array<{ type?: string; [key: string]: unknown }> }
			assert.equal(userMessage.role, "user")
			const toolResult = userMessage.content.find((block) => block.type === "tool_result")
			assert.ok(toolResult)
			assert.equal(toolResult.tool_use_id, "toolu_subagent_1")

			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_complete_1",
						name: DietCodeDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: VALID_SUBAGENT_COMPLETION_RESULT }),
					},
				},
			}
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = [{ name: "list_files" } as any]
			return "system prompt"
		})
		sinon.stub(SubagentBuilder.prototype, "buildNativeTools").returns([{ name: "list_files" }] as any)
		sinon.stub(skills, "discoverSkills").resolves([])
		sinon.stub(skills, "getAvailableSkills").returns([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const config = createTaskConfig(true)
		config.focusChainSettings = { ...config.focusChainSettings, enabled: true }
		config.taskState.currentFocusChainChecklist = "- [ ] Finish unrelated parent work"
		config.taskState.completionGateBlockCount = 10
		config.auditCompletionGateEnabled = true
		let inventoryReads = 0
		config.callbacks.getExecutionState = () => ({
			commands: { active: [], recent: [] },
			actions: {
				active: [
					{
						execution_id: "sibling-action",
						kind: "helper",
						label: `fresh state ${++inventoryReads}`,
						owner: "helper:sibling",
						status: "running",
					},
				],
				recent: [],
			},
		})
		const builder = new SubagentBuilder(config, "subagent")
		const runner = new SubagentRunner(config, builder)
		const result = await runner.run("List files", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(result.result, VALID_SUBAGENT_COMPLETION_RESULT)
		assert.equal(createMessage.callCount, 2)
		assert.equal(inventoryReads, 3) // fresh request context plus the final runtime handoff
		createMessage.getCalls().forEach((call, index) => {
			const request = JSON.stringify(call.args[1])
			assert.equal(request.match(/<execution_state>/g)?.length, 1)
			assert.ok(request.includes(`fresh state ${index + 1}`))
			assert.ok(request.includes("sibling-action"))
			assert.ok(request.includes(runner.getExecutionOwner()))
		})
		assert.equal(config.taskState.completionGateBlockCount, 10)
		assert.equal(config.taskState.completionAttemptCount ?? 0, 0)
		assert.equal(config.taskState.currentFocusChainChecklist, "- [ ] Finish unrelated parent work")
	})

	for (const checkFailure of [false, true]) {
		it(
			checkFailure
				? "returns a failed handoff when completion checks throw"
				: "hands back stalled completion attempts without consuming parent attempts",
			async () => {
				const createMessage = sinon.stub().callsFake(async function* () {
					yield {
						type: "tool_calls",
						tool_call: {
							function: {
								id: "helper-complete",
								name: DietCodeDefaultTool.ATTEMPT,
								arguments: JSON.stringify({
									result: checkFailure ? VALID_SUBAGENT_COMPLETION_RESULT : "x".repeat(7000),
								}),
							},
						},
					}
				})
				const promptRegistry = PromptRegistry.getInstance()
				sinon.stub(promptRegistry, "get").callsFake(async () => {
					promptRegistry.nativeTools = undefined
					return "system prompt"
				})
				sinon.stub(skills, "discoverSkills").resolves([])
				sinon.stub(skills, "getAvailableSkills").returns([])
				const validateCompletion = sinon.stub(completionGates, "validateSubagentCompletionGates")
				if (checkFailure) validateCompletion.rejects(new Error("check unavailable"))
				else validateCompletion.resolves("Required verification is still unavailable.")
				stubApiHandler(createMessage)
				initializeHostProvider()
				const config = createTaskConfig(true)
				const result = await new SubagentRunner(config, new SubagentBuilder(config)).run("Review schema", () => {})
				assert.equal(result.status, "failed", result.error)
				assert.ok(createMessage.callCount <= MAX_COMPLETION_GATE_BLOCK_COUNT)
				if (checkFailure) assert.equal(createMessage.callCount, 1)
				assert.equal(config.taskState.completionGateBlockCount ?? 0, 0)
				assert.equal(config.taskState.completionAttemptCount ?? 0, 0)
			},
		)
	}

	function prepareProgressRun(createMessage: sinon.SinonStub, tool = DietCodeDefaultTool.LIST_FILES) {
		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = [{ name: tool } as any]
			return "system prompt"
		})
		sinon.stub(SubagentBuilder.prototype, "buildNativeTools").returns([{ name: tool }] as any)
		sinon.stub(skills, "discoverSkills").resolves([])
		sinon.stub(skills, "getAvailableSkills").returns([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const config = createTaskConfig(true)
		const execute = sinon.stub().resolves("observed content")
		sinon.stub(ToolExecutorCoordinator.prototype, "getHandler").returns({ execute, getDescription: () => tool } as never)
		const builder = new SubagentBuilder(config)
		builder.setAllowedTools([tool])
		return { config, execute, runner: new SubagentRunner(config, builder) }
	}
	function callChunk(id: number, name: DietCodeDefaultTool, params: Record<string, unknown>) {
		return { type: "tool_calls", tool_call: { function: { id: `call-${id}`, name, arguments: JSON.stringify(params) } } }
	}
	it("publishes public commentary and tool progress before work finishes, retaining immutable snapshots", async () => {
		let turns = 0
		const updates: any[] = []
		const createMessage = sinon.stub().callsFake(async function* () {
			if (++turns === 1) {
				yield { type: "reasoning", reasoning: "private reasoning" }
				yield { type: "text", text: "Implementing safe openings." }
				assert.ok(updates.some((update) => update.latestMessage === "Implementing safe openings."))
				yield { type: "text", text: " Then I’ll add chording tests." }
				yield callChunk(1, DietCodeDefaultTool.FILE_NEW, { path: "src/domain/game.ts", content: "game code" })
			} else {
				yield callChunk(2, DietCodeDefaultTool.ATTEMPT, { result: VALID_SUBAGENT_COMPLETION_RESULT })
			}
		})
		const { runner, execute } = prepareProgressRun(createMessage, DietCodeDefaultTool.FILE_NEW)
		execute.callsFake(async () => {
			assert.ok(updates.some((update) => update.activity?.detail === "Writing src/domain/game.ts"))
			assert.ok(updates.some((update) => update.latestMessage?.endsWith("chording tests.")))
			assert.ok(updates.some((update) => update.recentTools?.at(-1).status === "running"))
			return "Saved file"
		})
		const result = await runner.run("Build the game", (update) => updates.push(update))
		assert.equal(result.status, "completed", result.error)
		assert.doesNotMatch(JSON.stringify(updates), /private reasoning/)
		assert.ok(updates.some((update) => update.responseChunks === 1 && update.responseBytes > 0))
		assert.ok(updates.some((update) => update.requestCount === 2))
		assert.ok(
			updates.some((update) => update.activity?.phase === "waiting" && update.activity.deadlineAt > update.lastActivityAt),
		)
		assert.ok(updates.some((update) => update.activity?.detail === "Preparing: Writing src/domain/game.ts"))
		assert.ok(updates.some((update) => update.activity?.detail === "Preparing tool call: write_to_file"))
		assert.equal(updates.find((update) => update.recentTools)?.recentTools[0].status, "running")
		assert.equal(updates.filter((update) => update.recentTools).at(-1).recentTools[0].status, "returned")
		assert.equal(updates.filter((update) => update.recentTools).at(-1).recentTools[0].output, "Saved file")
		assert.deepEqual(result.filesModified, ["src/domain/game.ts"])
	})

	it("bounds recent tool history without losing a failed result or mutating previous updates", async () => {
		let turns = 0
		const updates: any[] = []
		const createMessage = sinon.stub().callsFake(async function* () {
			yield ++turns <= 10
				? callChunk(turns, DietCodeDefaultTool.FILE_READ, { path: `file-${turns}.ts` })
				: callChunk(turns, DietCodeDefaultTool.ATTEMPT, { result: VALID_SUBAGENT_COMPLETION_RESULT })
		})
		const { runner, execute } = prepareProgressRun(createMessage, DietCodeDefaultTool.FILE_READ)
		execute.onCall(8).resolves(formatResponse.toolError("File unavailable"))
		const result = await runner.run("Read files", (update) => updates.push(update))
		assert.equal(result.status, "completed", result.error)
		const histories = updates.filter((update) => update.recentTools).map((update) => update.recentTools)
		assert.ok(histories.every((history) => history.length <= 8))
		assert.equal(histories[0].length, 1)
		assert.equal(histories.at(-1)[0].label, "Reading file-3.ts")
		assert.equal(histories.at(-1)[6].status, "failed")
		assert.equal(histories.at(-1)[7].status, "returned")
	})

	for (const partial of [false, true]) {
		it(`retains ${partial ? "partially committed" : "all successful"} patch paths in helper handoffs`, async () => {
			let turns = 0
			const createMessage = sinon.stub().callsFake(async function* () {
				yield ++turns === 1
					? callChunk(1, DietCodeDefaultTool.APPLY_PATCH, {
							input: "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n*** Add File: added.ts\n+content\n*** Delete File: deleted.ts\n*** End Patch",
						})
					: callChunk(2, DietCodeDefaultTool.ATTEMPT, { result: VALID_SUBAGENT_COMPLETION_RESULT })
			})
			const { runner, execute } = prepareProgressRun(createMessage, DietCodeDefaultTool.APPLY_PATCH)
			if (partial) execute.rejects(new PartialPatchError(["new.ts"], new Error("later conflict")))
			const result = await runner.run("Apply the assigned patch", () => {})
			assert.equal(result.status, "completed", result.error)
			assert.deepEqual(result.filesModified?.sort(), partial ? ["new.ts"] : ["added.ts", "deleted.ts", "new.ts", "old.ts"])
		})
	}
	it("does not reinterpret XML examples in prose when native tool calls are active", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			yield { type: "text", text: "The broken example starts with <execute_command><command>example" }
			yield callChunk(1, DietCodeDefaultTool.ATTEMPT, { result: VALID_SUBAGENT_COMPLETION_RESULT })
		})
		const { runner } = prepareProgressRun(createMessage)
		const result = await runner.run("Review XML serialization", () => {})
		assert.equal(result.status, "completed", result.error)
		sinon.assert.calledOnce(createMessage)
	})
	for (const mismatch of [false, true]) {
		it(`returns the original tool receipt for a replayed ID${mismatch ? " and refuses changed arguments" : ""}`, async () => {
			let turns = 0
			const createMessage = sinon.stub().callsFake(async function* (_prompt, conversation) {
				turns++
				if (turns <= 2)
					yield callChunk(1, DietCodeDefaultTool.FILE_NEW, {
						path: turns === 2 && mismatch ? "different.ts" : "saved.ts",
						content: "new",
					})
				else {
					assert.match(JSON.stringify(conversation.at(-1)), mismatch ? /different arguments/ : /observed content/)
					yield callChunk(3, DietCodeDefaultTool.ATTEMPT, { result: VALID_SUBAGENT_COMPLETION_RESULT })
				}
			})
			const { runner, execute } = prepareProgressRun(createMessage, DietCodeDefaultTool.FILE_NEW)
			const result = await runner.run("Create saved.ts", () => {})
			assert.equal(result.status, "completed", result.error)
			sinon.assert.calledOnce(execute)
			assert.deepEqual(result.filesModified, ["saved.ts"])
		})
	}
	it("adds actual pending command IDs to the final handoff", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			yield callChunk(1, DietCodeDefaultTool.ATTEMPT, { result: VALID_SUBAGENT_COMPLETION_RESULT })
		})
		const { config, runner } = prepareProgressRun(createMessage)
		config.callbacks.getExecutionState = () =>
			({
				commands: {
					active: [{ execution_id: "pending-run", owner: runner.getExecutionOwner(), status: "background" }],
					recent: [],
				},
				actions: { active: [], recent: [] },
			}) as never
		const result = await runner.run("Prepare server", () => {})
		assert.equal(result.status, "completed", result.error)
		assert.match(result.result!, /pending-run: background/)
		assert.match(result.result!, /read_command_output; do not relaunch/)
		assert.deepEqual(result.pendingCommandIds, ["pending-run"])
	})
	it("validates and dispatches the same normalized helper command", async () => {
		let turns = 0
		const createMessage = sinon.stub().callsFake(async function* () {
			yield ++turns === 1
				? callChunk(1, DietCodeDefaultTool.BASH, { command: "echo '&amp;' &amp;&amp; pwd" })
				: callChunk(2, DietCodeDefaultTool.ATTEMPT, { result: VALID_SUBAGENT_COMPLETION_RESULT })
		})
		const { config, runner, execute } = prepareProgressRun(createMessage, DietCodeDefaultTool.BASH)
		const preflight = sinon.stub().resolves({ success: true })
		config.universalGuard = { guardPreExecution: preflight, guardPostExecution: async () => {} } as never
		const result = await runner.run("Run command", () => {})
		assert.equal(result.status, "completed", result.error)
		assert.equal(preflight.firstCall.args[0].params.command, "echo '&amp;' && pwd")
		assert.equal(execute.firstCall.args[1].params.command, "echo '&amp;' && pwd")
	})
	for (const cancelled of [false, true]) {
		it(`includes pending execution IDs in a ${cancelled ? "cancelled" : "failed"} helper handoff`, async () => {
			const createMessage = sinon.stub().callsFake(async function* () {
				yield callChunk(1, DietCodeDefaultTool.FILE_EDIT, { path: "saved.ts" })
			})
			const { config, runner, execute } = prepareProgressRun(createMessage, DietCodeDefaultTool.FILE_EDIT)
			config.callbacks.getExecutionState = () =>
				({
					commands: {
						active: [
							{ execution_id: "own-pending", owner: runner.getExecutionOwner(), status: "stopping" },
							{ execution_id: "sibling-pending", owner: "other-helper", status: "running" },
						],
						recent: [],
					},
				}) as never
			execute.callsFake(async () => {
				if (cancelled) config.taskState.abort = true
				else
					createMessage.callsFake(async function* () {
						yield { type: "text", text: "No final tool" }
					})
				return "Saved once"
			})
			const result = await runner.run("Complete assignment", () => {})
			assert.equal(result.status, cancelled ? "cancelled" : "failed")
			assert.deepEqual(result.pendingCommandIds, ["own-pending"])
			assert.match(result.result!, /own-pending: stopping/)
			assert.ok(!result.result!.includes("sibling-pending"))
		})
	}
	it("cancels between calls in a multi-tool response and returns the completed evidence", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			yield callChunk(1, DietCodeDefaultTool.FILE_EDIT, { path: "saved.ts" })
			yield callChunk(2, DietCodeDefaultTool.FILE_EDIT, { path: "must-not-run.ts" })
		})
		const { config, runner, execute } = prepareProgressRun(createMessage, DietCodeDefaultTool.FILE_EDIT)
		execute.callsFake(async () => {
			config.taskState.abort = true
			return "Saved the change once."
		})
		const result = await runner.run("Edit files", () => {})
		assert.equal(result.status, "cancelled")
		assert.equal(result.isPartial, true)
		assert.match(result.result!, /Saved the change once/)
		assert.deepEqual(result.filesModified, ["saved.ts"])
		sinon.assert.calledOnce(execute)
		sinon.assert.calledOnce(createMessage)
	})

	it("cancels a silent provider that ignores abort without executing its tools", async () => {
		const createMessage = sinon.stub().callsFake(() => ({
			[Symbol.asyncIterator]: () => ({
				next: () =>
					new Promise(() => {
						queueMicrotask(() => {
							void runner.abort()
						})
					}),
				return: () => new Promise(() => {}),
			}),
		}))
		const { runner, execute } = prepareProgressRun(createMessage)
		const result = await runner.run("Read files", () => {})
		assert.equal(result.status, "cancelled")
		assert.match(result.error!, /cancelled/)
		sinon.assert.notCalled(execute)
		sinon.assert.calledOnce(createMessage)
	})

	it("cancels during workspace policy loading before opening a provider request", async () => {
		const createMessage = sinon.stub()
		const { config, runner } = prepareProgressRun(createMessage)
		sinon.stub(gatePolicy, "resolveCompletionGateOptions").callsFake(
			() =>
				new Promise(() => {
					queueMicrotask(() => {
						config.taskState.abort = true
					})
				}),
		)
		const result = await runner.run("Read files", () => {})
		assert.equal(result.status, "cancelled")
		assert.match(result.error!, /cancelled/)
		sinon.assert.notCalled(createMessage)
	})

	it("returns policy loading failures as a handoff without bypassing the policy", async () => {
		const createMessage = sinon.stub()
		const { runner } = prepareProgressRun(createMessage)
		sinon.stub(gatePolicy, "resolveCompletionGateOptions").rejects(new Error("policy unavailable"))
		const result = await runner.run("Read files", () => {})
		assert.equal(result.status, "failed")
		assert.match(result.error!, /policy unavailable/)
		sinon.assert.notCalled(createMessage)
	})

	for (const phase of ["collision", "guard", "completion"] as const) {
		it(`fails a stalled ${phase} check at its visible deadline without dispatching unchecked work`, async () => {
			const clock = sinon.useFakeTimers({ now: 1000 })
			let turns = 0
			const createMessage = sinon.stub().callsFake(async function* () {
				yield ++turns === 1
					? callChunk(turns, DietCodeDefaultTool.FILE_NEW, { path: "saved.ts", content: "saved" })
					: callChunk(turns, DietCodeDefaultTool.ATTEMPT, { result: VALID_SUBAGENT_COMPLETION_RESULT })
			})
			const { config, runner, execute } = prepareProgressRun(createMessage, DietCodeDefaultTool.FILE_NEW)
			let release!: (value: unknown) => void
			const pending = sinon.stub().callsFake(
				() =>
					new Promise((resolve) => {
						release = resolve
					}),
			)
			if (phase === "collision") sinon.stub(orchestrator, "checkCollision").callsFake(pending)
			if (phase === "guard") config.universalGuard = { guardPreExecution: pending } as never
			if (phase === "completion") sinon.stub(completionGates, "validateSubagentCompletionGates").callsFake(pending)
			const updates: any[] = []
			const running = runner.run(
				"Create saved.ts",
				(update) => updates.push(update),
				phase === "collision" ? "child" : undefined,
			)
			await clock.tickAsync(0)
			assert.equal(pending.callCount, 1)
			const deadline = updates.filter((update) => update.activity?.deadlineAt).at(-1).activity.deadlineAt
			await clock.tickAsync(deadline - Date.now())
			const result = await running
			assert.equal(result.status, "failed")
			assert.match(result.error ?? "", /timed out.*No unchecked action/)
			release(phase === "guard" ? { success: true } : null)
			await clock.tickAsync(0)
			assert.equal(execute.callCount, phase === "completion" ? 1 : 0)
			assert.equal(pending.callCount, 1)
		})
		it(`settles cancellation while ${phase} validation is still pending`, async () => {
			let turns = 0
			const createMessage = sinon.stub().callsFake(async function* () {
				yield ++turns === 1
					? callChunk(turns, DietCodeDefaultTool.FILE_NEW, { path: "saved.ts", content: "saved" })
					: callChunk(turns, DietCodeDefaultTool.ATTEMPT, { result: VALID_SUBAGENT_COMPLETION_RESULT })
			})
			const { config, runner, execute } = prepareProgressRun(createMessage, DietCodeDefaultTool.FILE_NEW)
			let started!: () => void
			const entered = new Promise<void>((resolve) => {
				started = resolve
			})
			let release!: (value: unknown) => void
			const pending = sinon.stub().callsFake(() => {
				started()
				return new Promise<unknown>((resolve) => {
					release = resolve
				})
			})
			if (phase === "collision") sinon.stub(orchestrator, "checkCollision").callsFake(pending)
			if (phase === "guard") config.universalGuard = { guardPreExecution: pending } as never
			if (phase === "completion") sinon.stub(completionGates, "validateSubagentCompletionGates").callsFake(pending)
			const statuses: Array<string | undefined> = []
			const running = runner.run(
				"Create saved.ts",
				(update) => statuses.push(update.status),
				phase === "collision" ? "child" : undefined,
			)
			let settled: Awaited<typeof running> | undefined
			void running.then((result) => {
				settled = result
			})
			await entered
			await runner.abort()
			await new Promise<void>((resolve) => setImmediate(resolve))
			const resultAtCancellation = settled
			// Allow the ignored dependency to settle too, so it cannot leak into another test.
			release(phase === "guard" ? { success: true } : null)
			await running
			assert.ok(resultAtCancellation, "Cancellation must settle without waiting for validation")
			assert.equal(resultAtCancellation.status, "cancelled")
			assert.match(resultAtCancellation.error ?? "", /cancelled/)
			assert.equal(statuses.at(-1), "cancelled")
			assert.equal(execute.callCount, phase === "completion" ? 1 : 0)
			assert.deepEqual(resultAtCancellation.filesModified, phase === "completion" ? ["saved.ts"] : [])
			if (phase === "completion") assert.match(resultAtCancellation.result ?? "", /observed content/)
		})
	}

	it("retains successful tool results when their description cannot be rendered", async () => {
		let turns = 0
		const createMessage = sinon.stub().callsFake(async function* (_prompt, conversation) {
			if (++turns === 1) {
				yield callChunk(turns, DietCodeDefaultTool.FILE_NEW, { path: "saved.ts", content: "saved" })
			} else {
				assert.match(JSON.stringify(conversation.at(-1)), /observed content/)
				assert.doesNotMatch(JSON.stringify(conversation.at(-1)), /description unavailable/)
				yield callChunk(turns, DietCodeDefaultTool.ATTEMPT, { result: VALID_SUBAGENT_COMPLETION_RESULT })
			}
		})
		const { runner, execute } = prepareProgressRun(createMessage, DietCodeDefaultTool.FILE_NEW)
		;(ToolExecutorCoordinator.prototype.getHandler as sinon.SinonStub).returns({
			execute,
			getDescription: () => {
				throw new Error("description unavailable")
			},
		})
		const result = await runner.run("Create saved.ts", () => {})
		assert.equal(result.status, "completed", result.error)
		assert.deepEqual(result.filesModified, ["saved.ts"])
		assert.equal(createMessage.callCount, 2)
		sinon.assert.calledOnce(execute)
	})

	for (const budget of ["maxCost", "maxTokens"] as const) {
		it(`does not send a request when ${budget} is already exhausted`, async () => {
			const createMessage = sinon.stub()
			const { config, runner } = prepareProgressRun(createMessage)
			config.taskState[budget] = 0
			const result = await runner.run("Read files", () => {})
			assert.match(result.error!, /budget reached/)
			sinon.assert.notCalled(createMessage)
		})
	}

	it("accounts for current response cost before executing any returned tool", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0.5 }
			yield callChunk(1, DietCodeDefaultTool.LIST_FILES, { path: "." })
		})
		const { config, runner, execute } = prepareProgressRun(createMessage)
		config.taskState.maxCost = 0.5
		const result = await runner.run("Read files", () => {})
		assert.match(result.error!, /cost budget reached/)
		assert.equal(result.stats.totalCost, 0.5)
		sinon.assert.notCalled(execute)
		sinon.assert.calledOnce(createMessage)
	})

	it("cannot evade the recovery window by alternating empty turns and unavailable tools", async () => {
		let turns = 0
		const createMessage = sinon.stub().callsFake(async function* () {
			if (++turns % 2) yield callChunk(turns, DietCodeDefaultTool.BASH, { command: "unavailable" })
		})
		const { runner, execute } = prepareProgressRun(createMessage)
		const result = await runner.run("Read files", () => {})
		assert.match(result.error!, /no new tool progress/)
		assert.equal(turns, 8)
		sinon.assert.notCalled(execute)
	})

	it("continues an interrupted helper from prior tool results without repeating a completed edit", async () => {
		let turn = 0
		const createMessage = sinon.stub().callsFake(async function* (_prompt, history) {
			switch (++turn) {
				case 1:
					yield callChunk(1, DietCodeDefaultTool.FILE_EDIT, { path: "saved.ts" })
					break
				case 2:
					yield callChunk(2, DietCodeDefaultTool.FILE_EDIT, { path: "unfinished.ts" })
					throw Object.assign(new Error("connection lost"), { headers: { "retry-after": "0.001" } })
				default:
					assert.match(JSON.stringify(history), /observed content/)
					assert.match(JSON.stringify(history), /Do not repeat completed actions/)
					assert.doesNotMatch(JSON.stringify(history), /unfinished.ts/)
					yield callChunk(3, DietCodeDefaultTool.ATTEMPT, { result: VALID_SUBAGENT_COMPLETION_RESULT })
			}
		})
		const { runner, execute } = prepareProgressRun(createMessage, DietCodeDefaultTool.FILE_EDIT)
		sinon.stub(completionGates, "validateSubagentCompletionGates").resolves(null)
		const updates: any[] = []
		const result = await runner.run("Edit files", (update) => updates.push(update))
		assert.equal(result.status, "completed")
		assert.deepEqual(result.filesModified, ["saved.ts"])
		assert.ok(updates.some((update) => update.activity?.phase === "retrying"))
		sinon.assert.calledOnce(execute)
		assert.equal(createMessage.callCount, 3)
	})
	it("marks multimodal MCP failures as errors and keeps them from renewing the helper progress window", async () => {
		let turns = 0
		const createMessage = sinon.stub().callsFake(async function* (_prompt, conversation) {
			if (turns > 0) assert.equal(conversation.at(-1).content[0].is_error, true)
			if (++turns > 8) throw new Error("Failure results must not manufacture progress")
			yield callChunk(turns, DietCodeDefaultTool.MCP_USE, {
				server_name: "docs",
				tool_name: "run",
				arguments: JSON.stringify({ attempt: turns }),
			})
		})
		const { runner, execute } = prepareProgressRun(createMessage, DietCodeDefaultTool.MCP_USE)
		execute.resolves(
			formatResponse.toolResult(formatResponse.toolError("remote conflict"), ["data:image/png;base64,aW1hZ2U="]),
		)
		const result = await runner.run("Use the remote result", () => {})
		assert.equal(result.status, "failed")
		assert.match(result.error ?? "", /no new tool progress/)
		assert.equal(execute.callCount, 8)
	})
	for (const observer of ["throws", "rejects", "hangs"] as const) {
		it(`preserves successful work when its progress observer ${observer}`, async () => {
			let turns = 0
			const createMessage = sinon.stub().callsFake(async function* () {
				yield ++turns === 1
					? callChunk(turns, DietCodeDefaultTool.FILE_NEW, { path: "saved.ts", content: "saved" })
					: callChunk(turns, DietCodeDefaultTool.ATTEMPT, { result: VALID_SUBAGENT_COMPLETION_RESULT })
			})
			const { runner, execute } = prepareProgressRun(createMessage, DietCodeDefaultTool.FILE_NEW)
			const result = await runner.run("Create saved.ts", (update) => {
				if (update.stats) update.stats.toolCalls = 999
				if (update.filesModified) update.filesModified.length = 0
				if (observer === "throws") throw new Error("observer failed")
				if (observer === "rejects") return Promise.reject(new Error("observer failed"))
				return new Promise<void>(() => {})
			})
			assert.equal(result.status, "completed", result.error)
			assert.equal(result.stats.toolCalls, 2)
			assert.deepEqual(result.filesModified, ["saved.ts"])
			sinon.assert.calledOnce(execute)
		})
	}
	it("returns completion without waiting for finding storage or writing the same finding twice", async () => {
		const resultText = `${VALID_SUBAGENT_COMPLETION_RESULT} CRITICAL: verified finding for the parent.`
		const createMessage = sinon.stub().callsFake(async function* () {
			yield callChunk(1, DietCodeDefaultTool.ATTEMPT, { result: resultText })
		})
		const { config, runner } = prepareProgressRun(createMessage, DietCodeDefaultTool.LIST_FILES)
		;(config as any).getSessionStreamId = () => "parent-stream"
		sinon.stub(completionGates, "validateSubagentCompletionGates").resolves(null)
		const store = sinon.stub(orchestrator, "storeMemory").returns(new Promise(() => {}))
		const result = await runner.run("Return findings", () => {})
		assert.equal(result.status, "completed", result.error)
		assert.equal(result.result, resultText)
		sinon.assert.calledOnce(store)
	})
	it("starts from the assignment when optional parent context and workspace metadata never settle", async () => {
		const clock = sinon.useFakeTimers()
		const createMessage = sinon.stub().callsFake(async function* (_prompt, conversation) {
			assert.match(JSON.stringify(conversation[0]), /Return the assigned finding/)
			assert.match(JSON.stringify(conversation[0]), /Workspace Configuration/)
			assert.match(JSON.stringify(conversation[0]), /tmp/)
			yield callChunk(1, DietCodeDefaultTool.ATTEMPT, { result: VALID_SUBAGENT_COMPLETION_RESULT })
		})
		const { config, runner } = prepareProgressRun(createMessage, DietCodeDefaultTool.LIST_FILES)
		sinon.stub(gatePolicy, "resolveCompletionGateOptions").resolves(buildCompletionGateOptionsFromSettings(config))
		sinon.stub(completionGates, "validateSubagentCompletionGates").resolves(null)
		;(config as any).getSessionStreamId = () => "parent-stream"
		const parentContext = sinon.stub(orchestrator, "getCompressedContext").returns(new Promise(() => {}))
		const metadata = sinon.stub().returns(new Promise(() => {}))
		config.workspaceManager = { buildWorkspacesJson: metadata } as any
		const running = runner.run("Return the assigned finding", () => {})
		await clock.tickAsync(2_000)
		assert.equal((await running).status, "completed")
		sinon.assert.calledOnce(parentContext)
		sinon.assert.calledOnce(metadata)
		sinon.assert.calledOnce(createMessage)
		assert.equal(clock.countTimers(), 0)
	})
	it("ignores unavailable parent tracking and does not let late context alter an already started helper", async () => {
		const clock = sinon.useFakeTimers()
		const createMessage = sinon.stub().callsFake(async function* () {
			yield callChunk(1, DietCodeDefaultTool.ATTEMPT, { result: VALID_SUBAGENT_COMPLETION_RESULT })
		})
		const { config, runner } = prepareProgressRun(createMessage, DietCodeDefaultTool.LIST_FILES)
		sinon.stub(gatePolicy, "resolveCompletionGateOptions").resolves(buildCompletionGateOptionsFromSettings(config))
		sinon.stub(completionGates, "validateSubagentCompletionGates").resolves(null)
		let finishContext!: (context: string) => void
		;(config as any).getSessionStreamId = () => "parent-stream"
		sinon.stub(orchestrator, "getCompressedContext").returns(
			new Promise((resolve) => {
				finishContext = resolve
			}),
		)
		const setContext = sinon.spy(SubagentBuilder.prototype, "setParentStreamContext")
		const running = runner.run("Return findings", () => {})
		await clock.tickAsync(1_000)
		assert.equal((await running).status, "completed")
		const calls = setContext.callCount
		finishContext("Late context must not change the completed assignment")
		await clock.tickAsync(0)
		assert.equal(setContext.callCount, calls)
		assert.doesNotMatch(String(createMessage.firstCall.args[0]), /Late context/)

		;(config as any).getSessionStreamId = () => {
			throw new Error("tracking unavailable")
		}
		const second = new SubagentRunner(config, new SubagentBuilder(config, "subagent"))
		assert.equal((await second.run("Return findings", () => {})).status, "completed")
	})
	it("returns edited paths when completion verification becomes unavailable", async () => {
		let turns = 0
		const createMessage = sinon.stub().callsFake(async function* () {
			yield ++turns === 1
				? callChunk(turns, DietCodeDefaultTool.FILE_NEW, { path: "saved.ts", content: "saved" })
				: callChunk(turns, DietCodeDefaultTool.ATTEMPT, { result: VALID_SUBAGENT_COMPLETION_RESULT })
		})
		const { runner } = prepareProgressRun(createMessage, DietCodeDefaultTool.FILE_NEW)
		sinon.stub(completionGates, "validateSubagentCompletionGates").rejects(new Error("check unavailable"))
		const result = await runner.run("Create saved.ts", () => {})
		assert.equal(result.status, "failed")
		assert.deepEqual(result.filesModified, ["saved.ts"])
		assert.equal(result.stats.toolCalls, 1)
	})
	it("finishes productive work after more than 50 calls and 25 turns without provider usage chunks", async () => {
		let turns = 0
		const createMessage = sinon.stub().callsFake(async function* () {
			turns++
			yield turns <= 55
				? callChunk(turns, DietCodeDefaultTool.LIST_FILES, { path: `folder-${turns}` })
				: callChunk(turns, DietCodeDefaultTool.ATTEMPT, { result: VALID_SUBAGENT_COMPLETION_RESULT })
		})
		const { runner, execute } = prepareProgressRun(createMessage)
		const result = await runner.run("Explore the requested folders", () => {})
		assert.equal(result.status, "completed", result.error)
		assert.equal(execute.callCount, 55)
		assert.equal(turns, 56)
	})
	it("hands back unchanged reads even when the observer adds fresh guidance", async () => {
		let turns = 0
		const createMessage = sinon.stub().callsFake(async function* () {
			yield callChunk(++turns, DietCodeDefaultTool.FILE_READ, { path: "a.ts", task_progress: `iteration ${turns}` })
		})
		const { config, runner } = prepareProgressRun(createMessage, DietCodeDefaultTool.FILE_READ)
		config.universalGuard = {
			guardPreExecution: sinon.stub().resolves({ success: true }),
			guardPostExecution: sinon.stub().resolves({ success: true }),
			onRead: sinon.stub().callsFake(async (_path, result) => `${result}\nRead count: ${turns}`),
		} as never
		const result = await runner.run("Inspect a.ts", () => {})
		assert.equal(result.status, "failed")
		assert.match(result.error!, /no new tool progress/)
		assert.equal(turns, 9)
		assert.deepEqual(result.filesViewed, ["a.ts"])
	})
	for (const denied of [false, true]) {
		it(
			denied ? "does not report denied writes as modified files" : "preserves successful writes when observation fails",
			async () => {
				let turns = 0
				const createMessage = sinon.stub().callsFake(async function* (_prompt, conversation) {
					turns++
					if (turns === 2) {
						assert.match(JSON.stringify(conversation.at(-1)), denied ? /denied this operation/ : /observed content/)
						assert.doesNotMatch(JSON.stringify(conversation.at(-1)), /observer unavailable/)
					}
					yield turns === 1
						? callChunk(turns, DietCodeDefaultTool.FILE_NEW, { path: "a.ts", content: "new source" })
						: callChunk(turns, DietCodeDefaultTool.ATTEMPT, { result: VALID_SUBAGENT_COMPLETION_RESULT })
				})
				const { config, runner, execute } = prepareProgressRun(createMessage, DietCodeDefaultTool.FILE_NEW)
				if (denied) execute.resolves(formatResponse.toolDenied())
				config.universalGuard = {
					guardPreExecution: sinon.stub().resolves({ success: true }),
					guardPostExecution: sinon.stub().rejects(new Error("observer unavailable")),
				} as never
				const result = await runner.run("Create a.ts", () => {})
				assert.equal(result.status, "completed", result.error)
				assert.deepEqual(result.filesModified, denied ? [] : ["a.ts"])
				sinon.assert.calledOnce(execute)
			},
		)
	}
	it("does not turn an earlier progress sentence into success after empty responses", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {})
		createMessage.onFirstCall().callsFake(async function* () {
			yield { type: "text", text: "I will inspect the files." }
		})
		const { runner } = prepareProgressRun(createMessage)
		const result = await runner.run("Inspect the files", () => {})
		assert.equal(result.status, "failed")
		assert.equal(createMessage.callCount, 2)
	})

	it("passes prior request token totals into the next-turn compaction check", async () => {
		const createMessage = sinon.stub()
		createMessage.onFirstCall().callsFake(async function* () {
			yield {
				type: "usage",
				inputTokens: 11,
				outputTokens: 7,
				cacheWriteTokens: 3,
				cacheReadTokens: 2,
			}
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_previous_tokens_1",
						name: DietCodeDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		createMessage.onSecondCall().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_previous_tokens_complete_1",
						name: DietCodeDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: VALID_SUBAGENT_COMPLETION_RESULT }),
					},
				},
			}
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = [{ name: "list_files" } as any]
			return "system prompt"
		})
		sinon.stub(SubagentBuilder.prototype, "buildNativeTools").returns([{ name: "list_files" }] as any)
		sinon.stub(skills, "discoverSkills").resolves([])
		sinon.stub(skills, "getAvailableSkills").returns([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const config = createTaskConfig(true)
		const builder = new SubagentBuilder(config, "subagent")
		const runner = new SubagentRunner(config, builder)
		const shouldCompactStub = sinon.stub(runner as any, "shouldCompactBeforeNextRequest").callsFake((...args: unknown[]) => {
			const [previousRequestTotalTokens] = args
			assert.equal(previousRequestTotalTokens, 23)
			return false
		})

		const result = await runner.run("List files", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(result.result, VALID_SUBAGENT_COMPLETION_RESULT)
		assert.equal(createMessage.callCount, 2)
		assert.equal(shouldCompactStub.callCount, 1)
	})

	it("falls back to non-native result blocks if structured tool calls appear while native mode is disabled", async () => {
		const createMessage = sinon.stub()
		createMessage.onFirstCall().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_2",
						name: DietCodeDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		createMessage.onSecondCall().callsFake(async function* (_systemPrompt: string, conversation: unknown[]) {
			const lastMessage = conversation[conversation.length - 1] as {
				role: string
				content: Array<{ type?: string; [key: string]: unknown }>
			}

			assert.equal(lastMessage.role, "user")
			assert.ok(lastMessage.content.every((block) => block.type === "text"))
			assert.equal(
				lastMessage.content.some((block) => block.type === "tool_result"),
				false,
			)

			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_complete_2",
						name: DietCodeDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: VALID_SUBAGENT_COMPLETION_RESULT }),
					},
				},
			}
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = undefined
			return "system prompt"
		})
		sinon.stub(skills, "discoverSkills").resolves([])
		sinon.stub(skills, "getAvailableSkills").returns([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const config = createTaskConfig(true)
		const builder = new SubagentBuilder(config, "subagent")
		const runner = new SubagentRunner(config, builder)
		const result = await runner.run("List files", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(result.result, VALID_SUBAGENT_COMPLETION_RESULT)
		assert.equal(createMessage.callCount, 2)
	})

	it("retries empty assistant turns with a no-tools-used nudge before failing", async () => {
		const createMessage = sinon.stub()
		createMessage.onFirstCall().callsFake(async function* () {})
		createMessage.onSecondCall().callsFake(async function* (_systemPrompt: string, conversation: unknown[]) {
			const lastAssistant = conversation[1] as {
				role: string
				content: Array<{ type?: string; text?: string }>
			}
			assert.equal(lastAssistant.role, "assistant")
			assert.equal(lastAssistant.content[0]?.type, "text")
			assert.equal(lastAssistant.content[0]?.text, "Failure: I did not provide a response.")

			const lastUser = conversation[2] as {
				role: string
				content: Array<{ type?: string; text?: string }>
			}
			assert.equal(lastUser.role, "user")
			assert.equal(lastUser.content[0]?.type, "text")
			assert.match(lastUser.content[0]?.text || "", /You did not use a tool in your previous response/i)

			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_complete_3",
						name: DietCodeDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: VALID_SUBAGENT_COMPLETION_RESULT }),
					},
				},
			}
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = undefined
			return "system prompt"
		})
		sinon.stub(skills, "discoverSkills").resolves([])
		sinon.stub(skills, "getAvailableSkills").returns([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const config = createTaskConfig(true)
		const builder = new SubagentBuilder(config, "subagent")
		const runner = new SubagentRunner(config, builder)
		const result = await runner.run("List files", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(result.result, VALID_SUBAGENT_COMPLETION_RESULT)
		assert.equal(createMessage.callCount, 2)
	})

	it("retries initial stream failures before failing", async () => {
		const createMessage = sinon.stub()
		createMessage.onFirstCall().callsFake(async function* () {
			yield* []
			throw new Error(
				'{"code":"stream_initialization_failed","message":"Failed to create stream: failed to generate stream from Vercel: failed to send request"}',
			)
		})
		createMessage.onSecondCall().callsFake(async function* () {
			yield* []
			throw new Error(
				'{"code":"stream_initialization_failed","message":"Failed to create stream: failed to generate stream from Vercel: failed to send request"}',
			)
		})
		createMessage.onThirdCall().callsFake(async function* () {
			yield* []
			throw new Error(
				'{"code":"stream_initialization_failed","message":"Failed to create stream: failed to generate stream from Vercel: failed to send request"}',
			)
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = undefined
			return "system prompt"
		})
		sinon.stub(skills, "discoverSkills").resolves([])
		sinon.stub(skills, "getAvailableSkills").returns([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const config = createTaskConfig(true)
		let inventoryReads = 0
		config.callbacks.getExecutionState = () => ({
			commands: { active: [], recent: [] },
			actions: {
				active: [
					{
						execution_id: "sibling",
						kind: "helper",
						label: `retry snapshot ${++inventoryReads}`,
						owner: "helper:sibling",
						status: "running",
					},
				],
				recent: [],
			},
		})
		const builder = new SubagentBuilder(config, "subagent")
		const runner = new SubagentRunner(config, builder)
		const result = await runner.run("List files", () => {})

		assert.equal(result.status, "failed")
		assert.equal(createMessage.callCount, 3)
		assert.equal(inventoryReads, 4, "three requests plus the final execution handoff")
		createMessage.getCalls().forEach((call, index) => {
			const request = JSON.stringify(call.args[1])
			assert.equal(request.match(/<execution_state>/g)?.length, 1)
			assert.ok(request.includes(`retry snapshot ${index + 1}`))
		})
	})

	it("bounds interrupted-response continuations without executing unfinished calls", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			yield { type: "text", text: "Working on the requested fix." }
			throw new Error("connection reset after output")
		})
		const promptRegistry = PromptRegistry.getInstance()
		const prompt = sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = undefined
			return "system prompt"
		})
		sinon.stub(skills, "discoverSkills").resolves([])
		sinon.stub(skills, "getAvailableSkills").returns([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const config = createTaskConfig(true)
		config.yoloModeToggled = true
		const runner = new SubagentRunner(config, new SubagentBuilder(config, "subagent"))
		const result = await runner.run("Apply the fix", () => {})
		assert.equal(result.status, "failed")
		assert.equal(createMessage.callCount, 3)
		assert.equal(prompt.firstCall.args[0].yoloModeToggled, true)
		sinon.assert.notCalled(config.callbacks.executeCommandTool as sinon.SinonStub)
	})

	it("does not execute native arguments truncated at a normal end of stream", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					call_id: "partial",
					function: { id: "partial", name: "execute_command", arguments: '{"command":"touch partial' },
				},
			}
		})
		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = undefined
			return "system prompt"
		})
		sinon.stub(skills, "discoverSkills").resolves([])
		sinon.stub(skills, "getAvailableSkills").returns([])
		stubApiHandler(createMessage)
		initializeHostProvider()
		const config = createTaskConfig(true)
		const runner = new SubagentRunner(config, new SubagentBuilder(config, "subagent"))
		const result = await runner.run("Apply the fix", () => {})
		assert.equal(result.status, "failed")
		assert.match(result.error ?? "", /Incomplete arguments/)
		assert.equal(createMessage.callCount, 1)
		sinon.assert.notCalled(config.callbacks.executeCommandTool as sinon.SinonStub)
	})

	it("fails context window errors", async () => {
		const createMessage = sinon.stub()
		createMessage.onFirstCall().callsFake(async function* () {
			yield* []
			const contextError = new Error("context length exceeded") as any
			contextError.status = 400
			throw contextError
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = undefined
			return "system prompt"
		})
		sinon.stub(skills, "discoverSkills").resolves([])
		sinon.stub(skills, "getAvailableSkills").returns([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const config = createTaskConfig(true)
		const builder = new SubagentBuilder(config, "subagent")
		const runner = new SubagentRunner(config, builder)
		const result = await runner.run("Huge prompt", () => {})

		assert.equal(result.status, "failed")
		assert.equal(createMessage.callCount, 1)
	})

	it("uses the configured task api handler for subagent requests", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_complete_4",
						name: DietCodeDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: VALID_SUBAGENT_COMPLETION_RESULT }),
					},
				},
			}
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = [{ name: "list_files" } as any]
			return "system prompt"
		})
		sinon.stub(SubagentBuilder.prototype, "buildNativeTools").returns([{ name: "list_files" }] as any)
		sinon.stub(skills, "discoverSkills").resolves([])
		sinon.stub(skills, "getAvailableSkills").returns([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const config = createTaskConfig(true)
		const builder = new SubagentBuilder(config, "subagent")
		const runner = new SubagentRunner(config, builder)
		const result = await runner.run("List files", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(createMessage.callCount, 1)
	})

	it("filters available skills to configured skills when subagent skills are configured", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_skills_filtered_1",
						name: DietCodeDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: VALID_SUBAGENT_COMPLETION_RESULT }),
					},
				},
			}
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async (context) => {
			assert.ok(context.skills)
			assert.deepEqual(
				context.skills.map((skill) => skill.name),
				["allowed-skill"],
			)
			promptRegistry.nativeTools = undefined
			return "system prompt"
		})
		sinon.stub(SubagentBuilder.prototype, "getConfiguredSkills").returns(["allowed-skill"])
		sinon.stub(skills, "discoverSkills").resolves([])
		sinon.stub(skills, "getAvailableSkills").returns([
			{ name: "allowed-skill", description: "Allowed", path: "/skills/allowed/SKILL.md", source: "project" },
			{ name: "other-skill", description: "Other", path: "/skills/other/SKILL.md", source: "project" },
		])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const config = createTaskConfig(true)
		const builder = new SubagentBuilder(config, "subagent")
		const runner = new SubagentRunner(config, builder)
		const result = await runner.run("Run task", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(createMessage.callCount, 1)
	})

	it("uses all available skills when subagent skills are not configured", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_skills_unconfigured_1",
						name: DietCodeDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: VALID_SUBAGENT_COMPLETION_RESULT }),
					},
				},
			}
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async (context) => {
			assert.ok(context.skills)
			assert.deepEqual(
				context.skills.map((skill) => skill.name),
				["alpha-skill", "beta-skill"],
			)
			promptRegistry.nativeTools = undefined
			return "system prompt"
		})
		sinon.stub(SubagentBuilder.prototype, "getConfiguredSkills").returns(undefined)
		sinon.stub(skills, "discoverSkills").resolves([])
		sinon.stub(skills, "getAvailableSkills").returns([
			{ name: "alpha-skill", description: "Alpha", path: "/skills/alpha/SKILL.md", source: "project" },
			{ name: "beta-skill", description: "Beta", path: "/skills/beta/SKILL.md", source: "project" },
		])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const config = createTaskConfig(true)
		const builder = new SubagentBuilder(config, "subagent")
		const runner = new SubagentRunner(config, builder)
		const result = await runner.run("Run task", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(createMessage.callCount, 1)
	})

	it("logs a warning when a configured skill is not available", async () => {
		const createMessage = sinon.stub().callsFake(async function* () {
			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_skills_missing_1",
						name: DietCodeDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: VALID_SUBAGENT_COMPLETION_RESULT }),
					},
				},
			}
		})

		const warnStub = sinon.stub(Logger, "warn")
		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async (context) => {
			assert.ok(context.skills)
			assert.deepEqual(
				context.skills.map((skill) => skill.name),
				["present-skill"],
			)
			promptRegistry.nativeTools = undefined
			return "system prompt"
		})
		sinon.stub(SubagentBuilder.prototype, "getConfiguredSkills").returns(["present-skill", "missing-skill"])
		sinon.stub(skills, "discoverSkills").resolves([])
		sinon
			.stub(skills, "getAvailableSkills")
			.returns([{ name: "present-skill", description: "Present", path: "/skills/present/SKILL.md", source: "project" }])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const config = createTaskConfig(true)
		const builder = new SubagentBuilder(config, "subagent")
		const runner = new SubagentRunner(config, builder)
		const result = await runner.run("Run task", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(createMessage.callCount, 1)
		sinon.assert.calledWith(warnStub, "[SubagentRunner] Configured skill 'missing-skill' not found for subagent run.")
	})

	it("includes workspace metadata only in the initial user message", async () => {
		const createMessage = sinon.stub()
		createMessage.onFirstCall().callsFake(async function* (_systemPrompt: string, conversation: unknown[]) {
			const initialUser = conversation[0] as {
				role: string
				content: Array<{ type?: string; text?: string }>
			}
			assert.equal(initialUser.role, "user")
			const initialTexts = initialUser.content
				.filter((block) => block.type === "text")
				.map((block) => block.text || "")
				.join("\n")
			assert.match(initialTexts, /# Workspace Configuration/)

			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_workspace_1",
						name: DietCodeDefaultTool.LIST_FILES,
						arguments: JSON.stringify({ path: ".", recursive: false }),
					},
				},
			}
		})
		createMessage.onSecondCall().callsFake(async function* (_systemPrompt: string, conversation: unknown[]) {
			const followUpUser = conversation[2] as {
				role: string
				content: Array<{ type?: string; text?: string }>
			}
			assert.equal(followUpUser.role, "user")
			const followUpTexts = followUpUser.content
				.filter((block) => block.type === "text")
				.map((block) => block.text || "")
				.join("\n")
			assert.equal(followUpTexts.includes("# Workspace Configuration"), false)

			yield {
				type: "tool_calls",
				tool_call: {
					function: {
						id: "toolu_subagent_workspace_complete_1",
						name: DietCodeDefaultTool.ATTEMPT,
						arguments: JSON.stringify({ result: VALID_SUBAGENT_COMPLETION_RESULT }),
					},
				},
			}
		})

		const promptRegistry = PromptRegistry.getInstance()
		sinon.stub(promptRegistry, "get").callsFake(async () => {
			promptRegistry.nativeTools = [{ name: "list_files" } as any]
			return "system prompt"
		})
		sinon.stub(SubagentBuilder.prototype, "buildNativeTools").returns([{ name: "list_files" }] as any)
		sinon.stub(skills, "discoverSkills").resolves([])
		sinon.stub(skills, "getAvailableSkills").returns([])
		stubApiHandler(createMessage)
		initializeHostProvider()

		const config = createTaskConfig(true)
		const builder = new SubagentBuilder(config, "subagent")
		const runner = new SubagentRunner(config, builder)
		const result = await runner.run("List files", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(result.result, VALID_SUBAGENT_COMPLETION_RESULT)
		assert.equal(createMessage.callCount, 2)
	})
})
