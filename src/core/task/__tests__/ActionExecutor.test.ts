import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { ActionExecutor } from "../ActionExecutor"
import { TaskState } from "../TaskState"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("ActionExecutor", () => {
	afterEach(() => sinon.restore())

	it("does not replay a mutating action on transient errors", async () => {
		const executor = new ActionExecutor()
		const operation = sinon.stub().rejects(new Error("UNAVAILABLE"))
		await assert.rejects(executor.execute("task", operation, { maxRetries: 5 }), /UNAVAILABLE/)
		sinon.assert.calledOnce(operation)
	})

	it("retries explicitly idempotent work with bounded backoff", async () => {
		const clock = sinon.useFakeTimers()
		const operation = sinon.stub().onFirstCall().rejects(new Error("SQLITE_BUSY"))
		operation.onSecondCall().resolves("saved")
		const result = new ActionExecutor().execute("task", operation, { idempotent: true, backoffMs: 20 })
		await clock.tickAsync(19)
		sinon.assert.calledOnce(operation)
		await clock.tickAsync(1)
		assert.equal(await result, "saved")
		assert.equal(clock.countTimers(), 0)
	})

	it("does not retry timeout or cancellation errors even for idempotent work", async () => {
		for (const message of ["TIMEOUT", "ABORTED", "deadline exceeded"]) {
			const operation = sinon.stub().rejects(new Error(message))
			await assert.rejects(new ActionExecutor().execute("task", operation, { idempotent: true }))
			sinon.assert.calledOnce(operation)
		}
	})

	it("lets tools own their default timeout, including commands longer than a minute", async () => {
		const clock = sinon.useFakeTimers()
		const work = deferred()
		let settled = false
		const result = new ActionExecutor()
			.execute("task", () => work.promise)
			.finally(() => {
				settled = true
			})
		await clock.tickAsync(120_000)
		assert.equal(settled, false)
		assert.equal(clock.countTimers(), 0)
		work.resolve()
		await result
	})

	it("keeps timed-out work in its slot until the operation actually settles", async () => {
		const clock = sinon.useFakeTimers()
		const executor = new ActionExecutor()
		const work = Array.from({ length: 5 }, deferred)
		const operations = work.map((item) => sinon.stub().returns(item.promise))
		const results = operations.map((operation) =>
			assert.rejects(
				executor.execute("task", operation, {
					timeoutMs: 10,
					idempotent: true,
				}),
				/may still be running/,
			),
		)
		const next = sinon.stub().resolves()
		const queued = executor.execute("task", next)
		await clock.tickAsync(10)
		await Promise.all(results)
		operations.forEach((operation) => sinon.assert.calledOnce(operation))
		sinon.assert.notCalled(next)
		work[0].resolve()
		await queued
		sinon.assert.calledOnce(next)
		work.forEach((item) => item.resolve())
		await clock.tickAsync(0)
		assert.equal(clock.countTimers(), 0)
	})

	it("hands slots to queued work in FIFO order without exceeding capacity", async () => {
		const executor = new ActionExecutor()
		const work = Array.from({ length: 14 }, deferred)
		const started: number[] = []
		let active = 0
		let peak = 0
		const pending = work.map((item, index) =>
			executor.execute("task", async () => {
				started.push(index)
				peak = Math.max(peak, ++active)
				await item.promise
				active--
			}),
		)
		await flush()
		assert.deepEqual(started, [0, 1, 2, 3, 4])
		for (const item of work) {
			item.resolve()
			await flush()
		}
		await Promise.all(pending)
		assert.equal(peak, 5)
		assert.deepEqual(
			started,
			work.map((_, index) => index),
		)
	})

	it("removes cancelled queued actions and keeps unrelated tasks moving", async () => {
		const executor = new ActionExecutor()
		const work = deferred()
		const running = Array.from({ length: 5 }, () => executor.execute("task", () => work.promise))
		const state = new TaskState()
		const operation = sinon.stub().resolves()
		const cancelled = assert.rejects(executor.execute("task", operation, { signal: state.abortSignal }), /abort/i)
		state.abort = true
		await cancelled
		assert.equal(await executor.execute("other task", async () => "ready"), "ready")
		work.resolve()
		await Promise.all(running)
		sinon.assert.notCalled(operation)
		assert.equal(await executor.execute("task", async () => "ready"), "ready")
	})

	it("propagates running cancellation and clears its deadline", async () => {
		const clock = sinon.useFakeTimers()
		const state = new TaskState()
		const work = deferred()
		let signal: AbortSignal | undefined
		const result = assert.rejects(
			new ActionExecutor().execute(
				"task",
				(current) => {
					signal = current
					return work.promise
				},
				{ timeoutMs: 500, signal: state.abortSignal },
			),
			/abort/i,
		)
		await clock.tickAsync(0)
		state.abort = true
		await result
		assert.equal(signal?.aborted, true)
		assert.equal(clock.countTimers(), 0)
		work.resolve()
	})

	it("cleans up successful deadlines and cancelled retry delays", async () => {
		const clock = sinon.useFakeTimers()
		const executor = new ActionExecutor()
		await executor.execute("task", async () => "done", { timeoutMs: 50 })
		assert.equal(clock.countTimers(), 0)
		const state = new TaskState()
		const operation = sinon.stub().rejects(new Error("RATE_LIMIT"))
		const result = assert.rejects(
			executor.execute("task", operation, { idempotent: true, signal: state.abortSignal }),
			/abort/i,
		)
		await clock.tickAsync(0)
		state.abort = true
		await result
		sinon.assert.calledOnce(operation)
		assert.equal(clock.countTimers(), 0)
	})

	it("lets an in-flight atomic save settle before its caller cleans up", async () => {
		const state = new TaskState()
		const work = deferred()
		let settled = false
		const result = new ActionExecutor()
			.execute("task", () => work.promise, {
				signal: state.abortSignal,
				settleOnAbort: true,
			})
			.finally(() => {
				settled = true
			})
		await flush()
		state.abort = true
		await flush()
		assert.equal(settled, false)
		work.resolve()
		await result
		assert.equal(settled, true)
	})

	it("does not apply one task's accumulated failures to another action", async () => {
		const executor = new ActionExecutor()
		for (let i = 0; i < 25; i++)
			await assert.rejects(
				executor.execute("broken", async () => {
					throw new Error("failed")
				}),
			)
		assert.equal(await executor.execute("healthy", async () => "done"), "done")
		assert.equal(await executor.execute("broken", async () => "recovered"), "recovered")
	})

	it("never starts an action after cancellation, and can resume with a fresh signal", async () => {
		const state = new TaskState()
		const operation = sinon.stub().resolves()
		const executor = new ActionExecutor()
		state.abort = true
		await assert.rejects(executor.execute("task", operation, { signal: state.abortSignal }), /abort/i)
		sinon.assert.notCalled(operation)
		state.abort = false
		await executor.execute("task", operation, { signal: state.abortSignal })
		sinon.assert.calledOnce(operation)
	})
})
