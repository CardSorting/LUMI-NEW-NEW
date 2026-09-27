import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { Task } from "../index"
import { TaskState } from "../TaskState"

describe("parent execution continuation", () => {
	afterEach(() => sinon.restore())
	function fixture() {
		return Object.assign(Object.create(Task.prototype), {
			taskState: new TaskState(),
			stateManager: { getGlobalSettingsKey: () => 3 },
			checkpointManager: { saveCheckpoint: sinon.stub().resolves() },
			consumeIdleGapFeedbackIfPending: sinon.stub().resolves(null),
			messageStateHandler: { addToApiConversationHistory: sinon.stub().resolves() },
			toolExecutor: { resetSystemPressure: sinon.stub() },
			runRequestLoop: sinon.stub().resolves(false),
			say: sinon.stub().resolves(),
			ask: sinon.stub().rejects(new Error("Continuation must not introduce a permission gate")),
		})
	}
	it("continues productive work beyond turn limits despite unavailable checkpoints", async () => {
		const task = fixture()
		task.checkpointManager.saveCheckpoint.rejects(new Error("snapshot unavailable"))
		for (let i = 0; i < 100; i++) {
			task.taskState.executionProgress.record("read_file", { path: `${i}.ts` }, `contents ${i}`)
			assert.deepEqual(await task.continueAfterToolResponse(), { userContent: task.taskState.userMessageContent })
		}
		sinon.assert.notCalled(task.runRequestLoop)
		assert.equal(task.taskState.checkpointManagerErrorMessage, "snapshot unavailable")
		sinon.assert.notCalled(task.ask)
		sinon.assert.notCalled(task.say)
	})
	it("redirects once, preserves the last native results, and ends an unchanged loop without approval retries", async () => {
		const task = fixture()
		for (let i = 1; i <= 8; i++) {
			task.taskState.userMessageContent = [{ type: "tool_result", tool_use_id: `call-${i}`, content: "already checked" }]
			// Tool handlers resetting their local mistake counter cannot reopen the recovery window.
			task.taskState.consecutiveMistakeCount = 0
			assert.deepEqual(
				await task.continueAfterToolResponse(),
				i === 8 ? true : { userContent: task.taskState.userMessageContent },
			)
			if (i === 3) assert.match(JSON.stringify(task.taskState.userMessageContent), /different concrete step/)
		}
		sinon.assert.notCalled(task.runRequestLoop)
		sinon.assert.calledOnce(task.toolExecutor.resetSystemPressure)
		sinon.assert.calledOnce(task.messageStateHandler.addToApiConversationHistory)
		assert.equal(task.messageStateHandler.addToApiConversationHistory.firstCall.args[0].content[0].tool_use_id, "call-8")
		sinon.assert.calledOnce(task.say)
		assert.match(task.say.firstCall.args[1], /no-progress loop/)
		sinon.assert.notCalled(task.ask)
	})
	it("prioritizes queued user steering over a depleted recovery window", async () => {
		const task = fixture()
		for (let i = 0; i < 8; i++) task.taskState.executionProgress.finishTurn()
		const result = { type: "tool_result", tool_use_id: "already-written", content: "Saved src/a.ts" }
		task.taskState.userMessageContent = [result]
		const feedback = [{ type: "text", text: "Use the available local data" }]
		task.consumeIdleGapFeedbackIfPending.resolves(feedback)
		assert.deepEqual(await task.continueAfterToolResponse(), { userContent: [result, ...feedback] })
		sinon.assert.notCalled(task.runRequestLoop)
		sinon.assert.notCalled(task.say)
	})
	it("keeps pending results paired when steering arrives before preparing the next request", async () => {
		const task = fixture()
		const feedback = [{ type: "text", text: "Keep the change and verify the affected path" }]
		task.consumeIdleGapFeedbackIfPending.resolves(feedback)
		const result = { type: "tool_result" as const, tool_use_id: "saved", content: "Saved src/a.ts" }
		assert.deepEqual(await task.makeDietCodeRequest([result]), {
			userContent: [result, ...feedback],
			includeFileDetails: false,
		})
		sinon.assert.notCalled(task.runRequestLoop)
	})
	it("renews progress on an explicit user response without resetting configured authority", async () => {
		const task = fixture()
		for (let i = 0; i < 8; i++) task.taskState.executionProgress.finishTurn()
		task.hasUnansweredAsk = () => true
		task.messageStateHandler.getDietCodeMessages = () => [{ type: "ask", ask: "tool" }]
		task.taskState.deniedToolApprovals.set("prior denial", 1)
		await task.handleWebviewAskResponse("yesButtonClicked")
		assert.equal(task.taskState.askResponse, "yesButtonClicked")
		assert.equal(task.taskState.executionProgress.finishTurn(), "continue")
		assert.equal(task.taskState.deniedToolApprovals.size, 1)
	})
	it("never dispatches a continuation after Stop during a checkpoint", async () => {
		const task = fixture()
		task.checkpointManager.saveCheckpoint.callsFake(async () => {
			task.taskState.abort = true
		})
		await assert.rejects(task.continueAfterToolResponse(), { name: "AbortError" })
		sinon.assert.notCalled(task.runRequestLoop)
		sinon.assert.notCalled(task.ask)
	})
})

describe("MCP startup scheduling", () => {
	afterEach(() => sinon.restore())
	it("waits once per task for a disconnected server, then continues unrelated requests immediately", async () => {
		const clock = sinon.useFakeTimers()
		const task = Object.assign(Object.create(Task.prototype), { taskState: new TaskState(), mcpHub: { isConnecting: true } })
		const initialWait = task.waitForMcpStartup()
		await clock.tickAsync(10_000)
		await initialWait
		await task.waitForMcpStartup()
		assert.equal(clock.countTimers(), 0)
	})
	it("Stop releases the startup wait promptly and does not leave a polling timer", async () => {
		const clock = sinon.useFakeTimers()
		const task = Object.assign(Object.create(Task.prototype), { taskState: new TaskState(), mcpHub: { isConnecting: true } })
		const stopped = assert.rejects(task.waitForMcpStartup(), { name: "AbortError" })
		task.taskState.abort = true
		await clock.tickAsync(100)
		await stopped
		assert.equal(clock.countTimers(), 0)
	})
})
