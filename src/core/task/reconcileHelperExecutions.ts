import type { DietCodeMessage, DietCodeSaySubagentStatus } from "@/shared/ExtensionMessage"
import { parseSubagentStatusPayload } from "@/shared/subagents"
import type { ActionExecutionSnapshot } from "./ActionExecutionRegistry"
import { type ExecutionRecoveryStore, recoveredBatch } from "./ExecutionRecovery"

/** Reconcile existing rows by batch identity. No helper, queue, editor or reservation is recreated. */
export function reconcileHelperExecutions(
	messages: DietCodeMessage[],
	store?: ExecutionRecoveryStore,
	lookup?: (id: string) => ActionExecutionSnapshot | undefined,
): DietCodeMessage[] {
	const batches = new Map(
		store
			?.entries("batch")
			.filter((entry) => entry.restored)
			.map((entry) => [entry.id, entry]),
	)
	const seen = new Set<string>()
	const reconcile = (payload: DietCodeSaySubagentStatus) => {
		for (const item of payload.items) {
			const action = item.executionId ? lookup?.(item.executionId) : undefined
			if (action?.kind === "helper" && ["completed", "failed", "cancelled"].includes(action.status)) {
				item.status = action.status as "completed" | "failed" | "cancelled"
				item.activity = undefined
				item.error = action.helper_handoff?.error
			}
			if (action?.helper_handoff) {
				item.filesModified = action.helper_handoff.files_modified
				item.filesViewed = action.helper_handoff.files_viewed
				item.pendingCommandIds = action.helper_handoff.pending_command_ids
				item.result = action.helper_handoff.result ?? item.result
			}
			if (item.status !== "running" && item.status !== "pending") continue
			if (action && !action.recovery && ["queued", "running", "retrying", "awaiting_completion"].includes(action.status))
				continue
			item.status = "interrupted"
			item.activity = undefined
			item.error = "The previous helper has no live owner. It was not resumed. Reconcile its saved work in the parent."
		}
		return JSON.stringify(parseSubagentStatusPayload(JSON.stringify(payload)))
	}
	const result = messages.map((message) => {
		if (message.say !== "subagent") return message
		let payload = parseSubagentStatusPayload(message.text)
		if (!payload) return message
		const saved = payload.batchId ? batches.get(payload.batchId) : undefined
		if (payload.batchId) seen.add(payload.batchId)
		if (saved) payload = recoveredBatch(saved.record) ?? payload
		return { ...message, partial: false, text: reconcile(payload) }
	})
	for (const [id, saved] of batches) {
		if (seen.has(id)) continue
		const payload = recoveredBatch(saved.record)
		if (payload) {
			let ts = saved.record.messageTs ?? saved.observedAt
			while (result.some((message) => message.ts === ts)) ts--
			const position = result.findIndex((message) => message.ts > ts)
			result.splice(position < 0 ? result.length : position, 0, {
				ts,
				type: "say",
				say: "subagent",
				partial: false,
				text: reconcile(payload),
			})
		}
	}
	return result
}
