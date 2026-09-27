/**
 * [LAYER: CORE]
 */
import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { applyWorkspaceAuditPolicy, resolveCompletionGateOptions } from "@shared/audit/auditGatePolicyLoader"
import { parsePartialArrayString } from "@/shared/array"
import { runCompletionAudit } from "@/shared/audit/completionAudit"
import { DietCodePlanModeResponse, type TaskAuditMetadata } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { TaskConfig } from "../types/TaskConfig"
import type { IPartialBlockHandler, IToolHandler, ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { getInitialTaskPreview } from "../utils/taskPreview"

const serializePlanPayload = (response: string, options: string[] = []): string =>
	JSON.stringify({ response, options } satisfies DietCodePlanModeResponse)

export class PlanModeRespondHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = DietCodeDefaultTool.PLAN_MODE

	getDescription(block: ToolUse): string {
		return `[${block.name}]`
	}

	/**
	 * Stream plan content as a non-blocking assistant update.
	 */
	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const response = uiHelpers.removeClosingTag(block, "response", block.params.response)
		const optionsRaw = uiHelpers.removeClosingTag(block, "options", block.params.options)
		const payload = serializePlanPayload(response, parsePartialArrayString(optionsRaw))

		await uiHelpers.say("plan_summary", payload, undefined, undefined, true).catch(() => {})
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const response: string | undefined = block.params.response
		const optionsRaw: string | undefined = block.params.options
		const taskProgress: string | undefined = block.params.task_progress
		const needsMoreExploration: boolean = block.params.needs_more_exploration === "true"

		if (!response?.trim()) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "response")
		}

		config.taskState.consecutiveMistakeCount = 0

		if (needsMoreExploration) {
			await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "plan_summary")
			config.taskState.currentTurnExplorationCount++

			if (config.taskState.currentTurnExplorationCount > 3) {
				return formatResponse.toolResult(
					`Exploration has repeated without a plan. Use the evidence already gathered to present an actionable plan. If a specific missing fact prevents action, investigate that fact once or describe the blocker; do not repeat this exploration request.`,
				)
			}

			return formatResponse.toolResult(
				`[You have indicated that you need more exploration. Use a tool to resolve the specific missing fact, then present the plan. Do not request permission for routine investigation.]`,
			)
		}

		if (config.mode === "act") {
			await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "plan_summary")
			await config.callbacks.say("text", response, undefined, undefined, false)
			return formatResponse.toolResult(`[Proceed with the task.]`)
		}

		const options = parsePartialArrayString(optionsRaw || "[]")
		const payload = serializePlanPayload(response, options)

		let planAuditMetadata: TaskAuditMetadata | undefined
		const gateOptions = await resolveCompletionGateOptions(config, config.cwd)
		if (gateOptions.gateEnabled && gateOptions.planRegressionGateEnabled) {
			try {
				const taskPreview = getInitialTaskPreview(config) || "plan mode response"
				planAuditMetadata = await runCompletionAudit(config.taskId, taskPreview, response, taskPreview)
				planAuditMetadata = await applyWorkspaceAuditPolicy(config.cwd, planAuditMetadata, config)
			} catch (error) {
				Logger.warn("[PlanModeRespondHandler] Plan audit metadata generation failed:", error)
			}
		}

		await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "plan_summary")
		await config.callbacks.say("plan_summary", payload, undefined, undefined, false, planAuditMetadata)

		if (taskProgress) {
			await config.callbacks.updateFCListFromToolResponse(taskProgress)
		}

		const switchSuccessful = await config.callbacks.switchToActMode()
		if (!switchSuccessful) {
			Logger.warn("[PlanModeRespondHandler] Failed to auto-switch to ACT MODE after plan presentation")
			return formatResponse.toolResult(
				`[Your plan was presented, but automatic transition to ACT MODE failed. Continue independent read-only work and report the mode transition problem once. Do not repeat this tool call to request the same transition.]`,
			)
		}

		config.taskState.didRespondToPlanAskBySwitchingMode = true

		config.taskState.currentTurnExplorationCount = 0
		return formatResponse.toolResult("[Planning complete. Proceed with implementing the plan in ACT MODE.]")
	}
}
