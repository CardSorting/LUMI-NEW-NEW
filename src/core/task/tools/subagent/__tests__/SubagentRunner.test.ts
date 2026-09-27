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
		const builder = new SubagentBuilder(config, "subagent")
		const runner = new SubagentRunner(config, builder)
		const result = await runner.run("List files", () => {})

		assert.equal(result.status, "completed", result.error)
		assert.equal(result.result, VALID_SUBAGENT_COMPLETION_RESULT)
		assert.equal(createMessage.callCount, 2)
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
				if (checkFailure)
					sinon.stub(completionGates, "validateSubagentCompletionGates").rejects(new Error("check unavailable"))
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
		assert.equal(createMessage.callCount, 4)
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
		const builder = new SubagentBuilder(config, "subagent")
		const runner = new SubagentRunner(config, builder)
		const result = await runner.run("List files", () => {})

		assert.equal(result.status, "failed")
		assert.equal(createMessage.callCount, 3)
	})

	it("does not replay a request after text or tool-call output", async () => {
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
		assert.equal(createMessage.callCount, 1)
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
