import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import * as coreApi from "@core/api"
import { DietCodeSubagentUsageInfo } from "@shared/ExtensionMessage"
import { DietCodeDefaultTool } from "@shared/tools"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { orchestrator } from "@/infrastructure/ai/Orchestrator"
import * as telemetryModule from "@/services/telemetry"
import { executor } from "../../../ActionExecutor"
import { TaskState } from "../../../TaskState"
import { AgentConfigLoader } from "../../subagent/AgentConfigLoader"
import { SubagentBuilder } from "../../subagent/SubagentBuilder"
import { SubagentRunner } from "../../subagent/SubagentRunner"
import type { TaskConfig } from "../../types/TaskConfig"
import { createUIHelpers } from "../../types/UIHelpers"
import { isToolFailure } from "../../utils/toolOutcome"
import { UseSubagentsToolHandler } from "../SubagentToolHandler"

function createConfig(options?: {
	autoApproveSafe?: boolean
	autoApproveAll?: boolean
	taskAskResponse?: "yesButtonClicked" | "noButtonClicked"
	subagentsEnabled?: boolean
}) {
	const taskState = new TaskState()
	const askResponse = options?.taskAskResponse ?? "yesButtonClicked"
	const subagentsEnabled = options?.subagentsEnabled ?? true

	const callbacks = {
		say: sinon.stub().resolves(undefined),
		ask: sinon.stub().resolves({ response: askResponse }),
		saveCheckpoint: sinon.stub().resolves(),
		sayAndCreateMissingParamError: sinon.stub().resolves("missing"),
		removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
		executeCommandTool: sinon.stub().resolves([false, "ok"]),
		cancelRunningCommandTool: sinon.stub().resolves(false),
		doesLatestTaskCompletionHaveNewChanges: sinon.stub().resolves(false),
		updateFCListFromToolResponse: sinon.stub().resolves(),
		shouldAutoApproveTool: sinon.stub().returns([options?.autoApproveSafe ?? false, options?.autoApproveAll ?? false]),
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
	}

	const config = {
		taskId: "task-1",
		ulid: randomUUID(),
		cwd: "/tmp",
		mode: "act",
		strictPlanModeEnabled: false,
		yoloModeToggled: false,
		vscodeTerminalExecutionMode: "vscodeTerminal",
		enableParallelToolCalling: true,
		context: {},
		taskState,
		messageState: {},
		api: {
			getModel: () => ({ id: "openai/gpt-5", info: {} }),
		},
		autoApprovalSettings: {
			enableNotifications: false,
			actions: {
				executeSafeCommands: false,
				executeAllCommands: false,
			},
		},
		autoApprover: {
			shouldAutoApproveTool: sinon.stub().returns([options?.autoApproveSafe ?? false, options?.autoApproveAll ?? false]),
		},
		browserSettings: {},
		focusChainSettings: {},
		services: {
			stateManager: {
				getGlobalStateKey: (key: string) => (key === "nativeToolCallEnabled" ? true : undefined),
				getGlobalSettingsKey: (key: string) => {
					if (key === "mode") {
						return "act"
					}
					if (key === "customPrompt") {
						return undefined
					}
					if (key === "subagentsEnabled") {
						return subagentsEnabled
					}
					return undefined
				},
				getApiConfiguration: () => ({
					planModeApiProvider: "openai",
					actModeApiProvider: "openai",
				}),
			},
			mcpHub: {},
		},
		callbacks,
		coordinator: {
			getHandler: sinon.stub(),
		},
	} as unknown as TaskConfig

	return { config, callbacks, taskState }
}

