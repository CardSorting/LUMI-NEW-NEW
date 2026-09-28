import type { ExplainChangesProgress } from "@shared/proto/dietcode/task"
import { describe, expect, it, vi } from "vitest"
import { CompletionWalkthroughStore } from "./completion-walkthrough"
import type { Callbacks } from "./grpc-client-base"

function fixture() {
	let callbacks!: Callbacks<ExplainChangesProgress>
	const cancel = vi.fn()
	const request = vi.fn((_messageTs: number, response: Callbacks<ExplainChangesProgress>) => {
		callbacks = response
		return cancel
	})
	const store = new CompletionWalkthroughStore(request)
	return { store, request, cancel, callbacks: () => callbacks }
}

describe("walkthrough operation lifetime", () => {
	it("allows only one active operation across results", () => {
		const { store, request } = fixture()
		store.start(42)
		store.start(42)
		store.start(43)
		expect(request).toHaveBeenCalledTimes(1)
		expect(store.getActiveTimestamp()).toBe(42)
	})
	it("invalidates late updates after stop and a new attempt", () => {
		const { store, callbacks, cancel } = fixture()
		store.start(42)
		const old = callbacks()
		store.stop(42)
		store.start(42)
		old.onError?.(new Error("old failure"))
		old.onComplete?.()
		expect(store.get(42).phase).toBe("loading")
		expect(store.getActiveTimestamp()).toBe(42)
		expect(cancel).toHaveBeenCalledTimes(1)
	})
	it("requires a terminal outcome before reporting success", () => {
		const { store, callbacks } = fixture()
		store.start(42)
		callbacks().onComplete?.()
		expect(store.get(42).phase).toBe("error")
		expect(store.getActiveTimestamp()).toBeUndefined()
	})
	it("ignores invalid progress and bounds completed session history", () => {
		const { store, callbacks } = fixture()
		for (let ts = 1; ts <= 25; ts++) {
			store.start(ts)
			callbacks().onResponse({ phase: "generating", filesTotal: 2, filesExplained: 3, commentCount: 1, currentFile: "" })
			expect(store.get(ts).phase).toBe("loading")
			callbacks().onResponse({ phase: "complete", filesTotal: 2, filesExplained: 1, commentCount: 1, currentFile: "" })
			callbacks().onComplete?.()
		}
		expect(store.get(1).phase).toBe("idle")
		expect(store.get(25).phase).toBe("complete")
	})
	it("releases listeners independently from generation and cancels on session disposal", () => {
		const { store, cancel, callbacks } = fixture()
		const listener = vi.fn()
		const unsubscribe = store.subscribe(listener)
		store.start(42)
		unsubscribe()
		callbacks().onResponse({ phase: "generating", filesTotal: 2, filesExplained: 1, commentCount: 1, currentFile: "" })
		expect(listener).toHaveBeenCalledTimes(1)
		expect(cancel).not.toHaveBeenCalled()
		store.dispose()
		expect(cancel).toHaveBeenCalledTimes(1)
		expect(store.get(42).phase).toBe("idle")
	})
})
