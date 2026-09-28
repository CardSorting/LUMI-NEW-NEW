import { createHash, randomUUID } from "node:crypto"
import type { ToolUse } from "@core/assistant-message"
import { sendPartialMessageEvent } from "@core/controller/ui/subscribeToPartialMessage"
import { formatResponse } from "@core/prompts/responses"
import {
	DietCodeAskUseSubagents,
	DietCodeSaySubagentStatus,
	DietCodeSubagentUsageInfo,
	SubagentStatusItem,
} from "@shared/ExtensionMessage"
import { convertDietCodeMessageToProto } from "@shared/proto-conversions/dietcode-message"
import { SUBAGENT_ACTIVITY_LIMIT, SUBAGENT_HEARTBEAT_INTERVAL_MS } from "@shared/subagents"
import { orchestrator } from "@/infrastructure/ai/Orchestrator"
import { Logger } from "@/shared/services/Logger"
import { DietCodeDefaultTool } from "@/shared/tools"
import { ActionAlreadyActiveError } from "../../ActionExecutionRegistry"
import { executor } from "../../ActionExecutor"
import { persistedToolResult, recoveryResult } from "../../ExecutionRecovery"
import { AgentConfigLoader } from "../subagent/AgentConfigLoader"
import { observeHelperOperation } from "../subagent/observeHelperOperation"
import { SUBAGENT_DEFAULT_ALLOWED_TOOLS, SubagentBuilder } from "../subagent/SubagentBuilder"
import { SubagentRunner, type SubagentRunResult } from "../subagent/SubagentRunner"
import type { TaskConfig } from "../types/TaskConfig"
import type { IFullyManagedTool, ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { recordExecutionEvidence } from "../utils/executionEvidence"
import { ToolResultUtils } from "../utils/ToolResultUtils"
import { reportToolUsage } from "../utils/toolTelemetry"

interface ConfigWithExtensions extends TaskConfig {
	getSessionStreamId?: () => string
}

const PROMPT_KEYS = ["prompt_1", "prompt_2", "prompt_3", "prompt_4", "prompt_5"] as const
const PROGRESS_UPDATE_INTERVAL_MS = 100

function resolveConfiguredSubagentName(toolName: string): string | undefined {
	return AgentConfigLoader.getInstance().resolveSubagentNameForTool(toolName)
}

function collectPrompts(block: ToolUse, configuredSubagentName?: string): string[] {
	if (configuredSubagentName) {
		const dynamicPrompt = block.params.prompt?.trim() || block.params.prompt_1?.trim()
		return dynamicPrompt ? [dynamicPrompt] : []
	}

	return [...new Set(PROMPT_KEYS.map((key) => block.params[key]?.trim()).filter((prompt): prompt is string => !!prompt))]
}

function excerpt(text: string | undefined, maxChars = 1200): string {
	if (!text) {
		return ""
	}

	const trimmed = text.trim()
	if (trimmed.length <= maxChars) {
		return trimmed
	}

	return `${trimmed.slice(0, maxChars)}...`
}

export class UseSubagentsToolHandler implements IFullyManagedTool {
	readonly name = DietCodeDefaultTool.USE_SUBAGENTS
	private readonly batches = new WeakMap<
		TaskConfig["taskState"],
		Map<string, { fingerprint: string; result: Promise<ToolResponse> }>
	>()

	getDescription(_block: ToolUse): string {
		const configuredSubagentName = resolveConfiguredSubagentName(_block.name)
		return configuredSubagentName ? `[subagent: ${configuredSubagentName}]` : "[subagents]"
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const configuredSubagentName = resolveConfiguredSubagentName(block.name)
		const prompts = configuredSubagentName
			? [
					uiHelpers
						.removeClosingTag(block, "prompt", block.params.prompt?.trim() || block.params.prompt_1?.trim())
						?.trim(),
				].filter((prompt): prompt is string => !!prompt)
			: PROMPT_KEYS.map((key) => uiHelpers.removeClosingTag(block, key, block.params[key]?.trim()))
					.map((prompt) => prompt?.trim())
					.filter((prompt): prompt is string => !!prompt)

		if (prompts.length === 0) {
			return
		}
		const partialMessage = JSON.stringify({
			batchId: block.call_id || block.tool_use_id,
			prompts,
		} satisfies DietCodeAskUseSubagents)
		const autoApproveResult = uiHelpers.shouldAutoApproveTool(this.name)
		const [shouldAutoApprove] = Array.isArray(autoApproveResult) ? autoApproveResult : [autoApproveResult, false]

		if (shouldAutoApprove) {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("ask", "use_subagents")
			await uiHelpers.say("use_subagents", partialMessage, undefined, undefined, block.partial)
		} else {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("say", "use_subagents")
			await uiHelpers.ask("use_subagents", partialMessage, block.partial).catch(() => {})
		}
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		let id = block.call_id || block.tool_use_id
		if (!id) {
			if (!config.taskState.recovery) return this.executeBatch(config, block)
			id = randomUUID()
			block = { ...block, call_id: id }
		}
		let receipts = this.batches.get(config.taskState)
		if (!receipts) {
			receipts = new Map()
			this.batches.set(config.taskState, receipts)
		}
		const fingerprint = createHash("sha256")
			.update(JSON.stringify([block.name, Object.entries(block.params).sort(([a], [b]) => a.localeCompare(b))]))
			.digest("hex")
		const existing = receipts.get(id)
		if (existing) {
			if (existing.fingerprint !== fingerprint)
				return formatResponse.toolError(
					"This helper batch ID already belongs to another assignment. No additional helpers were started. Use a new call ID for a new assignment.",
				)
			return existing.result
		}
		const recovery = config.taskState.recovery
		const saved = recovery?.get("batch", id)
		if (saved)
			return saved.fingerprint === fingerprint
				? recoveryResult(saved)
				: formatResponse.toolError(
						"This helper batch ID belongs to different persisted arguments. No helpers were started.",
					)
		recovery?.assertCanExecute(config.executionOwner)
		recovery?.put(id, { kind: "batch", fingerprint })
		// Keep settled receipts for this task; active batches are never evicted or redispatched.
		if (receipts.size >= 128)
			return formatResponse.toolError(
				"Helper batch receipt capacity reached. Reconcile existing results and continue in the parent.",
			)
		const entry = {
			fingerprint,
			result: Promise.resolve()
				.then(() => this.executeBatch(config, block))
				.then((result) => {
					const saved = recovery?.get("batch", id)
					if (saved) recovery?.observe(id, { ...saved, result: persistedToolResult(result) })
					return result
				}),
		}
		receipts.set(id, entry)
		return entry.result
	}

	private async executeBatch(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const subagentsEnabled = config.services.stateManager.getGlobalSettingsKey("subagentsEnabled")
		if (!subagentsEnabled) {
			return formatResponse.toolError("Subagents are disabled. Enable them in Settings > Features to use this tool.")
		}

		const configuredSubagentName = resolveConfiguredSubagentName(block.name)
		const prompts = collectPrompts(block, configuredSubagentName)

		if (prompts.length === 0) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(this.name, configuredSubagentName ? "prompt" : "prompt_1")
		}
		const currentDepth = config.recursionDepth || 0
		const maxDepthSetting = config.services.stateManager.getGlobalSettingsKey("maxSwarmDepth")
		const maxDepth = typeof maxDepthSetting === "number" ? maxDepthSetting : 3
		if (currentDepth >= maxDepth) {
			return formatResponse.toolError(
				`Helper depth limit reached (${maxDepth}). Return the current findings to the parent.`,
			)
		}
		if (config.taskState.abort) {
			return formatResponse.toolError("Helper batch cancelled before execution.")
		}

		// Production Hardening: Limit number of prompts for nested subagents to prevent swarm explosions
		const MAX_PROMPTS_PER_SWARM = config.isSubagentExecution ? 5 : 15
		if (prompts.length > MAX_PROMPTS_PER_SWARM) {
			config.taskState.consecutiveMistakeCount++
			return formatResponse.toolError(
				`Maximum subagent swarm size exceeded. Requested ${prompts.length}, but limited to ${MAX_PROMPTS_PER_SWARM} for stability.`,
			)
		}

		const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
		Logger.info(
			`[SubagentToolHandler] Spawning swarm of ${prompts.length} subagents (Mode: ${currentMode}, Concurrency: 3, Timeout: 20m)`,
		)

		const apiConfig = config.services.stateManager.getApiConfiguration()
		const provider = (currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string
		const approvalPayload: DietCodeAskUseSubagents = { prompts }
		const approvalBody = JSON.stringify(approvalPayload)

		const autoApproveResult = config.autoApprover?.shouldAutoApproveTool(this.name)
		const [autoApproveSafe] = Array.isArray(autoApproveResult) ? autoApproveResult : [autoApproveResult, false]
		const didAutoApprove = !!autoApproveSafe
		// Native calls carry their identity across partial, approval, and status rows.
		// Manual XML approvals gain an identity when their existing partial ask is finalized.
		// Auto-approved XML previews remain unkeyed for legacy prompt matching.
		const batchId = block.call_id || block.tool_use_id || (didAutoApprove ? undefined : randomUUID())

		if (didAutoApprove) {
			reportToolUsage(
				config.ulid,
				this.name,
				config.api.getModel().id,
				provider,
				true,
				true,
				undefined,
				block.isNativeToolCall,
			)
		} else {
			const approvalMessage = JSON.stringify({ ...approvalPayload, batchId })
			const didApprove = await ToolResultUtils.askApprovalAndPushFeedback(
				"use_subagents",
				approvalBody,
				{
					...config,
					callbacks: {
						...config.callbacks,
						// Correlation is display metadata. Keep the semantic approval body stable
						// so a new call/batch ID cannot reopen an identical denied assignment.
						ask: (type, text, partial) =>
							config.callbacks.ask(type, type === "use_subagents" ? approvalMessage : text, partial),
					},
				},
				prompts.length === 1
					? `DietCode wants to use ${configuredSubagentName ? `the '${configuredSubagentName}' subagent` : "a subagent"}`
					: `DietCode wants to use ${prompts.length} subagents`,
			)
			if (!didApprove) {
				reportToolUsage(
					config.ulid,
					this.name,
					config.api.getModel().id,
					provider,
					false,
					false,
					undefined,
					block.isNativeToolCall,
				)
				return formatResponse.toolDenied()
			}
			reportToolUsage(
				config.ulid,
				this.name,
				config.api.getModel().id,
				provider,
				false,
				true,
				undefined,
				block.isNativeToolCall,
			)
		}

		config.taskState.consecutiveMistakeCount = 0

		const entries: SubagentStatusItem[] = prompts.map((prompt, index) => ({
			id: randomUUID(),
			name: configuredSubagentName || `Helper ${index + 1}`,
			index: index + 1,
			prompt,
			criticalSignals: [],
			status: "pending",
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			contextTokens: 0,
			contextWindow: 0,
			contextUsagePercentage: 0,
			latestToolCall: undefined,
			queuedAt: Date.now(),
			heartbeatAt: Date.now(),
			lastActivityAt: Date.now(),
		}))
		let eventSequence = 0
		const recordEvent = (entry: SubagentStatusItem, kind: "phase" | "tool" | "warning", label: string) => {
			const events = (entry.activityEvents ??= [])
			if (events.at(-1)?.label === label) return
			events.push({ id: `${entry.id}:${++eventSequence}`, at: Date.now(), kind, label: label.slice(0, 1200) })
			if (events.length > SUBAGENT_ACTIVITY_LIMIT) {
				events.shift()
				entry.omittedActivityEvents = (entry.omittedActivityEvents ?? 0) + 1
			}
		}

		let statusMessageTs: number | undefined
		let revision = 0
		let lastRecoveryWriteAt = Number.NEGATIVE_INFINITY
		let partialDelivery: Promise<void> | undefined
		let latestPartial: Parameters<typeof convertDietCodeMessageToProto>[0] | undefined
		const deliverPartial = (message: NonNullable<typeof latestPartial>) => {
			latestPartial = message
			partialDelivery ??= Promise.resolve().then(async () => {
				try {
					while (latestPartial) {
						const next = latestPartial
						latestPartial = undefined
						await sendPartialMessageEvent(convertDietCodeMessageToProto(next), 2000)
					}
				} catch (error) {
					Logger.warn("[SubagentToolHandler] Live delivery unavailable", error)
				} finally {
					partialDelivery = undefined
				}
			})
		}
		let webviewDelivery: Promise<void> | undefined
		let webviewDeliveryPending = false
		const queueWebviewDelivery = () => {
			webviewDeliveryPending = true
			webviewDelivery ??= Promise.resolve().then(async () => {
				try {
					while (webviewDeliveryPending) {
						webviewDeliveryPending = false
						try {
							await config.callbacks.postStateToWebview()
						} catch (error) {
							Logger.warn("[SubagentToolHandler] Could not deliver helper progress", error)
						}
					}
				} finally {
					webviewDelivery = undefined
				}
			})
		}
		const emitStatus = async (status: DietCodeSaySubagentStatus["status"], partial: boolean) => {
			const successes = entries.filter((entry) => entry.status === "completed").length
			const failures = entries.filter((entry) => entry.status === "failed").length
			const cancelled = entries.filter((entry) => entry.status === "cancelled").length
			const completed = successes + failures + cancelled
			const toolCalls = entries.reduce((acc, entry) => acc + (entry.toolCalls || 0), 0)
			const inputTokens = entries.reduce((acc, entry) => acc + (entry.inputTokens || 0), 0)
			const outputTokens = entries.reduce((acc, entry) => acc + (entry.outputTokens || 0), 0)
			const contextWindow = entries.reduce((acc, entry) => Math.max(acc, entry.contextWindow || 0), 0)
			const maxContextTokens = entries.reduce((acc, entry) => Math.max(acc, entry.contextTokens || 0), 0)
			const maxContextUsagePercentage = entries.reduce((acc, entry) => Math.max(acc, entry.contextUsagePercentage || 0), 0)

			const payload: DietCodeSaySubagentStatus = {
				batchId,
				taskId: config.taskId,
				revision: ++revision,
				status,
				total: entries.length,
				completed,
				successes,
				failures,
				cancelled,
				toolCalls,
				inputTokens,
				outputTokens,
				contextWindow,
				maxContextTokens,
				maxContextUsagePercentage,
				items: entries,
			}

			const text = JSON.stringify(payload)
			const receiptId = block.call_id || block.tool_use_id
			const recovery = config.taskState.recovery
			const saved = receiptId ? recovery?.get("batch", receiptId) : undefined
			if (saved && receiptId && (!partial || Date.now() - lastRecoveryWriteAt >= 1000)) {
				lastRecoveryWriteAt = Date.now()
				recovery?.observe(receiptId, { ...saved, status: text, messageTs: statusMessageTs })
			}
			const messages = config.messageState
			if (messages?.publishSubagentStatus) {
				const create = statusMessageTs === undefined
				statusMessageTs ??= Math.max(Date.now(), (messages.getDietCodeMessages().at(-1)?.ts ?? 0) + 1)
				const message = { ts: statusMessageTs, type: "say" as const, say: "subagent" as const, text, partial }
				if (!messages.publishSubagentStatus(message, create)) return
				deliverPartial(message)
				// Full snapshots hydrate late subscribers; live updates never wait on auth/settings or disk.
				if (create || !partial) queueWebviewDelivery()
			} else if (messages?.getDietCodeMessages && messages.addToDietCodeMessages && messages.updateDietCodeMessage) {
				// Own one row. A delayed write cannot replace a newer command, approval, or helper batch.
				if (statusMessageTs === undefined) {
					statusMessageTs = Math.max(Date.now(), (messages.getDietCodeMessages().at(-1)?.ts ?? 0) + 1)
					await messages.addToDietCodeMessages({ ts: statusMessageTs, type: "say", say: "subagent", text, partial })
				} else {
					const index = messages.getDietCodeMessages().findIndex((message) => {
						if (message.ts !== statusMessageTs || message.say !== "subagent") return false
						try {
							return JSON.parse(message.text || "{}").items?.[0]?.id === entries[0].id
						} catch {
							return false
						}
					})
					if (index < 0) return
					await messages.updateDietCodeMessage(index, { text, partial })
				}
				// Persist the row independently: an unresponsive webview must not hold
				// newer progress or the terminal state behind an older delivery. Keep
				// at most one delivery in flight and coalesce its pending successor.
				queueWebviewDelivery()
			} else {
				await config.callbacks.say("subagent", text, undefined, undefined, partial)
			}
		}

		let pendingStatus: { status: DietCodeSaySubagentStatus["status"]; partial: boolean } | undefined
		let statusUpdateQueue: Promise<void> | undefined
		let lastStatusWriteAt = Number.NEGATIVE_INFINITY
		let resumeStatusDelay: (() => void) | undefined
		const queueStatusUpdate = (status: DietCodeSaySubagentStatus["status"], partial: boolean): Promise<void> => {
			// Bound progress I/O even when the UI is fast. Terminal updates bypass the delay.
			pendingStatus = { status, partial }
			if (!partial) resumeStatusDelay?.()
			statusUpdateQueue ??= (async () => {
				try {
					while (pendingStatus) {
						const waitMs = PROGRESS_UPDATE_INTERVAL_MS - (Date.now() - lastStatusWriteAt)
						if (pendingStatus.partial && waitMs > 0) {
							await new Promise<void>((resolve) => {
								const timer = setTimeout(resolve, waitMs)
								resumeStatusDelay = () => {
									clearTimeout(timer)
									resolve()
								}
							})
							resumeStatusDelay = undefined
						}
						const update = pendingStatus
						pendingStatus = undefined
						lastStatusWriteAt = Date.now()
						try {
							await emitStatus(update.status, update.partial)
						} catch (error) {
							Logger.warn("[SubagentToolHandler] Could not publish helper progress", error)
						}
					}
				} finally {
					// Clear before resolving, so an update arriving in the next microtask starts a new drain.
					statusUpdateQueue = undefined
				}
			})()
			return statusUpdateQueue
		}

		void queueStatusUpdate("running", true)
		let runners: SubagentRunner[]
		try {
			const builder = new SubagentBuilder(config, configuredSubagentName)

			// Phase 3: Swarm Tool Delegation & Authorization Guard
			const requestedTools = builder.getAllowedTools() || []
			const unauthorizedTools = requestedTools.filter(
				(t: DietCodeDefaultTool) => !SUBAGENT_DEFAULT_ALLOWED_TOOLS.includes(t) && t !== DietCodeDefaultTool.ATTEMPT,
			)

			if (unauthorizedTools.length > 0) {
				Logger.warn(
					`[SubagentToolHandler] Subagent '${configuredSubagentName}' requested restricted tools: ${unauthorizedTools.join(", ")}. Permission denied.`,
				)
				// Force filter the toolset to only include authorized tools
				builder.setAllowedTools(requestedTools.filter((t) => !unauthorizedTools.includes(t)))
			}

			runners = prompts.map((_prompt, index) => {
				// Each helper owns its provider stream and retry signal. Sharing the builder
				// also shared cancellation across otherwise independent helpers.
				const helperBuilder = index === 0 ? builder : new SubagentBuilder(config, configuredSubagentName)
				helperBuilder.setAllowedTools(builder.getAllowedTools())
				const runner = new SubagentRunner(config, helperBuilder)
				runner.setRecursionDepth(currentDepth + 1)
				return runner
			})
		} catch (error) {
			const reason = error instanceof Error ? error.message : "Helper runtime could not start"
			for (const entry of entries) {
				entry.status = "failed"
				entry.error = reason
			}
			await queueStatusUpdate("failed", false)
			return formatResponse.toolError(reason)
		}
		let stopReason: string | undefined
		let finalized = false
		let signalStopped!: () => void
		const stopped = new Promise<void>((resolve) => {
			signalStopped = resolve
		})
		const batchAbort = new AbortController()
		const stopBatch = (reason: string) => {
			if (stopReason) return
			stopReason = reason
			batchAbort.abort(new Error(reason))
			signalStopped()
			void Promise.allSettled(runners.map((runner) => Promise.resolve().then(() => runner.abort())))
		}
		const onParentAbort = () => stopBatch("Helper batch cancelled.")
		config.taskState.abortSignal.addEventListener("abort", onParentAbort, { once: true })
		if (config.taskState.abort) onParentAbort()

		// Wire each subagent prompt to an orchestrator child stream
		// getSessionStreamId may not be available on all config shapes
		let parentStreamId: string | undefined
		try {
			parentStreamId = (config as ConfigWithExtensions).getSessionStreamId?.()
		} catch (error) {
			Logger.warn("[SubagentToolHandler] Stream tracking unavailable:", error)
		}
		const childStreamIds: (string | undefined)[] = new Array(prompts.length)

		const results: (PromiseSettledResult<SubagentRunResult> | undefined)[] = Array.from({ length: prompts.length })
		const latestStats: (SubagentRunResult["stats"] | undefined)[] = new Array(prompts.length)
		const recordStats = (index: number, stats: SubagentRunResult["stats"]) => {
			const previous = latestStats[index]
			const merged = { ...stats }
			for (const key of [
				"toolCalls",
				"inputTokens",
				"outputTokens",
				"cacheWriteTokens",
				"cacheReadTokens",
				"totalCost",
			] as const) {
				merged[key] = Math.max(previous?.[key] || 0, Number.isFinite(stats[key]) ? stats[key] : 0)
			}
			latestStats[index] = merged
			return merged
		}
		const closedStreams = new Set<string>()
		const runningHelpers = new Set<number>()
		const closeChildStream = (index: number) => {
			const id = childStreamIds[index]
			if (!id || closedStreams.has(id) || runningHelpers.has(index)) return
			const current = entries[index]
			if (current.status !== "completed" && current.status !== "failed" && current.status !== "cancelled") return
			closedStreams.add(id)
			void observeHelperOperation("Stream finalization", async () => {
				if (current.status === "completed") await orchestrator.completeStream(id, excerpt(current.result, 200))
				else await orchestrator.failStream(id, current.error || "Helper stopped")
			})
		}
		let totalSwarmCost = 0
		let totalSwarmTokens = 0
		const MAX_PARENT_COST = config.taskState.maxCost
		const MAX_PARENT_TOKENS = config.taskState.maxTokens
		if (MAX_PARENT_COST !== undefined && Number.isFinite(MAX_PARENT_COST) && MAX_PARENT_COST <= 0) {
			stopBatch("Helper cost budget is exhausted.")
		}
		if (MAX_PARENT_TOKENS !== undefined && Number.isFinite(MAX_PARENT_TOKENS) && MAX_PARENT_TOKENS <= 0) {
			stopBatch("Helper token budget is exhausted.")
		}
		const recordUsage = (index: number, stats: SubagentRunResult["stats"]) => {
			const tokens = (usage: SubagentRunResult["stats"] | undefined) =>
				(usage?.inputTokens || 0) +
				(usage?.outputTokens || 0) +
				(usage?.cacheWriteTokens || 0) +
				(usage?.cacheReadTokens || 0)
			const previousTokens = tokens(latestStats[index])
			const merged = recordStats(index, stats)
			totalSwarmTokens += tokens(merged) - previousTokens
			recordCost(entries[index], merged.totalCost)
			if (MAX_PARENT_TOKENS !== undefined && Number.isFinite(MAX_PARENT_TOKENS) && totalSwarmTokens >= MAX_PARENT_TOKENS) {
				stopBatch(`Helper token budget reached (${totalSwarmTokens} / ${MAX_PARENT_TOKENS}).`)
			}
		}
		const recordCost = (current: SubagentStatusItem, cost: number | undefined) => {
			if (cost === undefined || !Number.isFinite(cost)) return
			const nextCost = Math.max(current.totalCost || 0, cost)
			totalSwarmCost += nextCost - (current.totalCost || 0)
			current.totalCost = nextCost
			if (MAX_PARENT_COST !== undefined && totalSwarmCost >= MAX_PARENT_COST) {
				stopBatch(`Helper cost budget reached ($${totalSwarmCost.toFixed(2)} / $${MAX_PARENT_COST.toFixed(2)}).`)
			}
		}

		const runSubagent = async (index: number) => {
			runningHelpers.add(index)
			try {
				const current = entries[index]
				current.status = "running"
				current.startedAt = Date.now()
				current.lastActivityAt = current.startedAt
				current.heartbeatAt = current.startedAt
				current.queuePosition = undefined
				current.activity = { phase: "preparing", detail: "Starting helper runtime", startedAt: current.startedAt }
				recordEvent(current, "phase", "Helper started")
				void queueStatusUpdate("running", true)
				if (parentStreamId) {
					await observeHelperOperation("Stream registration", async () => {
						const child = await orchestrator.spawnChildStream(
							parentStreamId!,
							`subagent: ${prompts[index].slice(0, 80)}`,
						)
						childStreamIds[index] = child.id
						runners[index].setStreamId(child.id)
						closeChildStream(index)
					})
				}
				if (stopReason || config.taskState.abort) {
					throw new Error(stopReason || "Helper batch cancelled before execution.")
				}
				const result = await runners[index].run(
					prompts[index],
					(update) => {
						executor.executions.recordHelperEvidence(config.ulid, current.executionId, update)
						if (finalized) return
						if (update.stats) recordUsage(index, update.stats)

						if (update.status) current.status = update.status
						if (update.result !== undefined) {
							current.result = update.result
						}
						if (update.error !== undefined) {
							current.error = update.error
						}
						if (update.latestToolCall !== undefined) {
							current.latestToolCall = update.latestToolCall
						}
						if (update.activity !== undefined) {
							if (
								update.activity.phase !== current.activity?.phase ||
								update.activity.detail !== current.activity?.detail
							) {
								const labels = {
									preparing: "Preparing helper",
									waiting: "Waiting for model response",
									responding: "Receiving model response",
									tool: "Running tool",
									retrying: "Retry scheduled",
									recovering: "Recovering interrupted response",
								}
								recordEvent(current, "phase", update.activity.detail || labels[update.activity.phase])
							}
							current.activity = update.activity
						}
						if (update.lastActivityAt !== undefined) current.lastActivityAt = update.lastActivityAt
						if (update.responseChunks !== undefined) current.responseChunks = update.responseChunks
						if (update.responseBytes !== undefined) current.responseBytes = update.responseBytes
						if (update.requestCount !== undefined) current.requestCount = update.requestCount
						if (update.latestMessage !== undefined) current.latestMessage = update.latestMessage
						if (update.recentTools !== undefined) {
							for (const tool of update.recentTools) {
								if (
									tool.status !== "running" &&
									current.recentTools?.find((previous) => previous.id === tool.id)?.status !== tool.status
								)
									recordEvent(
										current,
										tool.status === "failed" ? "warning" : "tool",
										`${tool.status === "failed" ? "Failed" : "Result received"}: ${tool.label}`,
									)
							}
							current.recentTools = update.recentTools
						}
						if (update.activeSignals !== undefined) {
							current.criticalSignals = update.activeSignals
						}
						if (update.filesModified !== undefined) {
							current.filesModified = update.filesModified
						}
						if (update.filesViewed !== undefined) {
							current.filesViewed = update.filesViewed
						}
						if (update.pendingCommandIds !== undefined) current.pendingCommandIds = update.pendingCommandIds
						if (update.durationMs !== undefined) {
							current.durationMs = update.durationMs
						}
						if (update.stats) {
							current.toolCalls = update.stats.toolCalls || 0
							current.inputTokens = update.stats.inputTokens || 0
							current.outputTokens = update.stats.outputTokens || 0
							current.contextTokens = update.stats.contextTokens || 0
							current.contextWindow = update.stats.contextWindow || 0
							current.contextUsagePercentage = update.stats.contextUsagePercentage || 0
						}
						void queueStatusUpdate("running", true)
					},
					childStreamIds[index] || undefined,
				)
				if (!finalized) {
					recordUsage(index, result.stats)
					results[index] = { status: "fulfilled", value: result }
					current.status = result.status
					current.result = result.result ?? current.result
					current.error = result.error
					current.filesModified = result.filesModified ?? current.filesModified
					current.filesViewed = result.filesViewed ?? current.filesViewed
					current.pendingCommandIds = result.pendingCommandIds ?? current.pendingCommandIds
					current.durationMs = result.durationMs ?? current.durationMs
					const stats = latestStats[index] ?? result.stats
					current.toolCalls = stats.toolCalls || 0
					current.inputTokens = stats.inputTokens || 0
					current.outputTokens = stats.outputTokens || 0
					current.totalCost = stats.totalCost || 0
					current.contextTokens = stats.contextTokens || 0
					current.contextWindow = stats.contextWindow || 0
					current.contextUsagePercentage = stats.contextUsagePercentage || 0
					current.activity = undefined
					recordEvent(
						current,
						result.status === "completed" ? "phase" : "warning",
						result.status === "completed" ? "Handoff ready for the main agent" : result.error || "Helper stopped",
					)
					// Release this finished helper's reservations without waiting for slower siblings.
					closeChildStream(index)
					void queueStatusUpdate("running", true)
				}
				// The execution receipt still receives a late outcome after the batch stops waiting.
				return result
			} finally {
				// A caller deadline does not release file reservations held by work still settling.
				runningHelpers.delete(index)
				closeChildStream(index)
			}
		}
		const failSubagent = (index: number, error: unknown) => {
			if (finalized || (stopReason && entries[index].status === "completed")) return
			if (!stopReason) Logger.error(`[SubagentToolHandler] Subagent ${index} crashed:`, error)
			const current = entries[index]
			if (error instanceof ActionAlreadyActiveError) current.executionId = error.execution.execution_id
			current.status = stopReason ? "cancelled" : "failed"
			current.activity = undefined
			current.error =
				stopReason ||
				(error instanceof Error ? error.message : typeof error === "string" ? error : "Internal Runner Crash")
			results[index] = { status: "rejected", reason: error }
			if (!stopReason) closeChildStream(index)
			void queueStatusUpdate("running", true)
		}

		const SUBAGENT_EXECUTION_TIMEOUT_MS = 20 * 60 * 1000
		// Own the deadline before per-assignment queue timers are registered, so a
		// stopped batch consistently cancels queued work instead of reporting crashes.
		const batchDeadline = setTimeout(
			() => stopBatch("Subagent swarm execution timed out after 20 minutes."),
			SUBAGENT_EXECUTION_TIMEOUT_MS,
		)
		// Reserve every assignment before dispatch. Batches share three slots per task/depth;
		// child helpers have a separate depth lane so parents waiting for them cannot deadlock it.
		const workers = prompts.map((prompt, index) =>
			executor
				.execute(config.ulid, () => runSubagent(index), {
					onReserved: (id) => {
						entries[index].executionId = id
					},
					concurrencyGroup: `helpers:${currentDepth}`,
					queueTimeoutMs: SUBAGENT_EXECUTION_TIMEOUT_MS,
					signal: AbortSignal.any([config.taskState.abortSignal, batchAbort.signal]),
					execution: {
						kind: "helper",
						input: { cwd: config.cwd, agent: configuredSubagentName ?? "default", prompt },
						label: prompt,
						owner: runners[index].getExecutionOwner(),
					},
				})
				.catch((error) => failSubagent(index, error)),
		)
		const refreshRuntime = () => {
			if (finalized) return
			const now = Date.now()
			const queue = executor.getQueues(config.ulid).find((lane) => lane.group === `helpers:${currentDepth}`)
			try {
				const inventory = config.callbacks.getExecutionState?.()
				for (const [index, entry] of entries.entries()) {
					if (entry.status !== "pending" && entry.status !== "running") continue
					entry.heartbeatAt = now
					entry.queuePosition = queue?.queue.find((item) => item.execution_id === entry.executionId)?.position
					if (inventory && "commands" in inventory) {
						const commands = [...inventory.commands.recent, ...inventory.commands.active]
							.filter((command) => command.owner === runners[index].getExecutionOwner())
							.slice(-8)
							.map((command) => ({
								id: command.execution_id,
								command: command.command.slice(0, 1000),
								status: command.status,
								output: command.output_preview.slice(-4000),
								exitCode: command.exit_code,
							}))
						if (JSON.stringify(commands) !== JSON.stringify(entry.commands ?? [])) {
							entry.commands = commands
							entry.lastActivityAt = now
						}
					}
				}
			} catch (error) {
				Logger.warn("[SubagentToolHandler] Command observation unavailable", error)
			}
			void queueStatusUpdate("running", true)
		}
		refreshRuntime()
		const heartbeat = setInterval(refreshRuntime, SUBAGENT_HEARTBEAT_INTERVAL_MS)

		try {
			await Promise.race([Promise.all(workers), stopped])
		} catch (err: unknown) {
			Logger.error("[SubagentToolHandler] Swarm execution error or timeout:", err)
			// Abort all runners on timeout to prevent zombie processes
			stopBatch(err instanceof Error ? err.message : "Helper batch stopped.")
		} finally {
			refreshRuntime()
			clearInterval(heartbeat)
			clearTimeout(batchDeadline)
			finalized = true
			config.taskState.abortSignal.removeEventListener("abort", onParentAbort)
		}

		let usageTokensIn = 0
		let usageTokensOut = 0
		let usageCacheWrites = 0
		let usageCacheReads = 0
		let usageCost = 0

		results.forEach((result, index) => {
			entries[index].activity = undefined
			if (!result) {
				// A sibling may have triggered the budget stop just after this helper
				// published its completed handoff but before its promise settled.
				if (entries[index].status === "completed" || entries[index].status === "failed") return
				entries[index].status = "cancelled"
				entries[index].error = stopReason || "Helper cancelled before finishing."
				return
			}

			if (result.status === "rejected") {
				entries[index].error = entries[index].error || "Subagent execution failed"
				return
			}
		})
		entries.forEach((_entry, index) => closeChildStream(index))
		if (entries.some((entry) => entry.status === "completed" || (entry.filesModified?.length ?? 0) > 0)) {
			// A fresh handoff can resolve the parent's blocker even with checkpoints disabled.
			recordExecutionEvidence(
				config.taskState,
				"helpers",
				[config.cwd, configuredSubagentName, prompts],
				entries.map((entry) => ({
					status: entry.status,
					result: entry.result,
					error: entry.error,
					filesModified: entry.filesModified,
					filesViewed: entry.filesViewed,
				})),
			)
		}
		for (const stats of latestStats) {
			usageTokensIn += stats?.inputTokens || 0
			usageTokensOut += stats?.outputTokens || 0
			usageCacheWrites += stats?.cacheWriteTokens || 0
			usageCacheReads += stats?.cacheReadTokens || 0
			usageCost += stats?.totalCost || 0
		}

		// Keep reconciliation references outside excerpts: long model prose must never hide live work.
		try {
			const inventory = config.callbacks.getExecutionState?.()
			if (inventory && "commands" in inventory)
				entries.forEach((entry, index) => {
					entry.pendingCommandIds = [
						...new Set([
							...(entry.pendingCommandIds ?? []),
							...inventory.commands.active
								.filter((command) => command.owner === runners[index].getExecutionOwner())
								.map((command) => command.execution_id),
						]),
					]
				})
		} catch (error) {
			Logger.warn("[SubagentToolHandler] Command handoff inventory unavailable:", error)
		}

		const failures = entries.filter((entry) => entry.status === "failed").length
		const cancelled = entries.filter((entry) => entry.status === "cancelled").length
		const finalStatus = queueStatusUpdate(cancelled > 0 ? "cancelled" : failures > 0 ? "failed" : "completed", false)

		const subagentUsagePayload: DietCodeSubagentUsageInfo = {
			source: "subagents",
			tokensIn: usageTokensIn,
			tokensOut: usageTokensOut,
			cacheWrites: usageCacheWrites,
			cacheReads: usageCacheReads,
			cost: usageCost,
		}
		await observeHelperOperation("Final status and usage display", () =>
			Promise.all([
				finalStatus,
				Promise.resolve().then(() => config.callbacks.say("subagent_usage", JSON.stringify(subagentUsagePayload))),
			]),
		)

		const successCount = entries.filter((entry) => entry.status === "completed").length
		const reconciliation = entries.flatMap((entry) => {
			const execution = entry.executionId ? executor.executions.get(config.ulid, entry.executionId) : undefined
			const settling = execution && ["queued", "running", "retrying", "awaiting_completion"].includes(execution.status)
			return [
				...(entry.executionId
					? [
							`- Helper ${entry.index}: execution_id ${entry.executionId}. ${settling ? "Still settling; do not repeat or overlap this assignment." : "Retained execution receipt."} Use get_execution_state with this ID for its latest status and structured helper_handoff.`,
						]
					: []),
				...(entry.pendingCommandIds ?? []).map(
					(id) => `- Pending command: ${id}. Use read_command_output; do not relaunch.`,
				),
			]
		})

		const blackboard = config.taskState.swarmBlackboard || []
		const summary = [
			"### SWARM EXECUTION SUMMARY",
			`Total Agents: ${entries.length} (Success: ${successCount}, Fail: ${failures}${cancelled ? `, Cancelled: ${cancelled}` : ""})`,
			...(failures > 0 || cancelled > 0
				? [
						"Use completed results and partial work below. Continue independent authorized work; resolve a reported blocker before retrying the same assignment.",
					]
				: []),
			...(reconciliation.length ? ["", "### RECONCILIATION", ...reconciliation] : []),
			"",
			"### AGENT DETAILS",
			...entries.map((entry) => {
				const header = `#### [${entry.index}] ${entry.name} - ${entry.status.toUpperCase()}`
				const isSingleAgent = entries.length === 1
				const promptLimit = isSingleAgent ? 1000 : 300
				const resultLimit = isSingleAgent ? 8000 : 2500

				const subPrompt = `**Objective:** ${excerpt(entry.prompt, promptLimit)}`
				const filesModifiedBlock =
					entry.filesModified && entry.filesModified.length > 0
						? `\n**Files Modified:** ${entry.filesModified.map((f) => `\`${f}\``).join(", ")}`
						: ""
				const filesReadBlock =
					entry.filesViewed && entry.filesViewed.length > 0
						? `\n**Files Read:** ${entry.filesViewed.map((f) => `\`${f}\``).join(", ")}`
						: ""
				const detail =
					entry.status === "completed"
						? `**Result:**\n${excerpt(entry.result, resultLimit)}`
						: `**${entry.status === "cancelled" ? "Cancellation" : "Error"}:**\n${entry.error || (entry.status === "cancelled" ? "Helper cancelled." : "Unknown error")}${entry.result ? `\n**Partial result:**\n${excerpt(entry.result, resultLimit)}` : ""}`
				const signals =
					entry.criticalSignals && entry.criticalSignals.length > 0
						? `\n**Signals:** ${entry.criticalSignals.join(", ")}`
						: ""
				return `${header}\n${subPrompt}${filesModifiedBlock}${filesReadBlock}\n${detail}${signals}\n`
			}),
			...(blackboard.length > 0 ? ["", "### SHARED SWARM FINDINGS (Blackboard)", ...blackboard.map((f) => `- ${f}`)] : []),
		].join("\n")

		// Timing and token counters remain in the UI; they cannot make an unchanged handoff look productive.
		return successCount === 0 ? formatResponse.toolError(summary) : formatResponse.toolResult(summary)
	}
}
