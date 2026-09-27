/** Foreground waits release the agent; they never replay or kill the command. */
export const DEFAULT_COMMAND_WAIT_SECONDS = 30
export const MAX_COMMAND_WAIT_SECONDS = 300
export const TERMINAL_START_TIMEOUT_MS = 15_000
export const MAX_ACTIVE_COMMANDS = 12
export const MAX_COMMAND_RECEIPTS = 64
export const MAX_COMMAND_READ_WAITERS = 16
export const MAX_COMMAND_SNAPSHOT_LENGTH = 64_000

/** Observation has its own short deadline. Zero explicitly requests an immediate snapshot. */
export function resolveCommandReadTimeoutSeconds(timeout?: string | number): number {
	if (typeof timeout === "string" && !timeout.trim()) return 5
	const parsed = typeof timeout === "string" ? Number(timeout.trim()) : timeout
	return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 30) : 5
}

export function boundCommandOutput(output: string): string {
	if (output.length <= MAX_COMMAND_SNAPSHOT_LENGTH) return output
	const notice = "\n... (output truncated; inspect the terminal for full output) ...\n"
	const keep = Math.floor((MAX_COMMAND_SNAPSHOT_LENGTH - notice.length) / 2)
	return `${output.slice(0, keep)}${notice}${output.slice(-keep)}`
}

const LONG_RUNNING_COMMAND_PATTERNS = [
	/\b(npm|pnpm|yarn|bun)\s+(install|ci|build|test)\b/i,
	/\b(npm|pnpm|yarn|bun)\s+run\s+(build|test|lint|typecheck|check)\b/i,
	/\b(pip|pip3|uv)\s+install\b/i,
	/\b(poetry|pipenv)\s+install\b/i,
	/\b(cargo|go|mvn|gradle|gradlew)\s+(build|test|check|install)\b/i,
	/\b(make|cmake|ctest|pytest|tox|nox|jest|vitest|mocha)\b/i,
	/\b(docker|podman)\s+build\b/i,
	/\b(torchrun|deepspeed|accelerate\s+launch|ffmpeg)\b/i,
	/\bpython(?:\d+(?:\.\d+)?)?\s+.*\b(train|finetune)\b/i,
]

export function isLikelyLongRunningCommand(command: string): boolean {
	return LONG_RUNNING_COMMAND_PATTERNS.some((pattern) => pattern.test(command.trim().replace(/\s+/g, " ")))
}

export function resolveCommandTimeoutSeconds(command: string, timeout?: string | number): number {
	const parsed = typeof timeout === "string" ? Number(timeout.trim()) : timeout
	if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) {
		return Math.max(0.001, Math.min(parsed, MAX_COMMAND_WAIT_SECONDS))
	}
	return isLikelyLongRunningCommand(command) ? MAX_COMMAND_WAIT_SECONDS : DEFAULT_COMMAND_WAIT_SECONDS
}
