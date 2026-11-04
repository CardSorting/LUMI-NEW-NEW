import OpenAI from "openai"
import { ModelInfo } from "@/shared/api"
import { Logger } from "@/shared/services/Logger"

// Type that represents the OpenAI ResponseStream with its private properties
// The #private property issue can be resolved by using the AsyncIterable interface
export async function* handleResponsesApiStreamResponse(
	stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent> & { _request_id?: string | null },
	modelInfo: ModelInfo,
	calculateCost: (
		modelInfo: ModelInfo,
		inputTokens: number,
		outputTokens: number,
		cacheWriteTokens: number,
		cacheReadTokens: number,
	) => Promise<number>,
) {
	const functionCallByItemId = new Map<string, { call_id?: string; name?: string; id?: string }>()
	const streamedArgs = new Map<string, string>()
	const emittedCallIds = new Set<string>()

	const toolCallDelta = (callId: string, args: string, snapshot = false): string => {
		const previous = streamedArgs.get(callId) || ""
		const delta = snapshot ? (args.startsWith(previous) ? args.slice(previous.length) : "") : args
		streamedArgs.set(callId, previous + delta)
		return delta
	}

	// Process the response stream
	for await (const chunk of stream) {
		// Handle different event types from Responses API
		if (chunk.type === "response.output_item.added") {
			const item = chunk.item
			if (item.type === "function_call" && item.id) {
				functionCallByItemId.set(item.id, { call_id: item.call_id, name: item.name, id: item.id })
				const callId = item.call_id || item.id
				const rawArgs = typeof item.arguments === "string" ? item.arguments : ""
				const delta = toolCallDelta(callId, rawArgs, true)
				if (delta.length > 0 || !emittedCallIds.has(callId)) {
					emittedCallIds.add(callId)
					yield {
						type: "tool_calls",
						id: item.id,
						tool_call: {
							call_id: item.call_id,
							function: {
								id: item.id,
								name: item.name,
								arguments: delta,
							},
						},
					} as const
				}
			}
			if (item.type === "reasoning" && item.encrypted_content && item.id) {
				yield {
					type: "reasoning",
					id: item.id,
					reasoning: "",
					redacted_data: item.encrypted_content,
				} as const
			}
		}
		if (chunk.type === "response.output_item.done") {
			const item = chunk.item
			if (item.type === "function_call") {
				const pendingCall = item.id ? functionCallByItemId.get(item.id) : undefined
				const functionName = item.name || pendingCall?.name
				if (item.id) {
					functionCallByItemId.set(item.id, { call_id: item.call_id, name: functionName, id: item.id })
				}
				const callId = item.call_id || item.id || ""
				const rawArgs = typeof item.arguments === "string" ? item.arguments : "{}"
				const delta = toolCallDelta(callId, rawArgs, true)
				if (delta.length > 0 || !emittedCallIds.has(callId)) {
					emittedCallIds.add(callId)
					yield {
						type: "tool_calls",
						id: item.id || item.call_id,
						tool_call: {
							call_id: item.call_id,
							function: {
								id: item.id,
								name: functionName,
								arguments: delta,
							},
						},
					} as const
				}
			}
			if (item.type === "reasoning") {
				yield {
					type: "reasoning",
					id: item.id,
					details: item.summary,
					reasoning: "",
				} as const
			}
		}
		if (chunk.type === "response.reasoning_summary_part.added") {
			yield {
				type: "reasoning",
				id: chunk.item_id,
				reasoning: chunk.part.text,
			} as const
		}
		if (chunk.type === "response.reasoning_summary_text.delta") {
			yield {
				type: "reasoning",
				id: chunk.item_id,
				reasoning: chunk.delta,
			} as const
		}
		if (chunk.type === "response.reasoning_summary_part.done") {
			yield {
				type: "reasoning",
				id: chunk.item_id,
				details: chunk.part,
				reasoning: "",
			} as const
		}
		if (chunk.type === "response.output_text.delta") {
			// Handle text content deltas
			if (chunk.delta) {
				yield {
					id: chunk.item_id,
					type: "text",
					text: chunk.delta,
				} as const
			}
		}
		if (chunk.type === "response.reasoning_text.delta") {
			// Handle reasoning content deltas
			if (chunk.delta) {
				yield {
					id: chunk.item_id,
					type: "reasoning",
					reasoning: chunk.delta,
				} as const
			}
		}
		if (chunk.type === "response.function_call_arguments.delta") {
			const pendingCall = functionCallByItemId.get(chunk.item_id)
			const callId = pendingCall?.call_id || chunk.item_id
			const functionName = pendingCall?.name || chunk.item_id
			const functionId = pendingCall?.id || chunk.item_id
			const delta = toolCallDelta(callId, chunk.delta || "", false)
			if (delta.length > 0) {
				emittedCallIds.add(callId)
				yield {
					type: "tool_calls",
					tool_call: {
						call_id: callId,
						function: {
							id: functionId,
							name: functionName,
							arguments: delta,
						},
					},
				} as const
			}
		}
		if (chunk.type === "response.function_call_arguments.done") {
			// Handle completed function call
			const pendingCall = chunk.item_id ? functionCallByItemId.get(chunk.item_id) : undefined
			const functionName = chunk.name || pendingCall?.name
			if (chunk.item_id && functionName) {
				const callId = pendingCall?.call_id || chunk.item_id
				const functionId = pendingCall?.id || chunk.item_id
				const rawArgs = typeof chunk.arguments === "string" ? chunk.arguments : "{}"
				const delta = toolCallDelta(callId, rawArgs, true)
				if (delta.length > 0 || !emittedCallIds.has(callId)) {
					emittedCallIds.add(callId)
					yield {
						type: "tool_calls",
						tool_call: {
							call_id: callId,
							function: {
								id: functionId,
								name: functionName,
								arguments: delta,
							},
						},
					} as const
				}
			}
		}

		if (
			chunk.type === "response.incomplete" &&
			chunk.response?.status === "incomplete" &&
			chunk.response?.incomplete_details?.reason === "max_output_tokens"
		) {
			Logger.log("Ran out of tokens")
			if (chunk.response?.output_text?.length > 0) {
				Logger.log("Partial output:", chunk.response.output_text)
			} else {
				Logger.log("Ran out of tokens during reasoning")
			}
		}

		if (chunk.type === "response.completed" && chunk.response?.usage) {
			// Handle usage information when response is complete
			const usage = chunk.response.usage
			const inputTokens = usage.input_tokens || 0
			const outputTokens = usage.output_tokens || 0
			const cacheReadTokens = usage.output_tokens_details?.reasoning_tokens || 0
			const cacheWriteTokens = usage.input_tokens_details?.cached_tokens || 0
			const totalTokens = usage.total_tokens || 0
			const totalCost = await calculateCost(modelInfo, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens)
			Logger.log(`Total tokens from Responses API usage: ${totalTokens}`)
			const nonCachedInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens)
			yield {
				type: "usage",
				inputTokens: nonCachedInputTokens,
				outputTokens: outputTokens,
				cacheWriteTokens: cacheWriteTokens,
				cacheReadTokens: cacheReadTokens,
				totalCost: totalCost,
				id: chunk.response.id,
			} as const
		}
	}
}
