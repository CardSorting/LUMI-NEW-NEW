import { parse } from "shell-quote"

/** Reuse explicit command trust without extending it to untrusted shell operations. */
export function matchesTrustedCommand(command: string, trustedCommands: readonly string[]): boolean {
	const normalized = command.trim()
	if (!normalized) return false
	// An explicitly trusted full command can include shell syntax.
	if (trustedCommands.some((trusted) => trusted.trim() === normalized)) return true
	// Prefix grants apply to literal arguments, not expansions, redirections, or subshells.
	if (/[`$\r\n]|%[^%]+%|![^!]+!/.test(normalized)) return false
	try {
		const segments: string[][] = [[]]
		for (const token of parse(normalized)) {
			if (typeof token === "string") {
				segments[segments.length - 1].push(token)
			} else if ("op" in token && ["&&", "||", ";", "|"].includes(token.op)) {
				if (!segments[segments.length - 1].length) return false
				segments.push([])
			} else {
				return false
			}
		}
		return segments.every(
			(segment) =>
				segment.length > 0 &&
				trustedCommands.some((trusted) => {
					const rule = trusted.trim()
					const isPrefix = rule.endsWith("*")
					const prefix = isPrefix ? rule.slice(0, -1).trimEnd() : rule
					if (!prefix || /[`$\r\n]/.test(prefix)) return false
					const args = parse(prefix)
					if (!args.length || !args.every((arg) => typeof arg === "string")) return false
					// A bare executable grants its arguments; multiword rules require an exact match or explicit *.
					if (!isPrefix && args.length > 1 && args.length !== segment.length) return false
					return args.every((arg, index) => arg === segment[index])
				}),
		)
	} catch {
		return false
	}
}
