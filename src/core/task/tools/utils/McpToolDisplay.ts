import type { TaskConfig } from "../types/TaskConfig"
import { ToolDisplay } from "./ToolDisplay"

/** One unavailable display disables further observation waits for this invocation. Approval remains separate. */
export class McpToolDisplay extends ToolDisplay {
	constructor(config: TaskConfig) {
		super(config, "MCP")
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
