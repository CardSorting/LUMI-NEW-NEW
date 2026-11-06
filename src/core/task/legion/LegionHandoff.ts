/** Escape untrusted report text and cap its encoded size before putting it in a handoff. */
export function formatLegionHandoffText(text: string, maxBytes = 12_000): string {
	const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
	const marker = "\n[Report truncated; inspect the original specialist results.]"
	const candidate = text.slice(0, maxBytes)
	const encoded = escape(candidate)
	if (candidate.length === text.length && Buffer.byteLength(encoded, "utf8") <= maxBytes) return encoded
	let low = 0
	let high = candidate.length
	while (low < high) {
		const middle = Math.ceil((low + high) / 2)
		if (Buffer.byteLength(escape(candidate.slice(0, middle)) + marker, "utf8") <= maxBytes) low = middle
		else high = middle - 1
	}
	// Do not split a surrogate pair when clipping UTF-16 text.
	if (low && /[\uD800-\uDBFF]/.test(candidate[low - 1])) low--
	return escape(candidate.slice(0, low)) + marker
}

export function legionHandoffStatus(status: string): string {
	return /^[a-z_]{1,40}$/.test(status) ? status : "unknown"
}
