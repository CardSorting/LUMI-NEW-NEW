import type { DietCodeAssistantContent, DietCodeUserContent } from "@/shared/messages/content"

/**
 * A broken stream may contain unsigned reasoning and incomplete native calls.
 * Record actual execution evidence as text instead of manufacturing finalized calls
 * or unmatched tool_result blocks. This also survives cancellation during backoff.
 */
export function buildInterruptedAssistantContent(text: string, results: DietCodeUserContent[]): DietCodeAssistantContent[] {
	const content: DietCodeAssistantContent[] = [
		{ type: "text", text: `${text}\n\n[Provider response interrupted. Unfinished tool calls were discarded.]`.trim() },
	]
	for (const result of results) {
		if (result.type === "tool_result") {
			content.push({ type: "text", text: `[Execution result recorded before interruption: ${result.tool_use_id}]` })
			if (typeof result.content === "string") {
				content.push({ type: "text", text: result.content || "(empty tool result)" })
			} else {
				for (const block of result.content ?? []) {
					if (block.type === "text" || block.type === "image") content.push(block)
				}
			}
		} else {
			content.push(result)
		}
	}
	return content
}

export const STREAM_RECOVERY_INSTRUCTION =
	"Continue the current task from the recorded execution results. Do not repeat completed actions. " +
	"If an interrupted operation has no result, inspect its state before deciding whether to run it again. " +
	"Only issue unfinished tool calls with complete arguments."
