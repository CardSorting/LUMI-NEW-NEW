import { ModelFamily } from "@/shared/prompts"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { DietCodeToolSpec } from "../spec"

export const get_execution_state_variants: DietCodeToolSpec[] = [
	{
		variant: ModelFamily.GENERIC,
		id: DietCodeDefaultTool.GET_EXECUTION_STATE,
		name: DietCodeDefaultTool.GET_EXECUTION_STATE,
		description:
			"Inspect tracked work shared by this task's parent and helpers: commands, action input previews, attempt limits, queue capacity and occupants, current approval settings, and recent results. Returns immediately and never starts or cancels work. Accepts either a command or action execution_id, including IDs from duplicate-action errors. Use read_command_output with the command's execution_id for full command output. Missing or unavailable observation does not prove no work is running. Caller cancellation or timeout does not prove an action stopped; awaiting_completion means its underlying operation is unresolved. Do independent work between checks; inventory polling is not task progress.",
		parameters: [
			{
				name: "execution_id",
				required: false,
				instruction:
					"Omit for the shared inventory and queue state. Provide a command or action execution ID to inspect that same operation, including retained results older than the recent summary. Helper receipts include structured helper_handoff with committed paths and pending command IDs, including late results after a batch stops waiting. Command results include their read_command_output handle. After a host restart, historical receipts have recovery.authority=none: inspect their evidence without assuming a live owner or replaying unfinished work. Recovery issues are reported explicitly. Expired or other-task IDs are rejected.",
				usage: "command or action execution ID (optional)",
			},
		],
	},
]
