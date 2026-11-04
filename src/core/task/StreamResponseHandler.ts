import type { ToolUse } from "@core/assistant-message"
import { JSONParser } from "@streamparser/json"
import deepEqual from "fast-deep-equal"
import { nanoid } from "nanoid"
import { McpHub } from "@/services/mcp/McpHub"
import { CLINE_MCP_TOOL_IDENTIFIER } from "@/shared/mcp"
import {
	DietCodeAssistantRedactedThinkingBlock,
	DietCodeAssistantThinkingBlock,
	DietCodeAssistantToolUseBlock,
	DietCodeReasoningDetailParam,
} from "@/shared/messages/content"
import { observeSession } from "@/shared/services/Session"
import { DietCodeDefaultTool } from "@/shared/tools"

export interface PendingToolUse {
	id: string
	name: string
	input: string
	parsedInput?: unknown
	signature?: string
	jsonParser?: JSONParser
	call_id: string
}

export type ToolArgumentErrorKind = "incomplete" | "concatenation" | "syntax" | "invalid_format"

export class ToolArgumentError extends Error {
	constructor(
		message: string,
		public readonly kind: ToolArgumentErrorKind,
		public readonly toolName: string,
		public readonly rawInput: string,
	) {
		super(message)
		this.name = "ToolArgumentError"
	}
}

export interface ExtractedJsonRoot {
	value: unknown
	startIndex: number
	endIndex: number
	raw: string
}

export interface ExtractedJsonResult {
	roots: ExtractedJsonRoot[]
	remainder: string
}

/**
 * Robustly parses all sequentially concatenated complete JSON objects/arrays from a string,
 * tracking character offsets and preserving inner braces, escaped quotes, and string literals.
 */
export function extractJsonRoots(raw: string): ExtractedJsonResult {
	const roots: ExtractedJsonRoot[] = []
	let i = 0
	while (i < raw.length) {
		while (i < raw.length && /\s/.test(raw[i])) i++
		if (i >= raw.length) break
		const startChar = raw[i]
		if (startChar !== "{" && startChar !== "[") {
			return { roots, remainder: raw.slice(i) }
		}
		const startIndex = i
		let depth = 0
		let inString = false
		let escape = false
		let parsedRoot: unknown = null
		let endIndex = -1
		for (; i < raw.length; i++) {
			const char = raw[i]
			if (inString) {
				if (escape) {
					escape = false
				} else if (char === "\\") {
					escape = true
				} else if (char === '"') {
					inString = false
				}
			} else {
				if (char === '"') {
					inString = true
				} else if (char === "{" || char === "[") {
					depth++
				} else if (char === "}" || char === "]") {
					depth--
					if (depth === 0) {
						endIndex = i + 1
						const slice = raw.slice(startIndex, endIndex)
						try {
							parsedRoot = JSON.parse(slice)
						} catch {
							parsedRoot = null
						}
						break
					}
				}
			}
		}
		if (parsedRoot !== null) {
			roots.push({ value: parsedRoot, startIndex, endIndex, raw: raw.slice(startIndex, endIndex) })
			i = endIndex
		} else {
			return { roots, remainder: raw.slice(startIndex) }
		}
	}
	return { roots, remainder: "" }
}

/**
 * Detects if a string contains a complete JSON value followed by extra content
 * (e.g. concatenated snapshots like `{"path": "."}{"path": "."}`).
 * Returns the parsed first object if found.
 */
export function extractFirstCompleteJsonRoot(raw: string): unknown | undefined {
	return extractJsonRoots(raw).roots[0]?.value
}

interface ToolUseDeltaBlock {
	id?: string
	type?: string
	name?: string
	input?: string
	call_id?: string
}

export interface ReasoningDelta {
	id?: string
	reasoning?: string
	call_id?: string
	details?: any[]
	redacted_data?: any
}

export interface PendingReasoning {
	id?: string
	content: string
	call_id: string
	redactedThinking: DietCodeAssistantRedactedThinkingBlock[]
	summary: unknown[] | DietCodeReasoningDetailParam[]
}

const ESCAPE_MAP: Record<string, string> = {
	"\\n": "\n",
	"\\t": "\t",
	"\\r": "\r",
	'\\"': '"',
	"\\\\": "\\",
}

