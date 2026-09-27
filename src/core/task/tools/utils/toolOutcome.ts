/** Recognize harness failures without mistaking error text inside a file or command log for a failed tool. */
export function isToolFailure(result: unknown): boolean {
	const text =
		typeof result === "string" ? result : Array.isArray(result) && result[0]?.type === "text" ? result[0].text : undefined
	return (
		typeof text === "string" &&
		(text.startsWith("The tool execution failed:") ||
			text.startsWith("The user denied this operation.") ||
			text.startsWith("Workspace policy blocked this change"))
	)
}
