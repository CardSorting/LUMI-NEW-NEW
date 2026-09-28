import { parseAssistantMessageV2 } from "@core/assistant-message"
import { SUBAGENT_MESSAGE_LIMIT } from "@shared/subagents"
import { DietCodeDefaultTool } from "@shared/tools"

/** Summarize the operation using its target, never its file contents or MCP arguments. */
export function describeSubagentTool(name: string, params: Partial<Record<string, string>>): string {
	let label: string
	switch (name) {
		case DietCodeDefaultTool.FILE_READ:
			label = `Reading ${params.path || "file"}`
			break
		case DietCodeDefaultTool.FILE_NEW:
			label = `Writing ${params.path || "file"}`
			break
		case DietCodeDefaultTool.FILE_EDIT:
			label = `Editing ${params.path || "file"}`
			break
		case DietCodeDefaultTool.APPLY_PATCH: {
			const file = params.input?.match(/^\*\*\* (?:Add File|Update File|Delete File):\s*(.+)$/m)?.[1]
			label = file ? `Applying changes to ${file}` : "Applying file changes"
			break
		}
		case DietCodeDefaultTool.BASH:
			label = params.command ? `Running ${params.command}` : "Running command"
			break
		case DietCodeDefaultTool.READ_COMMAND_OUTPUT:
			label = "Checking command output"
			break
		case DietCodeDefaultTool.GET_EXECUTION_STATE:
			label = "Checking running work"
			break
		case DietCodeDefaultTool.LIST_FILES:
			label = `Listing files in ${params.path || "workspace"}`
			break
		case DietCodeDefaultTool.SEARCH:
			label = `Searching ${params.path || "workspace"}${params.regex ? ` for ${params.regex}` : ""}`
			break
		case DietCodeDefaultTool.LIST_CODE_DEF:
			label = `Reading definitions in ${params.path || "workspace"}`
			break
		case DietCodeDefaultTool.WEB_FETCH:
			label = `Fetching ${params.url || "web page"}`
			break
		case DietCodeDefaultTool.WEB_SEARCH:
			label = params.query ? `Searching the web for ${params.query}` : "Searching the web"
			break
		case DietCodeDefaultTool.MCP_USE:
			label = `Using ${params.server_name || "MCP"}${params.tool_name ? ` / ${params.tool_name}` : " tool"}`
			break
		default:
			label = `Running ${name}`
	}
	const normalized = label.replace(/\s+/g, " ").trim()
	return normalized.length > 300 ? `${normalized.slice(0, 299)}…` : normalized
}

/** Only public text is progress. Keep XML tool payloads and reasoning out of the preview. */
export function subagentMessagePreview(text: string): string {
	const publicText = text.replace(/<(thinking|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
	const message = parseAssistantMessageV2(publicText)
		.flatMap((block) => (block.type === "text" ? [block.content] : []))
		.join("\n")
		.replace(/<[^>]*$/, "")
		.trim()
	return message.length > SUBAGENT_MESSAGE_LIMIT ? `${message.slice(0, SUBAGENT_MESSAGE_LIMIT - 1)}…` : message
}
