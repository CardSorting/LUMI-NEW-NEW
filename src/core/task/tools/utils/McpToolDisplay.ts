import pTimeout from "p-timeout"
import { Logger } from "@/shared/services/Logger"
import type { TaskConfig } from "../types/TaskConfig"

/** One unavailable display disables further observation waits for this invocation. Approval remains separate. */
export class McpToolDisplay {
	private available = true

	constructor(private readonly config: TaskConfig) {}

	async observe(operation: () => Promise<unknown>): Promise<void> {
		if (!this.available || this.config.taskState.abort) return
		try {
			await pTimeout(Promise.resolve().then(operation), { milliseconds: 1_000, signal: this.config.taskState.abortSignal })
		} catch (error) {
			this.available = false
			Logger.warn("MCP display unavailable; execution outcome retained:", error)
		}
	}

	async notifications(serverName: string): Promise<void> {
		await this.observe(async () => {
			const notifications = this.config.services.mcpHub.getPendingNotifications(serverName)
			if (notifications.length > 0) {
				await this.config.callbacks.say(
					"mcp_notification",
					notifications.map((item) => `[${item.serverName}] ${item.message}`).join("\n\n"),
				)
			}
		})
	}
}
