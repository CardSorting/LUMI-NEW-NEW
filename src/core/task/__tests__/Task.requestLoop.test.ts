import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { Task } from "../index"
import { TaskState } from "../TaskState"

function fixture() {
	return Object.assign(Object.create(Task.prototype), {
		taskState: new TaskState(),
		stateManager: { getGlobalSettingsKey: () => 3 },
		consumeIdleGapFeedbackIfPending: sinon.stub().resolves(null),
		messageStateHandler: { addToApiConversationHistory: sinon.stub().resolves() },
		toolExecutor: { resetSystemPressure: sinon.stub() },
		say: sinon.stub().resolves(),
		ask: sinon.stub().rejects(new Error("Unexpected permission prompt")),
	})
}

describe("parent request loop", () => {
	afterEach(() => sinon.restore())
	it("finishes each productive turn before dispatching the next, preserving native results across a long task", async () => {
		const task = fixture()
		let active = 0
		let completed = 0
		task.taskState.deniedToolApprovals.set("denied command", 1)
		task.taskState.autoRetryAttempts = 2
		task.makeDietCodeRequest = async (content: any[], includeFileDetails: boolean) => {
			assert.equal(active++, 0, "The preceding request must have released its scope")
			assert.equal(includeFileDetails, completed === 0)
			assert.equal(task.taskState.currentTurnReadHistory.size, 0)
			assert.equal(task.taskState.currentTurnTotalReadCount, 0)
			assert.equal(task.taskState.currentTurnUniqueReadCount, 0)
			assert.equal(task.taskState.currentTurnExplorationCount, 0)
			if (completed > 0) assert.equal(content[0].tool_use_id, `call-${completed}`)
			try {
				if (completed === 2_000) return true
				task.taskState.currentTurnReadHistory.set("src/app.ts", 1)
				task.taskState.currentTurnTotalReadCount = 10
				task.taskState.currentTurnUniqueReadCount = 10
				task.taskState.currentTurnExplorationCount = 10
				task.taskState.executionProgress.record("read_file", { path: `${completed}.ts` }, `contents ${completed}`)
				task.taskState.userMessageContent = [
					{ type: "tool_result", tool_use_id: `call-${completed + 1}`, content: "Saved work" },
				]
				return await task.continueAfterToolResponse()
			} finally {
				active--
				completed++
			}
		}
		assert.equal(await task.runRequestLoop([{ type: "text", text: "Complete the task" }], true), true)
		assert.equal(completed, 2_001)
		assert.equal(task.taskState.autoRetryAttempts, 2, "Scheduling does not renew provider retries")
		assert.equal(task.taskState.deniedToolApprovals.size, 1)
		sinon.assert.notCalled(task.ask)
		sinon.assert.notCalled(task.say)
	})
	it("keeps the no-progress stopping window across request boundaries", async () => {
		const task = fixture()
		task.makeDietCodeRequest = sinon.stub().callsFake(() => task.continueAfterToolResponse())
		assert.equal(await task.runRequestLoop([]), true)
		assert.equal(task.makeDietCodeRequest.callCount, 8)
		sinon.assert.calledOnce(task.toolExecutor.resetSystemPressure)
		sinon.assert.calledOnce(task.say)
		sinon.assert.notCalled(task.ask)
	})
	it("restages steering with pending results and retains initial context options", async () => {
		const task = fixture()
		const result = { type: "tool_result", tool_use_id: "saved", content: "Saved src/app.ts" }
		const feedback = { type: "text", text: "Keep the edit and verify it" }
		task.consumeIdleGapFeedbackIfPending.onFirstCall().resolves([feedback])
		task.makeDietCodeRequest = sinon.stub()
		task.makeDietCodeRequest
			.onFirstCall()
			.callsFake((...args: any[]) => (Task.prototype as any).makeDietCodeRequest.apply(task, args))
		task.makeDietCodeRequest.onSecondCall().resolves(true)
		assert.equal(await task.runRequestLoop([result], true), true)
		assert.deepEqual(task.makeDietCodeRequest.secondCall.args, [[result, feedback], true])
		sinon.assert.notCalled(task.ask)
	})
	for (const [stage, label] of [
		"request start",
		"before context",
		"after context",
		"before staging",
		"before stream",
	].entries()) {
		it(`preserves tool results when steering arrives ${label}, without leaving an unsent user turn`, async () => {
			const task = fixture()
			const messages: any[] = [{ type: "say", say: "api_req_started", ts: 1, text: "{}" }]
			let history: any[] = [
				{ role: "assistant", content: [{ type: "tool_use", id: "saved", name: "write_to_file", input: {} }] },
			]
			const result = { type: "tool_result", tool_use_id: "saved", content: "Saved src/app.ts" }
			const feedback = { type: "text", text: "Keep the edit and verify it" }
			task.consumeIdleGapFeedbackIfPending.onCall(stage).resolves([feedback])
			task.stateManager.getGlobalSettingsKey = () => false
			task.getCurrentProviderInfo = () => ({ providerId: "test", model: { id: "test" }, mode: "act" })
			task.modelContextTracker = { recordModelUsage: sinon.stub().resolves() }
			task.loadContext = async (content: any[]) => [content, "", false]
			task.diffViewProvider = { reset: sinon.stub().resolves() }
			task.streamHandler = { reset: sinon.stub() }
			task.postStateToWebview = sinon.stub().resolves()
			task.messageStateHandler = {
				getDietCodeMessages: () => messages,
				updateDietCodeMessage: async (index: number, update: any) => Object.assign(messages[index], update),
				deleteDietCodeMessage: async (index: number) => messages.splice(index, 1),
				getApiConversationHistory: () => history,
				addToApiConversationHistory: async (message: any) => history.push(message),
				overwriteApiConversationHistory: async (replacement: any[]) => {
					history = replacement
				},
			}
			task.say.callsFake(async (say: string, text: string) => messages.push({ type: "say", say, text, ts: 2 }))
			task.attemptApiRequest = sinon.stub().throws(new Error("Steering must be incorporated before dispatch"))
			const outcome = await task.makeDietCodeRequest([result], true)
			assert.deepEqual(outcome.userContent, [result, feedback])
			assert.equal(outcome.includeFileDetails ?? false, stage <= 1)
			assert.equal(history.length, 1)
			assert.equal(history[0].role, "assistant")
			assert.equal(messages.length, 1)
			sinon.assert.notCalled(task.attemptApiRequest)
			sinon.assert.notCalled(task.ask)
		})
	}
	for (const stopped of ["abort", "abandoned"]) {
		it(`never dispatches the next turn after ${stopped}`, async () => {
			const task = fixture()
			task.makeDietCodeRequest = sinon.stub().callsFake(async () => {
				task.taskState[stopped] = true
				return { userContent: [{ type: "text", text: "must not execute" }] }
			})
			assert.equal(await task.runRequestLoop([]), true)
			sinon.assert.calledOnce(task.makeDietCodeRequest)
			sinon.assert.notCalled(task.say)
		})
	}
	it("reports a later request preparation failure once without restarting completed turns", async () => {
		const task = fixture()
		task.makeDietCodeRequest = sinon.stub()
		task.makeDietCodeRequest.onFirstCall().resolves({ userContent: [{ type: "text", text: "already saved" }] })
		task.makeDietCodeRequest.onSecondCall().rejects(new Error("context storage unavailable"))
		task.say.rejects(new Error("display unavailable"))
		assert.equal(await task.runRequestLoop([]), true)
		assert.equal(task.makeDietCodeRequest.callCount, 2)
		sinon.assert.calledOnce(task.say)
		assert.match(task.say.firstCall.args[1], /context storage unavailable/)
		sinon.assert.notCalled(task.ask)
	})
	it("returns an empty-response outcome to its owner without inventing another request", async () => {
		const task = fixture()
		task.makeDietCodeRequest = sinon.stub().resolves(false)
		assert.equal(await task.runRequestLoop([]), false)
		sinon.assert.calledOnce(task.makeDietCodeRequest)
		sinon.assert.notCalled(task.ask)
	})
})
