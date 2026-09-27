import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import {
	DietCodeAskUseSubagents,
	DietCodeSaySubagentStatus,
	DietCodeSubagentUsageInfo,
	SubagentStatusItem,
} from "@shared/ExtensionMessage"
import pTimeout from "p-timeout"
import { orchestrator } from "@/infrastructure/ai/Orchestrator"
import { Logger } from "@/shared/services/Logger"
import { DietCodeDefaultTool } from "@/shared/tools"
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

function resolveConfiguredSubagentName(toolName: string): string | undefined {
	return AgentConfigLoader.getInstance().resolveSubagentNameForTool(toolName)
}

function collectPrompts(block: ToolUse, configuredSubagentName?: string): string[] {
	if (configuredSubagentName) {
		const dynamicPrompt = block.params.prompt?.trim() || block.params.prompt_1?.trim()
		return dynamicPrompt ? [dynamicPrompt] : []
	}

	return PROMPT_KEYS.map((key) => block.params[key]?.trim()).filter((prompt): prompt is string => !!prompt)
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
		const partialMessage = JSON.stringify({ prompts } satisfies DietCodeAskUseSubagents)
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
			const didApprove = await ToolResultUtils.askApprovalAndPushFeedback(
				"use_subagents",
				approvalBody,
				config,
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
			id: Math.random().toString(36).substring(2, 9),
			name: configuredSubagentName || `Subagent ${index + 1}`,
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
		}))

		let statusMessageTs: number | undefined
		const emitStatus = async (status: DietCodeSaySubagentStatus["status"], partial: boolean) => {
			const completed = entries.filter((entry) => entry.status === "completed" || entry.status === "failed").length
			const successes = entries.filter((entry) => entry.status === "completed").length
			const failures = entries.filter((entry) => entry.status === "failed").length
			const toolCalls = entries.reduce((acc, entry) => acc + (entry.toolCalls || 0), 0)
			const inputTokens = entries.reduce((acc, entry) => acc + (entry.inputTokens || 0), 0)
			const outputTokens = entries.reduce((acc, entry) => acc + (entry.outputTokens || 0), 0)
			const contextWindow = entries.reduce((acc, entry) => Math.max(acc, entry.contextWindow || 0), 0)
			const maxContextTokens = entries.reduce((acc, entry) => Math.max(acc, entry.contextTokens || 0), 0)
			const maxContextUsagePercentage = entries.reduce((acc, entry) => Math.max(acc, entry.contextUsagePercentage || 0), 0)

			const payload: DietCodeSaySubagentStatus = {
				status,
				total: entries.length,
				completed,
				successes,
				failures,
				toolCalls,
				inputTokens,
				outputTokens,
				contextWindow,
				maxContextTokens,
				maxContextUsagePercentage,
				items: entries,
			}

			const text = JSON.stringify(payload)
			const messages = config.messageState
			if (messages?.getDietCodeMessages && messages.addToDietCodeMessages && messages.updateDietCodeMessage) {
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
				await config.callbacks.postStateToWebview()
			} else {
				await config.callbacks.say("subagent", text, undefined, undefined, partial)
			}
		}

		let pendingStatus: { status: DietCodeSaySubagentStatus["status"]; partial: boolean } | undefined
		let statusUpdateQueue: Promise<void> | undefined
		const queueStatusUpdate = (status: DietCodeSaySubagentStatus["status"], partial: boolean): Promise<void> => {
			// Coalesce progress while the UI is busy; retain the final state without queuing every token update.
			pendingStatus = { status, partial }
			statusUpdateQueue ??= (async () => {
				try {
					while (pendingStatus) {
						const update = pendingStatus
						pendingStatus = undefined
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

		const runners = prompts.map((_prompt, index) => {
			// Each helper owns its provider stream and retry signal. Sharing the builder
			// also shared cancellation across otherwise independent helpers.
			const helperBuilder = index === 0 ? builder : new SubagentBuilder(config, configuredSubagentName)
			helperBuilder.setAllowedTools(builder.getAllowedTools())
			const runner = new SubagentRunner(config, helperBuilder)
			runner.setRecursionDepth(currentDepth + 1)
			return runner
		})
		void queueStatusUpdate("running", true)
		let stopReason: string | undefined
		let finalized = false
		let signalStopped!: () => void
		const stopped = new Promise<void>((resolve) => {
			signalStopped = resolve
		})
		const stopBatch = (reason: string) => {
			if (stopReason) return
			stopReason = reason
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

		// Production Hardening: Concurrency Limit (max 3 subagents in parallel)
		const MAX_CONCURRENCY = 3
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
		const closeChildStream = (index: number) => {
			const id = childStreamIds[index]
			if (!id || closedStreams.has(id)) return
			const current = entries[index]
			if (current.status !== "completed" && current.status !== "failed") return
			closedStreams.add(id)
			void observeHelperOperation("Stream finalization", async () => {
				if (current.status === "completed") await orchestrator.completeStream(id, excerpt(current.result, 200))
				else await orchestrator.failStream(id, current.error || "Helper stopped")
			})
		}
		let nextIndex = 0
		let totalSwarmCost = 0
		const MAX_PARENT_COST = config.taskState.maxCost
		if (MAX_PARENT_COST !== undefined && Number.isFinite(MAX_PARENT_COST) && MAX_PARENT_COST <= 0) {
			stopBatch("Helper cost budget is exhausted.")
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
			const current = entries[index]
			try {
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
					return
				}
				const result = await runners[index].run(
					prompts[index],
					(update) => {
						if (finalized) return
						if (update.stats) recordStats(index, update.stats)
						recordCost(current, update.stats?.totalCost)

						if (update.status === "running") {
							current.status = "running"
						}
						if (update.status === "completed") {
							current.status = "completed"
						}
						if (update.status === "failed") {
							current.status = "failed"
						}
						if (update.result !== undefined) {
							current.result = update.result
						}
						if (update.error !== undefined) {
							current.error = update.error
						}
						if (update.latestToolCall !== undefined) {
							current.latestToolCall = update.latestToolCall
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
				if (finalized) return
				recordStats(index, result.stats)
				recordCost(current, result.stats.totalCost)
				results[index] = { status: "fulfilled", value: result }
			} catch (error) {
				if (finalized) return
				Logger.error(`[SubagentToolHandler] Subagent ${index} crashed:`, error)
				current.status = "failed"
				current.error =
					error instanceof Error ? error.message : typeof error === "string" ? error : "Internal Runner Crash"
				results[index] = { status: "rejected", reason: error }
				void queueStatusUpdate("running", true)
			}
		}

		const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, prompts.length) }, async () => {
			while (nextIndex < prompts.length && !stopReason && !config.taskState.abort) {
				const i = nextIndex++
				await runSubagent(i)
			}
		})

		// Production Hardening: 20-minute hard timeout for the entire swarm execution
		const SUBAGENT_EXECUTION_TIMEOUT_MS = 20 * 60 * 1000

		try {
			await pTimeout(Promise.race([Promise.all(workers), stopped]), {
				milliseconds: SUBAGENT_EXECUTION_TIMEOUT_MS,
				message: "Subagent swarm execution timed out after 20 minutes.",
			})
		} catch (err: unknown) {
			Logger.error("[SubagentToolHandler] Swarm execution error or timeout:", err)
			// Abort all runners on timeout to prevent zombie processes
			stopBatch(err instanceof Error ? err.message : "Helper batch stopped.")
		} finally {
			finalized = true
			config.taskState.abortSignal.removeEventListener("abort", onParentAbort)
		}

		let usageTokensIn = 0
		let usageTokensOut = 0
		let usageCacheWrites = 0
		let usageCacheReads = 0
		let usageCost = 0

		results.forEach((result, index) => {
			if (!result) {
				entries[index].status = "failed"
				entries[index].error = stopReason || "Helper cancelled before finishing."
				return
			}

			if (result.status === "rejected") {
				entries[index].status = "failed"
				entries[index].error = entries[index].error || "Subagent execution failed"
				return
			}

			entries[index].status = result.value.status
			entries[index].result = result.value.result
			entries[index].error = result.value.error
			entries[index].filesModified = result.value.filesModified ?? entries[index].filesModified
			entries[index].filesViewed = result.value.filesViewed ?? entries[index].filesViewed
			entries[index].durationMs = result.value.durationMs
			const stats = latestStats[index] ?? result.value.stats
			entries[index].toolCalls = stats.toolCalls || 0
			entries[index].inputTokens = stats.inputTokens || 0
			entries[index].outputTokens = stats.outputTokens || 0
			entries[index].totalCost = stats.totalCost || 0
			entries[index].contextTokens = result.value.stats.contextTokens || 0
			entries[index].contextWindow = result.value.stats.contextWindow || 0
			entries[index].contextUsagePercentage = result.value.stats.contextUsagePercentage || 0
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

		const failures = entries.filter((entry) => entry.status === "failed").length
		const finalStatus = queueStatusUpdate(failures > 0 ? "failed" : "completed", false)

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

		const successCount = entries.length - failures

		const blackboard = config.taskState.swarmBlackboard || []
		const summary = [
			"### SWARM EXECUTION SUMMARY",
			`Total Agents: ${entries.length} (Success: ${successCount}, Fail: ${failures})`,
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
						: `**Error:**\n${entry.error || "Unknown error"}${entry.result ? `\n**Partial result:**\n${excerpt(entry.result, resultLimit)}` : ""}`
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
