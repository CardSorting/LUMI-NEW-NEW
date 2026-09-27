import type { DietCodeStorageMessage } from "@/shared/messages"
import { Logger } from "@/shared/services/Logger"
import { type ExecutionStateResult, executionContextByteBudget, formatExecutionState } from "./ExecutionState"

// Recognize only blocks we created. User text and tool results that contain similar tags remain untouched.
const runtimeBlocks = new WeakSet<object>()

/** Collect at dispatch, after prompt preparation/compaction. Never persist a runtime snapshot into history. */
export function withExecutionContext(
	conversation: DietCodeStorageMessage[],
	getState: (() => ExecutionStateResult) | undefined,
	observer = "parent",
	contextWindow?: number,
): DietCodeStorageMessage[] {
	let index = conversation.length - 1
	while (index >= 0 && conversation[index].role !== "user") index--
	if (index < 0) return conversation
	let text =
		"<execution_state>Execution inventory is unavailable for this request. This does not mean no work is running. Inspect known execution IDs and existing results before resubmitting work; continue independent authorized work.</execution_state>"
	try {
		const state = getState?.()
		if (state && "commands" in state) text = formatExecutionState(state, observer, executionContextByteBudget(contextWindow))
	} catch (error) {
		Logger.warn("[ExecutionContext] Execution inventory unavailable:", error)
	}
	const message = conversation[index]
	const content = Array.isArray(message.content)
		? message.content
		: [{ type: "text" as const, text: String(message.content ?? "") }]
	const block = { type: "text" as const, text }
	runtimeBlocks.add(block)
	const request = [...conversation]
	request[index] = { ...message, content: [...content.filter((item) => !runtimeBlocks.has(item)), block] }
	return request
}
