import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { DietCodeMessage } from "@/shared/proto/dietcode/ui"
import {
	registerPartialMessageCallback,
	sendPartialMessageEvent,
	subscribeToPartialMessage,
} from "../ui/subscribeToPartialMessage"

describe("bounded helper partial delivery", () => {
	afterEach(() => sinon.restore())
	it("delivers to healthy subscribers even if another transport hangs, and bounds pending work", async () => {
		const clock = sinon.useFakeTimers()
		const slow = sinon.stub().returns(new Promise(() => {}))
		const callback = sinon.spy()
		await subscribeToPartialMessage({} as never, {}, slow)
		const unsubscribe = registerPartialMessageCallback(callback)
		try {
			const message = DietCodeMessage.create({ ts: 100, text: "progress" })
			const delivery = sendPartialMessageEvent(message, 2000)
			sinon.assert.calledOnce(callback)
			await clock.tickAsync(2000)
			await delivery
			await sendPartialMessageEvent(message, 2000)
			sinon.assert.calledOnce(slow)
			sinon.assert.calledTwice(callback)
			assert.equal(clock.countTimers(), 0)
		} finally {
			unsubscribe()
		}
	})
})
