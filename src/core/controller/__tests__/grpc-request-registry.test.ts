import { expect } from "chai"
import * as sinon from "sinon"
import { GrpcRequestRegistry } from "../grpc-request-registry"

describe("GrpcRequestRegistry subscription lifetime", () => {
	let registry: GrpcRequestRegistry
	let clock: sinon.SinonFakeTimers

	beforeEach(() => {
		registry = new GrpcRequestRegistry()
		clock = sinon.useFakeTimers()
	})

	afterEach(() => {
		registry.dispose()
		clock.restore()
	})

	it("retains subscriptions during stale purging but still purges finite requests", () => {
		const subscriptionCleanup = sinon.spy()
		const finiteCleanup = sinon.spy()
		registry.registerRequest("subscription", subscriptionCleanup, {}, undefined, { persistent: true })
		registry.registerRequest("finite", finiteCleanup)
		registry.startStalePurge(60_000)

		clock.tick(3 * 60 * 60_000)

		expect(registry.hasRequest("subscription")).to.equal(true)
		expect(subscriptionCleanup.called).to.equal(false)
		expect(registry.hasRequest("finite")).to.equal(false)
		expect(finiteCleanup.calledOnce).to.equal(true)

		registry.dispose()
		expect(subscriptionCleanup.calledOnce).to.equal(true)
	})

	it("preserves subscription lifetime and transport cleanup when a handler registers cleanup", () => {
		const transportCleanup = sinon.spy()
		const handlerCleanup = sinon.spy()
		const responseStream = sinon.stub().resolves()
		registry.registerRequest("subscription", transportCleanup, { method: "subscribeToState" }, responseStream, {
			persistent: true,
		})
		registry.registerRequest("subscription", handlerCleanup, { type: "state_subscription" })

		clock.tick(3 * 60 * 60_000)
		expect(registry.cleanupStaleRequests(2 * 60 * 60_000)).to.equal(0)
		expect(registry.getRequestInfo("subscription")?.responseStream).to.equal(responseStream)
		expect(registry.cancelRequest("subscription")).to.equal(true)
		expect(registry.cancelRequest("subscription")).to.equal(false)
		expect(transportCleanup.calledOnce).to.equal(true)
		expect(handlerCleanup.calledOnce).to.equal(true)
	})

	it("retains transport metadata when a handler only adds cleanup", () => {
		registry.registerRequest("subscription", () => {}, { method: "subscribeToState" })
		registry.registerRequest("subscription", () => {})
		expect(registry.getRequestInfo("subscription")?.metadata).to.deep.equal({ method: "subscribeToState" })
	})

	it("runs handler cleanup even when transport cleanup throws", () => {
		const handlerCleanup = sinon.spy()
		registry.registerRequest("subscription", () => {
			throw new Error("Cleanup failed")
		})
		registry.registerRequest("subscription", handlerCleanup)

		expect(registry.cancelRequest("subscription")).to.equal(true)
		expect(handlerCleanup.calledOnce).to.equal(true)
		expect(registry.hasRequest("subscription")).to.equal(false)
	})
})
