import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import * as partialDelivery from "@/core/controller/ui/subscribeToPartialMessage"
import type { CompletionReview } from "@/shared/CompletionReview"
import type { DietCodeMessage } from "@/shared/ExtensionMessage"
import { Task } from "../index"
import { TaskState } from "../TaskState"

describe("completion review message delivery", () => {
	afterEach(() => sinon.restore())
	for (const hasDraft of [false, true]) {
		it(`persists the final review ${hasDraft ? "when replacing a streamed draft" : "in a new result"}`, async () => {
			const deliver = sinon.stub(partialDelivery, "sendPartialMessageEvent").resolves()
			const messages: DietCodeMessage[] = []
			const task = Object.assign(Object.create(Task.prototype), {
				taskState: new TaskState(),
				getCurrentProviderInfo: () => ({ providerId: "test", model: { id: "test" }, mode: "act" }),
				postStateToWebview: sinon.stub().resolves(),
				messageStateHandler: {
					getDietCodeMessages: () => messages,
					addToDietCodeMessages: async (message: DietCodeMessage) => {
						messages.push(message)
					},
					updateDietCodeMessage: async (index: number, update: Partial<DietCodeMessage>) => {
						Object.assign(messages[index], update)
					},
				},
			}) as Task
			const review: CompletionReview = {
				schemaVersion: 1,
				attempt: 1,
				priorBlocks: 0,
				checks: [{ id: "audit", status: "not_run", detail: "Not enabled." }],
			}
			if (hasDraft) {
				await task.say("completion_result", "Preparing", undefined, undefined, true)
				assert.equal(messages[0].completionReview, undefined)
			}
			await task.say("completion_result", "Done.", undefined, undefined, false, undefined, review)
			assert.equal(messages.length, 1)
			assert.deepEqual(JSON.parse(JSON.stringify(messages[0])).completionReview, review)
			assert.notEqual(messages[0].partial, true)
			if (hasDraft) assert.deepEqual(deliver.firstCall.args[0].completionReview, review)
		})
	}
})
