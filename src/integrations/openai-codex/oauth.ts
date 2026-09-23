import type { ModelInfo } from "@shared/api"
import { ApiFormat } from "@shared/proto/dietcode/models"
import * as crypto from "crypto"
import * as http from "http"
import { URL } from "url"
import { z } from "zod"
import { StateManager } from "@/core/storage/StateManager"
import { ExtensionRegistryInfo } from "@/registry"
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"

/**
 * OpenAI Codex OAuth Configuration
 *
 * Based on the OpenAI Codex OAuth implementation:
 * - ISSUER: https://auth.openai.com
 * - Authorization endpoint: https://auth.openai.com/oauth/authorize
 * - Token endpoint: https://auth.openai.com/oauth/token
 * - Fixed callback port: 1455
 * - Codex-specific params: codex_cli_simplified_flow=true, originator=dietcode
 */
export const OPENAI_CODEX_OAUTH_CONFIG = {
	authorizationEndpoint: "https://auth.openai.com/oauth/authorize",
	tokenEndpoint: "https://auth.openai.com/oauth/token",
	clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
	redirectUri: "http://localhost:1455/auth/callback",
	scopes: "openid profile email offline_access",
	callbackPort: 1455,
} as const

const CALLBACK_PATH = "/auth/callback"
const CALLBACK_PORTS = [1455, 1457] as const
const CALLBACK_TIMEOUT_MS = 5 * 60_000

// Token storage key - must match the key in SECRETS_KEYS (state-keys.ts)
const OPENAI_CODEX_CREDENTIALS_KEY = "openai-codex-oauth-credentials"
const CODEX_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models"
const CODEX_MODELS_CACHE_MS = 5 * 60_000

function safeModelString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined
	const text = value.replace(/\p{Cc}/gu, " ").trim()
	return text.length > 0 && text.length <= 200 ? text : undefined
}

function positiveModelNumber(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined
	return number !== undefined && Number.isFinite(number) && number > 0 ? number : undefined
}

export function normalizeOpenAiCodexModels(payload: unknown): Record<string, ModelInfo> {
	const root = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : undefined
	const rows = Array.isArray(payload) ? payload : root?.models
	if (!Array.isArray(rows)) throw new Error("OpenAI Codex model catalog response did not contain a models list")
	const result: Record<string, ModelInfo> = {}
	for (const value of rows) {
		if (typeof value !== "object" || value === null) continue
		const row = value as Record<string, unknown>
		const id = safeModelString(row.slug) ?? safeModelString(row.id)
		if (!id || id.includes("/") || id in result) continue
		const modalities = Array.isArray(row.input_modalities) ? row.input_modalities : undefined
		const levels = Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels : undefined
		result[id] = {
			name: safeModelString(row.display_name) ?? safeModelString(row.name) ?? id,
			maxTokens: positiveModelNumber(row.max_output_tokens),
			contextWindow: positiveModelNumber(row.context_window) ?? positiveModelNumber(row.max_context_window),
			supportsImages: modalities ? modalities.some((entry) => entry === "image") : true,
			supportsPromptCache: false,
			supportsReasoning: Boolean(levels?.length || safeModelString(row.default_reasoning_level)),
			inputPrice: 0,
			outputPrice: 0,
			description: safeModelString(row.description),
			apiFormat: ApiFormat.OPENAI_RESPONSES,
		}
	}
	return result
}

// Credentials schema
const openAiCodexCredentialsSchema = z.object({
	type: z.literal("openai-codex"),
	access_token: z.string().min(1),
	refresh_token: z.string().min(1),
	// expires is in milliseconds since epoch
	expires: z.number().finite().positive(),
	email: z.string().optional(),
	// ChatGPT account ID extracted from JWT claims (for ChatGPT-Account-Id header)
	accountId: z.string().optional(),
})

export type OpenAiCodexCredentials = z.infer<typeof openAiCodexCredentialsSchema>

