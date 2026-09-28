import { strict as assert } from "node:assert"
import type { IController } from "@core/controller/types"
import { describe, it } from "mocha"
import { taskCompletionViewChanges } from "../taskCompletionViewChanges"

describe("completion change review", () => {
	it("opens the requested completion snapshot", async () => {
		let args: unknown[] | undefined
		const controller = {
			task: {
				checkpointManager: {
					presentMultifileDiff: async (...values: unknown[]) => {
						args = values
					},
				},
			},
		} as unknown as IController
		await taskCompletionViewChanges(controller, { value: 42 })
		assert.deepEqual(args, [42, true])
	})
	it("reports missing task and checkpoint access instead of silently succeeding", async () => {
		await assert.rejects(taskCompletionViewChanges({} as IController, { value: 42 }), /Reopen this task/)
		await assert.rejects(taskCompletionViewChanges({ task: {} } as IController, { value: 42 }), /saved changes.*unavailable/)
	})
	it("propagates failures so the review action can offer a retry", async () => {
		const controller = {
			task: {
				checkpointManager: {
					presentMultifileDiff: async () => {
						throw new Error("snapshot unavailable")
					},
				},
			},
		} as unknown as IController
		await assert.rejects(taskCompletionViewChanges(controller, { value: 42 }), /snapshot unavailable/)
	})
})
