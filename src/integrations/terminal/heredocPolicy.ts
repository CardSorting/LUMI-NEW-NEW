/**
 * Policy and detection helpers for heredoc constructs in shell commands.
 * Terminal shell integration in VS Code deadlocks on multiline heredocs,
 * and coding agents must use write_to_file / replace_in_file instead of
 * terminal redirection for file creation and updates.
 */

export interface HeredocRedirectionDetection {
	isHeredocFileWrite: boolean
	targetFiles: string[]
	reason?: string
}

export interface TopLevelHeredoc {
	delimiter: string
	index: number
	statementStart: number
}

/**
 * Common regex pattern to capture file paths in shell commands:
 * Group 1: Double-quoted path (e.g., "path/to/my file.txt")
 * Group 2: Single-quoted path (e.g., 'path/to/my file.txt')
 * Group 3: Unquoted path (e.g., path/to/file.txt)
 */
const FILE_TARGET_PATTERN = `(?:"([^"\\r\\n]+)"|'([^'\\r\\n]+)'|([^\\s'"><;&|\\r\\n]+))`

/**
 * Scans a shell command and identifies top-level heredoc openings (<<),
 * ignoring occurrences inside quotes ('...', "...") and arithmetic expansions ($((...))).
 */
export function findTopLevelHeredocs(command: string): TopLevelHeredoc[] {
	if (!command || typeof command !== "string" || !command.includes("<<")) {
		return []
	}

	const heredocs: TopLevelHeredoc[] = []
	let state: "none" | "single_quote" | "double_quote" | "arithmetic" = "none"
	let parenDepth = 0
	let statementStart = 0

	for (let i = 0; i < command.length; i++) {
		const c = command[i]
		const next = command[i + 1]

		if (state === "single_quote") {
			if (c === "'") state = "none"
			continue
		}
		if (state === "double_quote") {
			if (c === "\\") {
				i++
				continue
			}
			if (c === '"') state = "none"
			continue
		}
		if (state === "arithmetic") {
			if (c === "(") parenDepth++
			else if (c === ")") {
				parenDepth--
				if (parenDepth <= 0) state = "none"
			}
			continue
		}

		// State: none
		if (c === "'") {
			state = "single_quote"
			continue
		}
		if (c === '"') {
			state = "double_quote"
			continue
		}
		if (c === "\\") {
			i++
			continue
		}
		if (c === "$" && next === "(" && command[i + 2] === "(") {
			state = "arithmetic"
			parenDepth = 2
			i += 2
			continue
		}
		if (c === "(" && next === "(") {
			state = "arithmetic"
			parenDepth = 2
			i += 1
			continue
		}

		// Track statement boundaries
		if (c === ";" || c === "\n" || c === "\r" || (c === "&" && next === "&") || (c === "|" && next === "|")) {
			statementStart = i + 1
			if (next === "&" || next === "|") i++
			continue
		}

		// Check for << operator (not <<< and not preceded by <)
		if (c === "<" && next === "<") {
			if (command[i + 2] === "<" || (i > 0 && command[i - 1] === "<")) {
				continue
			}
			let idx = i + 2
			if (command[idx] === "-") idx++
			while (idx < command.length && (command[idx] === " " || command[idx] === "\t")) idx++
			if (command[idx] === "\\") idx++

			let delim = ""
			if (command[idx] === "'") {
				idx++
				const start = idx
				while (idx < command.length && command[idx] !== "'") idx++
				delim = command.slice(start, idx)
			} else if (command[idx] === '"') {
				idx++
				const start = idx
				while (idx < command.length && command[idx] !== '"') idx++
				delim = command.slice(start, idx)
			} else {
				const start = idx
				while (idx < command.length && /[a-zA-Z0-9_-]/.test(command[idx])) idx++
				delim = command.slice(start, idx)
			}

			if (delim.length > 0) {
				heredocs.push({ delimiter: delim, index: i, statementStart })
			}
		}
	}
	return heredocs
}

/**
 * Detects whether a shell command attempts to create or overwrite files
 * using multiline heredoc syntax (e.g., cat > file << 'EOF', cat << 'EOF' > file,
 * tee file << 'EOF', cat << 'EOF' | sudo tee file).
 */
