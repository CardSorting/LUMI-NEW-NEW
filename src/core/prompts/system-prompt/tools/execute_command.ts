import { ModelFamily } from "@/shared/prompts"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { DietCodeToolSpec, DietCodeToolSpecParameter } from "../spec"

const approvalParameter: DietCodeToolSpecParameter = {
	name: "requires_approval",
	required: false,
	type: "boolean",
	instruction:
		"Optional risk hint: true for commands that may have destructive or external effects, false for routine reads, builds, and tests. Configured authority, saved trust, and command policy determine approval. Submit the tool call directly; do not ask for approval separately in text.",
	usage: "true or false",
}
const timeoutParameter: DietCodeToolSpecParameter = {
	name: "timeout",
	required: false,
	type: "number",
	instruction:
		"Positive seconds to wait in the foreground. This does not kill the command. If it is still running, inspect the existing terminal output or continue independent work; do not launch a duplicate. Automatically approved commands use a managed wait when omitted.",
	usage: "30",
}

const GENERIC: DietCodeToolSpec = {
	variant: ModelFamily.GENERIC,
	id: DietCodeDefaultTool.BASH,
	name: "execute_command",
	description: `Request to execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user's task. You must tailor your command to the user's system and provide a clear explanation of what the command does. For command chaining, use the appropriate chaining syntax for the user's shell. Prefer to execute complex CLI commands over creating executable scripts, as they are more flexible and easier to run. Commands will be executed in the current working directory: {{CWD}}{{MULTI_ROOT_HINT}}`,
	parameters: [
		{
			name: "command",
			required: true,
			instruction: `The CLI command to execute. This should be valid for the current operating system. Ensure the command is properly formatted and does not contain any harmful instructions.`,
			usage: "Your command here",
		},
		approvalParameter,
		timeoutParameter,
	],
}

const NATIVE_GPT_5: DietCodeToolSpec = {
	variant: ModelFamily.NATIVE_GPT_5,
	id: DietCodeDefaultTool.BASH,
	name: DietCodeDefaultTool.BASH,
	description:
		"Request to execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user's task.",
	parameters: [
		{
			name: "command",
			required: true,
			instruction:
				"The CLI command to execute. This should be valid for the current operating system. Do not use the ~ character or $HOME to refer to the home directory. Always use absolute paths. The command will be executed from the current workspace, you do not need to cd to the workspace.",
		},
		approvalParameter,
		timeoutParameter,
	],
}

const NATIVE_NEXT_GEN: DietCodeToolSpec = {
	...NATIVE_GPT_5,
	variant: ModelFamily.NATIVE_NEXT_GEN,
}

const GEMINI_3: DietCodeToolSpec = {
	variant: ModelFamily.GEMINI_3,
	id: DietCodeDefaultTool.BASH,
	name: DietCodeDefaultTool.BASH,
	description:
		"Request to execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user's task. When chaining commands, use the shell operator && (not the HTML entity &amp;&amp;). If using search/grep commands, be careful to not use vague search terms that may return thousands of results. When in PLAN MODE, you may use the execute_command tool, but only in a non-destructive manner and in a way that does not alter any files.",
	parameters: [
		{
			name: "command",
			required: true,
			instruction:
				"The CLI command to execute. This should be valid for the current operating system. For command chaining, use proper shell operators like && to chain commands (e.g., 'cd path && command'). Do not use the ~ character or $HOME to refer to the home directory. Always use absolute paths. Do not run search/grep commands that may return thousands of results.",
		},
		approvalParameter,
		timeoutParameter,
	],
}

export const execute_command_variants: DietCodeToolSpec[] = [GENERIC, NATIVE_GPT_5, NATIVE_NEXT_GEN, GEMINI_3]
