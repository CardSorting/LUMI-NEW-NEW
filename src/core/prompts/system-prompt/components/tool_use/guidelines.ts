import { TemplateEngine } from "../../templates/TemplateEngine"
import type { PromptVariant, SystemPromptContext } from "../../types"

export const TOOL_USE_GUIDELINES_TEMPLATE_TEXT = `# Tool Use Guidelines

1. In <thinking> tags, assess what information you already have and what information you need to proceed with the task.
2. Choose the most appropriate tool based on the task and the tool descriptions provided. Assess if you need additional information to proceed, and which of the available tools would be most effective for gathering this information. For example using the list_files tool is more effective than running a command like \`ls\` in the terminal. It's critical that you think about each available tool and use the one that best fits the current step in the task.
3. Follow the tool-call mode described above. Batch independent reads or searches when multiple calls are enabled. Sequence dependent operations, shared-file edits, browser actions, and commands that require earlier results.
4. Formulate your tool use using the format specified for each tool.
5. Inspect every returned tool result, including failures, diagnostics, and new output. Never assume that a call succeeded.
6. A successful tool result is sufficient confirmation to continue authorized work. Do not request redundant user confirmation. Respect approval decisions and ask only for missing information or authority needed for the next action.
7. Run relevant verification once and reuse passing results for unchanged code. If a check fails, fix its cause before retrying; report unavailable checks honestly.`

export async function getToolUseGuidelinesSection(_variant: PromptVariant, context: SystemPromptContext): Promise<string> {
	return new TemplateEngine().resolve(TOOL_USE_GUIDELINES_TEMPLATE_TEXT, context, {})
}
