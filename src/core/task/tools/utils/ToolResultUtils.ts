import { createHash } from "node:crypto"
import { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { ToolResponse } from "@core/task"
import { maybeTransitionToReplanMode } from "@core/task/utils/replanModeTransition"
import { processFilesIntoText } from "@/integrations/misc/extract-text"
import { DietCodeAsk } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { showNotificationForApproval } from "../../utils"
import type { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { TaskConfig } from "../types/TaskConfig"
import { isToolFailure } from "./toolOutcome"

/**
 * Utility functions for handling tool results and feedback
 */
export class ToolResultUtils {
	/**
	 * Push tool result to user message content with proper formatting
	 */
	static pushToolResult(
		content: ToolResponse,
		block: ToolUse,
		userMessageContent: any[],
		toolDescription: (block: ToolUse) => string,
		coordinator?: ToolExecutorCoordinator,
		toolUseIdMap?: Map<string, string>,
	): void {
		const toolUseId = block.tool_use_id || toolUseIdMap?.get(block.call_id || "") || "dietcode"
		// The first outcome owns this call ID, including empty and multimodal results.
		if (
			toolUseId !== "dietcode" &&
			userMessageContent.some((item) => item.type === "tool_result" && item.tool_use_id === toolUseId)
		) {
			Logger.warn(`ToolResultUtils: Tool result for tool_use_id ${toolUseId} already exists. Skipping duplicate.`)
			return
		}
		if (typeof content === "string") {
			const resultText = content || "(tool did not return anything)"

			// Try to get description from coordinator first, otherwise use the provided function
			let description: string = block.name
			try {
				const handler = coordinator?.getHandler(block.name)
				description = handler ? handler.getDescription(block) : toolDescription(block)
			} catch (error) {
				Logger.warn("Tool description unavailable; preserving the operation result:", error)
			}

			// Create ToolResultBlockParam with description and result
			userMessageContent.push(
				ToolResultUtils.createToolResultBlock(
					`${description} Result:\n${resultText}`,
					toolUseId,
					block.call_id,
					isToolFailure(content),
				),
			)
		} else {
			// For complex content (arrays with text/image blocks), pass it through directly
			// The content array should already be properly formatted with type, text, source, etc.
			// If using backward-compatible "dietcode" ID and content is an array, spread it directly
			// instead of wrapping it (which would cause JSON.stringify in createToolResultBlock)
			if ((toolUseId === "dietcode" || !toolUseId) && Array.isArray(content)) {
				userMessageContent.push(...content)
			} else {
				userMessageContent.push(ToolResultUtils.createToolResultBlock(content, toolUseId, block.call_id))
			}
		}
	}

	private static createToolResultBlock(content: ToolResponse, id?: string, call_id?: string, isError = isToolFailure(content)) {
		// If id is "dietcode", we treat it as a plain text result for backward compatibility
		// as we cannot find any existing tool call that matches this id.
		if (id === "dietcode" || !id) {
			return {
				type: "text",
				text: typeof content === "string" ? content : JSON.stringify(content, null, 2),
			}
		}

		// For tool_result blocks, content can be either a string or an array of content blocks
		// When it's a string, we need to wrap it in the proper format
		// When it's an array, it should already be properly formatted (e.g., with text and image blocks)
		return {
			type: "tool_result",
			tool_use_id: id,
			call_id: call_id,
			...(isError ? { is_error: true } : {}),
			content: typeof content === "string" ? content : content,
		}
	}

	/**
	 * Push additional tool feedback from user to message content
	 */
	static pushAdditionalToolFeedback(
		userMessageContent: any[],
		feedback?: string,
		images?: string[],
		fileContentString?: string,
	): void {
		// Check if we have any meaningful content to add
		const hasMeaningfulFeedback = feedback && feedback.trim() !== ""
		const hasImages = images && images.length > 0
		const hasMeaningfulFileContent = fileContentString && fileContentString.trim() !== ""

		// Only proceed if we have at least one meaningful piece of content
		if (!hasMeaningfulFeedback && !hasImages && !hasMeaningfulFileContent) {
			return
		}

		// Build the feedback text only if we have meaningful feedback
		const feedbackText = hasMeaningfulFeedback
			? `The user provided the following feedback:\n<feedback>\n${feedback}\n</feedback>`
			: "The user provided additional content:"

		const content = formatResponse.toolResult(feedbackText, images, hasMeaningfulFileContent ? fileContentString : undefined)
		if (typeof content === "string") {
			userMessageContent.push({
				type: "text",
				text: content,
			})
		} else {
			userMessageContent.push(...content)
		}
	}

	/**
	 * Handles tool approval flow and processes any user feedback
	 */
	static async askApprovalAndPushFeedback(
		type: DietCodeAsk,
		completeMessage: string,
		config: TaskConfig,
		notificationMessage?: string,
	) {
		if (config.isSubagentExecution) {
			return true
		}
		const feedbackVersion = () => {
			const messages = config.messageState?.getDietCodeMessages?.() || []
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].say === "user_feedback") return messages[i].ts
			}
			return 0
		}
		const approvalKey = createHash("sha256")
			.update(JSON.stringify([config.cwd, config.mode, type, completeMessage.trim()]))
			.digest("hex")
		const denied = (config.taskState.deniedToolApprovals ??= new Map<string, number>())
		if (denied.get(approvalKey) === feedbackVersion()) {
			config.taskState.didRejectTool = true
			await config.callbacks.removeLastPartialMessageIfExistsWithType?.("ask", type)
			return false
		}
		if (notificationMessage) {
			showNotificationForApproval(notificationMessage, config.autoApprovalSettings.enableNotifications)
		}

		const { response, text, images, files } = await config.callbacks.ask(type, completeMessage, false)

		if (text || (images && images.length > 0) || (files && files.length > 0)) {
			let fileContentString = ""
			if (files && files.length > 0) {
				fileContentString = await processFilesIntoText(files)
			}

			await maybeTransitionToReplanMode({
				feedback: text,
				currentMode: config.mode,
				yoloModeToggled: config.yoloModeToggled,
				switchToPlanMode: config.callbacks.switchToPlanMode,
				sayInfo: async (message) => {
					await config.callbacks.say("info", message)
				},
			})

			ToolResultUtils.pushAdditionalToolFeedback(config.taskState.userMessageContent, text, images, fileContentString)
			await config.callbacks.say("user_feedback", text, images, files)
		}

		if (config.taskState.abort) {
			config.taskState.didRejectTool = true
			return false
		}
		if (response !== "yesButtonClicked") {
			// User pressed reject button or responded with a message, which we treat as a rejection
			config.taskState.didRejectTool = true // Prevent further tool uses in this message
			denied.set(approvalKey, feedbackVersion())
			if (denied.size > 64) denied.delete(denied.keys().next().value!)
			return false
		}
		denied.delete(approvalKey)
		// User hit the approve button, and may have provided feedback
		return true
	}
}
