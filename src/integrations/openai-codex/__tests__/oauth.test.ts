import { strict as assert } from "node:assert"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { StateManager } from "@/core/storage/StateManager"
import * as net from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { type OpenAiCodexCredentials, OpenAiCodexOAuthManager } from "../oauth"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((res) => {
		resolve = res
	})
	return { promise, resolve }
}

function credentials(overrides: Partial<OpenAiCodexCredentials> = {}): OpenAiCodexCredentials {
	return {
		type: "openai-codex",
		access_token: "test-access-token",
		refresh_token: "test-refresh-token",
		expires: Date.now() + 3_600_000,
		accountId: "test-account",
		email: "test@example.invalid",
		...overrides,
	}
}

function catalog(id: string): Response {
	return Response.json({ models: [{ slug: id, display_name: id }] })
}

describe("OpenAI Codex account and model lifecycle", () => {
	let manager: OpenAiCodexOAuthManager
	let storedCredentials: string | undefined
	let fetchStub: sinon.SinonStub
	let setSecret: sinon.SinonStub
	let flushPendingState: sinon.SinonStub

	beforeEach(() => {
		manager = new OpenAiCodexOAuthManager()
		storedCredentials = JSON.stringify(credentials())
		setSecret = sinon.stub().callsFake((_key: string, value: string | undefined) => {
			storedCredentials = value
		})
		flushPendingState = sinon.stub().resolves()
		sinon.stub(StateManager, "get").returns({
			getSecretKey: sinon.stub().callsFake(() => storedCredentials),
			setSecret,
			flushPendingState,
		} as unknown as StateManager)
		fetchStub = sinon.stub(net, "fetch").rejects(new Error("Unexpected network request in OAuth test"))
		sinon.stub(Logger, "error")
		sinon.stub(Logger, "log")
	})

	afterEach(() => sinon.restore())

	it("does not reload the old stored account while sign-out waits for its storage write", async () => {
		assert.equal(await manager.isAuthenticated(), true)
		const signingOut = manager.clearCredentials()
		const authenticationDuringSignOut = manager.isAuthenticated()
		await signingOut
		assert.equal(await authenticationDuringSignOut, false)
		assert.equal(await manager.isAuthenticated(), false)
		assert.equal(await manager.getAccountId(), null)
		assert.equal(storedCredentials, undefined)
		sinon.assert.notCalled(fetchStub)
	})

	it("cancels an unfinished authorization attempt when signing out", async () => {
		sinon.stub(manager as unknown as { listenForCallback: () => Promise<number> }, "listenForCallback").resolves(1455)
		await manager.startAuthorizationFlow()
		const callback = assert.rejects(manager.waitForCallback(), /cancelled/i)
		assert.equal(manager.isAuthorizationPending(), true)

		await manager.clearCredentials()
		await callback
		assert.equal(manager.isAuthorizationPending(), false)
		assert.equal(await manager.isAuthenticated(), false)
	})

	it("ignores cancellation of a replaced authorization callback", async () => {
		sinon.stub(manager as unknown as { listenForCallback: () => Promise<number> }, "listenForCallback").resolves(1455)
		await manager.startAuthorizationFlow()
		const previousCallback = manager.waitForCallback()
		const previousCancelled = assert.rejects(previousCallback, /cancelled/i)
		await manager.startAuthorizationFlow()
		await previousCancelled
		const replacementCallback = manager.waitForCallback()

		manager.cancelAuthorizationFlow(previousCallback)
		assert.equal(manager.isAuthorizationPending(), true)
		assert.equal(manager.waitForCallback(), replacementCallback)

		const replacementCancelled = assert.rejects(replacementCallback, /cancelled/i)
		manager.cancelAuthorizationFlow(replacementCallback)
		await replacementCancelled
		assert.equal(manager.isAuthorizationPending(), false)
	})

	it("preserves a transient refresh failure instead of claiming the account is signed out", async () => {
		storedCredentials = JSON.stringify(credentials({ expires: Date.now() - 1 }))
		fetchStub.resolves(Response.json({ error: "temporarily_unavailable" }, { status: 503 }))

		await assert.rejects(manager.listModels(true), /Token refresh failed.*503/)
		assert.equal(await manager.isAuthenticated(), true)
		assert.ok(storedCredentials)
		sinon.assert.calledOnce(fetchStub)
		sinon.assert.notCalled(setSecret)
	})

	it("clears revoked refresh credentials and reports the actual refresh failure", async () => {
		storedCredentials = JSON.stringify(credentials({ expires: Date.now() - 1 }))
		fetchStub.resolves(Response.json({ error: "invalid_grant" }, { status: 400 }))

		await assert.rejects(manager.listModels(true), /invalid_grant/)
		assert.equal(await manager.isAuthenticated(), false)
		assert.equal(storedCredentials, undefined)
		sinon.assert.calledOnce(fetchStub)
	})

	it("recognizes a reused refresh token reported in a nested OAuth error code", async () => {
		storedCredentials = JSON.stringify(credentials({ expires: Date.now() - 1 }))
		fetchStub.resolves(Response.json({ error: { code: "refresh_token_reused" } }, { status: 401 }))

		await assert.rejects(manager.listModels(true), /refresh_token_reused/)
		assert.equal(await manager.isAuthenticated(), false)
		assert.equal(storedCredentials, undefined)
	})

	it("preserves transient refresh errors when a catalog 401 triggers a token refresh", async () => {
		fetchStub.onFirstCall().resolves(new Response(null, { status: 401 }))
		fetchStub.onSecondCall().resolves(Response.json({ error: "temporarily_unavailable" }, { status: 503 }))

		await assert.rejects(manager.listModels(true), /Token refresh failed.*503/)
		assert.equal(await manager.isAuthenticated(), true)
		sinon.assert.calledTwice(fetchStub)
	})

	it("refreshes once after a catalog 401 and retries with the new access token", async () => {
		fetchStub.onFirstCall().resolves(new Response(null, { status: 401 }))
		fetchStub.onSecondCall().resolves(Response.json({ access_token: "refreshed-test-token", expires_in: 3600 }))
		fetchStub.onThirdCall().resolves(catalog("account-model"))

		assert.deepEqual(Object.keys(await manager.listModels(true)), ["account-model"])
		assert.equal(fetchStub.callCount, 3)
		const retryHeaders = new Headers(fetchStub.thirdCall.args[1].headers)
		assert.equal(retryHeaders.get("Authorization"), "Bearer refreshed-test-token")
		assert.equal(retryHeaders.get("ChatGPT-Account-Id"), "test-account")
		assert.ok(storedCredentials)
		assert.equal(JSON.parse(storedCredentials).refresh_token, "test-refresh-token")
	})

	it("deduplicates simultaneous forced catalog refreshes", async () => {
		const response = deferred<Response>()
		fetchStub.returns(response.promise)
		const first = manager.listModels(true)
		const second = manager.listModels(true)
		response.resolve(catalog("account-model"))

		const results = await Promise.all([first, second])
		assert.deepEqual(Object.keys(results[0]), ["account-model"])
		assert.deepEqual(results[0], results[1])
		sinon.assert.calledOnce(fetchStub)
		assert.deepEqual(await manager.listModels(), results[0])
		sinon.assert.calledOnce(fetchStub)
	})

	it("discards catalog results that arrive after sign-out", async () => {
		const started = deferred<void>()
		const response = deferred<Response>()
		fetchStub.callsFake(() => {
			started.resolve()
			return response.promise
		})
		const loadingModels = assert.rejects(manager.listModels(true), /changed|signed|cancel/i)
		await started.promise
		await manager.clearCredentials()
		response.resolve(catalog("old-account-model"))

		await loadingModels
		await assert.rejects(manager.listModels(), /Not signed in/i)
		assert.equal(storedCredentials, undefined)
		sinon.assert.calledOnce(fetchStub)
	})

	it("discards a catalog body that finishes decoding after sign-out", async () => {
		const decoding = deferred<void>()
		const body = deferred<unknown>()
		const response = catalog("unused-model")
		sinon.stub(response, "json").callsFake(() => {
			decoding.resolve()
			return body.promise
		})
		fetchStub.resolves(response)
		const loadingModels = assert.rejects(manager.listModels(true), /changed|signed|cancel/i)
		await decoding.promise
		await manager.clearCredentials()
		body.resolve({ models: [{ slug: "old-account-model" }] })

		await loadingModels
		await assert.rejects(manager.listModels(), /Not signed in/i)
		sinon.assert.calledOnce(fetchStub)
	})

	it("keeps a new account's catalog when the previous account's request completes later", async () => {
		const started = deferred<void>()
		const oldResponse = deferred<Response>()
		fetchStub.onFirstCall().callsFake(() => {
			started.resolve()
			return oldResponse.promise
		})
		fetchStub.onSecondCall().resolves(catalog("new-account-model"))
		const oldCatalog = assert.rejects(manager.listModels(true), /changed|signed|cancel/i)
		await started.promise
		await manager.saveCredentials(credentials({ accountId: "new-account", refresh_token: "new-refresh-token" }))
		const newCatalog = await manager.listModels(true)
		assert.deepEqual(Object.keys(newCatalog), ["new-account-model"])
		oldResponse.resolve(catalog("old-account-model"))

		await oldCatalog
		assert.deepEqual(await manager.listModels(), newCatalog)
		sinon.assert.calledTwice(fetchStub)
		assert.equal(new Headers(fetchStub.secondCall.args[1].headers).get("ChatGPT-Account-Id"), "new-account")
	})

	it("waits for account persistence before choosing credentials for a new catalog request", async () => {
		await manager.isAuthenticated()
		const writing = deferred<void>()
		const flushed = deferred<void>()
		flushPendingState.callsFake(() => {
			writing.resolve()
			return flushed.promise
		})
		fetchStub.resolves(catalog("new-account-model"))
		const saving = manager.saveCredentials(
			credentials({ accountId: "new-account", access_token: "new-access-token", refresh_token: "new-refresh-token" }),
		)
		await writing.promise
		const loading = manager.listModels(true)
		await new Promise<void>((resolve) => setImmediate(resolve))
		flushed.resolve()

		await saving
		assert.deepEqual(Object.keys(await loading), ["new-account-model"])
		sinon.assert.calledOnce(fetchStub)
		const headers = new Headers(fetchStub.firstCall.args[1].headers)
		assert.equal(headers.get("ChatGPT-Account-Id"), "new-account")
		assert.equal(headers.get("Authorization"), "Bearer new-access-token")
	})

	it("does not restore refreshed credentials after sign-out", async () => {
		storedCredentials = JSON.stringify(credentials({ expires: Date.now() - 1 }))
		const started = deferred<void>()
		const response = deferred<Response>()
		fetchStub.callsFake(() => {
			started.resolve()
			return response.promise
		})
		const token = manager.getAccessToken()
		await started.promise
		await manager.clearCredentials()
		response.resolve(
			Response.json({ access_token: "stale-refreshed-token", refresh_token: "stale-refresh", expires_in: 3600 }),
		)

		assert.equal(await token, null)
		assert.equal(await manager.isAuthenticated(), false)
		assert.equal(storedCredentials, undefined)
	})

	it("does not clear a new account when the previous account's refresh is rejected", async () => {
		storedCredentials = JSON.stringify(credentials({ expires: Date.now() - 1 }))
		const started = deferred<void>()
		const response = deferred<Response>()
		fetchStub.callsFake(() => {
			started.resolve()
			return response.promise
		})
		const token = manager.getAccessToken()
		await started.promise
		await manager.saveCredentials(
			credentials({ accountId: "new-account", access_token: "new-access-token", refresh_token: "new-refresh-token" }),
		)
		response.resolve(Response.json({ error: "invalid_grant" }, { status: 400 }))

		assert.equal(await token, null)
		assert.equal(await manager.isAuthenticated(), true)
		assert.equal(await manager.getAccessToken(), "new-access-token")
		assert.ok(storedCredentials)
		assert.equal(JSON.parse(storedCredentials).accountId, "new-account")
		sinon.assert.calledOnce(fetchStub)
	})
})
