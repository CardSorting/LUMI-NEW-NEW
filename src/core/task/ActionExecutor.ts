import { Logger } from "@/shared/services/Logger"
import { ActionExecutionRegistry, type ActionIdentity } from "./ActionExecutionRegistry"

export interface ExecuteOptions {
	/** Stable semantic input. Duplicate queued/running work is rejected with its existing execution ID. */
	execution?: ActionIdentity
	/** Optional caller deadline. Tools otherwise own their operation timeout. */
	timeoutMs?: number
	/** Maximum wait for a slot, separate from the operation deadline. Defaults to 30 seconds. */
	queueTimeoutMs?: number
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
	executionId?: string
}
interface Lane {
	taskId: string
	group: string
	concurrency: number
	active: number
	running: Set<Waiter>
	queue: Waiter[]
}

export interface ActionQueueSnapshot {
	group: string
	concurrency: number
	occupied_slots: number
	active_execution_ids: string[]
	untracked_active: number
	queue: { position: number; execution_id?: string }[]
}

/** Task-scoped FIFO scheduling. Mutating actions execute once unless explicitly safe to repeat. */
export class ActionExecutor {
	readonly executions = new ActionExecutionRegistry()
	private lanes = new Map<string, Lane>()
	private readonly concurrency = 5

	getQueues(taskId: string): ActionQueueSnapshot[] {
		return [...this.lanes.values()]
			.filter((lane) => lane.taskId === taskId)
			.map((lane) => {
				const activeIds = [...lane.running].flatMap((waiter) => (waiter.executionId ? [waiter.executionId] : []))
				return {
					group: lane.group,
					concurrency: lane.concurrency,
					occupied_slots: lane.active,
					active_execution_ids: activeIds,
					untracked_active: lane.active - activeIds.length,
					queue: lane.queue.map((waiter, index) => ({ position: index + 1, execution_id: waiter.executionId })),
				}
			})
	}

	async execute<T>(
		taskId: string,
		operation: (signal: AbortSignal, executionId?: string) => Promise<T>,
		options: ExecuteOptions = {},
	): Promise<T> {
		options.signal?.throwIfAborted()
		const requestedAttempts = options.maxRetries ?? 3
		const attempts =
			options.idempotent && Number.isFinite(requestedAttempts) ? Math.max(1, Math.min(5, Math.floor(requestedAttempts))) : 1
		const group = options.concurrencyGroup ?? "default"
		const helperLane = /^helpers(?::\d+)?$/.test(group)
		const requestedWait = options.queueTimeoutMs ?? 30_000
		const queueTimeout =
			Number.isFinite(requestedWait) && requestedWait > 0
				? Math.min(requestedWait, helperLane ? 20 * 60_000 : 300_000)
				: 30_000
		const entry = options.execution
			? this.executions.claim(taskId, options.execution, {
					concurrency_group: group,
					max_attempts: attempts,
					queue_timeout_ms: queueTimeout,
				})
			: undefined
		for (let attempt = 1; ; attempt++) {
			let release: () => void
			try {
				options.signal?.throwIfAborted()
				this.executions.update(
					entry,
					"queued",
					attempt > 1 ? "Waiting for a slot for the next permitted attempt." : undefined,
				)
				release = await this.acquire(
					taskId,
					group,
					options.signal,
					queueTimeout,
					helperLane ? 3 : this.concurrency,
					entry?.snapshot.execution_id,
				)
			} catch (error) {
				this.executions.finish(
					entry,
					attempt > 1 ? "failed" : "not_started",
					error instanceof Error ? error.message : String(error),
				)
				throw error
			}
			const controller = new AbortController()
			let retrying = false
			let started = false
			// Retain the slot until the actual work settles, even if its caller stops waiting.
			const work = Promise.resolve()
				.then(() => {
					options.signal?.throwIfAborted()
					controller.signal.throwIfAborted()
					started = true
					this.executions.update(entry, "running", undefined, attempt)
					return operation(controller.signal, entry?.snapshot.execution_id)
				})
				.then(
					(result) => {
						let failed = false
						try {
							failed =
								!!result &&
								typeof result === "object" &&
								((entry?.snapshot.kind === "helper" && "status" in result && result.status === "failed") ||
									(entry?.snapshot.kind === "mcp_tool" && "isError" in result && result.isError === true))
						} catch {
							// Unreadable SDK metadata must not discard a settled operation or keep its identity active.
						}
						this.executions.finish(entry, failed ? "failed" : "completed", result)
						return result
					},
					(error) => {
						retrying =
							attempt < attempts &&
							!options.signal?.aborted &&
							!controller.signal.aborted &&
							this.isRetryable(error)
						if (retrying)
							this.executions.update(
								entry,
								"retrying",
								"Retrying an explicitly idempotent operation within its attempt limit.",
							)
						else
							this.executions.finish(
								entry,
								started ? "failed" : "not_started",
								error instanceof Error ? error.message : String(error),
							)
						throw error
					},
				)
				.finally(release)
			try {
				return await this.observe(work, controller, options)
			} catch (error) {
				if (!retrying) {
					this.executions.update(
						entry,
						"awaiting_completion",
						"Caller stopped waiting; the underlying action has not settled. Do not resubmit it.",
					)
					throw error
				}
				const base = options.backoffMs ?? 500
				const delay = Math.min(30_000, (Number.isFinite(base) ? Math.max(0, base) : 500) * 2 ** (attempt - 1))
				Logger.warn(`[ActionExecutor] Retrying idempotent action for ${taskId} (${attempt + 1}/${attempts})`)
				try {
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
				} catch (error) {
					this.executions.finish(
						entry,
						"failed",
						"Action cancelled during retry backoff; no further attempt was started.",
					)
					throw error
				}
			}
		}
	}

