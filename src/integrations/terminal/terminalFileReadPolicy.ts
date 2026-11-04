/**
 * Policy and detection helpers for file read commands in the terminal.
 * Reading files via terminal commands (such as 'cat', 'head', 'tail', 'more', 'less')
 * dumps file contents directly into the user's interactive terminal window.
 * Agents must use the native 'read_file' tool instead.
 */

export interface TerminalFileReadDetection {
	isTerminalFileRead: boolean
	targetFiles: string[]
	reason?: string
}

/**
 * Whitelisted system pseudo-devices and environment info targets
 * that are safe for terminal probing (do not belong to project/workspace/skills).
 */
const WHITELISTED_SYSTEM_TARGETS = new Set([
	"-",
	"/dev/null",
	"/dev/zero",
	"/dev/stdin",
	"/dev/stdout",
	"/dev/stderr",
	"/dev/urandom",
	"/dev/random",
])

const WHITELISTED_SYSTEM_PATTERNS = [
	/^\/proc\//i,
	/^\/sys\//i,
	/^\/etc\/(?:os-release|issue|lsb-release|version|debian_version|redhat-release|alpine-release|fedora-release|centos-release|arch-release)$/i,
]

function isWhitelistedTarget(target: string): boolean {
	const trimmed = target.trim()
	if (!trimmed) return true
	if (WHITELISTED_SYSTEM_TARGETS.has(trimmed)) return true
	return WHITELISTED_SYSTEM_PATTERNS.some((pattern) => pattern.test(trimmed))
}

export const TERMINAL_FILE_READ_COMMANDS = new Set([
	"cat",
	"head",
	"tail",
	"more",
	"less",
	"tac",
	"bat",
	"nl",
	"fold",
	"pr",
	"view",
	"pg",
	"most",
])

export const TERMINAL_PAGERS_AND_DUMPERS = new Set([
	"cat",
	"head",
	"tail",
	"more",
	"less",
	"tac",
	"bat",
	"nl",
	"fold",
	"pr",
	"view",
	"pg",
	"most",
	"tee",
])

/**
 * Helper to extract quoted or unquoted redirection/here-string target
 * respecting escaped characters.
 */
function extractRedirectionTarget(str: string, startIndex: number): { target: string; endIndex: number } {
	let j = startIndex
	while (j < str.length && (str[j] === " " || str[j] === "\t")) j++
	let target = ""
	if (j >= str.length) return { target: "", endIndex: j }

	const quote = str[j]
	if (quote === "'" || quote === '"') {
		j++
		while (j < str.length) {
			if (quote === '"' && str[j] === "\\" && j + 1 < str.length) {
				target += str[j + 1]
				j += 2
				continue
			}
			if (str[j] === quote) {
				j++
				break
			}
			target += str[j]
			j++
		}
	} else if (str[j] === "&") {
		// fd duplication destination: &1, &2, &-
		target += "&"
		j++
		while (j < str.length && !/[\s><;&|]/.test(str[j])) {
			target += str[j]
			j++
		}
	} else {
		while (j < str.length && !/[\s><;&|]/.test(str[j])) {
			if (str[j] === "\\" && j + 1 < str.length) {
				target += str[j + 1]
				j += 2
				continue
			}
			target += str[j]
			j++
		}
	}
	return { target, endIndex: j }
}

/**
 * Splits a compound shell command into top-level statements separated by
 * ';', '&&', '||', '\n', '\r', subshell parentheses, or command substitutions,
 * respecting quotes and escaped characters in both unquoted and double-quoted contexts.
 */
