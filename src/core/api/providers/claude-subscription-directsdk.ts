import { ModelInfo } from "@shared/api"
import { ApiFormat } from "@shared/proto/dietcode/models"
import { normalizeClaudeSubscriptionDirectSdkModel } from "@/core/providers/provider-ids"
import {
	CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL,
	type ClaudeSubscriptionDirectSdkMessage,
	type ClaudeSubscriptionDirectSdkTool,
	createClaudeSubscriptionDirectSdkCompletion,
	createClaudeToolNameMapping,
} from "@/integrations/claude-subscription-directsdk/provider"
import type { DietCodeStorageMessage } from "@/shared/messages/content"
import type { DietCodeTool } from "@/shared/tools"
import type { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { ApiHandler, CommonApiHandlerOptions } from "../types"

export interface ClaudeSubscriptionDirectSdkHandlerOptions extends CommonApiHandlerOptions {
	claudeSubscriptionDirectSdkModelId?: string
	claudeSubscriptionDirectSdkPythonPath?: string
	claudeSubscriptionDirectSdkCommand?: string
	claudeSubscriptionDirectSdkTimeoutMs?: number
	reasoningEffort?: string
	thinkingBudgetTokens?: number
}

function modelInfoFor(modelId: string): ModelInfo {
	const normalized = normalizeClaudeSubscriptionDirectSdkModel(modelId)
	const lowered = normalized.toLowerCase()
	const contextWindowTokens = lowered.endsWith("[1m]") ? 1_000_000 : 200_000
	return {
		name: normalized,
		maxTokens: lowered.includes("haiku") ? 64_000 : 128_000,
		contextWindow: contextWindowTokens,
		supportsImages: true,
		supportsPromptCache: false,
		supportsReasoning: true,
		inputPrice: 0,
		outputPrice: 0,
		apiFormat: ApiFormat.OPENAI_CHAT,
		description: "Experimental Claude Code DirectSDK subscription transport. Account access and usage remain Claude-managed.",
	}
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.filter((block): block is { type: "text"; text: string } => {
			return (
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string"
			)
		})
		.map((block) => block.text)
		.join("")
}

function imageUrl(block: Record<string, unknown>): string | undefined {
	const source = block.source
	if (typeof source !== "object" || source === null) return undefined
	const image = source as Record<string, unknown>
	if (image.type === "url" && typeof image.url === "string") return image.url
	if (image.type === "base64" && typeof image.media_type === "string" && typeof image.data === "string") {
		return `data:${image.media_type};base64,${image.data}`
	}
	return undefined
}

function toBridgeMessages(
	message: DietCodeStorageMessage,
	mapping: ReturnType<typeof createClaudeToolNameMapping>,
): ClaudeSubscriptionDirectSdkMessage[] {
	const content = message.content
	const blocks = Array.isArray(content) ? content : []
	if (message.role === "user") {
		const results: ClaudeSubscriptionDirectSdkMessage[] = []
		for (const block of blocks) {
			if (typeof block !== "object" || block === null) continue
			const candidate = block as unknown as Record<string, unknown>
			if (candidate.type === "tool_result" && typeof candidate.tool_use_id === "string") {
				results.push({
					role: "tool",
					tool_call_id: candidate.tool_use_id,
					content: typeof candidate.content === "string" ? candidate.content : textContent(candidate.content),
				})
			}
		}
		const text = textContent(content)
		const images = blocks.flatMap((block) => {
			if (typeof block !== "object" || block === null || (block as { type?: unknown }).type !== "image") return []
			const url = imageUrl(block as unknown as Record<string, unknown>)
			return url ? [{ type: "image_url" as const, image_url: { url } }] : []
		})
		if (text || images.length > 0) {
			results.push({
				role: "user",
				content: images.length > 0 ? [{ type: "text" as const, text }, ...images] : text,
			})
		}
		return results.length > 0 ? results : [{ role: "user", content: null }]
	}
	const toolCalls = blocks
		.filter((block): block is { type: "tool_use"; id: string; name: string; input: unknown } => {
			return (
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "tool_use" &&
				typeof (block as { id?: unknown }).id === "string" &&
				typeof (block as { name?: unknown }).name === "string"
			)
		})
		.map((block) => ({
			id: block.id,
			type: "function" as const,
			function: {
				name: mapping.originalToWire.get(block.name) ?? block.name,
				arguments: JSON.stringify(block.input ?? {}),
			},
		}))
	const bridgeMessage: ClaudeSubscriptionDirectSdkMessage = {
		role: message.role,
		content: textContent(content) || (typeof content === "string" ? content : null),
	}
	if (toolCalls.length > 0) bridgeMessage.tool_calls = toolCalls
	const reasoningDetails = (message as DietCodeStorageMessage & { reasoning_details?: unknown[] }).reasoning_details
	if (reasoningDetails) {
		;(bridgeMessage as ClaudeSubscriptionDirectSdkMessage & { reasoning_details?: unknown[] }).reasoning_details =
			reasoningDetails
	}
	return [bridgeMessage]
}

function toBridgeTool(
	tool: DietCodeTool,
	mapping: ReturnType<typeof createClaudeToolNameMapping>,
): ClaudeSubscriptionDirectSdkTool | null {
	if (typeof tool !== "object" || tool === null) return null
	const candidate = tool as Record<string, unknown>
	if (candidate.type === "function" && typeof candidate.function === "object" && candidate.function !== null) {
		const fn = candidate.function as Record<string, unknown>
		if (typeof fn.name !== "string") return null
		return {
			type: "function",
			function: {
				name: mapping.originalToWire.get(fn.name) ?? fn.name,
				description: typeof fn.description === "string" ? fn.description : "",
				parameters: (fn.parameters as Record<string, unknown> | undefined) ?? { type: "object", properties: {} },
			},
		}
	}
	if (typeof candidate.name === "string") {
		return {
			type: "function",
			function: {
				name: mapping.originalToWire.get(candidate.name) ?? candidate.name,
				description: typeof candidate.description === "string" ? candidate.description : "",
				parameters: (candidate.input_schema as Record<string, unknown> | undefined) ?? { type: "object", properties: {} },
			},
		}
	}
	return null
}

/** Compatibility handler for the older host API. The active monolith uses the
 * same transport directly; this adapter emits complete response chunks when
 * the legacy host expects an AsyncGenerator. */
export class ClaudeSubscriptionDirectSdkHandler implements ApiHandler {
	private readonly options: ClaudeSubscriptionDirectSdkHandlerOptions
	private activeAbortController: AbortController | undefined
	private lastUsage: ApiStreamUsageChunk | undefined

	constructor(options: ClaudeSubscriptionDirectSdkHandlerOptions) {
		this.options = options
	}

	async *createMessage(
		systemPrompt: string,
		messages: DietCodeStorageMessage[],
		tools?: DietCodeTool[],
		_useResponseApi?: boolean,
	): ApiStream {
		this.activeAbortController = new AbortController()
		this.lastUsage = undefined
		try {
			const history: ClaudeSubscriptionDirectSdkMessage[] = []
			if (systemPrompt.trim()) history.push({ role: "system", content: systemPrompt })
			const toolNames = (tools ?? []).flatMap((tool) => {
				if (typeof tool !== "object" || tool === null) return []
				const candidate = tool as Record<string, unknown>
				const fn = candidate.function as Record<string, unknown> | undefined
				const name =
					typeof fn?.name === "string" ? fn.name : typeof candidate.name === "string" ? candidate.name : undefined
				return name ? [name] : []
			})
			const toolNameMapping = createClaudeToolNameMapping(toolNames)
			history.push(...messages.flatMap((message) => toBridgeMessages(message, toolNameMapping)))
			const bridgeTools = (tools ?? [])
				.map((tool) => toBridgeTool(tool, toolNameMapping))
				.filter((tool): tool is ClaudeSubscriptionDirectSdkTool => tool !== null)
			const model = this.getModel()
			const reasoningEffort = this.normalizedReasoningEffort()
			const response = await createClaudeSubscriptionDirectSdkCompletion(
				{
					model: model.id || CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL,
					messages: history,
					max_tokens: model.info.maxTokens ?? 128_000,
					...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
					...(bridgeTools.length > 0 ? { tools: bridgeTools } : {}),
				},
				{
					pythonPath: this.options.claudeSubscriptionDirectSdkPythonPath,
					command: this.options.claudeSubscriptionDirectSdkCommand,
					timeoutMs: this.options.claudeSubscriptionDirectSdkTimeoutMs,
					signal: this.activeAbortController.signal,
				},
			)
			const choice = response.choices?.[0]
			const message = choice?.message
			if (message?.content) yield { type: "text", text: message.content, id: response.id }
			if (message?.reasoning_content) yield { type: "reasoning", reasoning: message.reasoning_content, id: response.id }
			for (const toolCall of message?.tool_calls ?? []) {
				yield {
					type: "tool_calls",
					id: response.id,
					tool_call: {
						call_id: toolCall.id,
						function: {
							name: toolNameMapping.wireToOriginal.get(toolCall.function.name) ?? toolCall.function.name,
							arguments: toolCall.function.arguments,
						},
					},
				}
			}
			const usage = response.usage
			if (usage) {
				this.lastUsage = {
					type: "usage",
					inputTokens: Number(usage.prompt_tokens ?? 0),
					outputTokens: Number(usage.completion_tokens ?? 0),
					// Subscription charges and extra-usage totals are account-owned; list-price data is not an invoice.
					totalCost: 0,
					id: response.id,
				}
				yield this.lastUsage
			}
		} finally {
			this.activeAbortController = undefined
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const requested = this.options.claudeSubscriptionDirectSdkModelId || CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL
		const id = normalizeClaudeSubscriptionDirectSdkModel(requested)
		return { id, info: modelInfoFor(id) }
	}

	private normalizedReasoningEffort(): string | undefined {
		const effort = this.options.reasoningEffort?.trim().toLowerCase()
		if (!effort || effort === "none") return undefined
		if (effort === "ultra" || effort === "very_high" || effort === "very-high") return "max"
		return ["minimal", "low", "medium", "high", "max"].includes(effort) ? effort : undefined
	}

	async getApiStreamUsage(): Promise<ApiStreamUsageChunk | undefined> {
		return this.lastUsage
	}

	abort(): void {
		this.activeAbortController?.abort()
	}
}
