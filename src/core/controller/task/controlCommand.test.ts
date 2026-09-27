import { strict as assert } from "node:assert"
import { CommandControlRequest } from "@shared/proto/dietcode/task"
import { describe, it } from "mocha"
import sinon from "sinon"
import type { IController } from "../types"
import { controlCommand } from "./controlCommand"

describe("command control ownership", () => {
	it("dispatches only explicit controls for the current task", async () => {
		const control = sinon.spy()
		const controller = { task: { taskId: "current", controlCommand: control } } as unknown as IController
		for (const action of ["show", "stop"]) {
			await controlCommand(controller, CommandControlRequest.create({ taskId: "current", executionId: "run", action }))
		}
		sinon.assert.calledWithExactly(control, "run", "show")
		sinon.assert.calledWithExactly(control, "run", "stop")
	})
	it("rejects wrong tasks, missing IDs, and unrecognized actions before any side effect", async () => {
		const control = sinon.spy()
		const controller = { task: { taskId: "current", controlCommand: control } } as unknown as IController
		for (const request of [
			{ taskId: "old", executionId: "run", action: "stop" },
			{ taskId: "current", action: "stop" },
			{ taskId: "current", executionId: "run", action: "restart" },
		])
			await assert.rejects(controlCommand(controller, CommandControlRequest.create(request)))
		sinon.assert.notCalled(control)
	})
})
