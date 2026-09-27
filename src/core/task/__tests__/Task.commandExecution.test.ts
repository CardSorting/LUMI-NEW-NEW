import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import * as joyride from "@/core/joyride"
import { Task } from "../index"
import { TaskState } from "../TaskState"

describe("task command execution context", () => {
	afterEach(() => sinon.restore())
	it("links observation cancellation to the parent without mutating the caller signal", async () => {
		const readCommandOutput = sinon.stub().resolves({ status: "background" })
		const task = Object.assign(Object.create(Task.prototype), {
			taskState: new TaskState(),
			commandExecutor: { readCommandOutput },
		}) as Task
		const caller = new AbortController()
		await task.readCommandOutput("run", 5, caller.signal)
		assert.equal(readCommandOutput.firstCall.args[0], "run")
		task.taskState.abort = true
		assert.equal(readCommandOutput.firstCall.args[2].aborted, true)
		assert.equal(caller.signal.aborted, false)
	})
	it("keeps an executed result when optional lease invalidation throws", async () => {
		sinon.stub(joyride, "getJoyRideCache").returns({ set: sinon.spy() } as never)
		const result = [false, "completed", { status: "completed", exitCode: 0 }]
		const execute = sinon.stub().resolves(result)
		const task = Object.assign(Object.create(Task.prototype), {
			cwd: "/workspace",
			taskId: "task",
			taskState: new TaskState(),
			commandExecutor: { execute },
			stateManager: { getGlobalSettingsKey: () => false },
			toolExecutor: {
				getGuard: () => {
					throw new Error("observer unavailable")
				},
			},
		}) as Task
		assert.equal(await task.executeCommandTool("npm test", 30), result)
		sinon.assert.calledOnce(execute)
	})
	it("keeps command result caches scoped to the execution directory and refreshes changed environments", async () => {
		const set = sinon.spy()
		sinon.stub(joyride, "getJoyRideCache").returns({ set } as never)
		const execute = sinon.stub().resolves([false, "Command executed successfully (exit code 0)."])
		const revokeLease = sinon.spy()
		const task = Object.assign(Object.create(Task.prototype), {
			cwd: "/primary",
			taskId: "terminal-test",
			taskState: new TaskState(),
			terminalExecutionMode: "vscodeTerminal",
			stateManager: { getGlobalSettingsKey: () => false },
			commandExecutor: { execute },
			toolExecutor: { getGuard: () => ({ engine: { revokeLease } }) },
		}) as Task
		const commandCancellation = new AbortController()
		await task.executeCommandTool("npm ci", 30, { cwd: "/first", signal: commandCancellation.signal })
		await task.executeCommandTool("npm ci", 30, { cwd: "/second" })
		assert.equal(set.firstCall.args[1].cwd, "/first")
		assert.equal(set.secondCall.args[1].cwd, "/second")
		assert.notEqual(set.firstCall.args[0], set.secondCall.args[0])
		assert.notEqual(set.firstCall.args[2].workspaceFingerprint, set.secondCall.args[2].workspaceFingerprint)
		sinon.assert.calledTwice(revokeLease)
		sinon.assert.calledTwice(execute)
		task.taskState.abort = true
		assert.equal(
			execute.firstCall.args[2].signal.aborted,
			true,
			"parent cancellation must reach commands with a caller signal",
		)
		assert.equal(commandCancellation.signal.aborted, false, "the parent does not mutate the caller's controller")
	})
})
