import type { IController as Controller } from "@core/controller/types"
import { COMPLETION_REVIEW_ERRORS } from "@shared/CompletionReview"
import { Empty, Int64Request } from "@shared/proto/dietcode/common"
import { Logger } from "@/shared/services/Logger"
import { sendRelinquishControlEvent } from "../ui/subscribeToRelinquishControl"

/**
 * Shows task completion changes in a diff view
 * @param controller The controller instance
 * @param request The request containing the timestamp of the message
 * @returns Empty response
 */
export async function taskCompletionViewChanges(controller: Controller, request: Int64Request): Promise<Empty> {
	try {
		if (!request.value || !controller.task) throw new Error(COMPLETION_REVIEW_ERRORS.taskUnavailable)
		const checkpointManager = controller.task.checkpointManager
		if (!checkpointManager?.presentMultifileDiff) throw new Error(COMPLETION_REVIEW_ERRORS.snapshotUnavailable)
		await checkpointManager.presentMultifileDiff(request.value, true)
		return Empty.create()
	} catch (error) {
		Logger.error("Error in taskCompletionViewChanges handler:", error)
		throw error
	} finally {
		await sendRelinquishControlEvent()
	}
}