describe("SubagentToolHandler", () => {
	afterEach(() => {
		sinon.restore()
	})

	const batch = {
		type: "tool_use" as const,
		name: DietCodeDefaultTool.USE_SUBAGENTS,
		params: { prompt_1: "one", prompt_2: "two", prompt_3: "three", prompt_4: "four", prompt_5: "five" },
		partial: false,
	}
	it("coalesces repeated assignments in one batch and reserves queued helpers across batches", async () => {
		const { config, taskState } = createConfig({ autoApproveSafe: true })
		const clock = sinon.useFakeTimers()
		let finish!: (result: ReturnType<typeof completed>) => void
		const work = new Promise<ReturnType<typeof completed>>((resolve) => {
			finish = resolve
		})
		const run = sinon.stub(SubagentRunner.prototype, "run").returns(work)
		const first = new UseSubagentsToolHandler().execute(config, batch)
		await clock.tickAsync(0)
		assert.equal(run.callCount, 3)
		const inventory = executor.executions.list(config.ulid).active
		assert.equal(inventory.length, 5)
		assert.equal(inventory.filter((entry) => entry.status === "queued").length, 2)
		const queued = inventory.find((entry) => entry.label === "five")!
		assert.match(queued.owner, /^helper:/)
		const duplicate = await new UseSubagentsToolHandler().execute(config, {
			...batch,
			params: { prompt_1: "five", prompt_2: " five " },
		})
		assert.match(String(duplicate), /Total Agents: 1/)
		assert.match(String(duplicate), /No duplicate was started/)
		assert.ok(String(duplicate).includes(queued.execution_id))
		assert.equal(run.callCount, 3)
		taskState.abort = true
		assert.match(String(await first), /cancelled/)
		await clock.tickAsync(0)
		assert.equal(executor.executions.list(config.ulid).active.length, 3)
		assert.equal(executor.executions.get(config.ulid, queued.execution_id)?.status, "not_started")
		finish(completed())
		await clock.tickAsync(0)
		assert.equal(executor.executions.list(config.ulid).active.length, 0)
		assert.equal(run.callCount, 3, "cancelled queued helpers must never start after a slot is freed")
		assert.equal(executor.executions.get(config.ulid, inventory[0].execution_id)?.status, "completed")
		assert.equal(clock.countTimers(), 0)
	})
	it("runs identical prompts only once within a successful batch", async () => {
		const { config } = createConfig({ autoApproveSafe: true })
		const run = sinon.stub(SubagentRunner.prototype, "run").resolves(completed())
		const result = await new UseSubagentsToolHandler().execute(config, {
			...batch,
			params: { prompt_1: "one", prompt_2: " one ", prompt_3: "one" },
		})
		assert.match(String(result), /Total Agents: 1 \(Success: 1, Fail: 0\)/)
		sinon.assert.calledOnce(run)
	})
	it("gives each helper its own provider and retry cancellation signal", async () => {
		const { config } = createConfig({ autoApproveSafe: true })
		const signals: AbortSignal[] = []
		const handlers: object[] = []
		sinon.stub(coreApi, "buildApiHandler").callsFake((options) => {
			signals.push(options.getRetrySignal!())
			const handler = { getModel: () => ({ id: "test", info: {} }), createMessage: sinon.stub(), abort: sinon.stub() }
			handlers.push(handler)
			return handler as never
		})
		const builders: SubagentBuilder[] = []
		sinon.stub(SubagentRunner.prototype, "run").callsFake(async function (this: any) {
			builders.push(this.agent)
			return completed()
		})
		await new UseSubagentsToolHandler().execute(config, batch)
		assert.equal(new Set(handlers).size, 5)
		assert.equal(new Set(signals).size, 5)
		builders[0].cancelPendingRetry()
		assert.equal(signals[0].aborted, true)
		assert.ok(signals.slice(1).every((signal) => !signal.aborted))
	})
	it("returns completed helper outcomes when the usage display fails", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: true })
		callbacks.say.withArgs("subagent_usage").rejects(new Error("UI unavailable"))
		const run = sinon.stub(SubagentRunner.prototype, "run").resolves(completed())
		const result = await new UseSubagentsToolHandler().execute(config, batch)
		assert.match(String(result), /Success: 5, Fail: 0/)
		assert.equal(run.callCount, 5)
	})
	it("starts every available helper and returns its result when status and usage displays never settle", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: true })
		const clock = sinon.useFakeTimers()
		callbacks.say.returns(new Promise(() => {}))
		const run = sinon.stub(SubagentRunner.prototype, "run").resolves(completed())
		const pending = new UseSubagentsToolHandler().execute(config, batch)
		await clock.tickAsync(0)
		assert.equal(run.callCount, 5)
		await clock.tickAsync(1000)
		assert.match(String(await pending), /Success: 5, Fail: 0/)
		assert.equal(clock.countTimers(), 0)
	})
	it("keeps a delayed final status attached to its own row after the parent continues", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: true })
		const clock = sinon.useFakeTimers()
		const rows: any[] = []
		let release!: () => void
		callbacks.postStateToWebview.onFirstCall().returns(
			new Promise<void>((resolve) => {
				release = resolve
			}),
		)
		config.messageState = {
			getDietCodeMessages: () => rows,
			addToDietCodeMessages: async (row: any) => {
				rows.push(row)
			},
			updateDietCodeMessage: async (index: number, update: any) => {
				Object.assign(rows[index], update)
			},
		} as never
		sinon.stub(SubagentRunner.prototype, "run").resolves(completed())
		const pending = new UseSubagentsToolHandler().execute(config, batch)
		await clock.tickAsync(1000)
		await pending
		rows.push({ ts: 5000, type: "say", say: "command", text: "Parent continued" })
		release()
		await clock.tickAsync(0)
		assert.equal(JSON.parse(rows[0].text).status, "completed")
		assert.equal(rows[0].partial, false)
		assert.equal(rows[1].text, "Parent continued")
	})
	it("settles a late tracking registration once without holding back completed helpers", async () => {
		const { config } = createConfig({ autoApproveSafe: true })
		const clock = sinon.useFakeTimers()
		;(config as any).getSessionStreamId = () => "parent"
		let register!: (stream: any) => void
		sinon.stub(orchestrator, "spawnChildStream").returns(
			new Promise((resolve) => {
				register = resolve
			}),
		)
		const close = sinon.stub(orchestrator, "completeStream").resolves("")
		const fail = sinon.stub(orchestrator, "failStream").resolves()
		const run = sinon.stub(SubagentRunner.prototype, "run").resolves(completed())
		const pending = new UseSubagentsToolHandler().execute(config, { ...batch, params: { prompt_1: "one" } })
		await clock.tickAsync(1000)
		assert.match(String(await pending), /Success: 1, Fail: 0/)
		sinon.assert.calledOnce(run)
		register({ id: "late-child" })
		await clock.tickAsync(0)
		sinon.assert.calledOnceWithExactly(close, "late-child", "done")
		sinon.assert.notCalled(fail)
	})
	it("cancels before tracking returns and never starts the helper after late registration", async () => {
		const { config, taskState } = createConfig({ autoApproveSafe: true })
		const clock = sinon.useFakeTimers()
		;(config as any).getSessionStreamId = () => "parent"
		let register!: (stream: any) => void
		sinon.stub(orchestrator, "spawnChildStream").returns(
			new Promise((resolve) => {
				register = resolve
			}),
		)
		const fail = sinon.stub(orchestrator, "failStream").resolves()
		const run = sinon.stub(SubagentRunner.prototype, "run").resolves(completed())
		const pending = new UseSubagentsToolHandler().execute(config, { ...batch, params: { prompt_1: "one" } })
		await clock.tickAsync(0)
		taskState.abort = true
		await clock.tickAsync(0)
		assert.equal(isToolFailure(await pending), true)
		register({ id: "late-child" })
		await clock.tickAsync(0)
		sinon.assert.notCalled(run)
		sinon.assert.calledOnce(fail)
	})
	it("does not let a failed helper's display delay queued independent work", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: true })
		const clock = sinon.useFakeTimers()
		callbacks.say.withArgs("subagent").returns(new Promise(() => {}))
		const run = sinon.stub(SubagentRunner.prototype, "run").resolves(completed())
		run.onFirstCall().rejects(new Error("one helper unavailable"))
		const pending = new UseSubagentsToolHandler().execute(config, batch)
		await clock.tickAsync(0)
		assert.equal(run.callCount, 5)
		await clock.tickAsync(1000)
		assert.match(String(await pending), /Success: 4, Fail: 1/)
	})
	it("keeps handoffs stable when only performance counters change and marks failed batches as failures", async () => {
		const { config } = createConfig({ autoApproveSafe: true })
		const run = sinon.stub(SubagentRunner.prototype, "run").resolves({ ...completed(), durationMs: 100 })
		const handler = new UseSubagentsToolHandler()
		const first = await handler.execute(config, batch)
		run.resolves({ ...completed(), durationMs: 900, stats: { ...completed().stats, toolCalls: 50, inputTokens: 1000 } })
		assert.equal(await handler.execute(config, batch), first)
		run.resolves({ ...completed(), status: "failed", result: undefined, error: "unavailable" })
		assert.equal(isToolFailure(await handler.execute(config, batch)), true)
	})
	it("preserves reported edits and usage when the final failed handoff omits them", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: true })
		sinon.stub(SubagentRunner.prototype, "run").callsFake(async (_prompt, progress) => {
			progress({ stats: { ...completed().stats, totalCost: 0.5, inputTokens: 25 }, filesModified: ["saved.ts"] })
			return { ...completed(), status: "failed", error: "verification unavailable", result: undefined }
		})
		const result = await new UseSubagentsToolHandler().execute(config, { ...batch, params: { prompt_1: "one" } })
		assert.match(String(result), /saved.ts/)
		assert.equal(config.taskState.workspaceRevision, 1)
		const usage = callbacks.say.getCalls().find((call) => call.args[0] === "subagent_usage")!
		assert.equal(JSON.parse(usage.args[1]).cost, 0.5)
		assert.equal(JSON.parse(usage.args[1]).tokensIn, 25)
	})
	it("continues authorized batches when telemetry throws or rejects", async () => {
		const { config } = createConfig({ autoApproveSafe: true })
		const telemetry = sinon.stub()
		sinon.stub(telemetryModule, "telemetryService").value({ captureToolUsage: telemetry })
		telemetry.onFirstCall().throws(new Error("telemetry unavailable"))
		telemetry.onSecondCall().rejects(new Error("telemetry unavailable"))
		const run = sinon.stub(SubagentRunner.prototype, "run").resolves(completed())
		const handler = new UseSubagentsToolHandler()
		await handler.execute(config, batch)
		await handler.execute(config, batch)
		assert.equal(run.callCount, 10)
	})
	it("does not dispatch helpers when the configured cost budget is already exhausted", async () => {
		const { config, taskState } = createConfig({ autoApproveSafe: true })
		taskState.maxCost = 0
		const run = sinon.stub(SubagentRunner.prototype, "run").resolves(completed())
		const result = await new UseSubagentsToolHandler().execute(config, batch)
		sinon.assert.notCalled(run)
		assert.match(String(result), /budget is exhausted/)
	})
	it("isolates a non-Error rejection without aborting successful or queued siblings", async () => {
		const { config } = createConfig({ autoApproveSafe: true })
		const run = sinon.stub(SubagentRunner.prototype, "run").resolves(completed())
		run.onFirstCall().callsFake(async () => {
			throw null
		})
		const abort = sinon.stub(SubagentRunner.prototype, "abort").resolves()
		const result = await new UseSubagentsToolHandler().execute(config, batch)
		assert.match(String(result), /Success: 4, Fail: 1/)
		assert.equal(run.callCount, 5)
		sinon.assert.notCalled(abort)
	})
	it("does not renew completion retries for an identical helper handoff", async () => {
		const { config, taskState } = createConfig({ autoApproveSafe: true })
		const run = sinon.stub(SubagentRunner.prototype, "run").resolves(completed())
		const handler = new UseSubagentsToolHandler()
		await handler.execute(config, batch)
		assert.equal(taskState.workspaceRevision, 1)
		await handler.execute(config, batch)
		assert.equal(taskState.workspaceRevision, 1)
		run.resolves({ ...completed(), result: "New evidence from the requested verification" })
		await handler.execute(config, batch)
		assert.equal(taskState.workspaceRevision, 2)
	})
	const completed = () => ({
		status: "completed" as const,
		result: "done",
		stats: {
			toolCalls: 1,
			inputTokens: 2,
			outputTokens: 3,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0,
			contextTokens: 5,
			contextWindow: 1000,
			contextUsagePercentage: 0.5,
		},
	})

	it("fills all three slots immediately and starts queued work as soon as a slot is free", async () => {
		const { config } = createConfig({ autoApproveSafe: true })
		const clock = sinon.useFakeTimers()
		const releases: (() => void)[] = []
		const run = sinon.stub(SubagentRunner.prototype, "run").callsFake(async () => {
			await new Promise<void>((resolve) => {
				releases.push(resolve)
			})
			return completed()
		})
		const pending = new UseSubagentsToolHandler().execute(config, batch)
		await clock.tickAsync(0)
		assert.equal(run.callCount, 3)
		releases[0]()
		await clock.tickAsync(0)
		assert.equal(run.callCount, 4)
		releases[1]()
		releases[2]()
		releases[3]()
		await clock.tickAsync(0)
		assert.equal(run.callCount, 5)
		releases[4]()
		await pending
		assert.equal(config.taskState.workspaceRevision, 1)
	})

	it("returns promptly on cancellation, skips queued work, and ignores late progress", async () => {
		const { config, callbacks, taskState } = createConfig({ autoApproveSafe: true })
		const clock = sinon.useFakeTimers()
		const progress: Parameters<SubagentRunner["run"]>[1][] = []
		const releases: (() => void)[] = []
		const run = sinon.stub(SubagentRunner.prototype, "run").callsFake(async (_prompt, onProgress) => {
			progress.push(onProgress)
			onProgress({ status: "running", stats: completed().stats })
			await new Promise<void>((resolve) => {
				releases.push(resolve)
			})
			return completed()
		})
		const abort = sinon.stub(SubagentRunner.prototype, "abort").resolves()
		const pending = new UseSubagentsToolHandler().execute(config, batch)
		await clock.tickAsync(0)
		taskState.abort = true
		await clock.tickAsync(100)
		const result = await pending
		assert.ok(String(result).includes("Success: 0, Fail: 5"))
		assert.equal(run.callCount, 3)
		assert.equal(abort.callCount, 5)
		const count = callbacks.say.callCount
		progress[0]({ status: "completed", result: "late" })
		for (const release of releases) release()
		await clock.tickAsync(0)
		assert.equal(callbacks.say.callCount, count)
		assert.equal(run.callCount, 3)
		assert.equal(taskState.workspaceRevision, 0)
		const usage = callbacks.say.getCalls().find((call) => call.args[0] === "subagent_usage")!
		assert.equal(JSON.parse(usage.args[1]).tokensIn, 6)
	})

	it("finalizes every helper on timeout, including helpers that never started", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: true })
		const clock = sinon.useFakeTimers()
		const run = sinon.stub(SubagentRunner.prototype, "run").returns(new Promise(() => {}))
		sinon.stub(SubagentRunner.prototype, "abort").resolves()
		const pending = new UseSubagentsToolHandler().execute(config, batch)
		await clock.tickAsync(20 * 60 * 1000)
		await pending
		assert.equal(run.callCount, 3)
		const final = callbacks.say
			.getCalls()
			.filter((call) => call.args[0] === "subagent")
			.at(-1)!
		const payload = JSON.parse(final.args[1])
		assert.equal(payload.completed, 5)
		assert.equal(payload.failures, 5)
		assert.ok(payload.items.every((item: { status: string }) => item.status === "failed"))
	})

	it("stops queued helpers when the cumulative budget is reached and preserves reported usage", async () => {
		const { config, callbacks, taskState } = createConfig({ autoApproveSafe: true })
		taskState.maxCost = 0.1
		const run = sinon.stub(SubagentRunner.prototype, "run").callsFake(async (_prompt, progress) => {
			progress({ status: "running", stats: { ...completed().stats, totalCost: 0.1 } })
			return new Promise(() => {})
		})
		sinon.stub(SubagentRunner.prototype, "abort").resolves()
		await new UseSubagentsToolHandler().execute(config, batch)
		assert.equal(run.callCount, 1)
		const usage = callbacks.say.getCalls().find((call) => call.args[0] === "subagent_usage")!
		assert.equal(JSON.parse(usage.args[1]).cost, 0.1)
	})

	it("shares the token budget across helpers including cache usage and retains partial handoffs", async () => {
		const { config, callbacks, taskState } = createConfig({ autoApproveSafe: true })
		taskState.maxTokens = 100
		const run = sinon.stub(SubagentRunner.prototype, "run").callsFake(async (_prompt, progress) => {
			progress({
				status: "running",
				result: "Found the cause in saved.ts",
				stats: { ...completed().stats, inputTokens: 25, cacheReadTokens: 25 },
			})
			return new Promise(() => {})
		})
		sinon.stub(SubagentRunner.prototype, "abort").resolves()
		const result = await new UseSubagentsToolHandler().execute(config, batch)
		assert.equal(run.callCount, 2)
		assert.match(String(result), /token budget reached/)
		assert.match(String(result), /Found the cause in saved.ts/)
		const usage = callbacks.say.getCalls().find((call) => call.args[0] === "subagent_usage")!
		assert.equal(JSON.parse(usage.args[1]).tokensIn, 50)
		assert.equal(JSON.parse(usage.args[1]).cacheReads, 50)
	})

	it("preserves a completed handoff when the batch stops before the runner promise resolves", async () => {
		const { config, callbacks, taskState } = createConfig({ autoApproveSafe: true })
		taskState.maxCost = 0.1
		sinon.stub(SubagentRunner.prototype, "run").callsFake(async (_prompt, progress) => {
			progress({ status: "completed", result: "Verified result", stats: { ...completed().stats, totalCost: 0.1 } })
			return new Promise(() => {})
		})
		sinon.stub(SubagentRunner.prototype, "abort").resolves()
		const result = await new UseSubagentsToolHandler().execute(config, batch)
		assert.match(String(result), /Success: 1, Fail: 4/)
		assert.match(String(result), /Verified result/)
		const final = callbacks.say
			.getCalls()
			.filter((call) => call.args[0] === "subagent")
			.at(-1)!
		assert.equal(JSON.parse(final.args[1]).items[0].status, "completed")
	})

	it("does not dispatch helpers when the token budget is already exhausted", async () => {
		const { config, taskState } = createConfig({ autoApproveSafe: true })
		taskState.maxTokens = 0
		const run = sinon.stub(SubagentRunner.prototype, "run").resolves(completed())
		await new UseSubagentsToolHandler().execute(config, batch)
		sinon.assert.notCalled(run)
	})

	it("rejects a depth limit before requesting approval or creating a running row", async () => {
		const { config, callbacks } = createConfig()
		config.recursionDepth = 3
		const result = await new UseSubagentsToolHandler().execute(config, batch)
		assert.ok(String(result).includes("depth limit"))
		sinon.assert.notCalled(callbacks.ask)
		sinon.assert.notCalled(callbacks.say)
	})

	it("coalesces rapid progress for a slow UI and publishes the final state last", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: true })
		let release!: () => void
		const slowWrite = new Promise<void>((resolve) => {
			release = resolve
		})
		let statusWrites = 0
		callbacks.say.callsFake(async (type: string) => {
			if (type === "subagent" && ++statusWrites === 2) await slowWrite
		})
		sinon.stub(SubagentRunner.prototype, "run").callsFake(async (_prompt, progress) => {
			for (let i = 0; i < 50; i++) progress({ status: "running", stats: { ...completed().stats, toolCalls: i } })
			return completed()
		})
		const pending = new UseSubagentsToolHandler().execute(config, { ...batch, params: { prompt_1: "one" } })
		await delay(0)
		assert.equal(statusWrites, 2)
		release()
		await pending
		assert.equal(statusWrites, 3)
		const last = callbacks.say
			.getCalls()
			.filter((call) => call.args[0] === "subagent")
			.at(-1)!
		assert.equal(JSON.parse(last.args[1]).status, "completed")
		assert.equal(last.args[4], false)
	})

	it("returns missing parameter error when no prompts are provided", async () => {
		const { config, callbacks, taskState } = createConfig()
		const handler = new UseSubagentsToolHandler()

		const result = await handler.execute(config, {
			type: "tool_use",
			name: DietCodeDefaultTool.USE_SUBAGENTS,
			params: {},
			partial: false,
		})

		assert.equal(result, "missing")
		assert.equal(taskState.consecutiveMistakeCount, 1)
		sinon.assert.calledOnce(callbacks.sayAndCreateMissingParamError)
	})

	it("returns an error when subagents are disabled", async () => {
		const { config } = createConfig({ subagentsEnabled: false })
		const handler = new UseSubagentsToolHandler()

		const result = await handler.execute(config, {
			type: "tool_use",
			name: DietCodeDefaultTool.USE_SUBAGENTS,
			params: {
				prompt_1: "first prompt",
			},
			partial: false,
		})

		assert.ok((result as string).includes("Subagents are disabled. Enable them in Settings > Features to use this tool."))
	})

	it("streams partial use_subagents approval as ask when not auto-approved", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: false, autoApproveAll: false })
		const handler = new UseSubagentsToolHandler()
		const uiHelpers = createUIHelpers(config)

		await handler.handlePartialBlock(
			{
				type: "tool_use",
				name: DietCodeDefaultTool.USE_SUBAGENTS,
				params: {
					prompt_1: "first prompt",
					prompt_2: "second prompt",
				},
				partial: true,
			},
			uiHelpers,
		)

		sinon.assert.calledOnce(callbacks.removeLastPartialMessageIfExistsWithType)
		sinon.assert.calledWithExactly(callbacks.removeLastPartialMessageIfExistsWithType, "say", "use_subagents")
		sinon.assert.calledOnce(callbacks.ask)
		sinon.assert.calledWithMatch(callbacks.ask, "use_subagents", sinon.match.string, true)

		const payload = JSON.parse(callbacks.ask.firstCall.args[1])
		assert.deepEqual(payload.prompts, ["first prompt", "second prompt"])
		sinon.assert.notCalled(callbacks.say)
	})

	it("streams partial use_subagents approval as say when auto-approved", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: true, autoApproveAll: false })
		const handler = new UseSubagentsToolHandler()
		const uiHelpers = createUIHelpers(config)

		await handler.handlePartialBlock(
			{
				type: "tool_use",
				name: DietCodeDefaultTool.USE_SUBAGENTS,
				params: {
					prompt_1: "first prompt",
					prompt_2: "second prompt",
				},
				partial: true,
			},
			uiHelpers,
		)

		sinon.assert.calledOnce(callbacks.removeLastPartialMessageIfExistsWithType)
		sinon.assert.calledWithExactly(callbacks.removeLastPartialMessageIfExistsWithType, "ask", "use_subagents")
		sinon.assert.calledOnce(callbacks.say)
		sinon.assert.calledWithMatch(callbacks.say, "use_subagents", sinon.match.string, undefined, undefined, true)

		const payload = JSON.parse(callbacks.say.firstCall.args[1])
		assert.deepEqual(payload.prompts, ["first prompt", "second prompt"])
		sinon.assert.notCalled(callbacks.ask)
	})

	it("uses one approval for the full batch and stops on denial", async () => {
		const { config, callbacks, taskState } = createConfig({ taskAskResponse: "noButtonClicked" })
		const runStub = sinon.stub(SubagentRunner.prototype, "run")
		const handler = new UseSubagentsToolHandler()

		const result = await handler.execute(config, {
			type: "tool_use",
			name: DietCodeDefaultTool.USE_SUBAGENTS,
			params: {
				prompt_1: "one",
				prompt_2: "two",
			},
			partial: false,
		})

		assert.ok(String(result).includes("The user denied this operation."))
		assert.ok(String(result).includes("Do not resubmit"))
		assert.equal(taskState.didRejectTool, true)
		sinon.assert.calledOnce(callbacks.ask)
		assert.equal(callbacks.ask.firstCall.args[0], "use_subagents")
		sinon.assert.notCalled(runStub)
	})

	it("uses read-file auto-approve level (safe only) for approval bypass", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: true, autoApproveAll: false })
		sinon.stub(SubagentRunner.prototype, "run").resolves({
			status: "completed",
			result: "done",
			stats: {
				toolCalls: 1,
				inputTokens: 2,
				outputTokens: 3,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.25,
				contextTokens: 5,
				contextWindow: 200000,
				contextUsagePercentage: 0.0025,
			},
		})

		const handler = new UseSubagentsToolHandler()
		await handler.execute(config, {
			type: "tool_use",
			name: DietCodeDefaultTool.USE_SUBAGENTS,
			params: {
				prompt_1: "one",
			},
			partial: false,
		})

		sinon.assert.notCalled(callbacks.ask)
		const subagentStatusCalls = callbacks.say.getCalls().filter((call) => call.args[0] === "subagent")
		assert.ok(subagentStatusCalls.length >= 1)
	})

	it("fans out prompts in parallel and emits aggregated status", async () => {
		const { config, callbacks } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		let activeRuns = 0
		let maxActiveRuns = 0

		sinon.stub(SubagentRunner.prototype, "run").callsFake(async (_prompt: string, onProgress) => {
			activeRuns++
			maxActiveRuns = Math.max(maxActiveRuns, activeRuns)
			onProgress({
				status: "running",
				stats: {
					toolCalls: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
					contextTokens: 0,
					contextWindow: 200000,
					contextUsagePercentage: 0,
				},
			})
			await delay(10)
			activeRuns--
			return {
				status: "completed",
				result: "done",
				stats: {
					toolCalls: 1,
					inputTokens: 2,
					outputTokens: 3,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.25,
					contextTokens: 5,
					contextWindow: 200000,
					contextUsagePercentage: 0.0025,
				},
			}
		})

		const handler = new UseSubagentsToolHandler()
		const result = await handler.execute(config, {
			type: "tool_use",
			name: DietCodeDefaultTool.USE_SUBAGENTS,
			params: {
				prompt_1: "one",
				prompt_2: "two",
				prompt_3: "three",
			},
			partial: false,
		})

		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("Total Agents: 3"))
		assert.ok(maxActiveRuns > 1)

		const subagentStatusCalls = callbacks.say.getCalls().filter((call) => call.args[0] === "subagent")
		assert.ok(subagentStatusCalls.length >= 2)
		const finalCall = subagentStatusCalls[subagentStatusCalls.length - 1]
		assert.equal(finalCall.args[4], false)

		const usageCalls = callbacks.say.getCalls().filter((call) => call.args[0] === "subagent_usage")
		assert.equal(usageCalls.length, 1)
		const usagePayload = JSON.parse(usageCalls[0].args[1]) as DietCodeSubagentUsageInfo
		assert.equal(usagePayload.source, "subagents")
		assert.equal(usagePayload.tokensIn, 6)
		assert.equal(usagePayload.tokensOut, 9)
		assert.equal(usagePayload.cacheWrites, 0)
		assert.equal(usagePayload.cacheReads, 0)
		assert.equal(usagePayload.cost, 0.75)
	})

	it("continues after per-subagent failures and reports both outcomes", async () => {
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true })

		sinon.stub(SubagentRunner.prototype, "run").callsFake(async (prompt: string) => {
			if (prompt.includes("fail")) {
				return {
					status: "failed",
					error: "boom",
					stats: {
						toolCalls: 1,
						inputTokens: 0,
						outputTokens: 0,
						cacheWriteTokens: 0,
						cacheReadTokens: 0,
						totalCost: 0,
						contextTokens: 0,
						contextWindow: 200000,
						contextUsagePercentage: 0,
					},
				}
			}
			return {
				status: "completed",
				result: "ok",
				stats: {
					toolCalls: 2,
					inputTokens: 0,
					outputTokens: 0,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
					contextTokens: 0,
					contextWindow: 200000,
					contextUsagePercentage: 0,
				},
			}
		})

		const handler = new UseSubagentsToolHandler()
		const result = await handler.execute(config, {
			type: "tool_use",
			name: DietCodeDefaultTool.USE_SUBAGENTS,
			params: {
				prompt_1: "succeed",
				prompt_2: "fail",
			},
			partial: false,
		})

		assert.equal(typeof result, "string")
		assert.ok((result as string).includes("Success: 1"))
		assert.ok((result as string).includes("Fail: 1"))
		assert.ok((result as string).includes("boom"))
	})

	it("runs configured subagent tools using the prompt parameter", async () => {
		const { config } = createConfig({ autoApproveSafe: true, autoApproveAll: true })
		const handler = new UseSubagentsToolHandler()
		const dynamicToolName = "use_subagent_code_reviewer"
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			resolveSubagentNameForTool: (toolName: string) => (toolName === dynamicToolName ? "code-reviewer" : undefined),
			getCachedConfig: () => undefined,
		} as unknown as AgentConfigLoader)

		const runStub = sinon.stub(SubagentRunner.prototype, "run").resolves({
			status: "completed",
			result: "dynamic done",
			stats: {
				toolCalls: 1,
				inputTokens: 2,
				outputTokens: 3,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.1,
				contextTokens: 100,
				contextWindow: 200000,
				contextUsagePercentage: 0.05,
			},
		})

		const result = await handler.execute(config, {
			type: "tool_use",
			name: dynamicToolName as DietCodeDefaultTool,
			params: { prompt: "review this PR" },
			partial: false,
		})

		assert.match(String(result), /dynamic done/)
		sinon.assert.calledOnce(runStub)
		assert.equal(runStub.firstCall.args[0], "review this PR")
	})

	it("requires prompt for configured subagent tools", async () => {
		const { config, callbacks, taskState } = createConfig()
		const handler = new UseSubagentsToolHandler()
		const dynamicToolName = "use_subagent_code_reviewer"
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			resolveSubagentNameForTool: (toolName: string) => (toolName === dynamicToolName ? "code-reviewer" : undefined),
			getCachedConfig: () => undefined,
		} as unknown as AgentConfigLoader)

		const result = await handler.execute(config, {
			type: "tool_use",
			name: dynamicToolName as DietCodeDefaultTool,
			params: {},
			partial: false,
		})

		assert.equal(result, "missing")
		assert.equal(taskState.consecutiveMistakeCount, 1)
		sinon.assert.calledWithExactly(callbacks.sayAndCreateMissingParamError, DietCodeDefaultTool.USE_SUBAGENTS, "prompt")
	})
})
