/** Release a cancelled task's wait while still observing the underlying prerequisite's eventual outcome. */
export function waitForTaskPrerequisite<T>(prerequisite: PromiseLike<T> | T, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason)
		if (signal.aborted) onAbort()
		else signal.addEventListener("abort", onAbort, { once: true })
		Promise.resolve(prerequisite).then(
			(value) => {
				signal.removeEventListener("abort", onAbort)
				resolve(value)
			},
			(error) => {
				signal.removeEventListener("abort", onAbort)
				reject(error)
			},
		)
	})
}
