import { hasEnabledMcpServers } from "../../components/mcp"
import { SystemPromptSection } from "../../templates/placeholders"
import type { SystemPromptContext } from "../../types"

/**
 * Base template for GPT-5 variant with structured sections
 */
export const BASE = `{{${SystemPromptSection.AGENT_ROLE}}}
{{${SystemPromptSection.JOY_ZONING}}}
{{${SystemPromptSection.ROADMAP_STEERING}}}
{{${SystemPromptSection.INTEGRITY_WIKI}}}
{{${SystemPromptSection.FORENSIC_TOOLS}}}

{{${SystemPromptSection.TOOL_USE}}}

====

{{${SystemPromptSection.TODO}}}

====

{{${SystemPromptSection.TASK_PROGRESS}}}

====

{{${SystemPromptSection.EDITING_FILES}}}

====

{{${SystemPromptSection.ACT_VS_PLAN}}}

====

{{${SystemPromptSection.CAPABILITIES}}}

====

{{${SystemPromptSection.SKILLS}}}

====

{{${SystemPromptSection.FEEDBACK}}}

====

{{${SystemPromptSection.RULES}}}

====

{{${SystemPromptSection.SYSTEM_INFO}}}

====

{{${SystemPromptSection.OBJECTIVE}}}

====

{{${SystemPromptSection.USER_INSTRUCTIONS}}}`

const RULES = (context: SystemPromptContext) => {
	const hasMcpServers = hasEnabledMcpServers(context)

	return `RULES

- The current working directory is \`{{CWD}}\` - this is the directory where all the tools will be executed from.${
		context.enableParallelToolCalling
			? `
- You may use multiple tools in a single response when the operations are independent (e.g., reading several files, creating independent files). For dependent operations where one result informs the next, use tools sequentially and inspect the tool result before continuing.`
			: ""
	}{{BROWSER_WAIT_RULES}}${hasMcpServers ? "\n- Apply the same dependency and approval rules to MCP tools: inspect results and continue authorized work without extra confirmation." : ""}`
}

const TOOL_USE = (context: SystemPromptContext) => `TOOL USE

Tools follow the user's configured approval policy.${context.enableParallelToolCalling ? " You may use multiple tools in a single response when the operations are independent (e.g., reading several files, searching in parallel). For dependent operations where one result informs the next, use tools sequentially." : ""} Tool results arrive automatically; they do not require an additional user message confirming success.`

const FEEDBACK = (_context: SystemPromptContext) => `FEEDBACK

When user is providing you with feedback on how you could improve, you can let the user know to report new issue using the '/reportbug' slash command.`

export const TEMPLATE_OVERRIDES = {
	BASE,
	RULES,
	TOOL_USE,
	FEEDBACK,
} as const
