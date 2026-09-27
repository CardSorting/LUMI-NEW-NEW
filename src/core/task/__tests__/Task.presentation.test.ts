import { strict as assert } from "node:assert"
import { DietCodeDefaultTool } from "@shared/tools"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { Session } from "@/shared/services/Session"
import { Task } from "../index"
import { TaskState } from "../TaskState"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function fixture(name: DietCodeDefaultTool, partial = false) {
	const state = new TaskState()
	state.assistantMessageContent = [{ type: "tool_use", name, params: {}, partial }]
	const executeTool = sinon.stub().resolves()
	// Exercise the real presentation state machine without starting a provider or workspace services.
	const task = Object.assign(Object.create(Task.prototype), {
		taskState: state,
		toolExecutor: { executeTool },
		isParallelToolCallingEnabled: () => true,
		environmentLeasePromise: Promise.resolve(),
		messageStateHandler: { getDietCodeMessages: () => [] },
	}) as {
		presentAssistantMessage: () => Promise<void>
		finishAssistantMessage: (text: string, blocks: any[]) => Promise<void>
		initialCheckpointCommitPromise?: Promise<unknown>
		environmentLeasePromise: Promise<unknown>
	}
	return { task, state, executeTool }
}

describe("Task tool presentation", () => {
	afterEach(() => sinon.restore())
	it("executes reads while the initial checkpoint is pending", async () => {
		const { task, state, executeTool } = fixture(DietCodeDefaultTool.FILE_READ)
		task.initialCheckpointCommitPromise = deferred().promise
		task.environmentLeasePromise = deferred().promise
		await task.presentAssistantMessage()
		sinon.assert.calledOnce(executeTool)
		assert.equal(state.currentStreamingContentIndex, 1)
	})

	it("executes a mutation exactly once after startup prerequisites settle", async () => {
		const { task, state, executeTool } = fixture(DietCodeDefaultTool.FILE_EDIT)
		const checkpoint = deferred()
		task.initialCheckpointCommitPromise = checkpoint.promise
		const pending = task.presentAssistantMessage()
		sinon.assert.notCalled(executeTool)
		const repeated = task.presentAssistantMessage()
		checkpoint.resolve()
		await Promise.all([pending, repeated])
		sinon.assert.calledOnce(executeTool)
		assert.equal(state.presentAssistantMessageLocked, false)
	})

	it("renders a partial tool preview without waiting for a checkpoint", async () => {
		const { task, executeTool } = fixture(DietCodeDefaultTool.FILE_EDIT, true)
		task.initialCheckpointCommitPromise = deferred().promise
		await task.presentAssistantMessage()
		sinon.assert.calledOnce(executeTool)
	})

	it("releases the streaming lock after a tool failure without advancing", async () => {
		const { task, state, executeTool } = fixture(DietCodeDefaultTool.FILE_READ)
		executeTool.rejects(new Error("tool failed"))
		await assert.rejects(task.presentAssistantMessage(), /tool failed/)
		assert.equal(state.presentAssistantMessageLocked, false)
		assert.equal(state.currentStreamingContentIndex, 0)
		executeTool.resolves()
		await task.presentAssistantMessage()
		assert.equal(state.currentStreamingContentIndex, 1)
	})

	it("does not execute a mutation cancelled while waiting for the checkpoint", async () => {
		const { task, state, executeTool } = fixture(DietCodeDefaultTool.FILE_EDIT)
		const checkpoint = deferred()
		task.initialCheckpointCommitPromise = checkpoint.promise
		const pending = task.presentAssistantMessage()
		await Promise.resolve()
		state.abort = true
		await assert.rejects(pending, /aborted/)
		sinon.assert.notCalled(executeTool)
		assert.equal(state.presentAssistantMessageLocked, false)
	})
	it("releases a cancelled environment wait before its probe finishes", async () => {
		const { task, state, executeTool } = fixture(DietCodeDefaultTool.FILE_EDIT)
		task.environmentLeasePromise = deferred().promise
		const pending = task.presentAssistantMessage()
		await Promise.resolve()
		state.abort = true
		await assert.rejects(pending, /aborted/)
		sinon.assert.notCalled(executeTool)
	})
	it("advances after a completed tool even when session bookkeeping fails", async () => {
		const { task, state, executeTool } = fixture(DietCodeDefaultTool.FILE_EDIT)
		state.assistantMessageContent[0] = { ...state.assistantMessageContent[0], call_id: "one" } as any
		sinon.stub(Session, "get").throws(new Error("statistics unavailable"))
		await task.presentAssistantMessage()
		await task.presentAssistantMessage()
		sinon.assert.calledOnce(executeTool)
		assert.equal(state.currentStreamingContentIndex, 1)
	})
	it("executes native calls found at stream end even without earlier partial blocks", async () => {
		const { task, state, executeTool } = fixture(DietCodeDefaultTool.FILE_READ)
		state.assistantMessageContent = []
		await task.finishAssistantMessage("", [
			{ type: "tool_use", name: DietCodeDefaultTool.FILE_READ, params: {}, partial: true, call_id: "one" },
		])
		sinon.assert.calledOnce(executeTool)
		assert.equal(executeTool.firstCall.args[0].partial, false)
		assert.equal(state.userMessageContentReady, true)
	})
	it("finishes an already consumed response without replay or a polling wait", async () => {
		const { task, state, executeTool } = fixture(DietCodeDefaultTool.FILE_READ)
		await task.presentAssistantMessage()
		state.userMessageContentReady = false
		await task.finishAssistantMessage("", [])
		sinon.assert.calledOnce(executeTool)
		assert.equal(state.userMessageContentReady, true)
	})
	it("shares a presentation failure with every waiter and releases ownership for later work", async () => {
		const { task, executeTool } = fixture(DietCodeDefaultTool.FILE_READ)
		executeTool.rejects(new Error("unavailable"))
		const results = await Promise.allSettled([task.presentAssistantMessage(), task.presentAssistantMessage()])
		assert.deepEqual(
			results.map((result) => result.status),
			["rejected", "rejected"],
		)
		sinon.assert.calledOnce(executeTool)
		executeTool.resolves()
		await task.presentAssistantMessage()
		assert.equal(executeTool.callCount, 2)
	})
})
