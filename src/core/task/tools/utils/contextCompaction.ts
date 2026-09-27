import { ensureTaskDirectoryExists } from "@core/storage/disk"
import { Logger } from "@/shared/services/Logger"
import type { TaskConfig } from "../types/TaskConfig"

/** Commit the truncation range before returning its summary; notices are optional observation. */
export async function applyContextCompaction(config: TaskConfig, keep: "none" | "lastTwo"): Promise<void> {
	config.taskState.abortSignal.throwIfAborted()
	const history = config.messageState.getApiConversationHistory()
	const previousRange = config.taskState.conversationHistoryDeletedRange
	config.taskState.conversationHistoryDeletedRange = config.services.contextManager.getNextTruncationRange(
		history,
		previousRange,
		keep,
	)
	try {
		await config.messageState.saveDietCodeMessagesAndUpdateHistory()
	} catch (error) {
		config.taskState.conversationHistoryDeletedRange = previousRange
		throw error
	}
	try {
		await config.services.contextManager.triggerApplyStandardContextTruncationNoticeChange(
			Date.now(),
			await ensureTaskDirectoryExists(config.taskId),
			history,
		)
	} catch (error) {
		Logger.warn("[ContextCompaction] Context notice unavailable; summary retained:", error)
	}
}