// Token response schema from OpenAI
const tokenResponseSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1).optional(),
	id_token: z.string().optional(),
	expires_in: z.number().finite().positive(),
	email: z.string().optional(),
	token_type: z.string().optional(),
})

/**
 * JWT claims structure for extracting ChatGPT account ID
 */
interface IdTokenClaims {
	chatgpt_account_id?: string
	account_id?: string
	"https://api.openai.com/auth.chatgpt_account_id"?: string
	organizations?: Array<{ id: string }>
	email?: string
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string
	}
}

/**
 * Parse JWT claims from a token
 * Returns undefined if the token is invalid or cannot be parsed
 */
function parseJwtClaims(token: string): IdTokenClaims | undefined {
	const parts = token.split(".")
	if (parts.length !== 3) return undefined
	try {
		// Use base64url decoding (Node.js Buffer handles this)
		const payload = Buffer.from(parts[1], "base64url").toString("utf-8")
		const claims: unknown = JSON.parse(payload)
		return typeof claims === "object" && claims !== null && !Array.isArray(claims) ? (claims as IdTokenClaims) : undefined
	} catch {
		return undefined
	}
}

/**
 * Extract ChatGPT account ID from JWT claims
 * Checks multiple locations:
 * 1. Root-level chatgpt_account_id
 * 2. Nested under https://api.openai.com/auth
 * 3. First organization ID
 */
function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
	const value =
		claims["https://api.openai.com/auth.chatgpt_account_id"] ||
		claims.chatgpt_account_id ||
		claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
		claims.account_id ||
		claims.organizations?.[0]?.id
	return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined
}

/**
 * Extract ChatGPT account ID from token response
 * Tries id_token first, then access_token
 */
function extractAccountId(tokens: { id_token?: string; access_token: string }): string | undefined {
	// Try id_token first (more reliable source)
	if (tokens.id_token) {
		const claims = parseJwtClaims(tokens.id_token)
		const accountId = claims && extractAccountIdFromClaims(claims)
		if (accountId) return accountId
	}
	// Fall back to access_token
	if (tokens.access_token) {
		const claims = parseJwtClaims(tokens.access_token)
		return claims ? extractAccountIdFromClaims(claims) : undefined
	}
	return undefined
}

class OpenAiCodexOAuthTokenError extends Error {
	public readonly status?: number
	public readonly errorCode?: string

	constructor(message: string, opts?: { status?: number; errorCode?: string }) {
		super(message)
		this.name = "OpenAiCodexOAuthTokenError"
		this.status = opts?.status
		this.errorCode = opts?.errorCode
	}

	public isLikelyInvalidGrant(): boolean {
		if (this.errorCode && /invalid_grant/i.test(this.errorCode)) {
			return true
		}
		if (this.status === 400 || this.status === 401 || this.status === 403) {
			return /invalid_grant|revoked|expired|invalid refresh/i.test(this.message)
		}
		return false
	}
}

function parseOAuthErrorDetails(errorText: string): { errorCode?: string } {
	try {
		const json: unknown = JSON.parse(errorText)
		if (!json || typeof json !== "object") {
			return {}
		}

		const obj = json as Record<string, unknown>
		const errorField = obj.error

		const errorCode: string | undefined =
			typeof errorField === "string"
				? errorField
				: errorField && typeof errorField === "object" && typeof (errorField as Record<string, unknown>).type === "string"
					? ((errorField as Record<string, unknown>).type as string)
					: undefined

		return { errorCode }
	} catch {
		return {}
	}
}

async function oauthResponseError(operation: "exchange" | "refresh", response: Response): Promise<OpenAiCodexOAuthTokenError> {
	let errorCode: string | undefined
	try {
		const details = parseOAuthErrorDetails(await response.text())
		if (details.errorCode && /^[a-z0-9_.-]{1,80}$/i.test(details.errorCode)) errorCode = details.errorCode
	} catch {
		// Keep error bodies out of logs and user facing messages.
	}
	return new OpenAiCodexOAuthTokenError(
		`Token ${operation} failed (HTTP ${response.status}).${errorCode ? ` Error: ${errorCode}.` : ""}`,
		{ status: response.status, errorCode },
	)
}

