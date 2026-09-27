import { ModelFamily } from "@/shared/prompts"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { DietCodeToolSpec } from "../spec"

export const read_command_output_variants: DietCodeToolSpec[] = [
	{
		variant: ModelFamily.GENERIC,
		id: DietCodeDefaultTool.READ_COMMAND_OUTPUT,
		name: DietCodeDefaultTool.READ_COMMAND_OUTPUT,
		description:
			"Read bounded output and authoritative status for an existing execute_command execution in this task. Never starts, restarts, or stops a command. Use its execution_id after a foreground timeout instead of running the command again. Completed receipts remain available for the latest 64 runs in this session. Exit code 0 confirms success; unknown or missing exit codes do not. After unchanged output, do independent work or diagnose the blocker; do not poll indefinitely.",
		parameters: [
			{
				name: "execution_id",
				required: true,
				instruction: "The execution ID returned by execute_command. This is not a terminal ID.",
				usage: "execution ID",
			},
			{
				name: "timeout",
				required: false,
				type: "number",
				instruction:
					"Seconds to wait once for completion. Default 5, maximum 30; use 0 for an immediate snapshot. Cancelling this read does not stop the command.",
				usage: "5",
			},
		],
	},
]
