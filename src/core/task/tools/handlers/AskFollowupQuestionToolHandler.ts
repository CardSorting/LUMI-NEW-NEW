/**
 * [LAYER: CORE]
 */
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { showSystemNotification } from "@integrations/notifications"
import { findLast, parsePartialArrayString } from "@shared/array"
import { DietCodeAsk, DietCodeAskQuestion } from "@shared/ExtensionMessage"
import { DietCodeDefaultTool } from "@shared/tools"
import { telemetryService } from "@/services/telemetry"
import { ToolUse } from "../../../assistant-message"
import { formatResponse } from "../../../prompts/responses"
import { maybeTransitionToReplanMode } from "../../utils/replanModeTransition"
import type { TaskConfig } from "../types/TaskConfig"
import type { IPartialBlockHandler, IToolHandler, ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

export class AskFollowupQuestionToolHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = DietCodeDefaultTool.ASK

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.question}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const config = uiHelpers.getConfig()
		if (config.yoloModeToggled || config.isSubagentExecution) return
		const question = block.params.question || ""
		const optionsRaw = block.params.options || "[]"
		const sharedMessage = {
			question: uiHelpers.removeClosingTag(block, "question", question),
			options: parsePartialArrayString(uiHelpers.removeClosingTag(block, "options", optionsRaw)),
		} satisfies DietCodeAskQuestion

		await uiHelpers.ask("followup" as DietCodeAsk, JSON.stringify(sharedMessage), block.partial).catch(() => {})
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const question = block.params.question?.trim()
		const optionsRaw: string | undefined = block.params.options

		// Validate required parameter
		if (!question) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(this.name, "question")
		}
		config.taskState.consecutiveMistakeCount = 0

		if (config.yoloModeToggled || config.isSubagentExecution) {
			await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "followup")
			return formatResponse.toolResult(
				`No user answer was requested. Use existing context and your judgment for routine, reversible decisions within the task. ` +
					`If a relevant fact can be found with a targeted check, check it once; otherwise state a reasonable assumption and proceed. ` +
					`Do not invent credentials, required facts, or authorization. If those are essential, report the specific blocker once ` +
					`${config.isSubagentExecution ? "in your handoff to the parent" : "to the user"} and continue independent work. ` +
					`Do not repeat this question or scan for a personal preference that is not in the workspace. Question: "${question}"`,
			)
		}

		// Show notification if enabled
		if (config.autoApprovalSettings.enableNotifications) {
			showSystemNotification({
				subtitle: "DietCode has a question...",
				message: question.replace(/\n/g, " "),
			})
		}

		const sharedMessage = {
			question: question,
			options: parsePartialArrayString(optionsRaw || "[]"),
		} satisfies DietCodeAskQuestion

		const options = parsePartialArrayString(optionsRaw || "[]")

		// Ask the question
		const {
			text,
			images,
			files: followupFiles,
		} = await config.callbacks.ask("followup", JSON.stringify(sharedMessage), false)

		if (config.taskState.abort) return formatResponse.toolResult("Question cancelled.")

		// Check if options contains the text response
		if (optionsRaw && text && options.includes(text)) {
			telemetryService.captureOptionSelected(config.ulid, options.length, "act")

			// Valid option selected, update last followup message with selected option
			const dietcodeMessages = config.messageState.getDietCodeMessages()
			const lastFollowupMessage = findLast(dietcodeMessages, (m: any) => m.ask === "followup")
			if (lastFollowupMessage) {
				lastFollowupMessage.text = JSON.stringify({
					...sharedMessage,
					selected: text,
				} satisfies DietCodeAskQuestion)
				await config.messageState.saveDietCodeMessagesAndUpdateHistory()
			}
		} else {
			// Option not selected, send user feedback
			telemetryService.captureOptionsIgnored(config.ulid, options.length, "act")
			await maybeTransitionToReplanMode({
				feedback: text,
				currentMode: config.mode,
				yoloModeToggled: config.yoloModeToggled,
				switchToPlanMode: config.callbacks.switchToPlanMode,
				sayInfo: async (message) => {
					await config.callbacks.say("info", message)
				},
			})
			await config.callbacks.say("user_feedback", text ?? "", images, followupFiles)
		}

		// Process any attached files
		let fileContentString = ""
		if (followupFiles && followupFiles.length > 0) {
			fileContentString = await processFilesIntoText(followupFiles)
		}

		return formatResponse.toolResult(`<answer>\n${text ?? "No text answer provided."}\n</answer>`, images, fileContentString)
	}
}
