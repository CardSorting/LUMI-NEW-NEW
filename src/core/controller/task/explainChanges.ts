import type { IController as Controller } from "@core/controller/types"
import { COMPLETION_REVIEW_ERRORS } from "@shared/CompletionReview"
import { Empty } from "@shared/proto/dietcode/common"
import type { ExplainChangesProgress, ExplainChangesRequest } from "@shared/proto/dietcode/task"
import { Logger } from "@/shared/services/Logger"
import { sendRelinquishControlEvent } from "../ui/subscribeToRelinquishControl"
import {
	buildDiffContent,
	openDiffView,
	setupCommentController,
	streamAIExplanationComments,
	stringifyConversationHistory,
} from "./explainChangesShared"

const activeWalkthroughs = new WeakSet<Controller>()

/** Keep the existing unary endpoint available for older clients. */
export async function explainChanges(controller: Controller, request: ExplainChangesRequest): Promise<Empty> {
	await runCompletionWalkthrough(controller, request)
	return Empty.create()
}

/** Open the saved diff first, then add explanations without moving editor focus. */
export async function runCompletionWalkthrough(
	controller: Controller,
	request: ExplainChangesRequest,
	options: { signal?: AbortSignal; onProgress?: (progress: ExplainChangesProgress) => Promise<void> } = {},
): Promise<void> {
	if (activeWalkthroughs.has(controller)) throw new Error(COMPLETION_REVIEW_ERRORS.walkthroughBusy)
	activeWalkthroughs.add(controller)
	const abortController = new AbortController()
	const cancel = () => abortController.abort()
	options.signal?.addEventListener("abort", cancel, { once: true })
	if (options.signal?.aborted) cancel()
	const task = controller.task
	const shouldAbort = () => abortController.signal.aborted || controller.task !== task || task?.taskState?.abort === true
	const taskWatch = setInterval(() => {
		if (shouldAbort()) cancel()
	}, 500)
	taskWatch.unref?.()
	let updates = Promise.resolve()
	const progress: ExplainChangesProgress = {
		phase: "loading",
		filesTotal: 0,
		filesExplained: 0,
		commentCount: 0,
		currentFile: "",
	}
	const report = () => {
		const snapshot = { ...progress }
		updates = updates.then(async () => {
			await options.onProgress?.(snapshot)
		})
		// Callback updates are queued from synchronous comment events; the terminal send awaits failures.
		void updates.catch(() => {})
		return updates
	}
	try {
		if (!task) throw new Error(COMPLETION_REVIEW_ERRORS.taskUnavailable)
		if (shouldAbort()) {
			progress.phase = "cancelled"
			await report()
			return
		}
		await report()
		const checkpointManager = task.checkpointManager
		if (!checkpointManager?.getCheckpointDiff) throw new Error(COMPLETION_REVIEW_ERRORS.snapshotUnavailable)
		const changedFiles = await checkpointManager.getCheckpointDiff(request.messageTs, true)
		if (shouldAbort()) {
			progress.phase = "cancelled"
			await report()
			return
		}
		if (!changedFiles.length) throw new Error(COMPLETION_REVIEW_ERRORS.noChanges)

		const apiConfiguration = controller.stateManager.getApiConfiguration()
		if (!apiConfiguration) throw new Error("API configuration not available")
		const conversationSummary = stringifyConversationHistory(task.messageStateHandler.getApiConversationHistory())
		const commentController = await setupCommentController(apiConfiguration, changedFiles, conversationSummary)
		if (shouldAbort()) {
			progress.phase = "cancelled"
			await report()
			return
		}
		await openDiffView("Explain Changes", changedFiles)
		progress.phase = "generating"
		progress.filesTotal = changedFiles.length
		await report()
		const explainedFiles = new Set<string>()
		let currentFile: string | undefined
		const commentCount = await streamAIExplanationComments(
			apiConfiguration,
			buildDiffContent(changedFiles),
			conversationSummary,
			changedFiles,
			(filePath, startLine, endLine) => {
				if (shouldAbort()) return
				const file = changedFiles.find((candidate) => candidate.absolutePath === filePath)
				if (!file) return
				currentFile = file.absolutePath
				commentController.startStreamingComment(filePath, startLine, endLine, file.relativePath, file.after, false)
				progress.currentFile = file.relativePath
				void report()
			},
			(chunk) => {
				if (!shouldAbort() && currentFile) commentController.appendToStreamingComment(chunk)
			},
			() => {
				if (!currentFile) return
				commentController.endStreamingComment()
				explainedFiles.add(currentFile)
				currentFile = undefined
				progress.filesExplained = explainedFiles.size
				progress.commentCount++
				progress.currentFile = ""
				void report()
			},
			shouldAbort,
			abortController.signal,
		)
		// Stopping preserves the diff and explanations already delivered.
		progress.phase = shouldAbort() ? "cancelled" : "complete"
		progress.currentFile = ""
		if (progress.phase === "complete" && commentCount === 0) throw new Error("No walkthrough comments were generated")
		await report()
	} catch (error) {
		if (!shouldAbort()) {
			Logger.error("Error in explainChanges:", error)
			throw error
		}
		progress.phase = "cancelled"
		await report()
	} finally {
		clearInterval(taskWatch)
		options.signal?.removeEventListener("abort", cancel)
		activeWalkthroughs.delete(controller)
		await sendRelinquishControlEvent()
	}
}
