import type { ToolUse } from "@core/assistant-message"
import { continuationPrompt } from "@core/prompts/contextManagement"
import { formatResponse } from "@core/prompts/responses"
import { showSystemNotification } from "@integrations/notifications"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { TaskConfig } from "../types/TaskConfig"
import type { IPartialBlockHandler, IToolHandler, ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { applyContextCompaction } from "../utils/contextCompaction"
import { ToolResultUtils } from "../utils/ToolResultUtils"

function canCompactAutomatically(config: TaskConfig): boolean {
	return !!(
		config.yoloModeToggled ||
		config.services.stateManager.getGlobalSettingsKey("autoApproveAllToggled") ||
		config.services.stateManager.getGlobalSettingsKey("useAutoCondense")
	)
}

export class CondenseHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = DietCodeDefaultTool.CONDENSE

	getDescription(block: ToolUse): string {
		return `[${block.name}]`
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const context: string | undefined = block.params.context

		// Validate required parameters
		if (!context?.trim()) {
			config.taskState.consecutiveMistakeCount++
			return formatResponse.toolError("Missing required parameter: context")
		}

		config.taskState.consecutiveMistakeCount = 0

		if (config.taskState.abort) return formatResponse.toolError("Context compaction cancelled.")
		const automatic = canCompactAutomatically(config)
		if (!automatic && config.autoApprovalSettings.enableNotifications) {
			showSystemNotification({
				subtitle: "DietCode wants to condense the conversation...",
				message: `DietCode is suggesting to condense your conversation with: ${context}`,
			})
		}

		// Automatic compaction uses the same summary view as summarize_task, without an approval pause.
		if (automatic) {
			await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "condense")
			await config.callbacks.say(
				"tool",
				JSON.stringify({ tool: "summarizeTask", content: context }),
				undefined,
				undefined,
				false,
			)
		} else {
			const approved = await ToolResultUtils.askApprovalAndPushFeedback("condense", context, config)
			if (!approved) return formatResponse.toolDenied()
		}
		if (config.taskState.abort) return formatResponse.toolError("Context compaction cancelled.")

		const apiConversationHistory = config.messageState.getApiConversationHistory()
		const lastMessage = apiConversationHistory[apiConversationHistory.length - 1]
		const summaryAlreadyAppended = lastMessage && lastMessage.role === "assistant"
		const keepStrategy = summaryAlreadyAppended ? "lastTwo" : "none"

		try {
			await applyContextCompaction(config, keepStrategy)
		} catch (error) {
			return formatResponse.toolError(`Could not save context compaction; previous context retained: ${error}`)
		}

		return formatResponse.toolResult(continuationPrompt(context))
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const context = block.params.context || ""
		const cleanedContext = uiHelpers.removeClosingTag(block, "context", context)
		if (canCompactAutomatically(uiHelpers.getConfig())) {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("ask", "condense")
			await uiHelpers.say(
				"tool",
				JSON.stringify({ tool: "summarizeTask", content: cleanedContext }),
				undefined,
				undefined,
				block.partial,
			)
			return
		}

		await uiHelpers.removeLastPartialMessageIfExistsWithType("say", "condense")
		await uiHelpers.ask("condense", cleanedContext, block.partial).catch(() => {})
	}
}
