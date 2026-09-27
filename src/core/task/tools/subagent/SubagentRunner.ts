import { createHash, randomUUID } from "node:crypto"
import * as path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { ApiHandler, buildApiHandler } from "@core/api"
import { guardedStream } from "@core/api/guardedStream"
import { getApiRetryDelay, shouldRetryApiError, waitForApiRetry } from "@core/api/retry"
import type { ApiStreamChunk } from "@core/api/transform/stream"
import { parseAssistantMessageV2, ToolUse } from "@core/assistant-message"
import { discoverSkills, getAvailableSkills } from "@core/context/instructions/user-instructions/skills"
import { formatResponse } from "@core/prompts/responses"
import { PromptRegistry } from "@core/prompts/system-prompt"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { StreamResponseHandler } from "@core/task/StreamResponseHandler"
import { buildInterruptedAssistantContent, STREAM_RECOVERY_INSTRUCTION } from "@core/task/streamRecovery"
import { resolveWorkspacePath } from "@core/workspace"
import { ModelInfo } from "@shared/api"
import { resolveCompletionGateOptions } from "@shared/audit/auditGatePolicyLoader"
import { buildSubagentAuditContext, buildSubagentGateSignals } from "@shared/audit/auditSubagentContext"
import type { SubagentActivity } from "@shared/ExtensionMessage"
import {
	DietCodeAssistantToolUseBlock,
	DietCodeStorageMessage,
	DietCodeTextContentBlock,
	DietCodeUserContent,
} from "@shared/messages"
import { Logger } from "@shared/services/Logger"
import { DietCodeDefaultTool, DietCodeTool } from "@shared/tools"
import pTimeout from "p-timeout"
import { ContextManager } from "@/core/context/context-management/ContextManager"
import { checkContextWindowExceededError } from "@/core/context/context-management/context-error-handling"
import { getContextWindowInfo } from "@/core/context/context-management/context-window-utils"
import { orchestrator } from "@/infrastructure/ai/Orchestrator"
import { FileEditProvider } from "@/integrations/editor/FileEditProvider"
import { canonicalFilePath } from "@/integrations/editor/FileMutationCoordinator"
import { normalizeShellCommand } from "@/integrations/terminal/normalizeCommand"
import { HostRegistryInfo } from "@/registry"
import { DietCodeError, DietCodeErrorType } from "@/services/error"
import { ApiFormat } from "@/shared/proto/dietcode/models"
import { calculateApiCostAnthropic, calculateApiCostOpenAI } from "@/utils/cost"
import { isNextGenModelFamily } from "@/utils/model-utils"
import { withExecutionContext } from "../../ExecutionContext"
import { TaskState } from "../../TaskState"
import { ToolProgressTracker } from "../../ToolProgressTracker"
import {
	buildCompletionGateObservabilityEnvelope,
	canonicalizeAttemptCompletionResultParams,
	getCompletionGateOperationalState,
	getCompletionGatePressureLevel,
	getCompletionGateRetryPolicy,
	isCompletionGateCircuitBreakerTripped,
} from "../attemptCompletionUtils"
import { validateSubagentCompletionGates } from "../subagentCompletionGates"
import { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import { PartialPatchError } from "../utils/FileProviderOperations"
import { isToolFailure } from "../utils/toolOutcome"
import { observeHelperOperation } from "./observeHelperOperation"
import { SubagentBuilder } from "./SubagentBuilder"
import { SwarmConsensusHandler } from "./SwarmConsensusHandler"

const MAX_EMPTY_ASSISTANT_RETRIES = 1
const MAX_INITIAL_STREAM_ATTEMPTS = 3
const INITIAL_STREAM_RETRY_BASE_DELAY_MS = 250
const MAX_STREAM_RECOVERY_ATTEMPTS = 2

function getParentCompletionFailedStage(taskState: TaskState): string | undefined {
	return taskState.lastCompletionFailedStage
}

function getParentGatePressureLevel(taskState: TaskState): string | undefined {
	return taskState.completionGatePressureLevel
}

function getSubagentGateConfig(baseConfig: TaskConfig): TaskConfig {
	return {
		taskState: baseConfig.taskState,
		focusChainSettings: baseConfig.focusChainSettings,
		messageState: baseConfig.messageState,
	} as TaskConfig
}

export type SubagentRunStatus = "completed" | "failed" | "cancelled"

export interface SubagentRunResult {
	status: SubagentRunStatus
	result?: string
	error?: string
	stats: SubagentRunStats
	filesModified?: string[]
	filesViewed?: string[]
	durationMs?: number
	isPartial?: boolean
	pendingCommandIds?: string[]
}

interface ConfigWithExtensions extends TaskConfig {
	getSessionStreamId?: () => string
}

interface SubagentProgressUpdate {
	stats?: SubagentRunStats
	latestToolCall?: string
	activity?: SubagentActivity
	status?: "running" | SubagentRunStatus
	result?: string
	error?: string
	activeSignals?: string[]
	filesModified?: string[]
	filesViewed?: string[]
	durationMs?: number
	pendingCommandIds?: string[]
}

interface SubagentRunStats {
	toolCalls: number
	inputTokens: number
	outputTokens: number
	cacheWriteTokens: number
	cacheReadTokens: number
	totalCost: number
	contextTokens: number
	contextWindow: number
	contextUsagePercentage: number
	maxTokens?: number
	maxCost?: number
}

interface SubagentRequestUsageState {
	inputTokens: number
	outputTokens: number
	cacheWriteTokens: number
	cacheReadTokens: number
	totalTokens: number
	totalCost?: number
}

interface SubagentUsageState {
	currentRequest: SubagentRequestUsageState
	lastRequest?: SubagentRequestUsageState
}

interface SubagentToolCall {
	toolUseId: string
	id?: string
	call_id?: string
	name: string
	input: unknown
	isNativeToolCall: boolean
}

function createEmptyRequestUsageState(): SubagentRequestUsageState {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheWriteTokens: 0,
		cacheReadTokens: 0,
		totalTokens: 0,
	}
}

function serializeToolResult(result: unknown): string {
	if (typeof result === "string") {
		return result
	}

	if (Array.isArray(result)) {
		return result
			.map((item) => {
				if (!item || typeof item !== "object") {
					return String(item)
				}

				const maybeText = (item as { text?: string }).text
				if (typeof maybeText === "string") {
					return maybeText
				}

				return JSON.stringify(item)
			})
			.join("\n")
	}

	return JSON.stringify(result, null, 2) ?? "(empty tool result)"
}

function toToolUseParams(input: unknown): Partial<Record<string, string>> {
	if (!input || typeof input !== "object") {
		return {}
	}

	const params: Record<string, string> = {}
	for (const [key, value] of Object.entries(input)) {
		params[key] = typeof value === "string" ? value : JSON.stringify(value)
	}

	return params
}

function calculateApiCost(
	modelInfo: ModelInfo,
	inputTokens: number,
	outputTokens: number,
	cacheCreationInputTokens?: number,
	cacheReadInputTokens?: number,
): number {
	const format = modelInfo.apiFormat
	if (
		format === ApiFormat.OPENAI_CHAT ||
		format === ApiFormat.OPENAI_RESPONSES ||
		format === ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE
	) {
		return calculateApiCostOpenAI(modelInfo, inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens)
	}
	// Fallback to Anthropic style for providers where inputTokens already represents the total
	return calculateApiCostAnthropic(modelInfo, inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens)
}