const ESCAPE_PATTERN = /\\[ntr"\\]/g

export class StreamResponseHandler {
	private toolUseHandler = new ToolUseHandler()
	private reasoningHandler = new ReasoningHandler()

	private _requestId: string | undefined

	public setRequestId(id?: string) {
		if (!this._requestId && id) {
			this._requestId = id
		}
	}

	public get requestId() {
		return this._requestId
	}

	public getHandlers() {
		return {
			toolUseHandler: this.toolUseHandler,
			reasonsHandler: this.reasoningHandler,
		}
	}

	public reset() {
		this._requestId = undefined
		this.toolUseHandler = new ToolUseHandler()
		this.reasoningHandler = new ReasoningHandler()
	}
}

/**
 * Handles streaming native tool use blocks and converts them to DietCodeAssistantToolUseBlock format
 */
class ToolUseHandler {
	private pendingToolUses = new Map<string, PendingToolUse>()

	processToolUseDelta(delta: ToolUseDeltaBlock, call_id?: string): void {
		if (delta.type !== "tool_use" || !delta.id) {
			return
		}

		let pending = this.pendingToolUses.get(delta.id)
		if (!pending) {
			pending = this.createPendingToolUse(delta.id, delta.name || "", call_id)
		}

		if (delta.name) {
			pending.name = delta.name
		}

		if (delta.call_id) {
			pending.call_id = delta.call_id
		}

		if (delta.input) {
			let inputDelta = delta.input
			// If delta.input is a duplicate snapshot of what was already accumulated, slice it to prevent corruption.
			if (pending.input.length > 0 && inputDelta.startsWith(pending.input)) {
				inputDelta = inputDelta.slice(pending.input.length)
			} else if (pending.input.trim().length > 0 && inputDelta.trim().length > 0) {
				// Check if inputDelta is an identical complete JSON duplicate of pending.input
				const pendingResult = extractJsonRoots(pending.input)
				const deltaResult = extractJsonRoots(inputDelta)
				if (
					pendingResult.roots.length > 0 &&
					pendingResult.remainder.trim() === "" &&
					deltaResult.roots.length > 0 &&
					deltaResult.remainder.trim() === "" &&
					deepEqual(pendingResult.roots[0].value, deltaResult.roots[0].value)
				) {
					inputDelta = ""
				}
			}
			if (inputDelta.length > 0) {
				pending.input += inputDelta
				try {
					pending.jsonParser?.write(inputDelta)
				} catch {
					// Expected during streaming - JSONParser may not have complete JSON yet
				}
			}
		}
	}

	getFinalizedToolUse(id: string): DietCodeAssistantToolUseBlock | undefined {
		const pending = this.pendingToolUses.get(id)
		if (!pending?.name) {
			return undefined
		}

		let input: unknown = {}
		if (pending.parsedInput != null) {
			input = pending.parsedInput
		} else if (pending.input) {
			try {
				input = JSON.parse(pending.input)
			} catch {
				const { roots } = extractJsonRoots(pending.input)
				if (roots.length > 0 && typeof roots[0].value === "object" && roots[0].value !== null) {
					input = roots[0].value
				} else {
					input = this.extractPartialJsonFields(pending.input)
				}
			}
		}

		return {
			type: "tool_use",
			id: pending.id,
			name: pending.name,
			input,
			call_id: pending.call_id,
		}
	}

	getAllFinalizedToolUses(summary?: DietCodeAssistantToolUseBlock["reasoning_details"]): DietCodeAssistantToolUseBlock[] {
		const results: DietCodeAssistantToolUseBlock[] = []
		for (const id of this.pendingToolUses.keys()) {
			const toolUse = this.getFinalizedToolUse(id)
			if (toolUse) {
				results.push({ ...toolUse, reasoning_details: summary })
			}
		}
		return results
	}

	assertCompleteToolUses(): void {
		for (const pending of this.pendingToolUses.values()) {
			const toolIdentifier = pending.name || pending.id
			if (!pending.name) {
				throw new ToolArgumentError(
					`Invalid arguments for tool ${toolIdentifier}; missing tool name.`,
					"invalid_format",
					toolIdentifier,
					pending.input,
				)
			}

			const trimmed = pending.input?.trim() ?? ""
			if (trimmed.length === 0) {
				throw new ToolArgumentError(
					`Incomplete arguments for tool ${toolIdentifier}; the call was not executed.`,
					"incomplete",
					toolIdentifier,
					pending.input,
				)
			}

			let input: unknown
			try {
				input = JSON.parse(pending.input)
			} catch (parseError) {
				// Diagnose whether this is concatenated snapshots, an incomplete stream, or malformed syntax
				const { roots, remainder } = extractJsonRoots(pending.input)
				if (roots.length > 1 && remainder.trim() === "") {
					const allEqual = roots.every((r) => deepEqual(r.value, roots[0].value))
					if (
						allEqual &&
						typeof roots[0].value === "object" &&
						roots[0].value !== null &&
						!Array.isArray(roots[0].value)
					) {
						// Self-heal: multiple identical duplicate snapshots detected across the stream
						pending.input = roots[0].raw
						pending.parsedInput = roots[0].value
						input = roots[0].value
					}
				}

				if (!input) {
					if (roots.length >= 1) {
						// There was at least one complete JSON root followed by more content or non-identical roots
						throw new ToolArgumentError(
							`Malformed arguments for tool ${toolIdentifier}: detected concatenated tool call arguments or duplicate snapshots ("${pending.input}").`,
							"concatenation",
							toolIdentifier,
							pending.input,
						)
					}

					const errorMsg = parseError instanceof Error ? parseError.message : String(parseError)
					const isIncomplete =
						errorMsg.includes("Unexpected end of JSON") ||
						errorMsg.includes("Unexpected end of data") ||
						errorMsg.includes("Unterminated string") ||
						errorMsg.includes("Expected ',' or '}'") ||
						errorMsg.includes("Expected ':'") ||
						errorMsg.includes("Expected double-quoted property name") ||
						trimmed.endsWith(":") ||
						trimmed.endsWith(",") ||
						trimmed.endsWith("{") ||
						trimmed.endsWith("[")

					if (isIncomplete) {
						throw new ToolArgumentError(
							`Incomplete arguments for tool ${toolIdentifier}; the call was not executed.`,
							"incomplete",
							toolIdentifier,
							pending.input,
						)
					}
					throw new ToolArgumentError(
						`Malformed arguments for tool ${toolIdentifier}: syntax error in tool arguments ("${errorMsg}").`,
						"syntax",
						toolIdentifier,
						pending.input,
					)
				}
			}

			if (input === null || typeof input !== "object" || Array.isArray(input)) {
				throw new ToolArgumentError(
					`Invalid arguments for tool ${toolIdentifier}; expected a JSON object.`,
					"invalid_format",
					toolIdentifier,
					pending.input,
				)
			}
		}
	}

	hasToolUse(id: string): boolean {
		return this.pendingToolUses.has(id)
	}

	getPartialToolUsesAsContent(): ToolUse[] {
		const results: ToolUse[] = []
		const pendingToolUses = this.pendingToolUses.values()

		for (const pending of pendingToolUses) {
			if (!pending.name) {
				continue
			}

			// Try to get the most up-to-date parsed input
			// Priority: parsedInput (from JSONParser) > fallback to manual parsing
			let input: any = {}
			if (pending.parsedInput != null) {
				input = pending.parsedInput
			} else if (pending.input) {
				// Try full JSON parse first
				try {
					input = JSON.parse(pending.input)
				} catch {
					// Fall back to extracting partial fields from incomplete JSON
					input = this.extractPartialJsonFields(pending.input)
				}
			}

			if (pending.name.includes(CLINE_MCP_TOOL_IDENTIFIER)) {
				const [key, toolName] = pending.name.split(CLINE_MCP_TOOL_IDENTIFIER)
				results.push({
					type: "tool_use",
					name: DietCodeDefaultTool.MCP_USE,
					params: {
						server_name: McpHub.getMcpServerByKey(key),
						tool_name: toolName,
						arguments: JSON.stringify(input),
					},
					partial: true,
					isNativeToolCall: true,
					call_id: pending.call_id,
					tool_use_id: pending.id,
				})
			} else {
				const params: Record<string, string> = {}
				if (typeof input === "object" && input !== null) {
					for (const [key, value] of Object.entries(input)) {
						params[key] = typeof value === "string" ? value : JSON.stringify(value)
					}
				}
				results.push({
					type: "tool_use",
					name: pending.name as DietCodeDefaultTool,
					params: params as any,
					partial: true,
					isNativeToolCall: true,
					call_id: pending.call_id,
					tool_use_id: pending.id,
				})
			}
		}
		// Ensure all returned tool uses are marked as partial
		return results.map((t) => ({ ...t, partial: true }))
	}

	reset(): void {
		this.pendingToolUses.clear()
	}

	private createPendingToolUse(id: string, name: string, callId?: string): PendingToolUse {
		const jsonParser = new JSONParser()
		jsonParser.onValue = (info: any) => {
			if (info.stack.length === 0 && info.value && typeof info.value === "object") {
				pending.parsedInput = info.value
			}
		}

		jsonParser.onError = () => {}

		const pending: PendingToolUse = {
			id,
			name,
			input: "",
			parsedInput: undefined,
			jsonParser,
			// Ensure call_id is always set for tracking
			call_id: callId || id || nanoid(8),
		}

		this.pendingToolUses.set(id, pending)
		// Initialize tool call in session tracking
		observeSession((session) => session.updateToolCall(pending.call_id, pending.name))

		return pending
	}

	private extractPartialJsonFields(partialJson: string): Record<string, any> {
		const result: Record<string, any> = {}
		const pattern = /"(\w+)":\s*"((?:[^"\\]|\\.)*)(?:")?/g

		for (const match of partialJson.matchAll(pattern)) {
			result[match[1]] = match[2].replace(ESCAPE_PATTERN, (m) => ESCAPE_MAP[m])
		}

		return result
	}
}

