import { DietCodeSayTool } from "@shared/ExtensionMessage"
import { DietCodeDefaultTool } from "@shared/tools"
import axios from "axios"
import { DietCodeEnv } from "@/config"
import { AuthService } from "@/services/auth/AuthService"
import { buildDietCodeExtraHeaders } from "@/services/EnvUtils"
import { featureFlagsService } from "@/services/feature-flags"
import { parsePartialArrayString } from "@/shared/array"
import { DIETCODE_ACCOUNT_AUTH_ERROR_MESSAGE } from "@/shared/DietCodeAccount"
import { getAxiosSettings } from "@/shared/net"
import { ToolUse } from "../../../assistant-message"
import { formatResponse } from "../../../prompts/responses"
import { isToolAutoApproved } from "../autoApprove"
import type { TaskConfig } from "../types/TaskConfig"
import type { IFullyManagedTool, ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { ToolResultUtils } from "../utils/ToolResultUtils"
import { reportToolUsage } from "../utils/toolTelemetry"

export class WebSearchToolHandler implements IFullyManagedTool {
	readonly name = DietCodeDefaultTool.WEB_SEARCH

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.query}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const query = block.params.query || ""
		const sharedMessageProps: DietCodeSayTool = {
			tool: "webSearch",
			path: uiHelpers.removeClosingTag(block, "query", query),
			content: `Searching for: ${uiHelpers.removeClosingTag(block, "query", query)}`,
			operationIsLocatedInWorkspace: false, // web_search is always external
		} satisfies DietCodeSayTool

		const partialMessage = JSON.stringify(sharedMessageProps)

		if (isToolAutoApproved(uiHelpers.shouldAutoApproveTool(this.name))) {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("ask", "tool")
			await uiHelpers.say("tool", partialMessage, undefined, undefined, block.partial)
		} else {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("say", "tool")
			await uiHelpers.ask("tool", partialMessage, block.partial).catch(() => {})
		}
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		try {
			config.taskState.abortSignal.throwIfAborted()
			const query: string | undefined = block.params.query
			const allowedDomainsRaw: string | undefined = block.params.allowed_domains
			const blockedDomainsRaw: string | undefined = block.params.blocked_domains

			// Extract provider information for telemetry
			const apiConfig = config.services.stateManager.getApiConfiguration()
			const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
			const provider = (currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

			// Check if DietCode web tools are enabled (both user setting and feature flag)
			const dietcodeWebToolsEnabled = config.services.stateManager.getGlobalSettingsKey("dietcodeWebToolsEnabled")
			const featureFlagEnabled = featureFlagsService.getWebtoolsEnabled()
			if (provider !== "dietcode" || !dietcodeWebToolsEnabled || !featureFlagEnabled) {
				return formatResponse.toolError("DietCode web tools are currently disabled.")
			}

			// Validate required parameters
			if (!query) {
				config.taskState.consecutiveMistakeCount++
				return await config.callbacks.sayAndCreateMissingParamError(this.name, "query")
			}
			config.taskState.consecutiveMistakeCount = 0

			// Parse domain arrays
			const allowedDomains = parsePartialArrayString(allowedDomainsRaw || "[]")
			const blockedDomains = parsePartialArrayString(blockedDomainsRaw || "[]")

			// Validate mutual exclusivity
			if (allowedDomains.length > 0 && blockedDomains.length > 0) {
				config.taskState.consecutiveMistakeCount++
				return formatResponse.toolError("Cannot specify both allowed_domains and blocked_domains")
			}

			// Create message for approval
			const sharedMessageProps: DietCodeSayTool = {
				tool: "webSearch",
				path: query,
				content: `Searching for: ${query}`,
				operationIsLocatedInWorkspace: false,
			}
			const completeMessage = JSON.stringify(sharedMessageProps)

			if (isToolAutoApproved(config.callbacks.shouldAutoApproveTool(this.name))) {
				// Auto-approve flow
				await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")
				await config.callbacks.say("tool", completeMessage, undefined, undefined, false)
				reportToolUsage(
					config.ulid,
					"web_search",
					config.api.getModel().id,
					provider,
					true,
					true,
					undefined,
					block.isNativeToolCall,
				)
			} else {
				// Manual approval flow
				await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")

				const didApprove = await ToolResultUtils.askApprovalAndPushFeedback(
					"tool",
					completeMessage,
					config,
					`DietCode wants to search for: ${query}`,
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

			// Execute the actual search
			config.taskState.abortSignal.throwIfAborted()
			const baseUrl = DietCodeEnv.config().apiBaseUrl
			const authToken = await AuthService.getInstance().getAuthToken()

			if (!authToken) {
				throw new Error(DIETCODE_ACCOUNT_AUTH_ERROR_MESSAGE)
			}

			const requestBody: {
				query: string
				allowed_domains?: string[]
				blocked_domains?: string[]
			} = {
				query: query,
			}

			// Only include domain filters if they have values
			if (allowedDomains.length > 0) {
				requestBody.allowed_domains = allowedDomains
			}
			if (blockedDomains.length > 0) {
				requestBody.blocked_domains = blockedDomains
			}

			const response = await axios.post(`${baseUrl}/api/v1/search/websearch`, requestBody, {
				headers: {
					Authorization: `Bearer ${authToken}`,
					"Content-Type": "application/json",
					"X-Task-ID": config.ulid || "",
					...(await buildDietCodeExtraHeaders()),
				},
				timeout: 15000,
				...getAxiosSettings(),
				signal: config.taskState.abortSignal,
			})

			// Parse response
			// Axios will throw on non-200 status, so no need to check fetchStatus
			const data = response.data.data

			// Format results for display
			const results = data.results || []
			const resultCount = results.length

			let resultText = `Search completed (${resultCount} results found)`
			if (results.length > 0) {
				resultText += ":\n\n"
				results.forEach((result: { title: string; url: string }, index: number) => {
					resultText += `${index + 1}. ${result.title}\n   ${result.url}\n\n`
				})
			}

			return formatResponse.toolResult(resultText)
		} catch (error) {
			return formatResponse.toolError(
				config.taskState.abortSignal.aborted
					? "Web search cancelled."
					: `Error performing web search: ${(error as Error).message}`,
			)
		}
	}
}
