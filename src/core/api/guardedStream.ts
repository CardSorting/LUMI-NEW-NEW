import { Logger } from "@/shared/services/Logger"

// Reasoning models may take longer to produce their first visible chunk.
export const FIRST_CHUNK_TIMEOUT_MS = 180_000
export const STREAM_IDLE_TIMEOUT_MS = 120_000

export class ApiStreamTimeoutError extends Error {
	readonly code = "ETIMEDOUT"
	constructor(firstChunk: boolean, milliseconds: number) {
		super(`The provider sent no ${firstChunk ? "response" : "new output"} for ${Math.ceil(milliseconds / 1000)} seconds.`)
		this.name = "ApiStreamTimeoutError"
	}
}

/**
 * Bound only provider reads: time spent executing tools or waiting for the user
 * does not consume the idle deadline. A provider that ignores abort/return must
 * not hold up cancellation, recovery, or the next helper in the queue.
 */
export async function* guardedStream<T>(
	createStream: (signal: AbortSignal) => AsyncIterable<T>,
	options: {
		signal: AbortSignal
		abort?: () => void
		firstChunkTimeoutMs?: number
		idleTimeoutMs?: number
	},
): AsyncGenerator<T> {
	options.signal.throwIfAborted()
	const requestController = new AbortController()
	const requestSignal = AbortSignal.any([options.signal, requestController.signal])
	let close: (() => unknown) | undefined
	let completed = false
	let firstChunk = true
	try {
		const iterator = createStream(requestSignal)[Symbol.asyncIterator]()
		close = iterator.return?.bind(iterator)
		while (true) {
			options.signal.throwIfAborted()
			const milliseconds = firstChunk
				? (options.firstChunkTimeoutMs ?? FIRST_CHUNK_TIMEOUT_MS)
				: (options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS)
			let timer: ReturnType<typeof setTimeout> | undefined
			let onAbort: () => void = () => {}
			let next: IteratorResult<T>
			try {
				const interrupted = new Promise<never>((_resolve, reject) => {
					onAbort = () => reject(options.signal.reason)
					options.signal.addEventListener("abort", onAbort, { once: true })
					timer = setTimeout(() => reject(new ApiStreamTimeoutError(firstChunk, milliseconds)), milliseconds)
				})
				next = await Promise.race([
					Promise.resolve().then(() => {
						options.signal.throwIfAborted()
						return iterator.next()
					}),
					interrupted,
				])
				options.signal.throwIfAborted()
			} finally {
				clearTimeout(timer)
				options.signal.removeEventListener("abort", onAbort)
			}
			if (next.done) {
				completed = true
				return
			}
			firstChunk = false
			yield next.value
		}
	} finally {
		// Stop delayed provider retries as well as the active transport. The owning
		// task remains live and can create a fresh request for recovery.
		requestController.abort()
		if (!completed) {
			try {
				options.abort?.()
			} catch (error) {
				Logger.warn("[API] Could not abort interrupted stream:", error)
			}
			// Async generators can queue return() behind a next() that never settles.
			// Observe cleanup failures, but never await uncooperative provider cleanup.
			void Promise.resolve()
				.then(() => close?.())
				.catch((error) => Logger.warn("[API] Interrupted stream cleanup failed:", error))
		}
	}
}
