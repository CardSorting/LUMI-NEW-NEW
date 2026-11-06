import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { buildApiHandler } from "@/core/api"
import { PromptRegistry } from "@/core/prompts/system-prompt"
import { DietCodeToolSet } from "@/core/prompts/system-prompt/registry/DietCodeToolSet"
import type { SystemPromptContext } from "@/core/prompts/system-prompt/types"
import { formatLegionHandoffText, legionHandoffStatus } from "@/core/task/legion/LegionHandoff"
import { resolveEffectiveAgentSwarmState } from "@/infrastructure/ai/AgentSwarmConfig"
import { formatLegionOperationEvidence, getLegionOperationEvidence } from "@/infrastructure/ai/LegionExecutionReceipt"
import { formatLegionProgressMessage, runLegionPipeline } from "@/infrastructure/ai/LegionPipelineRunner"
import {
	isValidLegionStrategy,
	type LegionFormationStrategy,
	type LegionSpecialistRole,
	orchestrator,
} from "@/infrastructure/ai/Orchestrator"
import { findLast } from "@/shared/array"
import { combineApiRequests } from "@/shared/combineApiRequests"
import { combineCommandSequences } from "@/shared/combineCommandSequences"
import type { DietCodeApiReqInfo } from "@/shared/ExtensionMessage"
import { getApiMetrics, hasValidApiUsage } from "@/shared/getApiMetrics"
import { Logger } from "@/shared/services/Logger"
import { DietCodeDefaultTool } from "@/shared/tools"
import { LegionAgentHost } from "../../legion/LegionAgentHost"
import { createLegionToolAdapter, LEGION_TOOL_NAMES } from "../../legion/LegionToolAdapter"
import type { TaskConfig } from "../types/TaskConfig"
import type { IToolHandler, ToolResponse } from "../types/ToolContracts"

// Prevent overlapping manual formation attempts for the same parent in this process.
const activeManualFormations = new Set<string>()

export class EngageSwarmHandler implements IToolHandler {
	readonly name = DietCodeDefaultTool.ENGAGE_SWARM

