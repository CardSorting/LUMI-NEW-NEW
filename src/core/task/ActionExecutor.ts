import { Logger } from "@/shared/services/Logger"

export interface ExecuteOptions {
	/** Optional caller deadline. Tools otherwise own their operation timeout. */
	timeoutMs?: number
	/** Total attempts, including the first. Repetition requires idempotent: true. */
	maxRetries?: number
	idempotent?: boolean
	backoffMs?: number
	concurrencyGroup?: string
	signal?: AbortSignal
	/** Let an already-started atomic write settle before its caller can revert/reset shared state. */
	settleOnAbort?: boolean
}

interface Waiter {
	start: () => void
}
interface Lane {
	active: number
	queue: Waiter[]
}

/** Task-scoped FIFO scheduling. Mutating actions execute once unless explicitly safe to repeat. */
export class ActionExecutor {
	private lanes = new Map<string, Lane>()
	private readonly concurrency = 5

	async execute<T>(taskId: string, operation: (signal: AbortSignal) => Promise<T>, options: ExecuteOptions = {}): Promise<T> {
		const requestedAttempts = options.maxRetries ?? 3
		const attempts =
			options.idempotent && Number.isFinite(requestedAttempts) ? Math.max(1, Math.min(5, Math.floor(requestedAttempts))) : 1
		const lane = JSON.stringify([taskId, options.concurrencyGroup ?? "default"])
		for (let attempt = 1; ; attempt++) {
			options.signal?.throwIfAborted()
			const release = await this.acquire(lane, options.signal)
			const controller = new AbortController()
			// Retain the slot until the actual work settles, even if its caller stops waiting.
			const work = Promise.resolve()
				.then(() => {
					options.signal?.throwIfAborted()
					controller.signal.throwIfAborted()
					return operation(controller.signal)
				})
				.finally(release)
			try {
				return await this.observe(work, controller, options)
			} catch (error) {
				if (attempt >= attempts || options.signal?.aborted || controller.signal.aborted || !this.isRetryable(error))
					throw error
				const base = options.backoffMs ?? 500
				const delay = Math.min(30_000, (Number.isFinite(base) ? Math.max(0, base) : 500) * 2 ** (attempt - 1))
				Logger.warn(`[ActionExecutor] Retrying idempotent action for ${taskId} (${attempt + 1}/${attempts})`)
				await new Promise<void>((resolve, reject) => {
					const finish = () => {
						options.signal?.removeEventListener("abort", cancel)
						resolve()
					}
					const timer = setTimeout(finish, delay)
					const cancel = () => {
						clearTimeout(timer)
						options.signal?.removeEventListener("abort", cancel)
						reject(options.signal?.reason)
					}
					options.signal?.addEventListener("abort", cancel, { once: true })
					if (options.signal?.aborted) cancel()
				})
			}
		}
	}

	private acquire(key: string, signal?: AbortSignal): Promise<() => void> {
		signal?.throwIfAborted()
		let lane = this.lanes.get(key)
		if (!lane) {
			lane = { active: 0, queue: [] }
			this.lanes.set(key, lane)
		}
		const current = lane
		return new Promise((resolve, reject) => {
			const waiter: Waiter = {
				start: () => {
					signal?.removeEventListener("abort", cancel)
					let released = false
					resolve(() => {
						if (released) return
						released = true
						const next = current.queue.shift()
						// Transfer the occupied slot directly; a new arrival cannot jump the queue.
						if (next) next.start()
						else if (--current.active === 0) this.lanes.delete(key)
					})
				},
			}
			const cancel = () => {
				const index = current.queue.indexOf(waiter)
				if (index !== -1) current.queue.splice(index, 1)
				signal?.removeEventListener("abort", cancel)
				reject(signal?.reason)
			}
			if (current.active < this.concurrency) {
				current.active++
				waiter.start()
			} else {
				current.queue.push(waiter)
				signal?.addEventListener("abort", cancel, { once: true })
			}
		})
	}

	private observe<T>(work: Promise<T>, controller: AbortController, options: ExecuteOptions): Promise<T> {
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined
			const cleanup = () => {
				clearTimeout(timer)
				options.signal?.removeEventListener("abort", cancel)
			}
			const stop = (reason: unknown) => {
				cleanup()
				controller.abort(reason)
				reject(reason)
			}
			const cancel = () => {
				if (options.settleOnAbort) {
					cleanup()
					controller.abort(options.signal?.reason)
				} else stop(options.signal?.reason)
			}
			options.signal?.addEventListener("abort", cancel, { once: true })
			if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
				timer = setTimeout(
					() =>
						stop(
							new Error(
								"Action deadline exceeded. The operation may still be running; inspect its result before retrying.",
							),
						),
					options.timeoutMs,
				)
			}
			work.then(
				(value) => {
					cleanup()
					resolve(value)
				},
				(error) => {
					cleanup()
					reject(error)
				},
			)
			if (options.signal?.aborted) cancel()
		})
	}

	private isRetryable(error: unknown): boolean {
		const message = (error instanceof Error ? error.message : String(error)).toUpperCase()
		// Timeout/cancellation leaves the outcome unknown, even for nominally idempotent work.
		if (/ABORT|CANCEL|TIME.?OUT|TIMED OUT|DEADLINE/.test(message)) return false
		return /CONTENTION|SQLITE_BUSY|SQLITE_LOCKED|RATE_LIMIT|UNAVAILABLE/.test(message)
	}
}

export const executor = new ActionExecutor()
