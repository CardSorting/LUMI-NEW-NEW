import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { Controller } from "../index"

describe("controller terminal ownership", () => {
	function fixture() {
		return Object.assign(Object.create(Controller.prototype), {
			task: { taskId: "current", cancelBackgroundCommand: sinon.stub().resolves(true) },
			backgroundCommandRunning: true,
			backgroundCommandTaskId: "current",
			postStateToWebview: sinon.stub().resolves(),
		})
	}
	it("ignores late status events from a previous task", () => {
		const controller = fixture()
		controller.updateBackgroundCommandState(false, "previous")
		controller.updateBackgroundCommandState(false, "current", { ...controller.task })
		assert.equal(controller.backgroundCommandRunning, true)
		assert.equal(controller.backgroundCommandTaskId, "current")
		sinon.assert.notCalled(controller.postStateToWebview)
		controller.updateBackgroundCommandState(false, "current", controller.task)
		assert.equal(controller.backgroundCommandRunning, false)
		sinon.assert.calledOnce(controller.postStateToWebview)
	})
	it("retains command status when cancellation is already requested but unconfirmed", async () => {
		const controller = fixture()
		await controller.cancelBackgroundCommand()
		await controller.cancelBackgroundCommand()
		assert.equal(controller.backgroundCommandRunning, true)
		sinon.assert.notCalled(controller.postStateToWebview)
	})
	it("does not clear a new task's status when an old cancellation reply arrives", async () => {
		const controller = fixture()
		let finish!: (value: boolean) => void
		controller.task.cancelBackgroundCommand.returns(
			new Promise((resolve) => {
				finish = resolve
			}),
		)
		const pending = controller.cancelBackgroundCommand()
		controller.task = { taskId: "new" }
		controller.backgroundCommandTaskId = "new"
		finish(false)
		await pending
		assert.equal(controller.backgroundCommandRunning, true)
		assert.equal(controller.backgroundCommandTaskId, "new")
		sinon.assert.notCalled(controller.postStateToWebview)
	})
})
