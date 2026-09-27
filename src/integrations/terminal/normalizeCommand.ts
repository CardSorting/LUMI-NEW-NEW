const SHELL_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">" }

function shellCharacter(command: string, index: number): { value: string; length: number } {
	const entity = command[index] === "&" ? /^&(?:amp;)*(amp|lt|gt);/.exec(command.slice(index)) : null
	return entity ? { value: SHELL_ENTITIES[entity[1]], length: entity[0].length } : { value: command[index], length: 1 }
}

interface HereDocument {
	delimiter: string
	stripTabs: boolean
}

function hereDocument(command: string, start: number): (HereDocument & { end: number }) | undefined {
	let end = start
	const stripTabs = command[end] === "-"
	if (stripTabs) end++
	while (command[end] === " " || command[end] === "\t") end++
	const wordStart = end
	let delimiter = ""
	let quote: string | undefined
	for (; end < command.length; end++) {
		const char = command[end]
		if (!quote && /[\s;&|<>()]/.test(char)) break
		if (char === "\\" && quote !== "'" && end + 1 < command.length) {
			delimiter += command[++end]
		} else if (char === quote) {
			quote = undefined
		} else if (!quote && (char === "'" || char === '"')) {
			quote = char
		} else {
			delimiter += char
		}
	}
	return end > wordStart && !quote ? { delimiter, stripTabs, end } : undefined
}

/** Expansions have their own quoting rules; preserve their contents as supplied. */
function expansionEnd(command: string, start: number): number {
	const opening = command[start + 1]
	const closing = opening === "(" ? ")" : "}"
	let depth = 1
	let quote: string | undefined
	for (let index = start + 2; index < command.length; index++) {
		const char = command[index]
		if (char === "\\" && quote !== "'") {
			index++
		} else if (quote !== "'" && char === "$" && (command[index + 1] === "(" || command[index + 1] === "{")) {
			index = expansionEnd(command, index) - 1
		} else if (quote) {
			if (char === quote) quote = undefined
		} else if (char === "'" || char === '"' || char === "`") {
			quote = char
		} else if (char === opening) {
			depth++
		} else if (char === closing && --depth === 0) {
			return index + 1
		}
	}
	return command.length
}

/**
 * Repair model-escaped shell operators before validation and approval for every provider.
 * Preserve quoted arguments, escapes, comments, expansions, and heredoc bodies.
 * Do not run general HTML decoding or spelling corrections over commands and scripts.
 */
export function normalizeShellCommand(command: string): string {
	let result = ""
	let quote: string | undefined
	const documents: HereDocument[] = []
	for (let index = 0; index < command.length; ) {
		const char = command[index]
		if (char === "\\" && quote !== "'") {
			result += command.slice(index, index + 2)
			index += 2
			continue
		}
		if (quote !== "'" && char === "$" && (command[index + 1] === "(" || command[index + 1] === "{")) {
			const end = expansionEnd(command, index)
			result += command.slice(index, end)
			index = end
			continue
		}
		if (quote) {
			if (char === quote) quote = undefined
			result += char
			index++
			continue
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char
			result += char
			index++
			continue
		}
		if (char === "#" && (!result || /[\s;&|()<>]/.test(result.at(-1) ?? ""))) {
			const end = command.indexOf("\n", index)
			if (end < 0) return result + command.slice(index)
			result += command.slice(index, end)
			index = end
			continue
		}
		if (char === "\n") {
			result += char
			index++
			for (const document of documents.splice(0)) {
				while (index < command.length) {
					const end = command.indexOf("\n", index)
					const lineEnd = end < 0 ? command.length : end
					const line = command.slice(index, lineEnd)
					const next = end < 0 ? lineEnd : end + 1
					result += command.slice(index, next)
					index = next
					if ((document.stripTabs ? line.replace(/^\t+/, "") : line) === document.delimiter) break
				}
			}
			continue
		}
		const current = shellCharacter(command, index)
		if (current.value === "<") {
			const next = shellCharacter(command, index + current.length)
			if (next.value === "<") {
				const after = index + current.length + next.length
				const third = shellCharacter(command, after)
				if (third.value === "<") {
					result += "<<<"
					index = after + third.length
					continue
				}
				const document = hereDocument(command, after)
				if (document) {
					documents.push(document)
					result += `<<${command.slice(after, document.end)}`
					index = document.end
					continue
				}
			}
		}
		result += current.value
		index += current.length
	}
	return result
}
