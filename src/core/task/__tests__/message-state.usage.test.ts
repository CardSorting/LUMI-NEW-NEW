import { strict as assert } from "node:assert"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import * as disk from "@/core/storage/disk"
import { MessageStateHandler } from "../message-state"
import { TaskState } from "../TaskState"

describe("strict specialist usage persistence", () => {
	let clock: sinon.SinonFakeTimers
	beforeEach(() => {
		clock = sinon.useFakeTimers()
	})
	afterEach(() => sinon.restore())

	const fixture = () => {
		const state = new MessageStateHandler({
			taskId: "task",
			ulid: "id",
			taskState: new TaskState(),
			updateTaskHistory: async () => [],
		})
		sinon.stub(state, "saveDietCodeMessagesAndUpdateHistory").resolves()
		state.setDietCodeMessages([
			{
				ts: 10,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					specialistUsage: { tokensIn: 5, tokensOut: 0, cacheReads: 0, cacheWrites: 0, cost: 0.1 },
				}),
			},
		])
		return state
	}

	it("propagates disk failures without publishing the new usage", async () => {
		const save = sinon.stub(disk, "saveDietCodeMessagesStrict").rejects(new Error("disk unavailable"))
		const state = fixture()
		await assert.rejects(
			state.recordSpecialistUsageStrict(10, undefined, { tokensIn: 8, tokensOut: 0, cacheReads: 0, cacheWrites: 0 }),
			/disk unavailable/,
		)
		const text = state.getDietCodeMessages()[0].text ?? "{}"
		assert.equal(JSON.parse(text).specialistUsage.tokensIn, 5)
		sinon.assert.calledOnce(save)
		sinon.assert.notCalled(state.saveDietCodeMessagesAndUpdateHistory as sinon.SinonStub)
	})

	it("keeps cumulative usage monotonic when an older callback finishes late", async () => {
		sinon.stub(disk, "saveDietCodeMessagesStrict").resolves()
		const state = fixture()
		const baseline = { tokensIn: 5, tokensOut: 0, cacheReads: 0, cacheWrites: 0, cost: 0.1 }
		await state.recordSpecialistUsageStrict(10, baseline, {
			tokensIn: 4,
			tokensOut: 1,
			cacheReads: 0,
			cacheWrites: 0,
			cost: 0.03,
		})
		await state.recordSpecialistUsageStrict(10, baseline, {
			tokensIn: 2,
			tokensOut: 0,
			cacheReads: 0,
			cacheWrites: 0,
			cost: 0.01,
		})
		const text = state.getDietCodeMessages()[0].text ?? "{}"
		const usage = JSON.parse(text).specialistUsage
		assert.equal(usage.tokensIn, 9)
		assert.equal(usage.tokensOut, 1)
		assert.equal(usage.cost, 0.13)
		sinon.assert.notCalled(state.saveDietCodeMessagesAndUpdateHistory as sinon.SinonStub)
		await clock.tickAsync(250)
		sinon.assert.calledOnce(state.saveDietCodeMessagesAndUpdateHistory as sinon.SinonStub)
	})

	it("preserves usage when a stale ordinary message update arrives after a strict save", async () => {
		sinon.stub(disk, "saveDietCodeMessagesStrict").resolves()
		const state = fixture()
		sinon
			.stub(state as unknown as Record<string, () => Promise<void>>, "saveDietCodeMessagesAndUpdateHistoryInternal")
			.resolves()
		const staleText = JSON.stringify({ request: "older snapshot" })
		await state.recordSpecialistUsageStrict(10, undefined, {
			tokensIn: 9,
			tokensOut: 1,
			cacheReads: 0,
			cacheWrites: 0,
			cost: 0.13,
		})
		await state.updateDietCodeMessage(0, { text: staleText })
		const text = state.getDietCodeMessages()[0].text ?? "{}"
		const info = JSON.parse(text)
		assert.equal(info.request, "older snapshot")
		assert.equal(info.specialistUsage.tokensIn, 9)
		assert.equal(info.specialistUsage.cost, 0.13)
	})

	it("does not allow an older specialist snapshot to reduce usage", async () => {
		const state = fixture()
		sinon
			.stub(state as unknown as Record<string, () => Promise<void>>, "saveDietCodeMessagesAndUpdateHistoryInternal")
			.resolves()
		await state.updateDietCodeMessage(0, {
			text: JSON.stringify({ specialistUsage: { tokensIn: 1, tokensOut: 2, cacheReads: 0, cacheWrites: 0, cost: 0.01 } }),
		})
		const text = state.getDietCodeMessages()[0].text ?? "{}"
		const usage = JSON.parse(text).specialistUsage
		assert.equal(usage.tokensIn, 5)
		assert.equal(usage.tokensOut, 2)
		assert.equal(usage.cost, 0.1)
	})
})