function formatToolArgPreview(value: string, maxLength = 48): string {
	const normalized = value.replace(/\s+/g, " ").trim()
	if (normalized.length <= maxLength) {
		return normalized
	}
	return `${normalized.slice(0, maxLength - 3)}...`
}

function formatToolCallPreview(toolName: string, params: Partial<Record<string, string>>): string {
	const entries = Object.entries(params).filter(([, value]) => value !== undefined)
	const visibleEntries = entries.slice(0, 3)
	const omittedCount = Math.max(0, entries.length - visibleEntries.length)

	const args = visibleEntries
		.map(([key, value]) => `${key}=${formatToolArgPreview(value ?? "")}`)
		.concat(omittedCount > 0 ? [`...+${omittedCount}`] : [])
		.join(", ")

	return `${toolName}(${args})`
}

function normalizeToolCallArguments(argumentsPayload: unknown): string {
	if (typeof argumentsPayload === "string") {
		return argumentsPayload
	}

	try {
		return JSON.stringify(argumentsPayload ?? {})
	} catch {
		return "{}"
	}
}

function resolveToolUseId(call: { id?: string; call_id?: string; name?: string }, index: number): string {
	const id = call.id?.trim()
	if (id) {
		return id
	}

	const callId = call.call_id?.trim()
	if (callId) {
		return callId
	}

	const fallbackId = `subagent_tool_${randomUUID()}_${index + 1}`
	Logger.warn(`[SubagentRunner] Missing tool call id for '${call.name || "unknown"}'; using fallback '${fallbackId}'`)
	return fallbackId
}

function toAssistantToolUseBlock(call: SubagentToolCall): DietCodeAssistantToolUseBlock {
	return {
		type: "tool_use",
		id: call.toolUseId,
		name: call.name,
		input: call.input,
		call_id: call.call_id,
	}
}

function parseNonNativeToolCalls(assistantText: string): SubagentToolCall[] {
	const parsedBlocks = parseAssistantMessageV2(assistantText)
	if (parsedBlocks.some((block) => block.type === "tool_use" && block.partial)) {
		throw new Error(
			"Helper response contains an incomplete tool call. No tool from this response was dispatched; reconcile earlier work before continuing.",
		)
	}

	return parsedBlocks
		.filter((block): block is ToolUse => block.type === "tool_use")
		.filter((block) => !block.partial)
		.map((block, index) => ({
			toolUseId: resolveToolUseId({ call_id: block.call_id, name: block.name }, index),
			name: block.name,
			input: block.params,
			call_id: block.call_id,
			isNativeToolCall: false,
		}))
}

function pushSubagentToolResultBlock(
	toolResultBlocks: DietCodeUserContent[],
	call: SubagentToolCall,
	label: string,
	content: string,
	isError = isToolFailure(content),
): void {
	if (call.isNativeToolCall) {
		toolResultBlocks.push({
			type: "tool_result",
			tool_use_id: call.toolUseId,
			call_id: call.call_id,
			content,
			...(isError ? { is_error: true } : {}),
		})
		return
	}

	toolResultBlocks.push({
		type: "text",
		text: `${label} Result:\n${content}`,
	})
}

export class SubagentRunner {
	private readonly executionOwner = `helper:${randomUUID()}`
	getExecutionOwner(): string {
		return this.executionOwner
	}
	private readonly apiHandler: ApiHandler
	private readonly agent: SubagentBuilder
	private readonly allowedTools: DietCodeDefaultTool[]
	private activeApiAbort?: () => void
	private readonly abortController = new AbortController()
	private abortRequested = false
	private recursionDepth = 0
	private streamId?: string

	private readonly baseConfig: TaskConfig
	private signaledFindings = new Set<string>()
	private stats: SubagentRunStats = {
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheWriteTokens: 0,
		cacheReadTokens: 0,
		totalCost: 0,
		contextTokens: 0,
		contextWindow: 0,
		contextUsagePercentage: 0,
	}
	private activeSignals: string[] = []
	private onProgress?: (update: SubagentProgressUpdate) => void
	private activeTaskState?: TaskState

	constructor(baseConfig: TaskConfig, agent: SubagentBuilder) {
		this.baseConfig = baseConfig
		this.agent = agent
		this.apiHandler = this.agent.getApiHandler()
		this.allowedTools = this.agent.getAllowedTools()
	}

	setRecursionDepth(depth: number): void {
		this.recursionDepth = depth
	}

	setStreamId(streamId: string): void {
		this.streamId = streamId
	}

	async abort(): Promise<void> {
		this.abortRequested = true
		this.abortController.abort()
		if (this.activeTaskState) this.activeTaskState.abort = true
		try {
			this.agent.cancelPendingRetry()
		} catch (error) {
			Logger.warn("[SubagentRunner] Failed to cancel retry wait:", error)
		}

		try {
			this.activeApiAbort?.()
		} catch (error) {
			Logger.error("[SubagentRunner] failed to abort active API stream", error)
		}
	}

	private shouldAbort(): boolean {
		return this.abortRequested || this.baseConfig.taskState.abort
	}

	private throwIfAborted(): void {
		if (this.shouldAbort()) throw new Error("Subagent run cancelled.")
		this.baseConfig.taskState.recovery?.assertCanExecute(this.executionOwner)
	}

	private waitForActiveOperation<T>(operation: () => Promise<T>): Promise<T> {
		this.throwIfAborted()
		return pTimeout(
			Promise.resolve().then(() => {
				this.throwIfAborted()
				return operation()
			}),
			{ milliseconds: Number.POSITIVE_INFINITY, signal: this.abortController.signal },
		)
	}

	private checkBudget(): void {
		const { maxTokens, maxCost, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, totalCost } = this.stats
		if (
			maxTokens !== undefined &&
			Number.isFinite(maxTokens) &&
			inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens >= maxTokens
		) {
			throw new Error(`Helper token budget reached (${maxTokens} tokens). Completed work is preserved for the parent.`)
		}
		if (maxCost !== undefined && Number.isFinite(maxCost) && totalCost >= maxCost) {
			throw new Error(`Helper cost budget reached ($${maxCost}). Completed work is preserved for the parent.`)
		}
	}

	private async getWorkspaceMetadataEnvironmentBlock(): Promise<string | null> {
		try {
			const workspacesJson =
				(this.baseConfig.workspaceManager
					? await observeHelperOperation("Workspace metadata", () =>
							this.baseConfig.workspaceManager!.buildWorkspacesJson(),
						)
					: undefined) ??
				JSON.stringify(
					{
						workspaces: {
							[this.baseConfig.cwd]: {
								hint: path.basename(this.baseConfig.cwd) || this.baseConfig.cwd,
							},
						},
					},
					null,
					2,
				)

			return `<environment_details>\n# Workspace Configuration\n${workspacesJson}\n</environment_details>`
		} catch (error) {
			Logger.warn("[SubagentRunner] Failed to build workspace metadata block", error)
			return null
		}
	}

