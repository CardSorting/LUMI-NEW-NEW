import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import type { DietCodeMessage } from "@/shared/ExtensionMessage"
import { MessageStateHandler } from "../message-state"
import { TaskState } from "../TaskState"

describe("live helper message state", () => {
	afterEach(() => sinon.restore())
	const row = (revision: number, status = "running", id = "helper"): DietCodeMessage => ({
		ts: 100,
		type: "say",
		say: "subagent",
		partial: status === "running",
		text: JSON.stringify({ taskId: "task", revision, items: [{ id, prompt: "Work", status }] }),
	})
	const handler = () =>
		new MessageStateHandler({ taskId: "task", ulid: "ulid", taskState: new TaskState(), updateTaskHistory: async () => [] })
	it("coalesces disk work without delaying synchronous progress or terminal state", async () => {
		const state = handler()
		let finish!: () => void
		const save = sinon
			.stub(state, "saveDietCodeMessagesAndUpdateHistory")
			.onFirstCall()
			.returns(
				new Promise((resolve) => {
					finish = resolve
				}),
			)
			.onSecondCall()
			.resolves()
		assert.equal(state.publishSubagentStatus(row(1), true), true)
		await Promise.resolve()
		for (let revision = 2; revision < 100; revision++) assert.equal(state.publishSubagentStatus(row(revision), false), true)
		assert.equal(state.publishSubagentStatus(row(100, "completed"), false), true)
		assert.equal(state.getDietCodeMessages().length, 1)
		assert.equal(state.getDietCodeMessages()[0].partial, false)
		sinon.assert.calledOnce(save)
		finish()
		await new Promise((resolve) => setImmediate(resolve))
		sinon.assert.calledTwice(save)
	})
	it("rejects duplicate revisions, sibling identity, late running state and removed rows", () => {
		const state = handler()
		sinon.stub(state, "saveDietCodeMessagesAndUpdateHistory").resolves()
		assert.equal(state.publishSubagentStatus(row(1), true), true)
		assert.equal(state.publishSubagentStatus(row(1), false), false)
		assert.equal(state.publishSubagentStatus(row(2, "running", "sibling"), false), false)
		assert.equal(state.publishSubagentStatus(row(2, "completed"), false), true)
		assert.equal(state.publishSubagentStatus(row(3), false), false)
		state.setDietCodeMessages([])
		assert.equal(state.publishSubagentStatus(row(4), false), false)
		assert.equal(state.getDietCodeMessages().length, 0)
	})
	it("throttles fast persistence to one second while terminal state bypasses the delay", async () => {
		const clock = sinon.useFakeTimers({ now: 1000 })
		const state = handler()
		const save = sinon.stub(state, "saveDietCodeMessagesAndUpdateHistory").resolves()
		state.publishSubagentStatus(row(1), true)
		await clock.tickAsync(0)
		state.publishSubagentStatus(row(2), false)
		await clock.tickAsync(50)
		sinon.assert.calledOnce(save)
		state.publishSubagentStatus(row(3, "completed"), false)
		await clock.tickAsync(0)
		sinon.assert.calledTwice(save)
		assert.equal(clock.countTimers(), 0)
	})
	it("isolates a failing auxiliary observer from the dedicated delivery and persistence path", async () => {
		const state = handler()
		const save = sinon.stub(state, "saveDietCodeMessagesAndUpdateHistory").resolves()
		state.on("dietcodeMessagesChanged", () => {
			throw new Error("Observer unavailable")
		})
		assert.equal(state.publishSubagentStatus(row(1, "completed"), true), true)
		await Promise.resolve()
		sinon.assert.calledOnce(save)
		assert.equal(state.getDietCodeMessages()[0].partial, false)
	})
})
