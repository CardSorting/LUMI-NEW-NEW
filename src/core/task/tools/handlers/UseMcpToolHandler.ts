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
import { formatMcpRequestFailure, formatMcpToolResult } from "../utils/mcpResult"
import { ToolResultUtils } from "../utils/ToolResultUtils"
import { reportToolUsage } from "../utils/toolTelemetry"

export class UseMcpToolHandler implements IFullyManagedTool {
	readonly name = DietCodeDefaultTool.MCP_USE

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.server_name}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const server_name = block.params.server_name
		const tool_name = block.params.tool_name
		const mcp_arguments = block.params.arguments

		const partialMessage = JSON.stringify({
			type: "use_mcp_tool",
			serverName: uiHelpers.removeClosingTag(block, "server_name", server_name),
			toolName: uiHelpers.removeClosingTag(block, "tool_name", tool_name),
			arguments: uiHelpers.removeClosingTag(block, "arguments", mcp_arguments),
		} satisfies DietCodeAskUseMcpServer)

		// Check if tool should be auto-approved using MCP-specific logic
		const config = uiHelpers.getConfig()
		const shouldAutoApprove = shouldAutoApproveMcp(config, block.name, server_name, tool_name)

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
		const tool_name: string | undefined = block.params.tool_name
		const mcp_arguments: string | undefined = block.params.arguments

		// Extract provider information for telemetry
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
		const provider = (currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

		// Validate required parameters
		if (!server_name) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "server_name")
		}

		if (!tool_name) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "tool_name")
		}

		// Parse and validate arguments if provided
		let parsedArguments: Record<string, unknown> | undefined
		if (mcp_arguments) {
			try {
				const parsed: unknown = JSON.parse(mcp_arguments)
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
					throw new Error("MCP arguments must be an object")
				parsedArguments = parsed as Record<string, unknown>
			} catch (_error) {
				config.taskState.consecutiveMistakeCount++
				await display.observe(() =>
					config.callbacks.say("error", `Invalid arguments for ${tool_name}: expected a JSON object.`),
				)
				return formatResponse.toolError(formatResponse.invalidMcpToolArgumentError(server_name, tool_name))
			}
		}

		config.taskState.consecutiveMistakeCount = 0

		// Handle approval flow
		const completeMessage = JSON.stringify({
			type: "use_mcp_tool",
			serverName: server_name,
			toolName: tool_name,
			arguments: mcp_arguments,
		} satisfies DietCodeAskUseMcpServer)

		if (shouldAutoApproveMcp(config, block.name, server_name, tool_name)) {
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
			const notificationMessage = `DietCode wants to use ${tool_name || "unknown tool"} on ${server_name || "unknown server"}`

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
		await display.notifications(server_name)
		try {
			const result = await executor.execute(
				config.ulid,
				(signal) => config.services.mcpHub.callTool(server_name, tool_name, parsedArguments, config.ulid, signal),
				{
					concurrencyGroup: `mcp:${server_name}`,
					signal: config.taskState.abortSignal,
					execution: {
						kind: "mcp_tool",
						input: { cwd: config.cwd, server: server_name, tool: tool_name, arguments: parsedArguments },
						label: `${server_name}/${tool_name}`,
						owner: config.executionOwner,
					},
				},
			)
			const formatted = formatMcpToolResult(result, config.api.getModel().info.supportsImages ?? false)
			await display.notifications(server_name)
			await display.observe(() => config.callbacks.say("mcp_server_response", formatted.displayText))
			return formatted.content
		} catch (error) {
			return formatMcpRequestFailure(error, true)
		}
	}
}
