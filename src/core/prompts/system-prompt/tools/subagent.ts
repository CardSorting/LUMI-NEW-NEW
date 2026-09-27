import { ModelFamily } from "@/shared/prompts"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { DietCodeToolSpec } from "../spec"

const id = DietCodeDefaultTool.USE_SUBAGENTS

const generic: DietCodeToolSpec = {
	variant: ModelFamily.GENERIC,
	id,
	name: "use_subagents",
	description:
		"Run up to five focused in-process subagents in parallel for independent investigation, implementation, debugging, or verification. Each helper can use its exposed tools to read and edit files, execute commands, and check results within the assigned scope and configured permissions. Give each helper a concrete deliverable and useful context. Use one or more helpers when delegation materially accelerates the task; reconcile their evidence and continue execution without peer-approval ceremonies.",
	contextRequirements: (context) => context.subagentsEnabled === true && !context.isSubagentRun,
	parameters: [
		{
			name: "prompt_1",
			required: true,
			instruction: "First subagent prompt.",
		},
		{
			name: "prompt_2",
			required: false,
			instruction: "Optional second subagent prompt.",
		},
		{
			name: "prompt_3",
			required: false,
			instruction: "Optional third subagent prompt.",
		},
		{
			name: "prompt_4",
			required: false,
			instruction: "Optional fourth subagent prompt.",
		},
		{
			name: "prompt_5",
			required: false,
			instruction: "Optional fifth subagent prompt.",
		},
	],
}

export const subagent_variants = [generic]
