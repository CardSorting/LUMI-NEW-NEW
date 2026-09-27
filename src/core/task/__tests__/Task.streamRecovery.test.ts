import { strict as assert } from "node:assert"
import * as api from "@core/api"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { DietCodeError, ErrorService } from "@/services/error"
import { Session } from "@/shared/services/Session"
import { DietCodeDefaultTool } from "@/shared/tools"
import { Task } from "../index"
import { StreamResponseHandler } from "../StreamResponseHandler"
import { buildInterruptedAssistantContent } from "../streamRecovery"
import { TaskState } from "../TaskState"

function fixture() {
	const taskState = new TaskState()
	taskState.assistantMessageContent = [
		{ type: "tool_use", name: DietCodeDefaultTool.BASH, params: { command: "unfinished" }, partial: true },
	]
	taskState.userMessageContent = [{ type: "tool_result", tool_use_id: "write-once", content: "Saved src/app.ts successfully." }]
	const history: any[] = []
	const messages = [
		{ text: "{}", partial: false },
		{ text: "unfinished", partial: true },
	]
	const otherTaskResponse = sinon.stub().resolves()
	const task = Object.assign(Object.create(Task.prototype), {
		taskState,
		api: { abort: sinon.spy(), getModel: () => ({ id: "test", info: { supportsPromptCache: false } }) },
		diffViewProvider: { isEditing: true, revertChanges: sinon.stub().resolves(), reset: sinon.stub().resolves() },
		messageStateHandler: {
			addToApiConversationHistory: async (message: any) => {
				history.push(message)
			},
			getDietCodeMessages: () => messages,
			updateDietCodeMessage: async (index: number, update: any) => Object.assign(messages[index], update),
			saveDietCodeMessagesAndUpdateHistory: sinon.stub().resolves(),
		},
		say: sinon.stub().resolves(),
		ask: sinon.stub().resolves({ response: "noButtonClicked" }),
		runRequestLoop: sinon.stub().resolves(false),
		reinitExistingTaskFromId: sinon.stub().resolves(),
		controller: { task: { handleWebviewAskResponse: otherTaskResponse } },
		toolExecutor: { executeTool: sinon.stub().resolves() },
	})
	const params = {
		assistantText: "Saved the first file.",
		modelInfo: { providerId: "test", modelId: "test", mode: "act" },
		taskMetrics: { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0, totalCost: 0 },
		lastApiReqIndex: 0,
	}
	const error = Object.assign(new Error("connection reset"), { headers: { "retry-after": "0.001" } })
	return { task, taskState, history, messages, params, error, otherTaskResponse }
}