/**
 * Generates a cryptographically random PKCE code verifier
 * Must be 43-128 characters long using unreserved characters
 */
export function generateCodeVerifier(): string {
	const buffer = crypto.randomBytes(64)
	return buffer.toString("base64url")
}

/**
 * Generates the PKCE code challenge from the verifier using S256 method
 */
export function generateCodeChallenge(verifier: string): string {
	const hash = crypto.createHash("sha256").update(verifier).digest()
	return hash.toString("base64url")
}

/**
 * Generates a random state parameter for CSRF protection
 */
export function generateState(): string {
	return crypto.randomBytes(32).toString("base64url")
}

/**
 * Builds the authorization URL for OpenAI Codex OAuth flow
 * Includes Codex-specific parameters per the implementation guide
 */
export function buildAuthorizationUrl(
	codeChallenge: string,
	state: string,
	redirectUri: string = OPENAI_CODEX_OAUTH_CONFIG.redirectUri,
): string {
	const params = new URLSearchParams({
		client_id: OPENAI_CODEX_OAUTH_CONFIG.clientId,
		redirect_uri: redirectUri,
		scope: OPENAI_CODEX_OAUTH_CONFIG.scopes,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		response_type: "code",
		state,
		id_token_add_organizations: "true",
		// Codex-specific parameters
		codex_cli_simplified_flow: "true",
		originator: "dietcode",
	})

	return `${OPENAI_CODEX_OAUTH_CONFIG.authorizationEndpoint}?${params.toString()}`
}

interface PendingCodexAuthorization {
	codeVerifier: string
	state: string
	redirectUri: string
	server?: http.Server
	timeout?: NodeJS.Timeout
	callback: Promise<OpenAiCodexCredentials>
	resolve: (credentials: OpenAiCodexCredentials) => void
	reject: (error: Error) => void
	callbackAccepted: boolean
	finished: boolean
	generation: number
	abortController: AbortController
}

function writeCallbackPage(response: http.ServerResponse, outcome: "success" | "cancelled" | "failed"): void {
	if (response.destroyed || response.headersSent) return
	const pages = {
		success: ["Sign-in complete", "OpenAI Codex is connected. Return to LUMI to choose a model."],
		cancelled: ["Sign-in cancelled", "No changes were made to your existing connection. Return to LUMI to try again."],
		failed: ["Sign-in incomplete", "LUMI could not finish connecting this account. Return to LUMI and try again."],
	} as const
	const [title, message] = pages[outcome]
	response.writeHead(outcome === "success" ? 200 : outcome === "cancelled" ? 400 : 502, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store, max-age=0",
		"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
	})
	response.end(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · LUMI</title><style>body{font:16px system-ui,sans-serif;max-width:36rem;margin:18vh auto;padding:0 1.5rem;color:#e5e7eb;background:#111827}h1{font-size:1.7rem}p{line-height:1.6;color:#b7c0ce}</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`,
	)
}

/**
 * Exchanges the authorization code for tokens
 * Important: Uses application/x-www-form-urlencoded (not JSON)
 * Important: state must NOT be included in token exchange body
 */
