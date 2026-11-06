import type { ApiConfiguration } from "@shared/api"
import { expect } from "chai"
import sinon from "sinon"
import { buildApiHandler } from "../index"
import { OpenRouterHandler } from "../providers/openrouter"

describe("provider selection", () => {
	it("keeps an unspecified provider on the default route", () => {
		expect(buildApiHandler({}, "act")).to.be.instanceOf(OpenRouterHandler)
		expect(buildApiHandler({ actModeApiProvider: "" as ApiConfiguration["actModeApiProvider"] }, "act")).to.be.instanceOf(
			OpenRouterHandler,
		)
	})

	for (const provider of ["openai", "bedrock", "requesty", "unknown-provider"]) {
		it(`does not send ${provider} requests to OpenRouter`, async () => {
			const openRouterRequest = sinon.spy(OpenRouterHandler.prototype, "createMessage")
			try {
				const config = { actModeApiProvider: provider, openRouterApiKey: "existing-key" } as ApiConfiguration
				const handler = buildApiHandler(config, "act")
				expect(handler.getModel().id).to.equal("unavailable")
				try {
					await handler.createMessage("private instructions", []).next()
					expect.fail("unsupported provider unexpectedly accepted a request")
				} catch (error) {
					expect((error as Error).message).to.include(`API provider "${provider}" is not supported`)
				}
				sinon.assert.notCalled(openRouterRequest)
			} finally {
				openRouterRequest.restore()
			}
		})
	}
})