export function detectHeredocFileRedirection(command: string): HeredocRedirectionDetection {
	if (!command || typeof command !== "string" || !command.includes("<<")) {
		return { isHeredocFileWrite: false, targetFiles: [] }
	}

	const topLevelHeredocs = findTopLevelHeredocs(command)
	if (topLevelHeredocs.length === 0) {
		return { isHeredocFileWrite: false, targetFiles: [] }
	}

	const targetFiles: string[] = []

	for (const { delimiter, index, statementStart } of topLevelHeredocs) {
		const beforeHeredoc = command.slice(statementStart, index)

		// Find end of the line containing the heredoc opening
		let lineEnd = command.indexOf("\n", index)
		if (lineEnd === -1) lineEnd = command.length
		const heredocLine = command.slice(index, lineEnd)

		// Check 1: Redirection before heredoc (e.g. cat > file, cat >> "my file")
		const redirectBefore = new RegExp(`(?:[0-9]*>>|[0-9]*>)\\s*${FILE_TARGET_PATTERN}`, "gi")
		let m: RegExpExecArray | null
		while ((m = redirectBefore.exec(beforeHeredoc)) !== null) {
			const file = m[1] ?? m[2] ?? m[3]
			if (file && file !== "/dev/null") targetFiles.push(file)
		}

		// Check 2: Tee before heredoc (e.g. tee file, sudo tee -a file)
		const teeBefore = new RegExp(`(?:^|[;&|\\s])(?:sudo\\s+|doas\\s+)?tee\\s+(?:-[a-zA-Z]+\\s+)*${FILE_TARGET_PATTERN}`, "gi")
		while ((m = teeBefore.exec(beforeHeredoc)) !== null) {
			const file = m[1] ?? m[2] ?? m[3]
			if (file && file !== "/dev/null") targetFiles.push(file)
		}

		// Check 3: Redirection on heredoc line after delimiter (e.g. << "EOF" > file, << "EOF" >> file)
		const redirectAfter = new RegExp(
			`<<-?\\s*\\\\?(?:"[^"\\r\\n]+"|'[^'\\r\\n]+'|[a-zA-Z0-9_\\-]+)\\s*(?:[0-9]*>>|[0-9]*>)\\s*${FILE_TARGET_PATTERN}`,
			"gi",
		)
		while ((m = redirectAfter.exec(heredocLine)) !== null) {
			const file = m[1] ?? m[2] ?? m[3]
			if (file && file !== "/dev/null") targetFiles.push(file)
		}

		// Check 4: Piped to tee or cat on heredoc line (e.g. << "EOF" | sudo tee file)
		const pipedAfter = new RegExp(
			`\\|\\s*(?:sudo\\s+|doas\\s+)?(?:tee\\s+(?:-[a-zA-Z]+\\s+)*|(?:cat|sh|bash)\\s*(?:[0-9]*>>|[0-9]*>)\\s*)${FILE_TARGET_PATTERN}`,
			"gi",
		)
		while ((m = pipedAfter.exec(heredocLine)) !== null) {
			const file = m[1] ?? m[2] ?? m[3]
			if (file && file !== "/dev/null") targetFiles.push(file)
		}

		// Check 5: Redirection after closing delimiter line (e.g. EOF > file or EOF >> file)
		const rest = command.slice(lineEnd)
		const escapedDelim = delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		const closingRedirect = new RegExp(
			`^[ \\t]*${escapedDelim}[ \\t]*(?:[0-9]*>>|[0-9]*>)[ \\t]*${FILE_TARGET_PATTERN}`,
			"gim",
		)
		while ((m = closingRedirect.exec(rest)) !== null) {
			const file = m[1] ?? m[2] ?? m[3]
			if (file && file !== "/dev/null") targetFiles.push(file)
		}
	}

	const uniqueFiles = Array.from(new Set(targetFiles.filter(Boolean)))

	if (uniqueFiles.length > 0) {
		const fileListStr = uniqueFiles.map((f) => `'${f}'`).join(", ")
		return {
			isHeredocFileWrite: true,
			targetFiles: uniqueFiles,
			reason: `Terminal heredoc file creation detected for ${fileListStr}. Writing files through terminal heredocs deadlocks interactive shell integration and bypasses file tracking. Use the 'write_to_file' tool directly to create or overwrite each file instead.`,
		}
	}

	return { isHeredocFileWrite: false, targetFiles: [] }
}

/**
 * Checks if a command contains multiline heredoc syntax that could deadlock
 * VS Code terminal shell integration if executed interactively.
 */
export function isMultilineHeredocCommand(command: string): boolean {
	if (!command || typeof command !== "string" || !command.includes("<<")) {
		return false
	}
	if (!command.includes("\n") && !command.includes("\r")) {
		return false
	}
	// If it's already identified as a heredoc file redirection, it's definitely a multiline heredoc
	if (detectHeredocFileRedirection(command).isHeredocFileWrite) {
		return true
	}
	const topLevelHeredocs = findTopLevelHeredocs(command)
	if (topLevelHeredocs.length === 0) {
		return false
	}
	for (const { delimiter, index } of topLevelHeredocs) {
		const rest = command.slice(index)
		if (!rest.includes("\n") && !rest.includes("\r")) {
			continue
		}
		// If delimiter appears on its own line: ^\s*DELIM\s*$
		const escapedDelim = delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		const closingPattern = new RegExp(`^\\s*${escapedDelim}\\s*(?:[;&|\\s].*)?$`, "m")
		if (closingPattern.test(rest)) {
			return true
		}
		// If multiple lines follow an open heredoc, interactive shell integration will wait for input and deadlock
		const linesAfter = rest.split(/\r?\n/).length
		if (linesAfter > 1) {
			return true
		}
	}
	return false
}
