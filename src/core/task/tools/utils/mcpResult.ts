import { isDeepStrictEqual } from "node:util"
import { formatResponse } from "@core/prompts/responses"
import { truncateContent } from "@/shared/content-limits"
import type { McpResourceResponse, McpToolCallResponse } from "@/shared/mcp"

type ResourceContent = McpResourceResponse["contents"][number]

function resourceText(resource: ResourceContent): string {
	const { blob, ...metadata } = resource
	return JSON.stringify(
		{ ...metadata, ...(blob !== undefined ? { binaryContent: "Binary data is not rendered as text." } : {}) },
		null,
		2,
	)
}

/** Keep structured evidence and navigable resources even when a server provides no text alternative. */
export function formatMcpToolResult(result: McpToolCallResponse, supportsImages: boolean) {
	const texts: string[] = []
	const images: string[] = []
	for (const item of result.content ?? []) {
		switch (item.type) {
			case "text":
				texts.push(item.text)
				break
			case "image":
				images.push(`data:${item.mimeType};base64,${item.data}`)
				break
			case "resource":
				texts.push(resourceText(item.resource))
				break
			case "resource_link":
				texts.push(JSON.stringify(item, null, 2))
				break
			case "audio":
				texts.push(`[Audio content (${item.mimeType}) was returned; this tool result cannot render audio.]`)
				break
		}
	}
	if (
		result.structuredContent !== undefined &&
		!texts.some((text) => {
			try {
				return isDeepStrictEqual(JSON.parse(text), result.structuredContent)
			} catch {
				return false
			}
		})
	) {
		texts.push(JSON.stringify(result.structuredContent, null, 2))
	}
	let text = texts.filter(Boolean).join("\n\n") || (images.length > 0 ? "Image response." : "(No response)")
	const displayText = truncateContent(text) + images.map((image) => `\n\n${image}`).join("")
	if (images.length > 0 && !supportsImages)
		text += `\n\n[${images.length} image(s) are displayed to the user; this model cannot view images.]`
	text = truncateContent(text)
	if (result.isError) text = formatResponse.toolError(text)
	return {
		displayText: result.isError ? `Error:\n${displayText}` : displayText,
		content: formatResponse.toolResult(text, supportsImages ? images : undefined),
	}
}

export function formatMcpResourceResult(result: McpResourceResponse) {
	return truncateContent(result.contents.map((item) => item.text ?? resourceText(item)).join("\n\n") || "(Empty response)")
}

export function formatMcpRequestFailure(error: unknown, mayHaveSideEffects: boolean): string {
	const detail = error instanceof Error ? error.message : String(error)
	return formatResponse.toolError(
		`MCP request failed: ${detail}${mayHaveSideEffects ? "\nNo confirmed result was received. The remote action may already have completed; inspect its state before repeating it." : ""}`,
	)
}