	async run(
		prompt: string,
		reportProgress: (update: SubagentProgressUpdate) => void,
		streamId?: string,
	): Promise<SubagentRunResult> {
		this.streamId = streamId
		const onProgress = (update: SubagentProgressUpdate): void => {
			try {
				// Observers receive snapshots and cannot mutate usage or invalidate a completed action.
				void Promise.resolve(
					reportProgress({
						...update,
						stats: update.stats ? { ...update.stats } : undefined,
						filesModified: update.filesModified?.slice(),
						filesViewed: update.filesViewed?.slice(),
						activeSignals: update.activeSignals?.slice(),
						pendingCommandIds: update.pendingCommandIds?.slice(),
					}),
				).catch((error) => Logger.warn("[SubagentRunner] Progress observer failed:", error))
			} catch (error) {
				Logger.warn("[SubagentRunner] Progress observer failed:", error)
			}
		}
		const startTime = Date.now()
		const filesModified = new Set<string>()
		const filesViewed = new Set<string>()
		// Keep bounded, actual execution evidence even when there is no final model answer.
		const completedResults: string[] = []
		const toolReceipts = new Map<string, { fingerprint: string; result: string; failed: boolean }>()
		const partialResult = () =>
			completedResults.length ? `Partial work — helper did not finish.\n\n${completedResults.join("\n\n")}` : undefined
		const state = new TaskState()
		let emptyAssistantResponseRetries = 0
		let streamRecoveryAttempts = 0
		const usageState: SubagentUsageState = {
			currentRequest: createEmptyRequestUsageState(),
		}
		this.stats = {
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0,
			contextTokens: 0,
			contextWindow: 0,
			contextUsagePercentage: 0,
			maxTokens: this.baseConfig.taskState.maxTokens,
			maxCost: this.baseConfig.taskState.maxCost,
		}
		const stats = this.stats

		this.activeSignals = []
		this.onProgress = onProgress
		this.agent.setRetryObserver((attempt, maxAttempts, delayMs) =>
			onProgress({
				activity: { phase: "retrying", attempt: attempt + 1, maxAttempts, retryAt: Date.now() + delayMs },
			}),
		)
		onProgress({ status: "running", stats, activity: { phase: "preparing" } })

		const onParentAbort = () => {
			void this.abort().catch((error) => Logger.warn("[SubagentRunner] Cancellation unavailable:", error))
		}
		this.baseConfig.taskState.abortSignal.addEventListener("abort", onParentAbort, { once: true })
		if (this.shouldAbort()) onParentAbort()
		try {
			this.throwIfAborted()
			this.checkBudget()
			const gateOptions = await pTimeout(
				resolveCompletionGateOptions(this.baseConfig, this.baseConfig.cwd, {
					lastAdvisoryAudit: this.baseConfig.taskState.lastAdvisoryAudit,
				}),
				{
					milliseconds: 15_000,
					signal: this.abortController.signal,
					message:
						"Helper workspace policy loading timed out. Resolve the unavailable policy before retrying this assignment.",
				},
			)
			const parentCompletionFailedStage = getParentCompletionFailedStage(this.baseConfig.taskState)
			const parentGateConfig = getSubagentGateConfig(this.baseConfig)
			const parentGateObservability =
				this.baseConfig.taskState.completionGateObservabilityEnvelope ??
				buildCompletionGateObservabilityEnvelope(parentGateConfig)
			const parentGatePressureLevel =
				getParentGatePressureLevel(this.baseConfig.taskState) ?? getCompletionGatePressureLevel(parentGateConfig)
			const parentGateRetryStatus = this.baseConfig.taskState.lastCompletionBlockReason
				? getCompletionGateRetryPolicy(
						this.baseConfig.taskState
							.lastCompletionBlockReason as import("../attemptCompletionUtils").CompletionPreflightReason,
						parentGateConfig,
					).retryStatus
				: undefined
			const parentGateOperationalState = getCompletionGateOperationalState(parentGateConfig)
			const parentGateBlockHistoryCount = this.baseConfig.taskState.completionGateBlockHistory?.length
			const parentGateSessionId = this.baseConfig.taskState.completionGateSessionId
			const parentGateSignals = buildSubagentGateSignals({
				lastCompletionAudit: this.baseConfig.taskState.lastCompletionAudit,
				lastAdvisoryAudit: this.baseConfig.taskState.lastAdvisoryAudit,
				completionGateBlockCount: this.baseConfig.taskState.completionGateBlockCount,
				lastCompletionBlockReason: this.baseConfig.taskState.lastCompletionBlockReason,
				lastCompletionFailedStage: parentCompletionFailedStage,
				completionAttemptCount: this.baseConfig.taskState.completionAttemptCount,
				completionGatePressureLevel: parentGatePressureLevel,
				completionGateRetryStatus: parentGateRetryStatus,
				completionGateBlockHistoryCount: parentGateBlockHistoryCount,
				completionGateSessionId: parentGateSessionId,
				completionGateOperationalState: parentGateOperationalState,
				gateOptions,
			})
			if (parentGateSignals.length > 0) {
				this.activeSignals = parentGateSignals
				onProgress({ activeSignals: parentGateSignals })
			}

			const mode = this.baseConfig.services.stateManager.getGlobalSettingsKey("mode")
			const apiConfiguration = this.baseConfig.services.stateManager.getApiConfiguration()
			const api = this.apiHandler
			this.activeApiAbort = api.abort?.bind(api)

			const providerId = (
				mode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider
			) as string
			const providerInfo = {
				providerId,
				model: api.getModel(),
				mode,
				customPrompt: this.baseConfig.services.stateManager.getGlobalSettingsKey("customPrompt"),
			}
			stats.contextWindow = providerInfo.model.info.contextWindow || 0
			const nativeToolCallsRequested =
				providerInfo.model.info.apiFormat === ApiFormat.OPENAI_RESPONSES ||
				!!this.baseConfig.services.stateManager.getGlobalStateKey("nativeToolCallEnabled")

			const host = HostRegistryInfo.get()
			const discoveredSkills = await pTimeout(discoverSkills(this.baseConfig.cwd), {
				milliseconds: 15_000,
				signal: this.abortController.signal,
				message: "Helper skill discovery timed out.",
			})
			const availableSkills = getAvailableSkills(discoveredSkills)
			const configuredSkillNames = this.agent.getConfiguredSkills()
			const skills =
				configuredSkillNames !== undefined
					? configuredSkillNames
							.map((skillName) => {
								const skill = availableSkills.find((candidate) => candidate.name === skillName)
								if (!skill) {
									Logger.warn(`[SubagentRunner] Configured skill '${skillName}' not found for subagent run.`)
								}
								return skill
							})
							.filter((skill): skill is (typeof availableSkills)[number] => Boolean(skill))
					: availableSkills

			const context: SystemPromptContext = {
				providerInfo,
				cwd: this.baseConfig.cwd,
				ide: host?.platform || "Unknown",
				skills,
				focusChainSettings: this.baseConfig.focusChainSettings,
				browserSettings: this.baseConfig.browserSettings,
				yoloModeToggled: this.baseConfig.yoloModeToggled,
				enableNativeToolCalls: nativeToolCallsRequested,
				enableParallelToolCalling: false,
				isSubagentRun: true,
				mode: mode as "plan" | "act", // Subagents inherit the parent's mode context
				parentMode: mode as "plan" | "act",
			}

			const promptRegistry = PromptRegistry.getInstance()
			const generatedSystemPrompt = await pTimeout(promptRegistry.get(context), {
				milliseconds: 30_000,
				signal: this.abortController.signal,
				message: "Helper prompt preparation timed out.",
			})

			// Supplement the assignment with available parent context without making tracking a prerequisite.
			try {
				const parentStreamId = (this.baseConfig as ConfigWithExtensions).getSessionStreamId?.()
				if (parentStreamId) {
					const auditContext = buildSubagentAuditContext({
						lastCompletionAudit: this.baseConfig.taskState.lastCompletionAudit,
						lastAdvisoryAudit: this.baseConfig.taskState.lastAdvisoryAudit,
						completionGateBlockCount: this.baseConfig.taskState.completionGateBlockCount,
						lastCompletionBlockReason: this.baseConfig.taskState.lastCompletionBlockReason,
						lastCompletionFailedStage: parentCompletionFailedStage,
						completionAttemptCount: this.baseConfig.taskState.completionAttemptCount,
						completionGatePressureLevel: parentGatePressureLevel,
						completionGateObservabilityEnvelope: parentGateObservability,
						completionGateRetryStatus: parentGateRetryStatus,
						completionGateBlockHistoryCount: parentGateBlockHistoryCount,
						completionGateSessionId: parentGateSessionId,
						completionGateOperationalState: parentGateOperationalState,
						gateOptions,
					})
					const compressed = await observeHelperOperation("Parent context", () =>
						orchestrator.getCompressedContext(parentStreamId),
					)
					const combined = [auditContext, compressed].filter(Boolean).join("\n\n")
					this.agent.setParentStreamContext(combined)
				}
			} catch (err) {
				Logger.warn("[SubagentRunner] Parent context unavailable; using the assignment:", err)
			}

			const useNativeToolCalls = !!promptRegistry.nativeTools?.length
			const nativeTools = useNativeToolCalls ? this.agent.buildNativeTools(context) : undefined

			if (useNativeToolCalls && (!nativeTools || nativeTools.length === 0)) {
				const error = "Subagent tool requires native tool calling support."
				onProgress({ status: "failed", error, stats })
				return { status: "failed", error, stats }
			}

			this.throwIfAborted()

			const workspaceMetadataEnvironmentBlock = await this.getWorkspaceMetadataEnvironmentBlock()
			const conversation: DietCodeStorageMessage[] = [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: prompt,
						} as DietCodeTextContentBlock,
						...(workspaceMetadataEnvironmentBlock
							? [
									{
										type: "text",
										text: workspaceMetadataEnvironmentBlock,
									} as DietCodeTextContentBlock,
								]
							: []),
					],
				},
			]

			// Keep one state for the whole helper run, isolated from the parent's
			// checklist/retry budget and shared by tool execution and completion.
			const subagentConfig = this.createSubagentTaskConfig()
			this.activeTaskState = subagentConfig.taskState
			this.activeTaskState.abort = this.shouldAbort()
			const progress = new ToolProgressTracker()
			while (true) {
				this.throwIfAborted()
				this.checkBudget()
				const systemPrompt = this.agent.buildSystemPrompt(generatedSystemPrompt)
				if (
					usageState.lastRequest &&
					this.shouldCompactBeforeNextRequest(usageState.lastRequest.totalTokens, api, providerInfo.model.id)
				) {
					const didCompact = this.compactConversationForContextWindow(conversation)
					if (didCompact) {
						Logger.warn("[SubagentRunner] Proactively compacted context before next subagent request.")
					}
					// Prevent repeated compaction attempts off the same token sample.
					usageState.lastRequest = undefined
				}

				const streamHandler = new StreamResponseHandler()
				const { toolUseHandler } = streamHandler.getHandlers()
				usageState.currentRequest = createEmptyRequestUsageState()
				const requestUsage = usageState.currentRequest
				const previousCost = stats.totalCost

				let assistantText = ""
				let assistantTextSignature: string | undefined
				let requestId: string | undefined
				let receivedChunk = false

				const stream = this.createMessageWithInitialChunkRetry(
					api,
					systemPrompt,
					conversation,
					nativeTools,
					providerInfo.providerId,
					providerInfo.model.id,
				)

				try {
					for await (const chunk of stream) {
						receivedChunk = true
						switch (chunk.type) {
							case "usage":
								requestId = requestId ?? chunk.id
								stats.inputTokens += chunk.inputTokens || 0
								stats.outputTokens += chunk.outputTokens || 0
								stats.cacheWriteTokens += chunk.cacheWriteTokens || 0
								stats.cacheReadTokens += chunk.cacheReadTokens || 0
								requestUsage.inputTokens += chunk.inputTokens || 0
								requestUsage.outputTokens += chunk.outputTokens || 0
								requestUsage.cacheWriteTokens += chunk.cacheWriteTokens || 0
								requestUsage.cacheReadTokens += chunk.cacheReadTokens || 0
								requestUsage.totalTokens =
									requestUsage.inputTokens +
									requestUsage.outputTokens +
									requestUsage.cacheWriteTokens +
									requestUsage.cacheReadTokens
								requestUsage.totalCost = chunk.totalCost ?? requestUsage.totalCost
								stats.contextTokens = requestUsage.totalTokens
								stats.contextUsagePercentage =
									stats.contextWindow > 0 ? (stats.contextTokens / stats.contextWindow) * 100 : 0
								const requestCost =
									requestUsage.totalCost ??
									calculateApiCost(
										providerInfo.model.info,
										requestUsage.inputTokens,
										requestUsage.outputTokens,
										requestUsage.cacheWriteTokens,
										requestUsage.cacheReadTokens,
									)
								if (Number.isFinite(requestCost))
									stats.totalCost = Math.max(stats.totalCost, previousCost + requestCost)
								onProgress({ stats: { ...stats } })
								this.checkBudget()

								break
							case "text":
								requestId = requestId ?? chunk.id
								assistantText += chunk.text || ""
								assistantTextSignature = chunk.signature || assistantTextSignature
								break
							case "tool_calls":
								requestId = requestId ?? chunk.id
								toolUseHandler.processToolUseDelta(
									{
										id: chunk.tool_call.function?.id,
										type: "tool_use",
										name: chunk.tool_call.function?.name,
										input: normalizeToolCallArguments(chunk.tool_call.function?.arguments),
									},
									chunk.tool_call.call_id,
								)
								break
							case "reasoning":
								requestId = requestId ?? chunk.id
								break
						}

						this.throwIfAborted()
					}
				} catch (error) {
					this.throwIfAborted()
					this.checkBudget()
					const delayMs = getApiRetryDelay(error, streamRecoveryAttempts, INITIAL_STREAM_RETRY_BASE_DELAY_MS)
					// Initial retries belong to the provider/initial-chunk loop. After output,
					// continue a new turn with evidence; never replay unfinished tool calls.
					if (
						!receivedChunk ||
						streamRecoveryAttempts >= MAX_STREAM_RECOVERY_ATTEMPTS ||
						delayMs === undefined ||
						!this.shouldRetryInitialStreamError(error, providerInfo.providerId, providerInfo.model.id)
					)
						throw error
					streamRecoveryAttempts++
					conversation.push(
						{ role: "assistant", content: buildInterruptedAssistantContent(assistantText, []) },
						{ role: "user", content: [{ type: "text", text: STREAM_RECOVERY_INSTRUCTION }] },
					)
					onProgress({
						activity: {
							phase: "retrying",
							attempt: streamRecoveryAttempts + 1,
							maxAttempts: MAX_STREAM_RECOVERY_ATTEMPTS + 1,
							retryAt: Date.now() + delayMs,
						},
					})
					await waitForApiRetry(delayMs, this.abortController.signal)
					continue
				}

				this.throwIfAborted()
				this.checkBudget()
				usageState.lastRequest = { ...requestUsage }

				toolUseHandler.assertCompleteToolUses()
				streamRecoveryAttempts = 0
				const nativeFinalizedToolCalls = toolUseHandler.getAllFinalizedToolUses().map((toolCall, index) => ({
					toolUseId: resolveToolUseId(toolCall, index),
					id: toolCall.id,
					call_id: toolCall.call_id,
					name: toolCall.name,
					input: toolCall.input,
					isNativeToolCall: true,
				}))
				const parsedNonNativeToolCalls = useNativeToolCalls ? [] : parseNonNativeToolCalls(assistantText)
				const fallbackNonNativeToolCalls = nativeFinalizedToolCalls.map((toolCall) => ({
					...toolCall,
					isNativeToolCall: false,
				}))

				let finalizedToolCalls: SubagentToolCall[] = []
				if (useNativeToolCalls) {
					finalizedToolCalls = nativeFinalizedToolCalls
				} else if (parsedNonNativeToolCalls.length > 0) {
					finalizedToolCalls = parsedNonNativeToolCalls
				} else if (fallbackNonNativeToolCalls.length > 0) {
					// Defensive fallback: if non-native mode receives structured tool call chunks,
					// execute them but serialize results as plain text to avoid tool_result pairing mismatches.
					Logger.warn(
						"[SubagentRunner] Received structured tool_calls while native tool calling is disabled; falling back to non-native result serialization.",
					)
					finalizedToolCalls = fallbackNonNativeToolCalls
				}
				const assistantContent: (DietCodeTextContentBlock | DietCodeAssistantToolUseBlock)[] = []
				if (assistantText.trim().length > 0) {
					assistantContent.push({
						type: "text",
						text: assistantText,
						signature: assistantTextSignature,
					})
				}
				if (useNativeToolCalls) {
					assistantContent.push(...finalizedToolCalls.map(toAssistantToolUseBlock))
				}

				if (assistantContent.length > 0) {
					conversation.push({
						role: "assistant",
						content: assistantContent,
						id: requestId,
					})
				}

				if (finalizedToolCalls.length === 0) {
					emptyAssistantResponseRetries += 1
					if (emptyAssistantResponseRetries > MAX_EMPTY_ASSISTANT_RETRIES) {
						throw new Error(
							"Helper did not provide an executable action or an explicit attempt_completion handoff after one reminder. Completed work is preserved; reconcile it in the parent before assigning more work.",
						)
					}

					const decision = progress.finishTurn()
					if (decision === "handoff") {
						throw new Error(
							"Helper made no new tool progress for eight turns. Continue from the partial work in the parent; do not restart the same assignment unchanged.",
						)
					}
					if (decision === "redirect") onProgress({ activity: { phase: "recovering" } })

					// Mirror the main loop's no-tools-used nudge so empty/blank model turns
					// can recover without surfacing an immediate hard failure in subagent UI.
					if (assistantContent.length === 0) {
						conversation.push({
							role: "assistant",
							content: [
								{
									type: "text",
									text: "Failure: I did not provide a response.",
								},
							],
							id: requestId,
						})
					}
					conversation.push({
						role: "user",
						content: [
							{
								type: "text",
								text: formatResponse.noToolsUsed(useNativeToolCalls),
							},
						],
					})
					await delay(0)
					continue
				}
				emptyAssistantResponseRetries = 0

				const toolResultBlocks = [] as DietCodeUserContent[]
				for (const call of finalizedToolCalls) {
					this.throwIfAborted()
					this.checkBudget()
					const toolName = call.name as DietCodeDefaultTool
					const toolCallParams = toToolUseParams(call.input)
					if (toolName === DietCodeDefaultTool.BASH && toolCallParams.command)
						toolCallParams.command = normalizeShellCommand(toolCallParams.command)
					const receiptId = call.id?.trim() || (call.isNativeToolCall ? call.call_id?.trim() : undefined)
					const fingerprint = createHash("sha256")
						.update(JSON.stringify([toolName, Object.entries(toolCallParams).sort(([a], [b]) => a.localeCompare(b))]))
						.digest("hex")
					const receipt = receiptId ? toolReceipts.get(receiptId) : undefined
					if (receipt) {
						const mismatch = receipt.fingerprint !== fingerprint
						pushSubagentToolResultBlock(
							toolResultBlocks,
							call,
							toolName,
							mismatch
								? formatResponse.toolError(
										"This tool call ID already belongs to different arguments. No action was repeated. Use a new ID for a new action.",
									)
								: receipt.result,
							mismatch || receipt.failed,
						)
						continue
					}
					if (toolReceipts.size >= 256 && toolName !== DietCodeDefaultTool.ATTEMPT)
						throw new Error(
							"Helper execution receipt capacity reached. Return a handoff with completed work instead of continuing the same assignment.",
						)

					if (toolName === DietCodeDefaultTool.ATTEMPT) {
						canonicalizeAttemptCompletionResultParams(toolCallParams)
						if (toolCallParams?.result) {
							this.signalCriticalFindingsToSwarm(toolCallParams.result as string)
						}
						let completionResult = typeof toolCallParams?.result === "string" ? toolCallParams.result.trim() : ""
						if (!completionResult) {
							const missingResultError = formatResponse.missingToolParameterError("result")
							pushSubagentToolResultBlock(toolResultBlocks, call, toolName, missingResultError)
							continue
						}

						let gateError: string | null = null
						try {
							gateError = await this.waitForActiveOperation(() =>
								validateSubagentCompletionGates(
									subagentConfig,
									completionResult,
									typeof toolCallParams?.task_progress === "string" ? toolCallParams.task_progress : undefined,
									typeof toolCallParams?.command === "string" ? toolCallParams.command : undefined,
								),
							)
						} catch (err) {
							this.throwIfAborted()
							Logger.warn("[SubagentRunner] Subagent completion gate check error:", err)
							const error = "Helper completion checks could not run. Return this failure to the parent for review."
							throw new Error(error)
						}
						if (gateError) {
							if (isCompletionGateCircuitBreakerTripped(subagentConfig)) {
								throw new Error(gateError)
							}
							pushSubagentToolResultBlock(toolResultBlocks, call, toolName, gateError)
							continue
						}
						this.throwIfAborted()

						const handoff = this.executionHandoff(completionResult)
						completionResult = handoff.result ?? completionResult
						stats.toolCalls += 1
						const durationMs = Date.now() - startTime
						onProgress({ stats: { ...stats } })
						onProgress({
							status: "completed",
							pendingCommandIds: handoff.pendingCommandIds,
							result: completionResult,
							stats: { ...stats },
							filesModified: Array.from(filesModified),
							filesViewed: Array.from(filesViewed),
							durationMs,
						})
						this.signalCriticalFindingsToSwarm(completionResult)
						void SwarmConsensusHandler.handleSignal(this.baseConfig, completionResult).catch((error) =>
							Logger.warn("[SubagentRunner] Consensus observation unavailable; handoff retained:", error),
						)
						return {
							status: "completed",
							pendingCommandIds: handoff.pendingCommandIds,
							result: completionResult,
							stats,
							filesModified: Array.from(filesModified),
							filesViewed: Array.from(filesViewed),
							durationMs,
						}
					}

					if (!this.allowedTools.includes(toolName)) {
						const deniedResult = formatResponse.toolError(`Tool '${toolName}' is not available inside subagent runs.`)
						pushSubagentToolResultBlock(toolResultBlocks, call, toolName, deniedResult)
						continue
					}

					const toolCallBlock: ToolUse = {
						type: "tool_use",
						name: toolName,
						params: toolCallParams,
						partial: false,
						isNativeToolCall: call.isNativeToolCall,
						call_id: call.call_id || call.toolUseId,
					}

					if (call.call_id) {
						state.toolUseIdMap.set(call.call_id, call.toolUseId)
					}

					const latestToolCall = formatToolCallPreview(toolName, toolCallParams)
					onProgress({ latestToolCall, activity: { phase: "tool" } })

					const handler = subagentConfig.coordinator?.getHandler(toolName)
					let toolResult: unknown
					let executionResult: unknown
					let operationReturned = false

					if (!handler) {
						toolResult = formatResponse.toolError(`No handler registered for tool '${toolName}'.`)
					} else {
						try {
							// V230: Swarm Collision Prevention
							if (
								this.streamId &&
								toolCallParams.path &&
								(toolName === DietCodeDefaultTool.FILE_NEW ||
									toolName === DietCodeDefaultTool.FILE_EDIT ||
									toolName === DietCodeDefaultTool.APPLY_PATCH)
							) {
								const streamId = this.streamId
								const targetPath = toolCallParams.path
								const collision = await this.waitForActiveOperation(() =>
									orchestrator.checkCollision(streamId, [targetPath]),
								)
								if (collision) {
									toolResult = formatResponse.toolError(
										`[COLLISION] ${collision} Wait for the other agent to finish or coordinate elsewhere.`,
									)
								}
							}

							if (!toolResult) {
								// V227: Sovereign Audit Integration for Swarms
								// Ensure subagent actions are recorded in the shared StabilityMonitor
								const guard = this.baseConfig.universalGuard
								if (guard) {
									const preExecResult = await this.waitForActiveOperation(() =>
										guard.guardPreExecution(toolCallBlock),
									)
									if (!preExecResult.success) {
										toolResult = formatResponse.toolError(
											preExecResult.error || "Subagent action denied by policy.",
										)
									} else {
										this.throwIfAborted()
										toolResult = await handler.execute(subagentConfig, toolCallBlock)
										executionResult = toolResult
										operationReturned = true
										if (!isToolFailure(toolResult) && !this.shouldAbort()) {
											await observeHelperOperation("Tool observation", () =>
												guard.guardPostExecution(toolCallBlock, executionResult),
											)
										}

										// V227: Substrate Read Auditing for Swarms
										if (
											!this.shouldAbort() &&
											!isToolFailure(toolResult) &&
											(toolName === DietCodeDefaultTool.FILE_READ ||
												toolName === DietCodeDefaultTool.SEARCH) &&
											toolCallParams.path &&
											typeof toolResult === "string"
										) {
											const pathKey = toolCallParams.path
											const currentCount = state.currentTurnReadHistory.get(pathKey) || 0
											if (currentCount === 0) {
												state.currentTurnUniqueReadCount++
											}
											const newCount = currentCount + 1
											state.currentTurnReadHistory.set(pathKey, newCount)
											state.currentTurnTotalReadCount++

											// Track global read history across turns
											const globalCount = (state.taskReadHistory.get(pathKey) || 0) + 1
											state.taskReadHistory.set(pathKey, globalCount)

											const readResult = toolResult
											toolResult =
												(await observeHelperOperation("Read observation", () =>
													guard.onRead(
														pathKey,
														readResult,
														state.currentTurnUniqueReadCount,
														newCount,
														globalCount,
													),
												)) ?? readResult
										}
									}
								} else {
									this.throwIfAborted()
									toolResult = await handler.execute(subagentConfig, toolCallBlock)
									executionResult = toolResult
									operationReturned = true
								}
							}
						} catch (error) {
							if (error instanceof PartialPatchError)
								for (const committedPath of error.committedPaths) filesModified.add(committedPath)
							if (operationReturned) {
								Logger.warn("[SubagentRunner] Observation failed after tool returned; result retained:", error)
							} else {
								toolResult = formatResponse.toolError((error as Error).message)
							}
						}
					}

					if (operationReturned && !isToolFailure(executionResult)) {
						if (toolName === DietCodeDefaultTool.APPLY_PATCH && typeof toolCallParams.input === "string") {
							for (const match of toolCallParams.input.matchAll(
								/^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+)$/gm,
							))
								filesModified.add(match[1].trim())
						}
						// Track file side-effects
						if (toolCallParams?.path && typeof toolCallParams.path === "string") {
							if (
								toolName === DietCodeDefaultTool.FILE_NEW ||
								toolName === DietCodeDefaultTool.FILE_EDIT ||
								toolName === DietCodeDefaultTool.APPLY_PATCH
							) {
								filesModified.add(toolCallParams.path)
							} else if (
								toolName === DietCodeDefaultTool.FILE_READ ||
								toolName === DietCodeDefaultTool.SEARCH ||
								toolName === DietCodeDefaultTool.LIST_CODE_DEF
							) {
								filesViewed.add(toolCallParams.path)
							}
						}
					}

					if (operationReturned) {
						const evidence = serializeToolResult(executionResult) || "(empty tool result)"
						completedResults.push(`${latestToolCall}\n${evidence.slice(0, 1200)}`)
						if (completedResults.length > 8) completedResults.shift()
					}
					stats.toolCalls += 1
					onProgress({
						result: partialResult(),
						stats: { ...stats },
						filesModified: Array.from(filesModified),
						filesViewed: Array.from(filesViewed),
						durationMs: Date.now() - startTime,
					})

					const serializedToolResult = serializeToolResult(toolResult)
					if (receiptId)
						toolReceipts.set(receiptId, {
							fingerprint,
							result:
								serializedToolResult.length > 32_000
									? serializedToolResult.slice(0, 32_000) +
										"\n[Retained result truncated. Inspect the existing execution or current files; the action was not repeated.]"
									: serializedToolResult,
							failed: isToolFailure(toolResult),
						})
					let toolDescription = `[${toolName}]`
					try {
						toolDescription = handler?.getDescription(toolCallBlock) || toolDescription
					} catch (error) {
						Logger.warn("[SubagentRunner] Tool description unavailable; result retained:", error)
					}
					pushSubagentToolResultBlock(
						toolResultBlocks,
						call,
						toolDescription,
						serializedToolResult,
						isToolFailure(toolResult),
					)

					// Phase 5: Cross-Swarm Memory Signalling
					// If the tool execution revealed something architecturally significant, signal it via orchestrator
					if (serializedToolResult.length > 0) {
						this.signalCriticalFindingsToSwarm(serializedToolResult)
					}

					progress.record(toolName, toolCallParams, operationReturned ? executionResult : toolResult)
					this.throwIfAborted()
				}

				const progressState = progress.finishTurn()
				if (progressState === "handoff") {
					throw new Error(
						"Helper made no new tool progress for eight turns. Completed work is preserved. Continue independent work or resolve the reported blocker in the parent; do not restart the same assignment unchanged.",
					)
				}
				if (progressState === "redirect") {
					onProgress({ activity: { phase: "recovering" } })
					toolResultBlocks.push({
						type: "text",
						text: "Recent tool calls returned no new evidence. Use the results already collected, change the failing input or approach, or finish with a clear blocker handoff. Do not repeat the same checks or request more permission.",
					})
				}

				conversation.push({
					role: "user",
					content: toolResultBlocks,
				})

				await delay(0)
			}
		} catch (error) {
			const durationMs = Date.now() - startTime
			const handoff = this.executionHandoff(partialResult())
			if (this.shouldAbort()) {
				const cancelledError = "Subagent run cancelled."
				onProgress({
					status: "cancelled",
					error: cancelledError,
					...handoff,
					stats: { ...stats },
					filesModified: Array.from(filesModified),
					filesViewed: Array.from(filesViewed),
					durationMs,
				})
				return {
					status: "cancelled",
					error: cancelledError,
					...handoff,
					isPartial: completedResults.length > 0,
					stats,
					filesModified: Array.from(filesModified),
					filesViewed: Array.from(filesViewed),
					durationMs,
				}
			}

			const errorText =
				error instanceof Error ? error.message : typeof error === "string" ? error : "Subagent execution failed."
			Logger.error("[SubagentRunner] run failed", error)
			onProgress({
				status: "failed",
				error: errorText,
				...handoff,
				stats: { ...stats },
				filesModified: Array.from(filesModified),
				filesViewed: Array.from(filesViewed),
				durationMs,
			})
			return {
				status: "failed",
				error: errorText,
				...handoff,
				isPartial: completedResults.length > 0,
				stats,
				filesModified: Array.from(filesModified),
				filesViewed: Array.from(filesViewed),
				durationMs,
			}
		} finally {
			this.agent.setRetryObserver(undefined)
			this.agent.setRequestRetrySignal(undefined)
			this.baseConfig.taskState.abortSignal.removeEventListener("abort", onParentAbort)
			this.activeApiAbort = undefined
			this.activeTaskState = undefined
			this.onProgress = undefined
		}
	}

	private createSubagentTaskConfig(): TaskConfig {
		const baseCallbacks = this.baseConfig.callbacks
		const { ToolExecutorCoordinator } = require("../ToolExecutorCoordinator")
		const coordinator = new ToolExecutorCoordinator()
		const validator = new ToolValidator(this.baseConfig.services.dietcodeIgnoreController, this.baseConfig.universalGuard)

		for (const tool of this.allowedTools) {
			coordinator.registerByName(tool, validator)
		}

		const subagentTaskState = new TaskState()
		subagentTaskState.recovery = this.baseConfig.taskState.recovery
		subagentTaskState.recursionDepth = this.recursionDepth

		return {
			...this.baseConfig,
			api: this.apiHandler,
			services: {
				...this.baseConfig.services,
				diffViewProvider: new FileEditProvider(this.baseConfig.cwd, subagentTaskState.abortSignal, () =>
					subagentTaskState.recovery?.assertCanExecute(this.executionOwner),
				),
			},
			coordinator,
			taskState: subagentTaskState,
			messageState: this.baseConfig.messageState, // Use parent's message state handler but they will have their own stream
			recursionDepth: this.recursionDepth,
			isSubagentExecution: true,
			executionOwner: this.executionOwner,
			vscodeTerminalExecutionMode: "vscodeTerminal",
			callbacks: {
				...baseCallbacks,
				say: async () => undefined,
				removeLastPartialMessageIfExistsWithType: async () => {},
				ask: async (_type, _text, partial) => {
					if (partial) return { response: "yesButtonClicked" }
					throw new Error(
						"This helper action needs authority outside its delegated tools or workspace. Return the exact blocker to the parent; do not open competing approval prompts.",
					)
				},
				shouldAutoApproveToolWithPath: async (toolName, target) => {
					const resolvedTarget = resolveWorkspacePath(
						this.baseConfig,
						target ?? ".",
						"SubagentRunner.delegatedApproval",
					)
					const absoluteTarget = typeof resolvedTarget === "string" ? resolvedTarget : resolvedTarget.absolutePath
					const relative = path.relative(this.baseConfig.cwd, absoluteTarget)
					if (
						this.allowedTools.includes(toolName) &&
						relative !== ".." &&
						!relative.startsWith(`..${path.sep}`) &&
						!path.isAbsolute(relative)
					) {
						const [root, resolved] = await Promise.all([
							canonicalFilePath(this.baseConfig.cwd),
							canonicalFilePath(absoluteTarget),
						])
						const actualRelative = path.relative(root, resolved)
						if (
							actualRelative !== ".." &&
							!actualRelative.startsWith(`..${path.sep}`) &&
							!path.isAbsolute(actualRelative)
						)
							return true
					}
					return baseCallbacks.shouldAutoApproveToolWithPath(toolName, target)
				},
				sayAndCreateMissingParamError: async (_toolName, paramName) =>
					formatResponse.toolError(formatResponse.missingToolParameterError(paramName)),
				executeCommandTool: async (command, timeoutSeconds, options) => {
					return await baseCallbacks.executeCommandTool(command, timeoutSeconds, {
						...options,
						suppressUserInteraction: true,
						interactive: false,
						signal: options?.signal
							? AbortSignal.any([options.signal, subagentTaskState.abortSignal])
							: subagentTaskState.abortSignal,
					})
				},
				readCommandOutput: async (executionId, timeoutSeconds, signal) => {
					if (!baseCallbacks.readCommandOutput) throw new Error("Command observation is unavailable in this session.")
					return baseCallbacks.readCommandOutput(
						executionId,
						timeoutSeconds,
						signal ? AbortSignal.any([signal, subagentTaskState.abortSignal]) : subagentTaskState.abortSignal,
					)
				},
			},
		}
	}

	private executionHandoff(result: string | undefined): Pick<SubagentRunResult, "result" | "pendingCommandIds"> {
		try {
			const state = this.baseConfig.callbacks.getExecutionState?.()
			if (!state || !("commands" in state)) return { result }
			const pending = state.commands.active.filter((command) => command.owner === this.executionOwner)
			if (!pending.length) return { result }
			return {
				pendingCommandIds: pending.map((command) => command.execution_id),
				result: `${result ? `${result}\n\n` : ""}Runtime handoff — commands still pending:\n${pending.map((command) => `- ${command.execution_id}: ${command.status}. Inspect with read_command_output; do not relaunch.`).join("\n")}`,
			}
		} catch (error) {
			Logger.warn("Helper execution inventory unavailable at handoff:", error)
			return {
				result: `${result ? `${result}\n\n` : ""}Runtime handoff: command status could not be inspected. Verify existing executions before repeating work.`,
			}
		}
	}

	private shouldRetryInitialStreamError(error: unknown, providerId: string, modelId: string): boolean {
		// Mirror main loop behavior: do not auto-retry auth/balance failures.
		const parsedError = DietCodeError.transform(error, modelId, providerId)
		const isAuthError = parsedError.isErrorType(DietCodeErrorType.Auth)
		const isBalanceError = parsedError.isErrorType(DietCodeErrorType.Balance)

		if (isAuthError || isBalanceError) {
			return false
		}

		return shouldRetryApiError(error, true)
	}

	private compactConversationForContextWindow(conversation: DietCodeStorageMessage[]): boolean {
		const contextManager = new ContextManager()
		const optimizationResult = this.optimizeConversationForContextWindow(contextManager, conversation)
		if (optimizationResult.didOptimize && !optimizationResult.needToTruncate) {
			return true
		}

		const deletedRange = contextManager.getNextTruncationRange(conversation, undefined, "quarter")
		if (deletedRange[1] < deletedRange[0]) {
			return optimizationResult.didOptimize
		}

		const truncated = contextManager
			.getTruncatedMessages(conversation, deletedRange)
			.map((message: unknown) => message as DietCodeStorageMessage)
		if (truncated.length >= conversation.length) {
			return optimizationResult.didOptimize
		}

		conversation.splice(0, conversation.length, ...truncated)
		return true
	}

	private optimizeConversationForContextWindow(
		contextManager: ContextManager,
		conversation: DietCodeStorageMessage[],
	): {
		didOptimize: boolean
		needToTruncate: boolean
	} {
		const timestamp = Date.now()
		const optimizationResult = contextManager.attemptFileReadOptimizationInMemory(conversation, undefined, timestamp)
		if (!optimizationResult.anyContextUpdates) {
			return { didOptimize: false, needToTruncate: true }
		}

		const optimizedConversation = optimizationResult.optimizedConversationHistory.map(
			(message: unknown) => message as DietCodeStorageMessage,
		)
		conversation.splice(0, conversation.length, ...optimizedConversation)
		return { didOptimize: true, needToTruncate: optimizationResult.needToTruncate }
	}

	private shouldCompactBeforeNextRequest(
		requestTotalTokens: number,
		api: ReturnType<typeof buildApiHandler>,
		modelId: string,
	): boolean {
		const { contextWindow, maxAllowedSize } = getContextWindowInfo(api)
		const useAutoCondense = this.baseConfig.services.stateManager.getGlobalSettingsKey("useAutoCondense")
		if (useAutoCondense && isNextGenModelFamily(modelId)) {
			const autoCondenseThreshold = 0.75
			const roundedThreshold = autoCondenseThreshold ? Math.floor(contextWindow * autoCondenseThreshold) : maxAllowedSize
			const thresholdTokens = Math.min(roundedThreshold, maxAllowedSize)
			return requestTotalTokens >= thresholdTokens
		}

		return requestTotalTokens >= maxAllowedSize
	}

	private async *createMessageWithInitialChunkRetry(
		api: ReturnType<typeof buildApiHandler>,
		systemPrompt: string,
		conversation: DietCodeStorageMessage[],
		nativeTools: DietCodeTool[] | undefined,
		providerId: string,
		modelId: string,
	): AsyncGenerator<ApiStreamChunk> {
		for (let attempt = 1; attempt <= MAX_INITIAL_STREAM_ATTEMPTS; attempt += 1) {
			this.throwIfAborted()
			this.checkBudget()
			this.onProgress?.({ activity: { phase: "waiting" } })
			const stream = guardedStream(
				(signal) => {
					this.agent.setRequestRetrySignal(signal)
					return api.createMessage(
						systemPrompt,
						withExecutionContext(
							conversation,
							this.baseConfig.callbacks.getExecutionState,
							this.executionOwner,
							api.getModel().info.contextWindow,
						),
						nativeTools,
					)
				},
				{ signal: this.abortController.signal, abort: api.abort?.bind(api) },
			)
			const iterator = stream[Symbol.asyncIterator]()
			let firstChunk: Awaited<ReturnType<typeof iterator.next>>

			try {
				firstChunk = await iterator.next()
			} catch (error) {
				this.agent.setRequestRetrySignal(undefined)
				if (checkContextWindowExceededError(error)) {
					const didCompact = this.compactConversationForContextWindow(conversation)
					if (!didCompact || this.shouldAbort() || attempt >= MAX_INITIAL_STREAM_ATTEMPTS) {
						throw error
					}
					Logger.warn(
						`[SubagentRunner] Context window exceeded on initial stream attempt ${attempt}; compacted conversation and retrying.`,
					)
					continue
				}

				const delayMs = getApiRetryDelay(error, attempt - 1, INITIAL_STREAM_RETRY_BASE_DELAY_MS)
				const shouldRetry =
					!this.shouldAbort() &&
					delayMs !== undefined &&
					attempt < MAX_INITIAL_STREAM_ATTEMPTS &&
					this.shouldRetryInitialStreamError(error, providerId, modelId)
				if (!shouldRetry) {
					throw error
				}

				Logger.warn(`[SubagentRunner] Initial stream failed. Retrying attempt ${attempt + 1}.`, error)
				this.onProgress?.({
					activity: {
						phase: "retrying",
						attempt: attempt + 1,
						maxAttempts: MAX_INITIAL_STREAM_ATTEMPTS,
						retryAt: Date.now() + delayMs!,
					},
				})
				await waitForApiRetry(delayMs!, this.abortController.signal)
				continue
			}

			// Once anything is emitted, only the caller can reconcile tool results. Never replay this request.
			if (firstChunk.done) return
			this.onProgress?.({ activity: { phase: "responding" } })
			try {
				yield firstChunk.value
				yield* iterator
			} finally {
				await iterator.return?.(undefined)
				this.agent.setRequestRetrySignal(undefined)
			}
			return
		}
	}

	private hashString(value: string): string {
		let hash = 2166136261
		for (let i = 0; i < value.length; i++) {
			hash ^= value.charCodeAt(i)
			hash = Math.imul(hash, 16777619)
		}
		return (hash >>> 0).toString(36)
	}

	private signalCriticalFindingsToSwarm(result: string): void {
		let parentStreamId: string | undefined
		try {
			parentStreamId = (this.baseConfig as ConfigWithExtensions).getSessionStreamId?.()
		} catch (error) {
			Logger.warn("[SubagentRunner] Finding stream unavailable:", error)
			return
		}
		if (!parentStreamId) {
			return
		}

		const criticalKeywords = [
			"CRITICAL:",
			"JOY-ZONING VIOLATION",
			"ARCHITECTURE VIOLATION",
			"SECURITY RISK",
			"TOXIC HOTSPOT",
			"SIGNAL: ARCHITECTURE_VIOLATION",
			"SIGNAL: SECURITY_RISK",
			"GROUNDED SPECIFICATION REFRESH",
			"CONTEXT UNCERTAINTY",
		]
		const upperResult = result.toUpperCase()
		const findingKey = this.hashString(upperResult).slice(0, 16)

		if (this.signaledFindings.has(findingKey)) {
			return // De-duplicate identical findings
		}

		if (criticalKeywords.some((keyword) => upperResult.includes(keyword))) {
			const matchingKeywords = criticalKeywords.filter((keyword) => upperResult.includes(keyword))
			this.activeSignals = Array.from(new Set([...this.activeSignals, ...matchingKeywords]))
			this.onProgress?.({ activeSignals: this.activeSignals })

			try {
				const label =
					upperResult.includes("GROUNDED SPECIFICATION REFRESH") || upperResult.includes("CONTEXT UNCERTAINTY")
						? `swarm_nudge_${Date.now()}_${findingKey}`
						: `swarm_finding_${Date.now()}_${findingKey}`
				this.signaledFindings.add(findingKey)
				if (this.signaledFindings.size > 128) this.signaledFindings.delete(this.signaledFindings.values().next().value!)
				void Promise.resolve(orchestrator.storeMemory(parentStreamId, label, result.slice(0, 1500))).catch((error) =>
					Logger.warn("[SubagentRunner] Failed to signal swarm finding:", error),
				)
			} catch (e) {
				Logger.warn("[SubagentRunner] Failed to signal swarm finding:", e)
			}
		}
	}
}
