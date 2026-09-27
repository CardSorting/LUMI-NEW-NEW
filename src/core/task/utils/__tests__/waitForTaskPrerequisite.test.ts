import { strict as assert } from "node:assert"
import { getEventListeners } from "node:events"
import { describe, it } from "mocha"
import { waitForTaskPrerequisite } from "../waitForTaskPrerequisite"

describe("task prerequisite cancellation", () => {
	it("releases a cancelled wait and consumes a late rejection without retaining listeners", async () => {
		const controller = new AbortController()
		let reject!: (error: Error) => void
		const prerequisite = new Promise<void>((_resolve, fail) => {
			reject = fail
		})
		const waiting = waitForTaskPrerequisite(prerequisite, controller.signal)
		const stopped = assert.rejects(waiting, { name: "AbortError" })
		controller.abort()
		await stopped
		assert.equal(getEventListeners(controller.signal, "abort").length, 0)
		reject(new Error("late prerequisite failure"))
		await Promise.resolve()
	})
	it("returns the original value or failure and removes cancellation listeners", async () => {
		const controller = new AbortController()
		assert.equal(await waitForTaskPrerequisite(Promise.resolve(42), controller.signal), 42)
		const failure = new Error("probe failed")
		await assert.rejects(waitForTaskPrerequisite(Promise.reject(failure), controller.signal), (error) => error === failure)
		assert.equal(getEventListeners(controller.signal, "abort").length, 0)
	})
	it("observes an already-started prerequisite even when the task was already stopped", async () => {
		const controller = new AbortController()
		controller.abort()
		await assert.rejects(waitForTaskPrerequisite(Promise.reject(new Error("late failure")), controller.signal), {
			name: "AbortError",
		})
	})
})
