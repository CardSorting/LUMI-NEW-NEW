import CheckpointTracker from "@integrations/checkpoints/CheckpointTracker"
import { EventEmitter } from "events"
import getFolderSize from "get-folder-size"
import Mutex from "p-mutex"
import { findLastIndex } from "@/shared/array"
import { combineApiRequests } from "@/shared/combineApiRequests"
import { combineCommandSequences } from "@/shared/combineCommandSequences"
import { DietCodeMessage } from "@/shared/ExtensionMessage"
import { getApiMetrics } from "@/shared/getApiMetrics"
import { HistoryItem } from "@/shared/HistoryItem"
import { DietCodeStorageMessage } from "@/shared/messages/content"
import { Logger } from "@/shared/services/Logger"
import { parseSubagentStatusPayload } from "@/shared/subagents"
import { getCwd, getDesktopDir } from "@/utils/path"
import { ensureTaskDirectoryExists, saveApiConversationHistory, saveDietCodeMessages } from "../storage/disk"
import { TaskState } from "./TaskState"

// Event types for dietcodeMessages changes
export type DietCodeMessageChangeType = "add" | "update" | "delete" | "set"

export interface DietCodeMessageChange {
	type: DietCodeMessageChangeType
	/** The full array after the change */
	messages: DietCodeMessage[]
	/** The affected index (for add/update/delete) */
	index?: number
	/** The new/updated message (for add/update) */
	message?: DietCodeMessage
	/** The old message before change (for update/delete) */
	previousMessage?: DietCodeMessage
	/** The entire previous array (for set) */
	previousMessages?: DietCodeMessage[]
}

// Strongly-typed event emitter interface
export interface MessageStateHandlerEvents {
	dietcodeMessagesChanged: [change: DietCodeMessageChange]
}

interface MessageStateHandlerParams {
	taskId: string
	ulid: string
	taskIsFavorited?: boolean
	updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	taskState: TaskState
	checkpointManagerErrorMessage?: string
}

export class MessageStateHandler extends EventEmitter<MessageStateHandlerEvents> {
	private apiConversationHistory: DietCodeStorageMessage[] = []
	private dietcodeMessages: DietCodeMessage[] = []
	private taskIsFavorited: boolean
	private checkpointTracker: CheckpointTracker | undefined
	private updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	private taskId: string
	private ulid: string
	private taskState: TaskState

	// Serializes conversation mutations and persistence (RC-4). Live helper rows
	// are synchronously replaced by identity, never by a captured array index.
	// Protects against data loss from race conditions when multiple
	// operations try to modify message state simultaneously
	// This follows the same pattern as Task.stateMutex for consistency
	private stateMutex = new Mutex()
	private helperSavePending = false
	private helperSave: Promise<void> | undefined
	private helperSaveUrgent = false
	private lastHelperSaveAt = Number.NEGATIVE_INFINITY
	private resumeHelperSave?: () => void

	constructor(params: MessageStateHandlerParams) {
		super()
		this.taskId = params.taskId
		this.ulid = params.ulid
		this.taskState = params.taskState
		this.taskIsFavorited = params.taskIsFavorited ?? false
		this.updateTaskHistory = params.updateTaskHistory
	}

	/**
	 * Emit a dietcodeMessagesChanged event with the change details
	 */
	private emitDietCodeMessagesChanged(change: DietCodeMessageChange): void {
		this.emit("dietcodeMessagesChanged", change)
	}

	setCheckpointTracker(tracker: CheckpointTracker | undefined) {
		this.checkpointTracker = tracker
	}

	/**
	 * Execute function with exclusive lock on message state
	 * Use this for ANY state modification to prevent race conditions
	 * This follows the same pattern as Task.withStateLock for consistency
	 */
	private async withStateLock<T>(fn: () => T | Promise<T>): Promise<T> {
		return await this.stateMutex.withLock(fn)
	}

	getApiConversationHistory(): DietCodeStorageMessage[] {
		return this.apiConversationHistory
	}

	setApiConversationHistory(newHistory: DietCodeStorageMessage[]): void {
		this.apiConversationHistory = newHistory
	}

	getDietCodeMessages(): DietCodeMessage[] {
		return this.dietcodeMessages
	}