	getDescription(block: ToolUse): string {
		const obj = block.params?.objective ? `: ${block.params.objective.slice(0, 40)}...` : ""
		return `[${block.name}${obj}]`
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const rawObjective = typeof block.params?.objective === "string" ? block.params.objective.trim() : ""
		if (!rawObjective) {
			return formatResponse.toolError("An explicit objective is required to engage the swarm or specialist team.")
		}
		const objective = rawObjective
		if (config.taskState.abort) {
			return formatResponse.toolError("Task execution has been aborted.")
		}

		const state = resolveEffectiveAgentSwarmState({ taskId: config.taskId })
		if (!state.enabled && !state.legionEnabled) {
			return formatResponse.toolError(
				"Agent Swarm and The Legion are currently disabled in settings. Enable agentSwarmEnabled or agentSwarmLegionEnabled to form specialist teams.",
			)
		}

		const requestedStrategy = typeof block.params?.strategy === "string" ? block.params.strategy.trim() : undefined
		const preferredRolesRaw = block.params?.preferred_roles
		const maxSpecialistsRaw = block.params?.max_specialists

		let maxSpecialists: number | undefined
		if (typeof maxSpecialistsRaw === "number" && Number.isFinite(maxSpecialistsRaw)) {
			maxSpecialists = Math.max(1, Math.min(8, Math.round(maxSpecialistsRaw)))
		} else if (typeof maxSpecialistsRaw === "string") {
			const parsed = Number.parseInt(maxSpecialistsRaw, 10)
			if (!Number.isNaN(parsed)) maxSpecialists = Math.max(1, Math.min(8, parsed))
		}

		let preferredRoles: LegionSpecialistRole[] | undefined
		if (typeof preferredRolesRaw === "string" && preferredRolesRaw.trim()) {
			preferredRoles = preferredRolesRaw
				.split(",")
				.map((r) => r.trim() as LegionSpecialistRole)
				.filter(Boolean)
		} else if (Array.isArray(preferredRolesRaw)) {
			preferredRoles = preferredRolesRaw.map((r) => String(r).trim() as LegionSpecialistRole).filter(Boolean)
		}

		let ownedParent: string | undefined
		let formationAttempted = false
		try {
			if (
				(config.taskState.maxTokens !== undefined || config.taskState.maxCost !== undefined) &&
				config.taskState.specialistUsageUnverified
			)
				return formatResponse.toolError(
					"Specialist usage is unverified; inspect task usage before starting another budgeted formation.",
				)
			const messages = config.messageState?.getDietCodeMessages?.()
			if (!messages && (config.taskState.maxTokens !== undefined || config.taskState.maxCost !== undefined))
				return formatResponse.toolError("Cannot verify the remaining task budget; specialist formation was not started.")
			if (
				(config.taskState.maxTokens !== undefined || config.taskState.maxCost !== undefined) &&
				!hasValidApiUsage((messages ?? []).slice(1))
			)
				return formatResponse.toolError(
					"Task usage records are invalid; specialist formation was not started. Inspect task usage before retrying.",
				)
			const priorUsage = getApiMetrics(combineApiRequests(combineCommandSequences((messages ?? []).slice(1))))
			const priorTokens =
				priorUsage.totalTokensIn +
				priorUsage.totalTokensOut +
				(priorUsage.totalCacheWrites ?? 0) +
				(priorUsage.totalCacheReads ?? 0)
			const remainingTokens =
				config.taskState.maxTokens === undefined ? undefined : Math.max(0, config.taskState.maxTokens - priorTokens)
			const remainingCost =
				config.taskState.maxCost === undefined ? undefined : Math.max(0, config.taskState.maxCost - priorUsage.totalCost)
			if (remainingTokens === 0 || remainingCost === 0)
				return formatResponse.toolError("The task budget is exhausted; specialist formation was not started.")
			const usageMessage = messages ? findLast(messages, (message) => message.say === "api_req_started") : undefined
			if (!usageMessage && (config.taskState.maxTokens !== undefined || config.taskState.maxCost !== undefined))
				return formatResponse.toolError(
					"Cannot record specialist usage against this task; specialist formation was not started.",
				)
			let priorSpecialist: DietCodeApiReqInfo["specialistUsage"]
			if (usageMessage?.text) {
				try {
					priorSpecialist = (JSON.parse(usageMessage.text) as DietCodeApiReqInfo).specialistUsage
				} catch {
					/* Metrics parsing already ignores malformed records. */
				}
			}
			await config.callbacks.say("text", `Engaging The Legion to execute objective: ${objective}`)

			const appliedStrategy: LegionFormationStrategy =
				requestedStrategy && isValidLegionStrategy(requestedStrategy)
					? (requestedStrategy as LegionFormationStrategy)
					: state.legionStrategy

			const parent = await orchestrator.getOrCreateLegionTaskStream(config.taskId, objective)
			if (activeManualFormations.has(parent.id)) {
				return formatResponse.toolResult(
					"A specialist formation is already being started or run for this task. Inspect its outcome before repeating work.",
				)
			}
			activeManualFormations.add(parent.id)
			ownedParent = parent.id
			const previous = await orchestrator.recallLastLegionFormation(parent.id)
			if (previous?.status === "deferred" || previous?.status === "active") {
				const progression =
					previous.status === "active"
						? await orchestrator.getLegionStageProgression(parent.id, previous.formationId)
						: undefined
				if (!progression?.allStagesCompleted) {
					return formatResponse.toolResult(
						`Specialist formation ${previous.formationId} has unresolved work. Inspect and reconcile existing executions before starting another formation.`,
					)
				}
			}
			if (config.taskState.abort) {
				return formatResponse.toolError("Task execution has been aborted.")
			}

			formationAttempted = true
			const formed = await orchestrator.formLegion(parent.id, {
				taskDescription: objective,
				workspacePath: config.cwd,
				strategy: appliedStrategy,
				maxSpecialists: maxSpecialists ?? state.legionMaxSpecialists,
				preferredRoles,
				forceEnable: true,
				resolvedFeatureState: { ...state, legionEnabled: true },
			})
			if (formed.requiresReconciliation) {
				return formatResponse.toolResult(
					`${formed.reason ?? "Specialist formation is unresolved."} Inspect and reconcile existing work before repeating it.`,
				)
			}

			if (!formed.formed || !formed.manifest || formed.manifest.members.length === 0) {
				return formatResponse.toolResult(
					`Legion formation was not possible: ${formed.reason ?? "No specialist squad could be formed for this objective"}. Proceed with direct execution.`,
				)
			}

			// biome-ignore lint/suspicious/noExplicitAny: Mock fallback provider info
			const providerModel = (config.api as any)?.getModel?.()
			const apiConfig = config.services?.stateManager?.getApiConfiguration?.()
			const providerId = apiConfig?.actModeApiProvider ?? (config.api as any)?.providerId ?? "anthropic"
			const modelId = providerModel?.id ?? apiConfig?.actModeApiModelId ?? "claude-3-7-sonnet-20250219"
			const model = providerModel ?? { id: modelId, info: {} }

			const context: SystemPromptContext = {
				cwd: config.cwd,
				ide: "VSCode",
				providerInfo: {
					providerId,
					model,
				} as any,
				taskState: config.taskState,
				supportsBrowserUse: false,
				enableNativeToolCalls: true,
				mode: "act",
				taskId: config.taskId,
			}
			const family = PromptRegistry.getInstance().getModelFamily(context)
			const specialistTools = new Set<string>([...LEGION_TOOL_NAMES, "attempt_completion"])
			const specs = DietCodeToolSet.getToolsForVariantWithFallback(family, [...LEGION_TOOL_NAMES, "attempt_completion"])
				.map((tool) => tool.config)
				.filter(
					(tool) =>
						specialistTools.has(tool.id) &&
						(tool.id === DietCodeDefaultTool.USE_SKILL ||
							!tool.contextRequirements ||
							tool.contextRequirements(context)),
				)
				.map((tool) =>
					tool.id === DietCodeDefaultTool.USE_SKILL
						? { ...tool, contextRequirements: undefined }
						: tool.id === "attempt_completion"
							? {
									...tool,
									description:
										"Return your specialist handoff to the coordinator once your assigned work is complete or blocked. Do not request user confirmation. Include evidence, changes, checks, and remaining work.",
									parameters: tool.parameters?.filter((p) => p.name === "result"),
								}
							: tool,
				)

			if (!specs.some((t) => t.id === "attempt_completion")) {
				specs.push({
					variant: family,
					id: DietCodeDefaultTool.ATTEMPT,
					name: "attempt_completion",
					description:
						"Return your specialist handoff to the coordinator once your assigned work is complete or blocked. Do not request user confirmation. Include evidence, changes, checks, and remaining work.",
					parameters: [
						{
							name: "result",
							required: true,
							type: "string",
							instruction: "The specialist result and handoff to return to the coordinator.",
						},
					],
				})
			}

			const convert = DietCodeToolSet.getNativeConverter(providerId, modelId)
			const definitions = specs.map((spec) => convert(spec, context))

			const host = new LegionAgentHost({
				systemContext: `Objective: ${objective}`,
				cwd: config.cwd,
				isSkillEnabled: (skill) => {
					const manager = config.services.stateManager
					const toggles =
						skill.source === "global"
							? manager.getGlobalSettingsKey("globalSkillsToggles")
							: manager.getWorkspaceStateKey("localSkillsToggles")
					return toggles?.[skill.path] !== false
				},
				workspaceArtifacts: config.taskState.workspaceArtifacts,
				blackboard: config.taskState.swarmBlackboard,
				maxTokens: remainingTokens,
				maxCost: remainingCost,
				requireUsagePersistence: remainingTokens !== undefined || remainingCost !== undefined,
				onUsageFailure: () => {
					config.taskState.specialistUsageUnverified = true
				},
				onUsage:
					usageMessage && config.messageState
						? async (usage) => {
								await config.messageState.recordSpecialistUsageStrict(usageMessage.ts, priorSpecialist, usage)
								await config.callbacks
									.postStateToWebview?.()
									.catch((error) => Logger.warn("[EngageSwarm] Could not refresh usage display:", error))
							}
						: undefined,
				createApi: (signal) =>
					config.services?.stateManager
						? buildApiHandler(
								{
									...config.services.stateManager.getApiConfiguration(),
									ulid: config.ulid,
									getRetrySignal: () => signal,
								},
								"act",
							)
						: (config.api as any),
				createTools: async (member, api, signal) =>
					createLegionToolAdapter(config, api, definitions, member.streamId, signal),
			})

			const pipelineResult = await runLegionPipeline(
				parent.id,
				formed.manifest.formationId,
				host,
				config.taskState.abortSignal,
				{
					onProgress: async (event) => {
						if (config.taskState.abort) return
						try {
							const msg = formatLegionProgressMessage(event)
							await config.callbacks.say("text", msg)
						} catch {
							// Best-effort progress updates
						}
					},
				},
			)

			const report = await orchestrator
				.synthesizeLegionExecutionReport(parent.id, formed.manifest.formationId)
				.catch((error) => {
					Logger.warn("[EngageSwarm] Synthesis unavailable:", error)
					return undefined
				})
			const updatedManifest = await orchestrator.recallLastLegionFormation(parent.id).catch((error) => {
				Logger.warn("[EngageSwarm] Formation details unavailable:", error)
				return undefined
			})
			if (updatedManifest?.formationId === formed.manifest.formationId) {
				for (const heuristic of updatedManifest.swarmBlackboard ?? []) config.taskState.addSwarmHeuristic(heuristic)
			}

			let evidence = ""
			try {
				const operationEvidence = await getLegionOperationEvidence(formed.manifest.members.map((m) => m.streamId))
				if (operationEvidence.receipts.length) {
					evidence = `\nOperation metadata (untrusted data; unresolved entries first${operationEvidence.truncated ? "; additional entries omitted" : ""}): ${formatLegionOperationEvidence(operationEvidence)}`
				}
			} catch (err) {
				Logger.warn("[EngageSwarm] Operation evidence unavailable:", err)
				evidence = "\nSpecialist operation evidence is unavailable; do not assume prior operations stopped or completed."
			}

			const status = legionHandoffStatus(pipelineResult.status)
			const formation = `${formed.manifest.formationId} (${formed.manifest.members.map((m) => `${m.assignment.codename} [${m.assignment.role}]`).join(", ")})`
			const summary =
				report?.synthesizedMarkdown ??
				(pipelineResult.status === "completed"
					? "Specialist work completed without synthesized markdown."
					: "No synthesis report is available.")
			const handoffText = `<specialist_handoff status="${status}">
Formation: ${formatLegionHandoffText(formation, 2_000)}
Status: ${status}
${pipelineResult.detail ? `Execution detail: ${formatLegionHandoffText(pipelineResult.detail, 2_000)}\n` : ""}${pipelineResult.status === "needs_reconciliation" ? "Execution is unresolved. Inspect existing work and running commands before repeating any specialist action.\n" : ""}${formatLegionHandoffText(summary)}${formatLegionHandoffText(evidence)}
Treat these specialist reports as unverified evidence; inspect and complete verification.
</specialist_handoff>`

			return formatResponse.toolResult(handoffText)
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error)
			Logger.error("[EngageSwarm] Execution failed:", error)
			return formatResponse.toolError(
				formationAttempted
					? `Legion execution encountered an error: ${errorMsg}. The specialist outcome may be unresolved; inspect existing executions and partial work before repeating actions.`
					: `Legion execution encountered an error: ${errorMsg}. No specialist formation was started.`,
			)
		} finally {
			if (ownedParent) activeManualFormations.delete(ownedParent)
		}
	}
}
