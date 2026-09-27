import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { Task } from "../index"
import { TaskState } from "../TaskState"

describe("pending task approvals", () => {
	afterEach(() => sinon.restore())
	function fixture() {
		const taskState = new TaskState()
		const messages: any[] = []
		const task = Object.assign(Object.create(Task.prototype), {
			taskState,
			messageStateHandler: {
				getDietCodeMessages: () => messages,
				addToDietCodeMessages: async (message: unknown) => {
					messages.push(message)
				},
			},
			postStateToWebview: sinon.stub().resolves(),
		})
		return { task, taskState }
	}
	it("releases a pending approval when stopped without needing another UI message", async () => {
		const clock = sinon.useFakeTimers()
		const { task, taskState } = fixture()
		const waiting = assert.rejects(task.ask("command", "npm test"), /aborted/)
		await clock.tickAsync(0)
		taskState.abort = true
		await clock.tickAsync(100)
		await waiting
	})
	it("keeps the resume control available after cancellation", async () => {
		const clock = sinon.useFakeTimers()
		const { task, taskState } = fixture()
		taskState.abort = true
		const waiting = task.ask("resume_task")
		await clock.tickAsync(0)
		taskState.askResponse = "yesButtonClicked"
		await clock.tickAsync(100)
		assert.equal((await waiting).response, "yesButtonClicked")
	})
})