export async function exchangeCodeForTokens(
	code: string,
	codeVerifier: string,
	redirectUri: string = OPENAI_CODEX_OAUTH_CONFIG.redirectUri,
	signal?: AbortSignal,
): Promise<OpenAiCodexCredentials> {
	// Per the implementation guide: use application/x-www-form-urlencoded
	// and do NOT include state in the body (OpenAI returns error if included)
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: OPENAI_CODEX_OAUTH_CONFIG.clientId,
		code,
		redirect_uri: redirectUri,
		code_verifier: codeVerifier,
	})

	if (signal?.aborted) throw new Error("OpenAI Codex sign-in was cancelled.")
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 30_000)
	const abortFromCaller = () => controller.abort()
	signal?.addEventListener("abort", abortFromCaller, { once: true })
	try {
		const response = await fetch(OPENAI_CODEX_OAUTH_CONFIG.tokenEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: body.toString(),
			signal: controller.signal,
		})
		if (!response.ok) throw await oauthResponseError("exchange", response)

		const tokenResponse = tokenResponseSchema.parse(await response.json())

		if (!tokenResponse.refresh_token) throw new Error("Token exchange did not return a refresh_token")

		// Per the implementation guide: expires is in milliseconds since epoch.
		const expiresAt = Date.now() + tokenResponse.expires_in * 1000

		const accountId = extractAccountId({ id_token: tokenResponse.id_token, access_token: tokenResponse.access_token })

		return {
			type: "openai-codex",
			access_token: tokenResponse.access_token,
			refresh_token: tokenResponse.refresh_token,
			expires: expiresAt,
			email: tokenResponse.email,
			accountId,
		}
	} catch (error) {
		if (signal?.aborted) throw new Error("OpenAI Codex sign-in was cancelled.")
		if (controller.signal.aborted) throw new Error("OpenAI Codex token exchange timed out. Try signing in again.")
		throw error
	} finally {
		clearTimeout(timeout)
		signal?.removeEventListener("abort", abortFromCaller)
	}
}

/**
 * Refreshes the access token using the refresh token
 * Uses application/x-www-form-urlencoded (not JSON)
 */
export async function refreshAccessToken(credentials: OpenAiCodexCredentials): Promise<OpenAiCodexCredentials> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: OPENAI_CODEX_OAUTH_CONFIG.clientId,
		refresh_token: credentials.refresh_token,
	})

	const response = await fetch(OPENAI_CODEX_OAUTH_CONFIG.tokenEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: body.toString(),
		signal: AbortSignal.timeout(30000),
	})

	if (!response.ok) {
		throw await oauthResponseError("refresh", response)
	}

	const data = await response.json()
	const tokenResponse = tokenResponseSchema.parse(data)

	// Per the implementation guide: expires is in milliseconds since epoch
	const expiresAt = Date.now() + tokenResponse.expires_in * 1000

	// Extract new account ID from refreshed tokens, or preserve existing one
	const newAccountId = extractAccountId({
		id_token: tokenResponse.id_token,
		access_token: tokenResponse.access_token,
	})

	return {
		type: "openai-codex",
		access_token: tokenResponse.access_token,
		refresh_token: tokenResponse.refresh_token ?? credentials.refresh_token,
		expires: expiresAt,
		email: tokenResponse.email ?? credentials.email,
		// Prefer newly extracted accountId, fall back to existing
		accountId: newAccountId ?? credentials.accountId,
	}
}

/**
 * Checks if the credentials are expired (with 5 minute buffer)
 * Per the implementation guide: expires is in milliseconds since epoch
 */
export function isTokenExpired(credentials: OpenAiCodexCredentials): boolean {
	const bufferMs = 5 * 60 * 1000 // 5 minutes buffer
	return Date.now() >= credentials.expires - bufferMs
}

/**
 * OpenAiCodexOAuthManager - Handles OAuth flow and token management
 */
export class OpenAiCodexOAuthManager {
	private cachedModels: Record<string, ModelInfo> = {}
	private cachedModelsAt = 0
	private credentials: OpenAiCodexCredentials | null = null
	private refreshPromise: Promise<OpenAiCodexCredentials> | null = null
	private credentialGeneration = 0
	private authorizationGeneration = 0
	private credentialWriteQueue: Promise<void> = Promise.resolve()
	private pendingAuth: PendingCodexAuthorization | null = null

