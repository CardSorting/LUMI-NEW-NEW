import { setTimeout as sleep } from "node:timers/promises"
import { Logger } from "@/shared/services/Logger"

interface RetryOptions {
	/** Total attempts, including the first request (legacy option name). */
	maxRetries?: number
	baseDelay?: number
	maxDelay?: number
	/** Also retry transient network/server failures; never authentication, invalid requests or cancellation. */
	retryAllErrors?: boolean
	signal?: AbortSignal
}

const exhaustedErrors = new WeakSet<object>()
const rememberExhausted = (error: unknown) => {
	if (error !== null && typeof error === "object") exhaustedErrors.add(error)
}

export class RetriableError extends Error {
	status = 429
	constructor(
		message: string,
		public retryAfter?: number,
		options?: ErrorOptions,
	) {
		super(message, options)
		this.name = "RetriableError"
	}
}

export function shouldRetryApiError(error: unknown, retryAllErrors = false): boolean {
	if (error === null || typeof error !== "object" || exhaustedErrors.has(error)) return false
	const { status, statusCode, name, code, response } = error as Record<string, unknown>
	if (name === "AbortError" || name === "APIUserAbortError" || code === "ABORT_ERR" || code === "ERR_CANCELED") return false
	const httpStatus = Number(status ?? statusCode ?? (response as { status?: number } | undefined)?.status)
	if (httpStatus === 429 || error instanceof RetriableError) return true
	if (!retryAllErrors) return false
	if (httpStatus >= 400 && httpStatus < 500) return httpStatus === 408 || httpStatus === 409
	return !Number.isFinite(httpStatus) || httpStatus >= 500
}

function retryOptions(options: RetryOptions) {
	const finite = (value: number | undefined, fallback: number) => (Number.isFinite(value) ? value! : fallback)
	return {
		maxRetries: Math.min(5, Math.max(1, Math.floor(finite(options.maxRetries, 3)))),
		baseDelay: Math.max(1, finite(options.baseDelay, 1000)),
		maxDelay: Math.min(60_000, Math.max(1, finite(options.maxDelay, 10_000))),
		retryAllErrors: options.retryAllErrors ?? false,
	}
}

/** Returns undefined when the server asks us to wait beyond the automatic retry budget. */
export function getApiRetryDelay(error: unknown, attempt: number, baseDelay = 1000, maxDelay = 10_000): number | undefined {
	const fallback = Math.min(maxDelay, baseDelay * 2 ** Math.min(attempt, 10))
	const data = (error ?? {}) as {
		headers?: Record<string, string> | Headers
		response?: { headers?: Record<string, string> | Headers }
		retryAfter?: number
	}
	const headers = data.headers ?? data.response?.headers
	const header = (key: string) =>
		typeof headers?.get === "function" ? headers.get(key) : (headers as Record<string, string> | undefined)?.[key]
	const retryAfter = header("retry-after")
	const reset = header("x-ratelimit-reset") ?? header("ratelimit-reset")
	const raw = retryAfter ?? reset ?? data.retryAfter
	if (raw === undefined || raw === null || raw === "") return fallback
	const value = Number(raw)
	let delay: number
	if (Number.isFinite(value)) {
		// Reset headers are timestamps. Keep legacy epoch-style retryAfter support without timer overflow.
		const epoch = (retryAfter == null && reset != null) || value >= 1_000_000_000
		delay = epoch ? value * 1000 - Date.now() : value * 1000
	} else {
		delay = Date.parse(String(raw)) - Date.now()
	}
	if (!Number.isFinite(delay) || delay <= 0) return fallback
	// Do not retry sooner than the server permits, or turn a huge timeout into a 1ms Node timer.
	return delay > maxDelay ? undefined : Math.ceil(delay)
}

export async function waitForApiRetry(delay: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted()
	await sleep(delay, undefined, { signal })
	signal?.throwIfAborted()
}

export function withRetry(options: RetryOptions = {}) {
	const { maxRetries, baseDelay, maxDelay, retryAllErrors } = retryOptions(options)
	return (_target: any, _propertyKey: string, descriptor: PropertyDescriptor) => {
		const originalMethod = descriptor.value
		descriptor.value = async function* (...args: any[]) {
			const handler = this as {
				options?: { getRetrySignal?: () => AbortSignal; onRetryAttempt?: (...args: any[]) => unknown }
			}
			const signal = options.signal ?? handler.options?.getRetrySignal?.()
			for (let attempt = 0; attempt < maxRetries; attempt++) {
				signal?.throwIfAborted()
				let emitted = false
				try {
					for await (const chunk of originalMethod.apply(this, args)) {
						signal?.throwIfAborted()
						emitted = true
						yield chunk
					}
					return
				} catch (error) {
					signal?.throwIfAborted()
					const retryable = shouldRetryApiError(error, retryAllErrors)
					const delay = getApiRetryDelay(error, attempt, baseDelay, maxDelay)
					if (emitted || !retryable || attempt === maxRetries - 1 || delay === undefined) {
						// Parent/helper recovery must not multiply a provider's exhausted retry budget.
						if (!emitted && retryable) rememberExhausted(error)
						throw error
					}
					try {
						await handler.options?.onRetryAttempt?.(attempt + 1, maxRetries, delay, error)
					} catch (callbackError) {
						Logger.error("Error in onRetryAttempt callback:", callbackError)
					}
					await waitForApiRetry(delay, signal)
				}
			}
		}
		return descriptor
	}
}

export async function asyncRetry<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {},
	onRetry?: (attempt: number, error: any, delay: number) => Promise<void> | void,
): Promise<T> {
	const { maxRetries, baseDelay, maxDelay, retryAllErrors } = retryOptions(options)
	for (let attempt = 0; ; attempt++) {
		options.signal?.throwIfAborted()
		try {
			return await fn()
		} catch (error) {
			options.signal?.throwIfAborted()
			const retryable = shouldRetryApiError(error, retryAllErrors)
			const delay = getApiRetryDelay(error, attempt, baseDelay, maxDelay)
			if (!retryable || attempt >= maxRetries - 1 || delay === undefined) {
				if (retryable) rememberExhausted(error)
				throw error
			}
			await onRetry?.(attempt + 1, error, delay)
			await waitForApiRetry(delay, options.signal)
		}
	}
}