export function splitTopLevelStatements(command: string): string[] {
	if (!command || typeof command !== "string") return []

	const normalized = command.replace(/^@[\w.-]+:\s*/, "")
	const statements: string[] = []
	let state: "none" | "single_quote" | "double_quote" = "none"
	let statementStart = 0

	for (let i = 0; i < normalized.length; i++) {
		const c = normalized[i]
		const next = normalized[i + 1]

		if (state === "single_quote") {
			if (c === "'") state = "none"
			continue
		}

		if (state === "double_quote") {
			if (c === "\\") {
				i++
				continue
			}
			if (c === '"') {
				state = "none"
				continue
			}
			// Command substitution inside double quotes $(...)
			if (c === "$" && next === "(" && normalized[i + 2] !== "(") {
				let depth = 1
				let j = i + 2
				while (j < normalized.length && depth > 0) {
					if (normalized[j] === "\\") {
						j += 2
						continue
					}
					if (normalized[j] === "(") depth++
					else if (normalized[j] === ")") depth--
					j++
				}
				const inner = normalized.slice(i + 2, j - 1)
				if (inner.trim()) statements.push(...splitTopLevelStatements(inner))
				i = j - 1
				continue
			}
			// Backtick substitution inside double quotes `...`
			if (c === "`") {
				let j = i + 1
				while (j < normalized.length) {
					if (normalized[j] === "\\") {
						j += 2
						continue
					}
					if (normalized[j] === "`") break
					j++
				}
				if (j < normalized.length) {
					const inner = normalized.slice(i + 1, j)
					if (inner.trim()) statements.push(...splitTopLevelStatements(inner))
					i = j
					continue
				}
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

		// Extract command substitution $(...)
		if (c === "$" && next === "(" && normalized[i + 2] !== "(") {
			let depth = 1
			let j = i + 2
			while (j < normalized.length && depth > 0) {
				if (normalized[j] === "\\") {
					j += 2
					continue
				}
				if (normalized[j] === "(") depth++
				else if (normalized[j] === ")") depth--
				j++
			}
			const inner = normalized.slice(i + 2, j - 1)
			if (inner.trim()) statements.push(...splitTopLevelStatements(inner))
			i = j - 1
			continue
		}

		// Extract backtick substitution `...`
		if (c === "`") {
			let j = i + 1
			while (j < normalized.length) {
				if (normalized[j] === "\\") {
					j += 2
					continue
				}
				if (normalized[j] === "`") break
				j++
			}
			if (j < normalized.length) {
				const inner = normalized.slice(i + 1, j)
				if (inner.trim()) statements.push(...splitTopLevelStatements(inner))
				i = j
				continue
			}
		}

		// Statement boundary: ;, &&, ||, \n, \r, or subshell parens ( )
		if (c === ";" || c === "\n" || c === "\r" || (c === "&" && next === "&") || (c === "|" && next === "|")) {
			const stmt = normalized.slice(statementStart, i).trim()
			if (stmt) statements.push(stmt)
			if (next === "&" || next === "|") i++
			statementStart = i + 1
		} else if (c === "(" || c === ")") {
			const stmt = normalized.slice(statementStart, i).trim()
			if (stmt) statements.push(stmt)
			statementStart = i + 1
		}
	}

	const lastStmt = normalized.slice(statementStart).trim()
	if (lastStmt) statements.push(lastStmt)

	return statements
}

interface ParsedStage {
	tokens: string[]
	command?: string
	targetFiles: string[]
	hasRedirectOut: boolean
	hasHeredoc: boolean
	hasHereString: boolean
	isFollow: boolean
	xargsCommand?: string
	findExecCommand?: string
	subscriptFileRead?: TerminalFileReadDetection
}

function parseStage(stageStr: string): ParsedStage {
	const tokens: string[] = []
	let hasRedirectOut = false
	let hasHeredoc = false
	let hasHereString = false
	const redirectInFiles: string[] = []

	let state: "none" | "single_quote" | "double_quote" = "none"
	let current = ""

	for (let i = 0; i < stageStr.length; i++) {
		const c = stageStr[i]
		const next = stageStr[i + 1]

		if (state === "single_quote") {
			if (c === "'") state = "none"
			else current += c
			continue
		}
		if (state === "double_quote") {
			if (c === "\\") {
				if (next !== undefined) {
					current += next
					i++
				}
				continue
			}
			if (c === '"') state = "none"
			else current += c
			continue
		}

		if (c === "'") {
			state = "single_quote"
			continue
		}
		if (c === '"') {
			state = "double_quote"
			continue
		}
		if (c === "\\") {
			if (next !== undefined) {
				current += next
				i++
			}
			continue
		}

		// Check here-string <<<
		if (c === "<" && next === "<" && stageStr[i + 2] === "<") {
			hasHereString = true
			if (current) {
				tokens.push(current)
				current = ""
			}
			const extracted = extractRedirectionTarget(stageStr, i + 3)
			i = extracted.endIndex - 1
			continue
		}

		// Check heredoc <<
		if (c === "<" && next === "<") {
			hasHeredoc = true
			if (current) {
				tokens.push(current)
				current = ""
			}
			i += 1
			continue
		}

		// Check &> or &>> (redirect stdout and stderr)
		if (c === "&" && next === ">") {
			const isAppend = stageStr[i + 2] === ">"
			const opLen = isAppend ? 3 : 2
			if (current) {
				tokens.push(current)
				current = ""
			}
			hasRedirectOut = true
			const redirectDest = extractRedirectionTarget(stageStr, i + opLen)
			i = redirectDest.endIndex - 1
			continue
		}

		// Check redirect out > or >> or >&
		if (c === ">") {
			const isDup = next === "&"
			const isAppend = next === ">"
			const opLen = isDup || isAppend ? 2 : 1
			const redirectDest = extractRedirectionTarget(stageStr, i + opLen)

			// Check if this is standard error redirection: 2> or 2>> or 2>&1
			const isErrRedirect = current.endsWith("2") && (current.length === 1 || !/[\w.-]/.test(current[current.length - 2]))
			if (isErrRedirect) {
				current = current.slice(0, -1)
				if (current) {
					tokens.push(current)
					current = ""
				}
				// 2> does NOT redirect stdout, so do not set hasRedirectOut
			} else if (isDup) {
				// >&2 duplicates stdout to stderr (both go to terminal)
				if (current) {
					tokens.push(current)
					current = ""
				}
			} else {
				// Standard output redirection (>, 1>, >>, etc.)
				const isStdoutFd = current.endsWith("1") && (current.length === 1 || !/[\w.-]/.test(current[current.length - 2]))
				if (isStdoutFd) {
					current = current.slice(0, -1)
				}
				if (current) {
					tokens.push(current)
					current = ""
				}
				hasRedirectOut = true
			}

			i = redirectDest.endIndex - 1
			continue
		}

		// Check input redirection < (single)
		if (c === "<") {
			// Check if this is fd 0 input redirection: 0<
			const isStdinFd = current.endsWith("0") && (current.length === 1 || !/[\w.-]/.test(current[current.length - 2]))
			if (isStdinFd) {
				current = current.slice(0, -1)
			}
			if (current) {
				tokens.push(current)
				current = ""
			}
			const extracted = extractRedirectionTarget(stageStr, i + 1)
			if (extracted.target) {
				redirectInFiles.push(extracted.target)
			}
			i = extracted.endIndex - 1
			continue
		}

		if (c === " " || c === "\t") {
			if (current) {
				tokens.push(current)
				current = ""
			}
			continue
		}

		// Curly braces group markers
		if ((c === "{" || c === "}") && !current) {
			continue
		}

		current += c
	}

	if (current) {
		tokens.push(current)
	}

	// Find command name skipping env vars and wrappers
	let idx = 0
	while (idx < tokens.length && tokens[idx].includes("=")) idx++

	while (idx < tokens.length) {
		const t = tokens[idx].split("/").pop()?.toLowerCase()
		if (t === "sudo" || t === "doas" || t === "nohup" || t === "time" || t === "exec" || t === "builtin") {
			idx++
		} else if (t === "command") {
			idx++
			while (idx < tokens.length && tokens[idx].startsWith("-")) idx++
		} else if (t === "env") {
			idx++
			while (idx < tokens.length) {
				if (tokens[idx] === "-u" || tokens[idx] === "--unset") {
					idx += 2
				} else if (tokens[idx].startsWith("-")) {
					idx++
				} else if (tokens[idx].includes("=")) {
					idx++
				} else {
					break
				}
			}
		} else {
			break
		}
	}

	const command = tokens[idx] ? tokens[idx].split("/").pop()?.toLowerCase() : undefined
	const targetFiles: string[] = []
	let isFollow = false
	let xargsCommand: string | undefined
	let findExecCommand: string | undefined
	let subscriptFileRead: TerminalFileReadDetection | undefined

	if (command && TERMINAL_FILE_READ_COMMANDS.has(command)) {
		const args = tokens.slice(idx + 1)
		if (command === "tail") {
			isFollow = args.some((arg) => arg === "-f" || arg === "-F" || arg === "--follow" || arg.startsWith("-f"))
		}

		if (!isFollow) {
			let skipNext = false
			for (let a = 0; a < args.length; a++) {
				if (skipNext) {
					skipNext = false
					continue
				}
				const arg = args[a]
				if ((command === "head" || command === "tail") && (arg === "-n" || arg === "-c")) {
					skipNext = true
					continue
				}
				if (arg.startsWith("-")) continue
				targetFiles.push(arg)
			}
			targetFiles.push(...redirectInFiles)
		}
	} else if (command === "xargs") {
		// Identify subcommand executed by xargs
		const args = tokens.slice(idx + 1)
		let subIdx = 0
		while (subIdx < args.length) {
			const arg = args[subIdx]
			if (arg === "-I" || arg === "-n" || arg === "-L" || arg === "-P" || arg === "-s" || arg === "-E" || arg === "-d") {
				subIdx += 2
			} else if (arg.startsWith("-")) {
				subIdx++
			} else {
				break
			}
		}
		if (subIdx < args.length) {
			const subCmd = args[subIdx].split("/").pop()?.toLowerCase()
			if (subCmd && TERMINAL_FILE_READ_COMMANDS.has(subCmd)) {
				xargsCommand = subCmd
			}
		}
	} else if (command === "find") {
		// Identify -exec or -execdir subcommand executed by find
		const args = tokens.slice(idx + 1)
		for (let a = 0; a < args.length; a++) {
			if (args[a] === "-exec" || args[a] === "-execdir") {
				const nextArg = args[a + 1]
				if (nextArg) {
					const subCmd = nextArg.split("/").pop()?.toLowerCase()
					if (subCmd && TERMINAL_FILE_READ_COMMANDS.has(subCmd)) {
						findExecCommand = subCmd
						break
					}
				}
			}
		}
	} else if (command === "sh" || command === "bash" || command === "zsh" || command === "dash" || command === "ksh") {
		// Inspect -c script invocation
		const args = tokens.slice(idx + 1)
		for (let a = 0; a < args.length; a++) {
			if (args[a] === "-c" || (args[a].startsWith("-") && args[a].includes("c"))) {
				const scriptStr = args[a + 1]
				if (scriptStr) {
					const sub = detectTerminalFileRead(scriptStr)
					if (sub.isTerminalFileRead) {
						subscriptFileRead = sub
						if (sub.targetFiles.length > 0) {
							targetFiles.push(...sub.targetFiles)
						}
					}
				}
				break
			}
		}
	} else if (!command && redirectInFiles.length > 0) {
		// e.g. < file.txt in zsh
		targetFiles.push(...redirectInFiles)
	}

	return {
		tokens,
		command,
		targetFiles: targetFiles.filter((t) => !isWhitelistedTarget(t)),
		hasRedirectOut,
		hasHeredoc,
		hasHereString,
		isFollow,
		xargsCommand,
		findExecCommand,
		subscriptFileRead,
	}
}

function splitPipeline(stmt: string): string[] {
	const stages: string[] = []
	let state: "none" | "single_quote" | "double_quote" = "none"
	let start = 0

	for (let i = 0; i < stmt.length; i++) {
		const c = stmt[i]
		const next = stmt[i + 1]

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

		// Pipe (single |)
		if (c === "|" && next !== "|" && stmt[i - 1] !== "|") {
			const s = stmt.slice(start, i).trim()
			if (s) stages.push(s)
			start = i + 1
		}
	}
	const last = stmt.slice(start).trim()
	if (last) stages.push(last)
	return stages
}

/**
 * Detects whether a shell command attempts to read workspace or filesystem files
 * using terminal commands like 'cat', 'head', 'tail', 'more', 'less', 'tac', 'bat', 'nl', 'fold', 'pr', 'view'
 * without piping or file redirection, which dumps file content directly into the terminal.
 */
export function detectTerminalFileRead(command: string): TerminalFileReadDetection {
	if (!command || typeof command !== "string") {
		return { isTerminalFileRead: false, targetFiles: [] }
	}

	const statements = splitTopLevelStatements(command)
	const detectedTargets: string[] = []

	for (const stmt of statements) {
		const stagesRaw = splitPipeline(stmt)
		if (stagesRaw.length === 0) continue

		const stages = stagesRaw.map(parseStage)
		const lastStage = stages[stages.length - 1]

		// Check for interactive stdin file creation deadlock trap: cat > file (without << and without input files or pipe)
		for (const st of stages) {
			if (st.command === "cat" && st.hasRedirectOut && !st.hasHeredoc && !st.hasHereString && stages.length === 1) {
				const args = st.tokens.slice(1).filter((t) => !t.startsWith("-"))
				if (args.length === 0) {
					return {
						isTerminalFileRead: true,
						targetFiles: [],
						reason: "Interactive terminal file creation detected ('cat > file'). Terminal commands run in non-interactive sessions without stdin and will deadlock waiting for input. Use the 'write_to_file' tool directly to create or edit files.",
					}
				}
			}
		}

		// If the final stage redirects output to a file, stdout does not dump to the terminal
		if (lastStage.hasRedirectOut) continue

		// Check for xargs terminal file read dump (e.g. find . -name "*.c" | xargs cat)
		if (lastStage.xargsCommand && !lastStage.hasRedirectOut) {
			return {
				isTerminalFileRead: true,
				targetFiles: [],
				reason: `Terminal file read detected via 'xargs ${lastStage.xargsCommand}'. Reading files through terminal commands dumps file content directly into the terminal and clutters the session. Use the 'read_file' tool directly to inspect file contents cleanly.`,
			}
		}

		// Check for find -exec terminal file read dump (e.g. find . -name "*.c" -exec cat {} +)
		if (lastStage.findExecCommand && !lastStage.hasRedirectOut) {
			return {
				isTerminalFileRead: true,
				targetFiles: [],
				reason: `Terminal file read detected via 'find -exec ${lastStage.findExecCommand}'. Reading files through terminal commands dumps file content directly into the terminal and clutters the session. Use the 'read_file' tool directly to inspect file contents cleanly.`,
			}
		}

		// Check for subshell script invocation file read (e.g. bash -c "cat file")
		if (lastStage.subscriptFileRead?.isTerminalFileRead) {
			if (lastStage.subscriptFileRead.targetFiles.length > 0) {
				detectedTargets.push(...lastStage.subscriptFileRead.targetFiles)
				continue
			}
			return lastStage.subscriptFileRead
		}

		// Case 1: The last stage is a file reader with file targets (or single stage)
		if (lastStage.command && TERMINAL_FILE_READ_COMMANDS.has(lastStage.command) && !lastStage.isFollow) {
			if (lastStage.targetFiles.length > 0) {
				detectedTargets.push(...lastStage.targetFiles)
				continue
			}
		}

		// Case 2: Multi-stage pipeline where last stage is a pager/dumper reading stdin,
		// and an earlier stage was reading files without filtering
		if (stages.length > 1) {
			const lastCmd = lastStage.command
			if (lastCmd && TERMINAL_PAGERS_AND_DUMPERS.has(lastCmd)) {
				for (let i = stages.length - 2; i >= 0; i--) {
					const prev = stages[i]
					if (prev.targetFiles.length > 0) {
						detectedTargets.push(...prev.targetFiles)
						break
					}
					if (!prev.command || !TERMINAL_PAGERS_AND_DUMPERS.has(prev.command)) {
						break
					}
				}
			}
		}

		// Case 3: Naked input redirection < file.txt without command
		if (!lastStage.command && lastStage.targetFiles.length > 0) {
			detectedTargets.push(...lastStage.targetFiles)
		}
	}

	const uniqueTargets = Array.from(new Set(detectedTargets.filter(Boolean)))

	if (uniqueTargets.length > 0) {
		const targetList = uniqueTargets.map((t) => `'${t}'`).join(", ")
		return {
			isTerminalFileRead: true,
			targetFiles: uniqueTargets,
			reason: `Terminal file read detected for ${targetList}. Reading files through terminal commands dumps file content directly into the terminal and clutters the session. Use the 'read_file' tool directly to inspect file contents cleanly.`,
		}
	}

	return { isTerminalFileRead: false, targetFiles: [] }
}

/**
 * Checks whether a command represents an unpiped terminal file read.
 */
export function isTerminalFileReadCommand(command: string): boolean {
	return detectTerminalFileRead(command).isTerminalFileRead
}