	/**
	 * Live helper telemetry is an atomic, synchronous in-memory change. Disk/history
	 * work remains serialized, but cannot hold presentation behind a filesystem scan.
	 * Only the owning task/batch may update this row; deleted rows are not recreated.
	 */
	publishSubagentStatus(message: DietCodeMessage, create: boolean): boolean {
		const next = message.say === "subagent" ? parseSubagentStatusPayload(message.text) : undefined
		if (!next || next.taskId !== this.taskId || !next.revision) return false
		let index = this.dietcodeMessages.findIndex((item) => item.ts === message.ts)
		const previousMessage = this.dietcodeMessages[index]
		if (previousMessage) {
			const previous = previousMessage.say === "subagent" ? parseSubagentStatusPayload(previousMessage.text) : undefined
			if (
				!previous ||
				previous.taskId !== next.taskId ||
				previous.batchId !== next.batchId ||
				previous.items[0].id !== next.items[0].id ||
				(previous.revision ?? 0) >= next.revision
			)
				return false
			if (!previousMessage.partial && message.partial) return false
			this.dietcodeMessages[index] = { ...previousMessage, ...message }
		} else {
			if (!create) return false
			index = this.dietcodeMessages.length
			this.dietcodeMessages.push({
				...message,
				conversationHistoryIndex: this.apiConversationHistory.length - 1,
				conversationHistoryDeletedRange: this.taskState.conversationHistoryDeletedRange,
			})
		}
		try {
			this.emitDietCodeMessagesChanged({
				type: previousMessage ? "update" : "add",
				messages: this.dietcodeMessages,
				index,
				previousMessage,
				message: this.dietcodeMessages[index],
			})
		} catch (error) {
			// An auxiliary observer cannot prevent persistence or dedicated live delivery.
			Logger.warn("Helper message observer failed", error)
		}
		this.helperSavePending = true
		this.helperSaveUrgent ||= !message.partial
		if (this.helperSaveUrgent) this.resumeHelperSave?.()
		this.helperSave ??= Promise.resolve().then(async () => {
			try {
				while (this.helperSavePending) {
					// Live delivery can run at 10 Hz; filesystem scans/history updates cannot.
					const waitMs = 1000 - (Date.now() - this.lastHelperSaveAt)
					if (!this.helperSaveUrgent && waitMs > 0) {
						await new Promise<void>((resolve) => {
							const timer = setTimeout(resolve, waitMs)
							this.resumeHelperSave = () => {
								clearTimeout(timer)
								resolve()
							}
						})
						this.resumeHelperSave = undefined
					}
					this.helperSavePending = false
					this.helperSaveUrgent = false
					this.lastHelperSaveAt = Date.now()
					await this.saveDietCodeMessagesAndUpdateHistory()
				}
			} catch (error) {
				Logger.warn("Could not persist helper progress", error)
			} finally {
				this.helperSave = undefined
			}
		})
		return true
	}

	setDietCodeMessages(newMessages: DietCodeMessage[]) {
		const previousMessages = this.dietcodeMessages
		this.dietcodeMessages = newMessages
		this.emitDietCodeMessagesChanged({
			type: "set",
			messages: this.dietcodeMessages,
			previousMessages,
		})
	}

	/**
	 * Internal method to save messages and update history (without mutex protection)
	 * This is used by methods that already hold the stateMutex lock
	 * Should NOT be called directly - use saveDietCodeMessagesAndUpdateHistory() instead
	 */
	private async saveDietCodeMessagesAndUpdateHistoryInternal(): Promise<void> {
		try {
			await saveDietCodeMessages(this.taskId, this.dietcodeMessages)

			// combined as they are in ChatView
			const apiMetrics = getApiMetrics(combineApiRequests(combineCommandSequences(this.dietcodeMessages.slice(1))))
			const taskMessage = this.dietcodeMessages[0] // first message is always the task say
			const lastRelevantMessage =
				this.dietcodeMessages[
					findLastIndex(
						this.dietcodeMessages,
						(message) => !(message.ask === "resume_task" || message.ask === "resume_completed_task"),
					)
				]
			const lastModelInfo = [...this.apiConversationHistory].reverse().find((msg) => msg.modelInfo !== undefined)
			const taskDir = await ensureTaskDirectoryExists(this.taskId)
			let taskDirSize = 0
			try {
				// getFolderSize.loose silently ignores errors
				// returns # of bytes, size/1000/1000 = MB
				taskDirSize = await getFolderSize.loose(taskDir)
			} catch (error) {
				Logger.error("Failed to get task directory size:", taskDir, error)
			}
			const cwd = await getCwd(getDesktopDir())
			await this.updateTaskHistory({
				id: this.taskId,
				ulid: this.ulid,
				ts: lastRelevantMessage.ts,
				task: taskMessage.text ?? "",
				tokensIn: apiMetrics.totalTokensIn,
				tokensOut: apiMetrics.totalTokensOut,
				cacheWrites: apiMetrics.totalCacheWrites,
				cacheReads: apiMetrics.totalCacheReads,
				totalCost: apiMetrics.totalCost,
				size: taskDirSize,
				shadowGitConfigWorkTree: await this.checkpointTracker?.getShadowGitConfigWorkTree(),
				cwdOnTaskInitialization: cwd,
				conversationHistoryDeletedRange: this.taskState.conversationHistoryDeletedRange,
				isFavorited: this.taskIsFavorited,
				checkpointManagerErrorMessage: this.taskState.checkpointManagerErrorMessage,
				modelId: lastModelInfo?.modelInfo?.modelId,
			})
		} catch (error) {
			Logger.error("Failed to save dietcode messages:", error)
		}
	}

