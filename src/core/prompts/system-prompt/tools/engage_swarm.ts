import { ModelFamily } from "@/shared/prompts"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { DietCodeToolSpec } from "../spec"
import type { SystemPromptContext } from "../types"

const id = DietCodeDefaultTool.ENGAGE_SWARM

const generic: DietCodeToolSpec = {
	variant: ModelFamily.GENERIC,
	id,
	name: "engage_swarm",
	description:
		"Engage The Legion / Agent Swarm to form and operate a specialized multi-agent team (architect, implementer, verifier, hardener, ux, researcher, data steward) for an objective, test suite, or implementation milestone. Specialists execute in dependency-ordered stages and synthesize an evidence-backed handoff report.",
	contextRequirements: (context: SystemPromptContext) => {
		if (context.isTesting) return false
		try {
			const { resolveEffectiveAgentSwarmState } = require("@/infrastructure/ai/AgentSwarmConfig")
			const taskId = (context as any)?.taskId || (context as any)?.taskState?.taskId
			const state = resolveEffectiveAgentSwarmState(taskId ? { taskId } : undefined)
			return state.legionEnabled || state.enabled
		} catch {
			return true
		}
	},
	parameters: [
		{
			name: "objective",
			required: true,
			type: "string",
			instruction: "The specific objective or task description for the specialist swarm to execute.",
			usage: "Run the full test suite and fix failing assertions in test project",
		},
		{
			name: "strategy",
			required: false,
			type: "string",
			instruction:
				"Optional formation strategy. One of: 'adaptive' | 'tactical_strike' | 'balanced_squad' | 'full_legion' | 'verification_heavy'. Defaults to 'adaptive'.",
			usage: "verification_heavy",
		},
		{
			name: "preferred_roles",
			required: false,
			type: "string",
			instruction:
				"Optional comma-separated list of specialist roles to prioritize (e.g. 'legion_implementer,legion_verifier').",
			usage: "legion_implementer,legion_verifier",
		},
		{
			name: "max_specialists",
			required: false,
			type: "integer",
			instruction: "Maximum number of specialists to spawn (1 to 8).",
			usage: "3",
		},
	],
}

export const engage_swarm_variants = [generic]
