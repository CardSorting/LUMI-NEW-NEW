import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { DietCodeAsk, DietCodeAskUseMcpServer } from "@shared/ExtensionMessage"
import { DietCodeDefaultTool } from "@/shared/tools"
import { executor } from "../../ActionExecutor"
import { shouldAutoApproveMcp } from "../autoApprove"
import type { TaskConfig } from "../types/TaskConfig"
import type { IFullyManagedTool, ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { McpToolDisplay } from "../utils/McpToolDisplay"
import { formatMcpRequestFailure, formatMcpResourceResult } from "../utils/mcpResult"
import { ToolResultUtils } from "../utils/ToolResultUtils"
import { reportToolUsage } from "../utils/toolTelemetry"

export class AccessMcpResourceHandler implements IFullyManagedTool {
	readonly name = DietCodeDefaultTool.MCP_ACCESS

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.server_name}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const server_name = block.params.server_name
		const uri = block.params.uri

		const partialMessage = JSON.stringify({
			type: this.name,
			serverName: uiHelpers.removeClosingTag(block, "server_name", server_name),
			toolName: undefined,
			uri: uiHelpers.removeClosingTag(block, "uri", uri),
			arguments: undefined,
		} satisfies DietCodeAskUseMcpServer)

		// Check if tool should be auto-approved (access_mcp_resource uses general auto-approval)
		const shouldAutoApprove = shouldAutoApproveMcp(uiHelpers.getConfig(), block.name, server_name)

		if (shouldAutoApprove) {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("ask", "use_mcp_server")
			await uiHelpers.say("use_mcp_server" as any, partialMessage, undefined, undefined, block.partial)
		} else {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("say", "use_mcp_server")
			await uiHelpers.ask("use_mcp_server" as DietCodeAsk, partialMessage, block.partial).catch(() => {})
		}
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		config.taskState.abortSignal.throwIfAborted()
		const display = new McpToolDisplay(config)
		const server_name: string | undefined = block.params.server_name
		const uri: string | undefined = block.params.uri

		// Extract provider using the proven pattern from ReportBugHandler
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
		const provider = (currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

		// Validate required parameters
		if (!server_name) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(DietCodeDefaultTool.MCP_ACCESS, "server_name")
		}

		if (!uri) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(DietCodeDefaultTool.MCP_ACCESS, "uri")
		}

		config.taskState.consecutiveMistakeCount = 0

		// Handle approval flow
		const completeMessage = JSON.stringify({
			type: "access_mcp_resource",
			serverName: server_name,
			toolName: undefined,
			uri: uri,
			arguments: undefined,
		} satisfies DietCodeAskUseMcpServer)

		const shouldAutoApprove = shouldAutoApproveMcp(config, block.name, server_name)

		if (shouldAutoApprove) {
			// Auto-approval flow
			await display.observe(() => config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "use_mcp_server"))
			await display.observe(() => config.callbacks.say("use_mcp_server", completeMessage, undefined, undefined, false))

			// Capture telemetry
			reportToolUsage(
				config.ulid,
				block.name,
				config.api.getModel().id,
				provider,
				true,
				true,
				undefined,
				block.isNativeToolCall,
			)
		} else {
			// Manual approval flow
			const notificationMessage = `DietCode wants to access ${uri || "unknown resource"} on ${server_name || "unknown server"}`

			// Show notification
			await display.observe(() => config.callbacks.removeLastPartialMessageIfExistsWithType("say", "use_mcp_server"))

			const didApprove = await ToolResultUtils.askApprovalAndPushFeedback(
				"use_mcp_server",
				completeMessage,
				config,
				notificationMessage,
			)
			if (!didApprove) {
				reportToolUsage(
					config.ulid,
					block.name,
					config.api.getModel().id,
					provider,
					false,
					false,
					undefined,
					block.isNativeToolCall,
				)
				return formatResponse.toolDenied()
			}
			reportToolUsage(
				config.ulid,
				block.name,
				config.api.getModel().id,
				provider,
				false,
				true,
				undefined,
				block.isNativeToolCall,
			)
		}

		config.taskState.abortSignal.throwIfAborted()

		// Run PreToolUse hook after approval but before execution
		try {
			const { ToolHookUtils } = await import("../utils/ToolHookUtils")
			await ToolHookUtils.runPreToolUseIfEnabled(config, block)
		} catch (error) {
			const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
			if (error instanceof PreToolUseHookCancellationError) {
				return formatResponse.toolDenied()
			}
			throw error
		}

		config.taskState.abortSignal.throwIfAborted()
		await display.observe(() => config.callbacks.say("mcp_server_request_started"))
		try {
			const result = await executor.execute(
				config.ulid,
				(signal) => config.services.mcpHub.readResource(server_name, uri, signal),
				{
					concurrencyGroup: `mcp:${server_name}`,
					signal: config.taskState.abortSignal,
					execution: {
						kind: "mcp_resource",
						input: { server: server_name, uri },
						label: `${server_name}: ${uri}`,
						owner: config.executionOwner,
					},
				},
			)
			const text = formatMcpResourceResult(result)
			await display.observe(() => config.callbacks.say("mcp_server_response", text))
			return formatResponse.toolResult(text)
		} catch (error) {
			return formatMcpRequestFailure(error, false)
		}
	}
}
