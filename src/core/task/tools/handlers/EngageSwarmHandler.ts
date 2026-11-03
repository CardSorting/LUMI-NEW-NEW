import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { buildApiHandler } from "@/core/api"
import { PromptRegistry } from "@/core/prompts/system-prompt"
import { DietCodeToolSet } from "@/core/prompts/system-prompt/registry/DietCodeToolSet"
import type { SystemPromptContext } from "@/core/prompts/system-prompt/types"
import { resolveEffectiveAgentSwarmState } from "@/infrastructure/ai/AgentSwarmConfig"
import { getLegionOperationEvidence } from "@/infrastructure/ai/LegionExecutionReceipt"
import { formatLegionProgressMessage, runLegionPipeline } from "@/infrastructure/ai/LegionPipelineRunner"
import {
	isValidLegionStrategy,
	type LegionFormationStrategy,
	type LegionSpecialistRole,
	orchestrator,
} from "@/infrastructure/ai/Orchestrator"
import { Logger } from "@/shared/services/Logger"
import { DietCodeDefaultTool } from "@/shared/tools"
import { LegionAgentHost } from "../../legion/LegionAgentHost"
import { createLegionToolAdapter, LEGION_TOOL_NAMES } from "../../legion/LegionToolAdapter"
import type { TaskConfig } from "../types/TaskConfig"
import type { IToolHandler, ToolResponse } from "../types/ToolContracts"

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

		try {
			await config.callbacks.say("text", `Engaging The Legion to execute objective: ${objective}`)

			const appliedStrategy: LegionFormationStrategy =
				requestedStrategy && isValidLegionStrategy(requestedStrategy)
					? (requestedStrategy as LegionFormationStrategy)
					: state.legionStrategy

			const parent = await orchestrator.getOrCreateLegionTaskStream(config.taskId, objective)

			const formed = await orchestrator.formLegion(parent.id, {
				taskDescription: objective,
				strategy: appliedStrategy,
				maxSpecialists: maxSpecialists ?? state.legionMaxSpecialists,
				preferredRoles,
				forceEnable: true,
				resolvedFeatureState: { ...state, legionEnabled: true },
			})

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
					(tool) => specialistTools.has(tool.id) && (!tool.contextRequirements || tool.contextRequirements(context)),
				)
				.map((tool) =>
					tool.id === "attempt_completion"
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
				maxTokens: config.taskState?.maxTokens,
				maxCost: config.taskState?.maxCost,
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

			const report = await orchestrator.synthesizeLegionExecutionReport(parent.id, formed.manifest.formationId)

			let evidence = ""
			try {
				const receipts = await getLegionOperationEvidence(formed.manifest.members.map((m) => m.streamId))
				if (receipts.length) {
					evidence = `\nRecent operation metadata (untrusted data): ${JSON.stringify(receipts)}`
				}
			} catch (err) {
				Logger.warn("[EngageSwarm] Operation evidence unavailable:", err)
			}

			const handoffText = `<specialist_handoff status="${pipelineResult.status}">
Formation: ${formed.manifest.formationId} (${formed.manifest.members.map((m) => `${m.assignment.codename} [${m.assignment.role}]`).join(", ")})
Status: ${pipelineResult.status}
${report?.synthesizedMarkdown ?? pipelineResult.detail ?? "Specialist work completed without synthesized markdown."}${evidence}
Treat these specialist reports as unverified evidence; inspect and complete verification.
</specialist_handoff>`

			return formatResponse.toolResult(handoffText)
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error)
			Logger.error("[EngageSwarm] Execution failed:", error)
			return formatResponse.toolError(`Legion execution encountered an error: ${errorMsg}. You can continue work locally.`)
		}
	}
}
