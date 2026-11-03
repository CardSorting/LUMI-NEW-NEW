import { SystemPromptSection } from "../templates/placeholders"
import { TemplateEngine } from "../templates/TemplateEngine"
import type { PromptVariant, SystemPromptContext } from "../types"

const getActVsPlanModeTemplateText = () => `ACT MODE V.S. PLAN MODE

Read the current mode from environment_details. Do not assume a new task starts in PLAN MODE. The system manages mode transitions automatically; do not ask the user to switch modes.

- ACT MODE: Use available tools to implement the requested outcome, inspect results, repair failures, and run relevant verification. Proceed directly when the next action is clear; a preliminary plan is not required. The plan_mode_respond tool is unavailable. When the requested work and verification are complete, use attempt_completion.
- PLAN MODE: Use read-only tools for bounded inspection of the requirements and relevant code. Use project_map when it helps locate the work, then verify useful findings with targeted reads or searches. Once you have enough context to choose an approach, present a concise, actionable plan with plan_mode_respond. A finalized plan automatically transitions the system to ACT MODE; continue with implementation.

Keep planning proportional to the task. Resolve routine choices yourself and stop exploring when further inspection would not change the approach. If the user changes scope, adapt the work and follow the mode currently reported by the environment.`

export async function getActVsPlanModeSection(variant: PromptVariant, context: SystemPromptContext): Promise<string> {
	const template = variant.componentOverrides?.[SystemPromptSection.ACT_VS_PLAN]?.template || getActVsPlanModeTemplateText

	let content = new TemplateEngine().resolve(template, context, {})
	if (!context.isTesting) {
		try {
			const { resolveEffectiveAgentSwarmState } = require("@/infrastructure/ai/AgentSwarmConfig")
			const taskId = context.taskId || context.taskState?.taskId
			const state = resolveEffectiveAgentSwarmState(taskId ? { taskId } : undefined)
			if (state.legionEnabled || state.enabled) {
				content += `\n- AGENT SWARM & THE LEGION: In PLAN MODE, map out which specialist roles (architect, implementer, verifier, hardener) will handle each milestone. After finalizing your plan with plan_mode_respond, you transition to ACT MODE where you can engage the specialist swarm via engage_swarm or oversee stage progression.`
			}
		} catch {
			// Ignore if unavailable
		}
	}
	return content
}
