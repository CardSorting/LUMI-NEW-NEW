import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { Controller } from "../index"

describe("agent mode transition", () => {
	it("keeps the current mode when the target provider cannot be constructed", async () => {
		const setGlobalState = sinon.spy()
		const controller = Object.assign(Object.create(Controller.prototype), {
			stateManager: { getApiConfiguration: () => ({}), setGlobalState },
			task: { ulid: "task", updateApiHandler: sinon.stub().throws(new Error("provider unavailable")) },
			postStateToWebview: sinon.stub().resolves(),
		})
		await assert.rejects(controller.toggleActModeForYoloMode(), /provider unavailable/)
		sinon.assert.notCalled(setGlobalState)
		sinon.assert.notCalled(controller.postStateToWebview)
	})

	it("prepares the provider before changing mode and publishes the new state once", async () => {
		const updateApiHandler = sinon.spy()
		const setGlobalState = sinon.spy()
		const controller = Object.assign(Object.create(Controller.prototype), {
			stateManager: { getApiConfiguration: () => ({ actModeApiProvider: "openrouter" }), setGlobalState },
			task: { ulid: "task", updateApiHandler },
			postStateToWebview: sinon.stub().resolves(),
		})
		assert.equal(await controller.toggleActModeForYoloMode(), true)
		sinon.assert.callOrder(updateApiHandler, setGlobalState, controller.postStateToWebview)
		sinon.assert.calledOnceWithExactly(setGlobalState, "mode", "act")
	})
})