	private async serializeCredentialWrite<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.credentialWriteQueue
		let release!: () => void
		this.credentialWriteQueue = new Promise<void>((resolve) => {
			release = resolve
		})
		await previous
		try {
			return await operation()
		} finally {
			release()
		}
	}

	/**
	 * Force a refresh using the stored refresh token even if the access token is not expired.
	 * Useful when the server invalidates an access token early.
	 */
	async forceRefreshAccessToken(): Promise<string | null> {
		try {
			const credentials = await this.refreshCredentials(true)
			return credentials?.access_token ?? null
		} catch (error) {
			Logger.error("[openai-codex-oauth] Failed to force refresh token:", error)
			return null
		}
	}

	private async refreshCredentials(force: boolean): Promise<OpenAiCodexCredentials | null> {
		if (!this.credentials) await this.loadCredentials()
		if (!this.credentials) return null
		if (!force && !isTokenExpired(this.credentials)) return this.credentials
		if (this.refreshPromise) return this.refreshPromise

		const previous = this.credentials
		const generation = this.credentialGeneration
		const refresh = (async () => {
			const refreshed = await refreshAccessToken(previous)
			if (generation !== this.credentialGeneration || this.credentials?.refresh_token !== previous.refresh_token) {
				throw new Error("OpenAI Codex sign-in changed while refreshing credentials")
			}
			await this.saveCredentials(refreshed, generation)
			return refreshed
		})()
		this.refreshPromise = refresh
		try {
			return await refresh
		} catch (error) {
			if (
				generation === this.credentialGeneration &&
				error instanceof OpenAiCodexOAuthTokenError &&
				error.isLikelyInvalidGrant()
			) {
				Logger.log("[openai-codex-oauth] Refresh token is invalid; clearing stored credentials")
				await this.clearCredentials()
			}
			throw error
		} finally {
			if (this.refreshPromise === refresh) this.refreshPromise = null
		}
	}

	/**
	 * Load credentials from storage via StateManager.
	 */
	async loadCredentials(): Promise<OpenAiCodexCredentials | null> {
		const generation = this.credentialGeneration
		try {
			const stateManager = StateManager.get()
			const credentialsJson = stateManager.getSecretKey(OPENAI_CODEX_CREDENTIALS_KEY)

			if (!credentialsJson) {
				return null
			}

			const parsed = JSON.parse(credentialsJson)
			const credentials = openAiCodexCredentialsSchema.parse(parsed)
			if (generation === this.credentialGeneration) this.credentials = credentials
			return this.credentials
		} catch (error) {
			Logger.error("[openai-codex-oauth] Failed to load stored credentials:", error)
			return null
		}
	}

	/**
	 * Save credentials to storage via StateManager
	 */
	async saveCredentials(credentials: OpenAiCodexCredentials, expectedGeneration?: number): Promise<void> {
		await this.serializeCredentialWrite(async () => {
			if (expectedGeneration !== undefined && expectedGeneration !== this.credentialGeneration) {
				throw new Error("OpenAI Codex authentication changed before credentials could be saved")
			}
			const stateManager = StateManager.get()
			const previous = stateManager.getSecretKey(OPENAI_CODEX_CREDENTIALS_KEY)
			stateManager.setSecret(OPENAI_CODEX_CREDENTIALS_KEY, JSON.stringify(credentials))
			try {
				await stateManager.flushPendingState()
			} catch (error) {
				stateManager.setSecret(OPENAI_CODEX_CREDENTIALS_KEY, previous)
				await stateManager
					.flushPendingState()
					.catch((restoreError) => Logger.error("[openai-codex-oauth] Failed to restore credentials:", restoreError))
				throw error
			}
			if (expectedGeneration !== undefined && expectedGeneration !== this.credentialGeneration) {
				stateManager.setSecret(OPENAI_CODEX_CREDENTIALS_KEY, previous)
				await stateManager
					.flushPendingState()
					.catch((error) => Logger.error("[openai-codex-oauth] Failed to restore credentials:", error))
				throw new Error("OpenAI Codex authentication changed before credentials could be saved")
			}
			this.credentials = credentials
			this.cachedModels = {}
			this.cachedModelsAt = 0
		})
	}

	/**
	 * Clear credentials from storage
	 */
	async clearCredentials(): Promise<void> {
		this.credentialGeneration += 1
		this.refreshPromise = null
		this.credentials = null
		this.cachedModels = {}
		this.cachedModelsAt = 0
		await this.serializeCredentialWrite(async () => {
			const stateManager = StateManager.get()
			const previous = stateManager.getSecretKey(OPENAI_CODEX_CREDENTIALS_KEY)
			stateManager.setSecret(OPENAI_CODEX_CREDENTIALS_KEY, undefined)
			try {
				await stateManager.flushPendingState()
			} catch (error) {
				stateManager.setSecret(OPENAI_CODEX_CREDENTIALS_KEY, previous)
				await stateManager
					.flushPendingState()
					.catch((restoreError) =>
						Logger.error("[openai-codex-oauth] Failed to restore credentials after sign-out error:", restoreError),
					)
				throw error
			}
		})
	}

	/**
	 * Get a valid access token, refreshing if necessary
	 */
	async getAccessToken(): Promise<string | null> {
		try {
			const credentials = await this.refreshCredentials(false)
			return credentials?.access_token ?? null
		} catch (error) {
			Logger.error("[openai-codex-oauth] Failed to refresh token:", error)
			return null
		}
	}

	/**
	 * Get the user's email from credentials
	 */
	async getEmail(): Promise<string | null> {
		if (!this.credentials) {
			await this.loadCredentials()
		}
		return this.credentials?.email || null
	}

	/**
	 * Get the ChatGPT account ID from credentials
	 * Used for the ChatGPT-Account-Id header required by the Codex API
	 */
	async getAccountId(): Promise<string | null> {
		if (!this.credentials) {
			await this.loadCredentials()
		}
		return this.credentials?.accountId || null
	}

	/**
	 * Check if the user has stored credentials (i.e. has completed auth).
	 * This intentionally does NOT attempt a token refresh so that transient
	 * network failures or expired-but-refreshable tokens don't cause the
	 * CLI to bounce the user back to the onboarding flow.
	 */
	async isAuthenticated(): Promise<boolean> {
		if (!this.credentials) {
			await this.loadCredentials()
		}
		return this.credentials !== null
	}

	/**
	 * Load the model catalog exposed by the signed-in ChatGPT Codex account.
	 * Results are cached briefly so opening settings and starting a turn do not
	 * create a burst of identical catalog requests.
	 */
	async listModels(forceRefresh = false): Promise<Record<string, ModelInfo>> {
		if (
			!forceRefresh &&
			this.cachedModelsAt > Date.now() - CODEX_MODELS_CACHE_MS &&
			Object.keys(this.cachedModels).length > 0
		) {
			return { ...this.cachedModels }
		}
		const requestCatalog = async (token: string): Promise<Response> => {
			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), 8_000)
			try {
				const accountId = await this.getAccountId()
				return await fetch(
					`${CODEX_MODELS_ENDPOINT}?client_version=${encodeURIComponent(ExtensionRegistryInfo.version)}`,
					{
						headers: {
							Accept: "application/json",
							Authorization: `Bearer ${token}`,
							originator: "dietcode",
							"User-Agent": `dietcode/${ExtensionRegistryInfo.version}`,
							...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
						},
						signal: controller.signal,
					},
				)
			} catch (error) {
				if (controller.signal.aborted) throw new Error("OpenAI Codex model catalog request timed out after 8 seconds")
				throw error
			} finally {
				clearTimeout(timer)
			}
		}

		let token = await this.getAccessToken()
		if (!token) throw new Error("Not signed in to OpenAI Codex. Sign in from provider settings and try again.")
		let response = await requestCatalog(token)
		if (response.status === 401) {
			await response.body?.cancel().catch(() => undefined)
			token = (await this.forceRefreshAccessToken()) ?? ""
			if (!token) throw new Error("OpenAI Codex rejected the session. Sign out, then sign in again.")
			response = await requestCatalog(token)
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined)
			throw new Error(`OpenAI Codex model catalog request failed (HTTP ${response.status})`)
		}
		let payload: unknown
		try {
			payload = await response.json()
		} catch {
			throw new Error("OpenAI Codex returned an invalid model catalog")
		}
		const models = normalizeOpenAiCodexModels(payload)
		if (Object.keys(models).length === 0) throw new Error("OpenAI Codex returned no usable models for this account")
		this.cachedModels = models
		this.cachedModelsAt = Date.now()
		return { ...models }
	}

	/** Start the callback listener before returning a URL that can open the browser. */
	async startAuthorizationFlow(): Promise<string> {
		this.cancelAuthorizationFlow()
		this.credentialGeneration += 1
		const codeVerifier = generateCodeVerifier()
		const codeChallenge = generateCodeChallenge(codeVerifier)
		const generation = ++this.authorizationGeneration
		let resolve!: (credentials: OpenAiCodexCredentials) => void
		let reject!: (error: Error) => void
		const callback = new Promise<OpenAiCodexCredentials>((res, rej) => {
			resolve = res
			reject = rej
		})
		void callback.catch(() => undefined)
		const pending: PendingCodexAuthorization = {
			codeVerifier,
			state: generateState(),
			redirectUri: OPENAI_CODEX_OAUTH_CONFIG.redirectUri,
			callback,
			resolve,
			reject,
			callbackAccepted: false,
			finished: false,
			generation,
			abortController: new AbortController(),
		}
		this.pendingAuth = pending

		try {
			const port = await this.listenForCallback(pending)
			if (pending.finished || this.pendingAuth !== pending || generation !== this.authorizationGeneration) {
				throw new Error("OpenAI Codex sign-in was cancelled.")
			}
			pending.redirectUri = `http://localhost:${port}${CALLBACK_PATH}`
			return buildAuthorizationUrl(codeChallenge, pending.state, pending.redirectUri)
		} catch (error) {
			this.finishAuthorization(pending, error instanceof Error ? error : new Error(String(error)))
			throw error
		}
	}

	private async listenForCallback(pending: PendingCodexAuthorization): Promise<number> {
		for (const port of CALLBACK_PORTS) {
			try {
				await new Promise<void>((resolve, reject) => {
					let listening = false
					const server = http.createServer({ maxHeaderSize: 8 * 1024 }, (request, response) => {
						void this.handleCallback(pending, request, response)
					})
					pending.server = server
					server.on("error", (error: NodeJS.ErrnoException) => {
						if (!listening) reject(error)
						else
							this.finishAuthorization(
								pending,
								new Error("The local OpenAI Codex callback listener stopped unexpectedly."),
							)
					})
					server.listen(port, "127.0.0.1", () => {
						listening = true
						if (pending.finished || this.pendingAuth !== pending) {
							server.close()
							reject(new Error("OpenAI Codex sign-in was cancelled."))
							return
						}
						resolve()
					})
				})
				if (pending.finished || this.pendingAuth !== pending) {
					throw new Error("OpenAI Codex sign-in was cancelled.")
				}
				pending.timeout = setTimeout(
					() =>
						this.finishAuthorization(
							pending,
							new Error("OpenAI Codex sign-in timed out. Start a new sign-in to try again."),
						),
					CALLBACK_TIMEOUT_MS,
				)
				pending.timeout.unref?.()
				return port
			} catch (error) {
				try {
					pending.server?.close()
				} catch {
					// The listener may not have started.
				}
				pending.server = undefined
				if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && port !== CALLBACK_PORTS.at(-1)) continue
				if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
					throw new Error(
						"OpenAI Codex sign-in could not reserve a local callback port. Close another sign-in and try again.",
					)
				}
				throw error
			}
		}
		throw new Error("OpenAI Codex sign-in could not start its local callback listener.")
	}

	private async handleCallback(
		pending: PendingCodexAuthorization,
		request: http.IncomingMessage,
		response: http.ServerResponse,
	): Promise<void> {
		if (request.method !== "GET") {
			response.writeHead(405, { Allow: "GET", "Cache-Control": "no-store" }).end()
			return
		}

		let url: URL
		try {
			url = new URL(request.url || "/", pending.redirectUri)
		} catch {
			response.writeHead(400, { "Cache-Control": "no-store" }).end()
			return
		}
		if (url.origin !== new URL(pending.redirectUri).origin) {
			response.writeHead(400, { "Cache-Control": "no-store" }).end()
			return
		}
		if (url.pathname !== CALLBACK_PATH) {
			response.writeHead(404, { "Cache-Control": "no-store" }).end()
			return
		}
		if (pending.finished || pending.callbackAccepted) {
			response.writeHead(409, { "Cache-Control": "no-store" }).end()
			return
		}

		const states = url.searchParams.getAll("state")
		if (states.length !== 1 || states[0] !== pending.state) {
			writeCallbackPage(response, "failed")
			return
		}

		const oauthErrors = url.searchParams.getAll("error")
		if (oauthErrors.length > 1) {
			writeCallbackPage(response, "failed")
			return
		}
		if (oauthErrors.length === 1) {
			pending.callbackAccepted = true
			const cancelled = oauthErrors[0] === "access_denied"
			writeCallbackPage(response, cancelled ? "cancelled" : "failed")
			this.finishAuthorization(
				pending,
				new Error(cancelled ? "OpenAI Codex sign-in was cancelled." : "OpenAI Codex could not complete sign-in."),
			)
			return
		}

		const codes = url.searchParams.getAll("code")
		if (codes.length !== 1 || !codes[0]) {
			writeCallbackPage(response, "failed")
			return
		}
		pending.callbackAccepted = true

		try {
			const credentials = await exchangeCodeForTokens(
				codes[0],
				pending.codeVerifier,
				pending.redirectUri,
				pending.abortController.signal,
			)
			if (this.pendingAuth !== pending || pending.generation !== this.authorizationGeneration) {
				throw new Error("OpenAI Codex sign-in was cancelled.")
			}
			this.credentialGeneration += 1
			this.refreshPromise = null
			await this.saveCredentials(credentials, this.credentialGeneration)
			writeCallbackPage(response, "success")
			this.finishAuthorization(pending, undefined, credentials)
		} catch (error) {
			writeCallbackPage(response, "failed")
			const safeError = error instanceof Error ? error : new Error("OpenAI Codex could not complete sign-in.")
			this.finishAuthorization(pending, safeError)
		}
	}

	private finishAuthorization(pending: PendingCodexAuthorization, error?: Error, credentials?: OpenAiCodexCredentials): void {
		if (pending.finished) return
		pending.finished = true
		if (pending.timeout) clearTimeout(pending.timeout)
		if (error) pending.abortController.abort()
		try {
			pending.server?.close()
		} catch {
			// Closing an already stopped listener is harmless.
		}
		if (this.pendingAuth === pending) this.pendingAuth = null
		if (error) pending.reject(error)
		else if (credentials) pending.resolve(credentials)
		else pending.reject(new Error("OpenAI Codex sign-in ended without credentials."))
	}

	/** Wait for the callback from the already-listening local server. */
	waitForCallback(): Promise<OpenAiCodexCredentials> {
		if (!this.pendingAuth) throw new Error("No pending authorization flow")
		return this.pendingAuth.callback
	}

	/** Expose only the flow state needed to keep the provider settings UI in sync. */
	isAuthorizationPending(): boolean {
		return this.pendingAuth !== null && !this.pendingAuth.finished
	}

	/** Cancel any pending authorization flow. */
	cancelAuthorizationFlow(): void {
		this.authorizationGeneration += 1
		if (this.pendingAuth) {
			this.credentialGeneration += 1
			this.finishAuthorization(this.pendingAuth, new Error("OpenAI Codex sign-in was cancelled."))
		}
	}
}

// Singleton instance
export const openAiCodexOAuthManager = new OpenAiCodexOAuthManager()
