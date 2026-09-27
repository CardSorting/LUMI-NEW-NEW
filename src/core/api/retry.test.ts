import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { asyncRetry, getApiRetryDelay, RetriableError, shouldRetryApiError, waitForApiRetry, withRetry } from "./retry"

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const values: T[] = []
	for await (const value of stream) values.push(value)
	return values
}

describe("bounded API retries", () => {
	afterEach(() => sinon.restore())

	it("retries before any output and reports the actual backoff", async () => {
		const attempts = sinon.spy()
		class Provider {
			options = { onRetryAttempt: attempts }
			calls = 0
			@withRetry({ maxRetries: 3, baseDelay: 1, maxDelay: 2 })
			async *createMessage() {
				if (++this.calls < 3) throw new RetriableError("busy")
				yield "ready"
			}
		}
		const provider = new Provider()
		assert.deepEqual(await collect(provider.createMessage()), ["ready"])
		assert.equal(provider.calls, 3)
		assert.deepEqual(
			attempts.args.map((args) => args.slice(0, 3)),
			[
				[1, 3, 1],
				[2, 3, 2],
			],
		)
	})

	it("never replays text or tool output when a stream fails later", async () => {
		class Provider {
			calls = 0
			@withRetry({ retryAllErrors: true, baseDelay: 1 })
			async *createMessage() {
				this.calls++
				yield { type: "tool_calls", id: "write-once" }
				throw new RetriableError("disconnected")
			}
		}
		const provider = new Provider()
		const values: unknown[] = []
		await assert.rejects(async () => {
			for await (const chunk of provider.createMessage()) values.push(chunk)
		}, /disconnected/)
		assert.equal(provider.calls, 1)
		assert.deepEqual(values, [{ type: "tool_calls", id: "write-once" }])
	})

	it("does not multiply exhausted retries in an outer recovery layer", async () => {
		let calls = 0
		await assert.rejects(
			asyncRetry(
				() =>
					asyncRetry(
						async () => {
							calls++
							throw new RetriableError("busy")
						},
						{ maxRetries: 2, baseDelay: 1 },
					),
				{ maxRetries: 3, baseDelay: 1 },
			),
			/busy/,
		)
		assert.equal(calls, 2)
	})

	for (const status of [400, 401, 402, 403, 404, 422]) {
		it(`does not retry HTTP ${status} even with retryAllErrors`, async () => {
			const action = sinon.stub().rejects(Object.assign(new Error("fix configuration"), { status }))
			await assert.rejects(asyncRetry(action, { retryAllErrors: true, baseDelay: 1 }), /fix configuration/)
			sinon.assert.calledOnce(action)
		})
	}

	it("recognizes cancellation and transient failures", () => {
		assert.equal(shouldRetryApiError(Object.assign(new Error(), { name: "AbortError" }), true), false)
		assert.equal(shouldRetryApiError(Object.assign(new Error(), { code: "ERR_CANCELED" }), true), false)
		assert.equal(shouldRetryApiError(Object.assign(new Error(), { status: 503 }), true), true)
		assert.equal(shouldRetryApiError(new Error("connection reset"), true), true)
		assert.equal(shouldRetryApiError(new Error("unknown")), false)
	})

	it("uses fractional seconds, Headers instances, HTTP dates and epoch reset headers", () => {
		const now = Date.parse("2026-09-26T12:00:00Z")
		sinon.stub(Date, "now").returns(now)
		assert.equal(getApiRetryDelay({ headers: { "retry-after": "0.01" } }, 0), 10)
		assert.equal(getApiRetryDelay({ headers: new Headers({ "retry-after": "2" }) }, 0), 2000)
		assert.equal(getApiRetryDelay({ headers: { "retry-after": "Sat, 26 Sep 2026 12:00:03 GMT" } }, 0), 3000)
		assert.equal(getApiRetryDelay({ headers: { "x-ratelimit-reset": String(now / 1000 + 4) } }, 0), 4000)
		assert.equal(getApiRetryDelay({ retryAfter: now / 1000 + 5 }, 0), 5000)
	})

	it("does not hot-loop on expired, zero or malformed headers", () => {
		for (const value of ["0", "-1", "invalid", "1262304000", "Fri, 01 Jan 2010 00:00:00 GMT"]) {
			assert.equal(getApiRetryDelay({ headers: { "retry-after": value } }, 1), 2000)
		}
	})

	it("stops automatic retries when the server delay exceeds the budget", async () => {
		const action = sinon.stub().rejects(Object.assign(new Error("busy"), { status: 429, headers: { "retry-after": "3600" } }))
		await assert.rejects(asyncRetry(action), /busy/)
		sinon.assert.calledOnce(action)
	})

	it("normalizes invalid attempt counts without silently skipping the request", async () => {
		for (const maxRetries of [0, -1, Number.NaN]) {
			const action = sinon.stub().resolves("ok")
			assert.equal(await asyncRetry(action, { maxRetries }), "ok")
			sinon.assert.calledOnce(action)
		}
	})

	it("cancels a provider backoff without sending another request", async () => {
		const controller = new AbortController()
		class Provider {
			calls = 0
			options = { getRetrySignal: () => controller.signal, onRetryAttempt: () => controller.abort() }
			@withRetry({ baseDelay: 10_000 })
			async *createMessage() {
				this.calls++
				throw new RetriableError("busy")
			}
		}
		const provider = new Provider()
		await assert.rejects(collect(provider.createMessage()), { name: "AbortError" })
		assert.equal(provider.calls, 1)
	})

	it("cancels an already pending wait immediately", async () => {
		const controller = new AbortController()
		const pending = waitForApiRetry(60_000, controller.signal)
		controller.abort()
		await assert.rejects(pending, { name: "AbortError" })
	})

	it("closes a provider generator when the consumer stops after its first chunk", async () => {
		const closed = sinon.spy()
		class Provider {
			@withRetry()
			async *createMessage() {
				try {
					yield "one"
					yield "two"
				} finally {
					closed()
				}
			}
		}
		for await (const _ of new Provider().createMessage()) break
		sinon.assert.calledOnce(closed)
	})
})
