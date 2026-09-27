import pTimeout from "p-timeout"
import { Logger } from "@/shared/services/Logger"
import type { TaskConfig } from "../types/TaskConfig"

/** Optional presentation gets one bounded wait per invocation. Approval is never routed here. */
export class ToolDisplay {
	private available = true

	constructor(
		protected readonly config: TaskConfig,
		private readonly label: string,
	) {}

	async observe<T>(operation: () => Promise<T>): Promise<T | undefined> {
		if (!this.available || this.config.taskState.abort) return
		try {
			return await pTimeout(Promise.resolve().then(operation), {
				milliseconds: 1_000,
				signal: this.config.taskState.abortSignal,
			})
		} catch (error) {
			this.available = false
			Logger.warn(`${this.label} display unavailable; execution outcome retained:`, error)
			return undefined
		}
	}
}
