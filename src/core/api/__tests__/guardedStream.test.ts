import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { ApiStreamTimeoutError, guardedStream } from "../guardedStream"
import { RetriableError, withRetry } from "../retry"

describe("provider stream lifecycle", () => {
	afterEach(() => sinon.restore())

	function fixture() {
		const controller = new AbortController()
		const iterator = {
			next: sinon.stub().returns(new Promise<IteratorResult<string>>(() => {})),
			return: sinon.stub().returns(new Promise<IteratorResult<string>>(() => {})),
		}
		const create = sinon.stub().returns({ [Symbol.asyncIterator]: () => iterator })
		const abort = sinon.spy()
		return {
			controller,
			iterator,
			create,
			abort,
			stream: guardedStream(create, {
				signal: controller.signal,
				abort,
				firstChunkTimeoutMs: 100,
				idleTimeoutMs: 50,
			}),
		}
	}

	it("cancels a stuck read without awaiting provider cleanup", async () => {
		const clock = sinon.useFakeTimers()
		const { controller, iterator, stream, abort } = fixture()
		const pending = stream.next()
		const rejection = assert.rejects(pending, { name: "AbortError" })
		await clock.tickAsync(0)
		controller.abort()
		await rejection
		sinon.assert.calledOnce(abort)
		sinon.assert.calledOnce(iterator.return)
		assert.equal(clock.countTimers(), 0)
	})

	it("times out silent first chunks and frees the stream even when abort throws", async () => {
		const clock = sinon.useFakeTimers()
		const { create, controller, iterator } = fixture()
		const stream = guardedStream(create, {
			signal: controller.signal,
			firstChunkTimeoutMs: 100,
			abort: () => {
				throw new Error("offline")
			},
		})
		const rejection = assert.rejects(stream.next(), ApiStreamTimeoutError)
		await clock.tickAsync(100)
		await rejection
		sinon.assert.calledOnce(iterator.return)
		assert.equal(clock.countTimers(), 0)
	})

	it("uses an idle deadline between chunks, not a total runtime limit", async () => {
		const clock = sinon.useFakeTimers()
		const { iterator, stream } = fixture()
		iterator.next.onFirstCall().resolves({ done: false, value: "one" })
		assert.deepEqual(await stream.next(), { done: false, value: "one" })
		await clock.tickAsync(1000) // The consumer may be executing a tool or waiting for approval.
		assert.equal(clock.countTimers(), 0)
		const rejection = assert.rejects(stream.next(), /no new output/)
		await clock.tickAsync(50)
		await rejection
		assert.equal(clock.countTimers(), 0)
	})

	it("does not open an already cancelled request or read after a cancellation race", async () => {
		const { controller, create, stream } = fixture()
		controller.abort()
		await assert.rejects(stream.next(), { name: "AbortError" })
		sinon.assert.notCalled(create)
		const second = fixture()
		const pending = second.stream.next()
		second.controller.abort()
		await assert.rejects(pending, { name: "AbortError" })
		sinon.assert.notCalled(second.iterator.next)
	})

	it("discards late chunks after a timeout instead of replaying them", async () => {
		const clock = sinon.useFakeTimers()
		const { iterator, stream } = fixture()
		let release!: (result: IteratorResult<string>) => void
		iterator.next.returns(
			new Promise<IteratorResult<string>>((resolve) => {
				release = resolve
			}),
		)
		const rejection = assert.rejects(stream.next(), ApiStreamTimeoutError)
		await clock.tickAsync(100)
		await rejection
		release({ done: false, value: "late tool call" })
		assert.equal((await stream.next()).done, true)
		sinon.assert.calledOnce(iterator.next)
	})

	it("cancels delayed internal retries after timeout while leaving the task able to recover", async () => {
		const clock = sinon.useFakeTimers()
		const controller = new AbortController()
		let signal: AbortSignal
		let release!: () => void
		class Provider {
			calls = 0
			options = {
				getRetrySignal: () => signal,
				onRetryAttempt: () =>
					new Promise<void>((resolve) => {
						release = resolve
					}),
			}
			@withRetry({ baseDelay: 1 })
			async *createMessage() {
				if (++this.calls === 1) throw new RetriableError("busy")
				yield "new request succeeded"
			}
		}
		const provider = new Provider()
		const create = () =>
			guardedStream(
				(requestSignal) => {
					signal = requestSignal
					return provider.createMessage()
				},
				{ signal: controller.signal, firstChunkTimeoutMs: 100 },
			)
		const timedOut = assert.rejects(create().next(), ApiStreamTimeoutError)
		await clock.tickAsync(100)
		await timedOut
		assert.equal(controller.signal.aborted, false)
		release()
		await clock.tickAsync(100)
		assert.equal(provider.calls, 1)
		const recovered = create()
		assert.equal((await recovered.next()).value, "new request succeeded")
		await recovered.return(undefined)
		assert.equal(provider.calls, 2)
		assert.equal(clock.countTimers(), 0)
	})

	it("releases timers on success and aborts only streams that were interrupted", async () => {
		const clock = sinon.useFakeTimers()
		const { iterator, stream, abort } = fixture()
		iterator.next.onFirstCall().resolves({ done: false, value: "one" })
		iterator.next.onSecondCall().resolves({ done: true })
		await stream.next()
		await stream.next()
		sinon.assert.notCalled(abort)
		assert.equal(clock.countTimers(), 0)
		const second = fixture()
		second.iterator.next.resolves({ done: false, value: "one" })
		await second.stream.next()
		await second.stream.return(undefined)
		sinon.assert.calledOnce(second.abort)
		sinon.assert.calledOnce(second.iterator.return)
		assert.equal(clock.countTimers(), 0)
	})
})