describe("Task stream recovery", () => {
	beforeEach(() => {
		sinon.stub(ErrorService, "get").returns({ toDietCodeError: DietCodeError.transform } as unknown as ErrorService)
	})
	afterEach(() => sinon.restore())
	it("keeps retry cancellation attached to the owning task when rebuilding its provider", () => {
		const { task, taskState } = fixture()
		const build = sinon.stub(api, "buildApiHandler").returns(task.api)
		task.updateApiHandler({ actModeApiProvider: "openrouter" }, "act")
		const signal = build.firstCall.args[0].getRetrySignal!()
		assert.equal(signal, taskState.abortSignal)
		assert.equal(typeof build.firstCall.args[0].onRetryAttempt, "function")
		taskState.abort = true
		assert.equal(signal.aborted, true)
	})

	it("continues the same task from persisted results without executing partial tools or clicking another task's approval", async () => {
		const { task, taskState, history, messages, params, error, otherTaskResponse } = fixture()
		const next = await task.recoverFromStreamFailure(error, params)
		assert.match(JSON.stringify(history), /Saved src\/app.ts successfully/)
		assert.equal(
			history[0].content.some((block: any) => block.type === "tool_result" || block.type === "tool_use"),
			false,
		)
		assert.match(next.userContent[0].text, /Do not repeat completed actions/)
		sinon.assert.notCalled(task.runRequestLoop)
		assert.equal(taskState.autoRetryAttempts, 1)
		assert.equal(taskState.assistantMessageContent.length, 0)
		assert.equal(messages[1].partial, false)
		sinon.assert.calledOnce(task.diffViewProvider.revertChanges)
		sinon.assert.notCalled(task.toolExecutor.executeTool)
		sinon.assert.notCalled(task.reinitExistingTaskFromId)
		sinon.assert.notCalled(otherTaskResponse)
		sinon.assert.notCalled(task.ask)
	})

	it("preserves completed work when cancelled during recovery and never sends a new request", async () => {
		const { task, taskState, history, params, error } = fixture()
		task.say.callsFake(async () => {
			taskState.abort = true
		})
		await assert.rejects(task.recoverFromStreamFailure(error, params), { name: "AbortError" })
		assert.match(JSON.stringify(history), /Saved src\/app.ts successfully/)
		sinon.assert.notCalled(task.runRequestLoop)
		sinon.assert.notCalled(task.ask)
	})

	it("offers one explicit recovery after the retry budget is exhausted", async () => {
		const { task, taskState, history, params, error } = fixture()
		taskState.autoRetryAttempts = 3
		assert.equal(await task.recoverFromStreamFailure(error, params), true)
		sinon.assert.calledOnce(task.ask)
		sinon.assert.notCalled(task.runRequestLoop)
		assert.match(JSON.stringify(history), /Saved src\/app.ts successfully/)
	})

	it("does not auto-retry authentication failures", async () => {
		const { task, params } = fixture()
		await task.recoverFromStreamFailure(Object.assign(new Error("unauthorized"), { status: 401 }), params)
		sinon.assert.calledOnce(task.ask)
		sinon.assert.notCalled(task.runRequestLoop)
	})

	it("retains image evidence without orphaned native tool results", () => {
		const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "test" } } as const
		const result = buildInterruptedAssistantContent("", [
			{ type: "tool_result", tool_use_id: "screenshot", content: [{ type: "text", text: "Screen captured" }, image] },
		])
		assert.ok(result.includes(image))
		assert.match(JSON.stringify(result), /Screen captured/)
		assert.equal(
			result.some((block) => block.type === "tool_use"),
			false,
		)
	})

	it("treats checkpoint failure as unavailable recovery support, allowing the task to continue", async () => {
		const task = Object.assign(Object.create(Task.prototype), {
			taskState: new TaskState(),
			checkpointManager: { saveCheckpoint: sinon.stub().rejects(new Error("disk unavailable")) },
		})
		await task.saveCheckpointCallback()
		assert.equal(task.taskState.checkpointManagerErrorMessage, "disk unavailable")
	})
})

describe("stream tool argument integrity", () => {
	afterEach(() => sinon.restore())
	it("retains provider IDs without transport IDs even when session observation fails", () => {
		sinon.stub(Session, "get").throws(new Error("session unavailable"))
		const { toolUseHandler } = new StreamResponseHandler().getHandlers()
		toolUseHandler.processToolUseDelta({
			type: "tool_use",
			id: "provider-id",
			name: DietCodeDefaultTool.BASH,
			input: '{"command":"echo ok"}',
		})
		toolUseHandler.assertCompleteToolUses()
		assert.equal(toolUseHandler.getPartialToolUsesAsContent()[0].tool_use_id, "provider-id")
		assert.equal(toolUseHandler.getAllFinalizedToolUses()[0].id, "provider-id")
	})
	for (const input of ['{"command":"echo partial', '{"command":"echo ok"} trailing', "null", "[]", '"command"']) {
		it(`rejects incomplete or invalid arguments: ${input}`, () => {
			const { toolUseHandler } = new StreamResponseHandler().getHandlers()
			toolUseHandler.processToolUseDelta({ type: "tool_use", id: "one", name: DietCodeDefaultTool.BASH, input })
			assert.throws(() => toolUseHandler.assertCompleteToolUses(), /arguments/)
		})
	}
	it("accepts a complete object assembled across stream chunks", () => {
		const { toolUseHandler } = new StreamResponseHandler().getHandlers()
		toolUseHandler.processToolUseDelta({ type: "tool_use", id: "one", name: DietCodeDefaultTool.BASH, input: '{"command":' })
		toolUseHandler.processToolUseDelta({ type: "tool_use", id: "one", input: '"echo ok"}' })
		assert.doesNotThrow(() => toolUseHandler.assertCompleteToolUses())
		assert.deepEqual(toolUseHandler.getAllFinalizedToolUses()[0].input, { command: "echo ok" })
	})
})