	private acquire(
		taskId: string,
		group: string,
		signal?: AbortSignal,
		queueTimeoutMs = 30_000,
		concurrency = this.concurrency,
		executionId?: string,
	): Promise<() => void> {
		signal?.throwIfAborted()
		const key = JSON.stringify([taskId, group])
		let lane = this.lanes.get(key)
		if (!lane) {
			lane = { taskId, group, concurrency, active: 0, running: new Set(), queue: [] }
			this.lanes.set(key, lane)
		}
		const current = lane
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined
			const cleanup = () => {
				clearTimeout(timer)
				signal?.removeEventListener("abort", cancel)
			}
			const waiter: Waiter = {
				executionId,
				start: () => {
					cleanup()
					current.running.add(waiter)
					let released = false
					resolve(() => {
						if (released) return
						released = true
						current.running.delete(waiter)
						const next = current.queue.shift()
						// Transfer the occupied slot directly; a new arrival cannot jump the queue.
						if (next) next.start()
						else if (--current.active === 0) this.lanes.delete(key)
					})
				},
			}
			const remove = (reason: unknown) => {
				const index = current.queue.indexOf(waiter)
				if (index !== -1) current.queue.splice(index, 1)
				cleanup()
				reject(reason)
			}
			const cancel = () => remove(signal?.reason)
			if (current.active < concurrency) {
				current.active++
				waiter.start()
			} else {
				if (current.queue.length >= 100) {
					reject(
						new Error(
							"Action did not start: the task execution queue is full. Inspect existing work before submitting more actions.",
						),
					)
					return
				}
				current.queue.push(waiter)
				signal?.addEventListener("abort", cancel, { once: true })
				timer = setTimeout(
					() =>
						remove(
							new Error(
								"Action did not start: waiting for an execution slot timed out. Earlier work may still be running. Inspect it or continue independent work; do not repeatedly resubmit this action.",
							),
						),
					queueTimeoutMs,
				)
				if (signal?.aborted) cancel()
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
					Math.min(options.timeoutMs, 2_147_483_647),
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