	/**
	 * Save dietcode messages and update task history (public API with mutex protection)
	 * This is the main entry point for saving message state from external callers
	 */
	async saveDietCodeMessagesAndUpdateHistory(): Promise<void> {
		return await this.withStateLock(async () => {
			await this.saveDietCodeMessagesAndUpdateHistoryInternal()
		})
	}

	async addToApiConversationHistory(message: DietCodeStorageMessage) {
		// Protect with mutex to prevent concurrent modifications from corrupting data (RC-4)
		return await this.withStateLock(async () => {
			this.apiConversationHistory.push(message)
			await saveApiConversationHistory(this.taskId, this.apiConversationHistory)
		})
	}

	async overwriteApiConversationHistory(newHistory: DietCodeStorageMessage[]): Promise<void> {
		// Protect with mutex to prevent concurrent modifications from corrupting data (RC-4)
		return await this.withStateLock(async () => {
			this.apiConversationHistory = newHistory
			await saveApiConversationHistory(this.taskId, this.apiConversationHistory)
		})
	}

	/**
	 * Add a new message to dietcodeMessages array with proper index tracking
	 * CRITICAL: This entire operation must be atomic to prevent race conditions (RC-4)
	 * The conversationHistoryIndex must be set correctly based on the current state,
	 * and the message must be added and saved without any interleaving operations
	 */
	async addToDietCodeMessages(message: DietCodeMessage) {
		return await this.withStateLock(async () => {
			// these values allow us to reconstruct the conversation history at the time this dietcode message was created
			// it's important that apiConversationHistory is initialized before we add dietcode messages
			message.conversationHistoryIndex = this.apiConversationHistory.length - 1 // NOTE: this is the index of the last added message which is the user message, and once the dietcodemessages have been presented we update the apiconversationhistory with the completed assistant message. This means when resetting to a message, we need to +1 this index to get the correct assistant message that this tool use corresponds to
			message.conversationHistoryDeletedRange = this.taskState.conversationHistoryDeletedRange
			const index = this.dietcodeMessages.length
			this.dietcodeMessages.push(message)
			this.emitDietCodeMessagesChanged({
				type: "add",
				messages: this.dietcodeMessages,
				index,
				message,
			})
			await this.saveDietCodeMessagesAndUpdateHistoryInternal()
		})
	}

	/**
	 * Replace the entire dietcodeMessages array with new messages
	 * Protected by mutex to prevent concurrent modifications (RC-4)
	 */
	async overwriteDietCodeMessages(newMessages: DietCodeMessage[]) {
		return await this.withStateLock(async () => {
			const previousMessages = this.dietcodeMessages
			this.dietcodeMessages = newMessages
			this.emitDietCodeMessagesChanged({
				type: "set",
				messages: this.dietcodeMessages,
				previousMessages,
			})
			await this.saveDietCodeMessagesAndUpdateHistoryInternal()
		})
	}

	/**
	 * Update a specific message in the dietcodeMessages array
	 * The entire operation (validate, update, save) is atomic to prevent races (RC-4)
	 */
	async updateDietCodeMessage(index: number, updates: Partial<DietCodeMessage>): Promise<void> {
		return await this.withStateLock(async () => {
			if (index < 0 || index >= this.dietcodeMessages.length) {
				throw new Error(`Invalid message index: ${index}`)
			}

			// Capture previous state before mutation
			const previousMessage = { ...this.dietcodeMessages[index] }

			// Apply updates to the message
			Object.assign(this.dietcodeMessages[index], updates)

			this.emitDietCodeMessagesChanged({
				type: "update",
				messages: this.dietcodeMessages,
				index,
				previousMessage,
				message: this.dietcodeMessages[index],
			})

			// Save changes and update history
			await this.saveDietCodeMessagesAndUpdateHistoryInternal()
		})
	}

	/**
	 * Delete a specific message from the dietcodeMessages array
	 * The entire operation (validate, delete, save) is atomic to prevent races (RC-4)
	 */
	async deleteDietCodeMessage(index: number): Promise<void> {
		return await this.withStateLock(async () => {
			if (index < 0 || index >= this.dietcodeMessages.length) {
				throw new Error(`Invalid message index: ${index}`)
			}

			// Capture the message before deletion
			const previousMessage = this.dietcodeMessages[index]

			// Remove the message at the specified index
			this.dietcodeMessages.splice(index, 1)

			this.emitDietCodeMessagesChanged({
				type: "delete",
				messages: this.dietcodeMessages,
				index,
				previousMessage,
			})

			// Save changes and update history
			await this.saveDietCodeMessagesAndUpdateHistoryInternal()
		})
	}
}