/**
 * Handles streaming reasoning content and converts it to the appropriate message format
 */
class ReasoningHandler {
	private pendingReasoning: PendingReasoning | null = null

	processReasoningDelta(delta: ReasoningDelta): void {
		// Initialize pending reasoning if we have an ID but no pending reasoning yet
		if (!this.pendingReasoning) {
			this.pendingReasoning = {
				id: delta.id,
				content: "",
				redactedThinking: [],
				summary: [],
				call_id: delta.call_id || delta.id || "",
			}
		}

		if (!this.pendingReasoning) {
			return
		}

		// Update fields from delta
		if (delta.reasoning) {
			this.pendingReasoning.content += delta.reasoning
		}
		if (delta.call_id) {
			this.pendingReasoning.call_id = delta.call_id
		}
		if (delta.details) {
			if (Array.isArray(delta.details)) {
				this.pendingReasoning.summary.push(...delta.details)
			} else {
				this.pendingReasoning.summary.push(delta.details)
			}
		}
		if (delta.redacted_data) {
			this.pendingReasoning.redactedThinking.push({
				type: "redacted_thinking",
				data: delta.redacted_data,
				call_id: delta.id || this.pendingReasoning.id,
			})
		}
	}

	getCurrentReasoning(): DietCodeAssistantThinkingBlock | null {
		if (!this.pendingReasoning) {
			return null
		}

		if (!this.pendingReasoning.summary.length && !this.pendingReasoning.content) {
			return null
		}

		// Ensure signature is set if it's hidden in the summary / reasoning details
		// to ensure it's always accessible at the top level by each provider.
		if (!this.pendingReasoning.call_id && this.pendingReasoning.summary.length) {
			const lastSummary = this.pendingReasoning.summary.at(-1)
			if (lastSummary && typeof lastSummary === "object" && "call_id" in lastSummary) {
				if (typeof lastSummary.call_id === "string") {
					this.pendingReasoning.call_id = lastSummary.call_id
				}
			}
		}

		return {
			type: "thinking",
			thinking: this.pendingReasoning.content,
			summary: this.pendingReasoning.summary,
			call_id: this.pendingReasoning.id || this.pendingReasoning.call_id,
			signature: this.pendingReasoning.call_id, // For backward compatibility if signature is required but missing
		} as DietCodeAssistantThinkingBlock
	}

	getRedactedThinking(): DietCodeAssistantRedactedThinkingBlock[] {
		return this.pendingReasoning?.redactedThinking || []
	}

	reset(): void {
		this.pendingReasoning = null
	}
}
