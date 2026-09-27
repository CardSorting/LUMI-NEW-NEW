import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import type { IController } from "@/core/controller/types"
import { HostProvider } from "@/hosts/host-provider"
import { type OpenAiCodexCredentials, openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { Logger } from "@/shared/services/Logger"
import * as env from "@/utils/env"
import { openAiCodexSignIn } from "../openAiCodexSignIn"
import { openAiCodexSignOut } from "../openAiCodexSignOut"
import { refreshOpenAiCodexModels } from "../refreshOpenAiCodexModels"

describe("OpenAI Codex account handlers", () => {
	afterEach(() => sinon.restore())

	function controllerFixture() {
		const postStateToWebview = sinon.stub().resolves()
		return { controller: { postStateToWebview } as unknown as IController, postStateToWebview }
	}

	it("publishes the account state after a successful model refresh", async () => {
		const { controller, postStateToWebview } = controllerFixture()
		const listModels = sinon.stub(openAiCodexOAuthManager, "listModels").resolves({})

		assert.deepEqual(await refreshOpenAiCodexModels(controller), { value: "{}" })
		sinon.assert.calledOnceWithExactly(listModels, true)
		sinon.assert.calledOnce(postStateToWebview)
		sinon.assert.callOrder(listModels, postStateToWebview)
	})

	it("publishes the account state when refresh fails so cleared credentials reach the UI", async () => {
		const { controller, postStateToWebview } = controllerFixture()
		const error = new Error("Token refresh failed (HTTP 400). Error: invalid_grant.")
		const listModels = sinon.stub(openAiCodexOAuthManager, "listModels").rejects(error)

		await assert.rejects(refreshOpenAiCodexModels(controller), (actual) => actual === error)
		sinon.assert.calledOnce(postStateToWebview)
		sinon.assert.callOrder(listModels, postStateToWebview)
	})

	it("publishes the signed-out state after clearing the account", async () => {
		const { controller, postStateToWebview } = controllerFixture()
		const clearCredentials = sinon.stub(openAiCodexOAuthManager, "clearCredentials").resolves()

		assert.deepEqual(await openAiCodexSignOut(controller, {}), {})
		sinon.assert.calledOnce(clearCredentials)
		sinon.assert.calledOnce(postStateToWebview)
		sinon.assert.callOrder(clearCredentials, postStateToWebview)
	})

	it("does not cancel a restarted sign-in when the previous callback rejects", async () => {
		const { controller, postStateToWebview } = controllerFixture()
		let rejectPrevious!: (error: Error) => void
		const previousCallback = new Promise<never>((_resolve, reject) => {
			rejectPrevious = reject
		})
		const replacementCallback = new Promise<never>(() => {})
		const startAuthorization = sinon.stub(openAiCodexOAuthManager, "startAuthorizationFlow")
		startAuthorization.onFirstCall().resolves("https://example.invalid/first-authorization")
		startAuthorization.onSecondCall().callsFake(async () => {
			rejectPrevious(new Error("OpenAI Codex sign-in was cancelled."))
			return "https://example.invalid/replacement-authorization"
		})
		const waitForCallback = sinon.stub(openAiCodexOAuthManager, "waitForCallback")
		waitForCallback.onFirstCall().returns(previousCallback)
		waitForCallback.onSecondCall().returns(replacementCallback)
		const cancelAuthorization = sinon.stub(openAiCodexOAuthManager, "cancelAuthorizationFlow")
		const openExternal = sinon.stub(env, "openExternal").resolves()
		const showMessage = sinon.stub().resolves()
		sinon.stub(HostProvider, "window").get(() => ({ showMessage }))
		sinon.stub(Logger, "error")

		await openAiCodexSignIn(controller, {})
		await openAiCodexSignIn(controller, {})
		await new Promise<void>((resolve) => setImmediate(resolve))

		sinon.assert.calledTwice(openExternal)
		sinon.assert.notCalled(cancelAuthorization)
		sinon.assert.notCalled(showMessage)
		sinon.assert.calledThrice(postStateToWebview)
	})

	it("publishes successful sign-in before its notification is dismissed", async () => {
		const { controller, postStateToWebview } = controllerFixture()
		let completeSignIn!: (credentials: OpenAiCodexCredentials) => void
		const callback = new Promise<OpenAiCodexCredentials>((resolve) => {
			completeSignIn = resolve
		})
		sinon.stub(openAiCodexOAuthManager, "startAuthorizationFlow").resolves("https://example.invalid/authorization")
		sinon.stub(openAiCodexOAuthManager, "waitForCallback").returns(callback)
		sinon.stub(env, "openExternal").resolves()
		const showMessage = sinon.stub().returns(new Promise<never>(() => {}))
		sinon.stub(HostProvider, "window").get(() => ({ showMessage }))
		sinon.stub(Logger, "error")

		await openAiCodexSignIn(controller, {})
		postStateToWebview.resetHistory()
		completeSignIn({
			type: "openai-codex",
			access_token: "test-token",
			refresh_token: "test-refresh",
			expires: Date.now() + 3_600_000,
		})
		await new Promise<void>((resolve) => setImmediate(resolve))

		sinon.assert.calledOnce(showMessage)
		sinon.assert.calledOnce(postStateToWebview)
	})
})
