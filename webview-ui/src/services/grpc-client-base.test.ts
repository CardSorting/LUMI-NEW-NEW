import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProtoBusClient } from "./grpc-client-base"

const { postMessage } = vi.hoisted(() => ({ postMessage: vi.fn() }))

vi.mock("../config/platform.config", () => ({
	PLATFORM_CONFIG: {
		postMessage,
		encodeMessage: (message: Record<string, unknown>) => message,
		decodeMessage: (message: Record<string, unknown>, decode: (value: Record<string, unknown>) => unknown) => decode(message),
	},
}))

class TestClient extends ProtoBusClient {
	static serviceName = "dietcode.TestService"
}

describe("ProtoBusClient stream lifetimes", () => {
	const cancellations: Array<() => void> = []

	beforeEach(() => {
		vi.useFakeTimers()
		postMessage.mockReset()
	})

	afterEach(() => {
		for (const cancel of cancellations.splice(0)) cancel()
		vi.useRealTimers()
	})

	function startStream(method = "subscribeToState", decode = (message: Record<string, unknown>) => message) {
		const callbacks = { onResponse: vi.fn(), onError: vi.fn(), onComplete: vi.fn() }
		const cancel = TestClient.makeStreamingRequest(method, {}, (message) => message, decode, callbacks)
		cancellations.push(cancel)
		const requestId = postMessage.mock.calls.at(-1)?.[0].grpc_request.request_id as string
		const respond = (response: Record<string, unknown>) => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "grpc_response", grpc_response: { request_id: requestId, is_streaming: true, ...response } },
				}),
			)
		}
		return { callbacks, cancel, requestId, respond }
	}

	it.each([
		"subscribeToState",
		"subscribeToSettingsButtonClicked",
		"subscribeToAuthStatusUpdate",
		"ocaSubscribeToAuthStatusUpdate",
	])("keeps %s alive before and after long idle periods", (method) => {
		const { callbacks, respond } = startStream(method)

		vi.advanceTimersByTime(11 * 60_000)
		respond({ message: { value: "first event" } })
		vi.advanceTimersByTime(3 * 60 * 60_000)
		respond({ message: { value: "later event" } })

		expect(callbacks.onResponse.mock.calls).toEqual([[{ value: "first event" }], [{ value: "later event" }]])
		expect(callbacks.onError).not.toHaveBeenCalled()
		expect(callbacks.onComplete).not.toHaveBeenCalled()
		expect(postMessage).toHaveBeenCalledTimes(1)
	})

	it("still times out a stalled finite stream and cancels it once", () => {
		const { callbacks, cancel, requestId, respond } = startStream("triggerAudit")
		vi.advanceTimersByTime(10 * 60_000)
		cancel()
		respond({ message: { value: "late event" } })

		expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(
			new Error("Timed out waiting for dietcode.TestService.triggerAudit stream update."),
		)
		expect(callbacks.onResponse).not.toHaveBeenCalled()
		expect(postMessage).toHaveBeenCalledTimes(2)
		expect(postMessage).toHaveBeenLastCalledWith({
			type: "grpc_request_cancel",
			grpc_request_cancel: { request_id: requestId },
		})
	})

	it("explicitly cancels an idle subscription once and ignores subsequent events", () => {
		const { callbacks, cancel, requestId, respond } = startStream()
		vi.advanceTimersByTime(11 * 60_000)
		cancel()
		cancel()
		respond({ message: { value: "late event" } })

		expect(postMessage).toHaveBeenCalledTimes(2)
		expect(postMessage).toHaveBeenLastCalledWith({
			type: "grpc_request_cancel",
			grpc_request_cancel: { request_id: requestId },
		})
		expect(callbacks.onResponse).not.toHaveBeenCalled()
		expect(callbacks.onError).not.toHaveBeenCalled()
		expect(callbacks.onComplete).not.toHaveBeenCalled()
	})

	it("reports a real subscription error once and allows a new subscription", () => {
		const failed = startStream()
		failed.respond({ error: "Subscription failed", is_streaming: false })
		failed.respond({ message: { value: "late event" } })
		const replacement = startStream()
		replacement.respond({ message: { value: "reconnected" } })

		expect(failed.callbacks.onError).toHaveBeenCalledExactlyOnceWith(new Error("Subscription failed"))
		expect(failed.callbacks.onResponse).not.toHaveBeenCalled()
		expect(replacement.callbacks.onResponse).toHaveBeenCalledExactlyOnceWith({ value: "reconnected" })
		expect(postMessage).toHaveBeenCalledTimes(2)
	})

	it("cleans up and cancels a subscription whose response cannot be decoded", () => {
		const { callbacks, respond, cancel } = startStream("subscribeToState", () => {
			throw new Error("Invalid response")
		})
		respond({ message: { invalid: true } })
		respond({ message: { invalid: true } })
		cancel()

		expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(new Error("Invalid response"))
		expect(postMessage).toHaveBeenCalledTimes(2)
	})

	it("reports a failure to start the subscription immediately", () => {
		postMessage.mockImplementationOnce(() => {
			throw new Error("Host unavailable")
		})
		const { callbacks, respond } = startStream()
		respond({ message: { value: "late event" } })

		expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(new Error("Host unavailable"))
		expect(callbacks.onResponse).not.toHaveBeenCalled()
	})

	it("completes a subscription on a terminal response and stops delivering events", () => {
		const { callbacks, respond } = startStream()
		respond({ is_streaming: false })
		respond({ message: { value: "late event" } })

		expect(callbacks.onComplete).toHaveBeenCalledTimes(1)
		expect(callbacks.onResponse).not.toHaveBeenCalled()
		expect(callbacks.onError).not.toHaveBeenCalled()
	})

	it("retains the timeout for unary requests", async () => {
		const request = TestClient.makeUnaryRequest(
			"refreshModels",
			{},
			(message) => message,
			(message) => message,
		)
		const result = expect(request).rejects.toThrow("Timed out waiting for dietcode.TestService.refreshModels response.")
		vi.advanceTimersByTime(60_000)
		await result
	})
})
