import { createHash } from "node:crypto"
import { isToolFailure } from "./tools/utils/toolOutcome"

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.filter((key) => key !== "task_progress")
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(",")}}`
	}
	return JSON.stringify(value) ?? "undefined"
}

const BOOKKEEPING_TOOLS = new Set(["focus_chain", "condense", "summarize_task"])

/** Renew execution when tools produce new evidence, not when a checklist or error counter changes. */
export class ToolProgressTracker {
	private readonly results = new Set<string>()
	private madeProgress = false
	private stalledTurns = 0
	private redirected = false

	/** Explicit user input starts a fresh recovery window, including after a stopped loop. */
	reset(): void {
		this.results.clear()
		this.stalledTurns = 0
		this.redirected = false
		this.madeProgress = true
	}

	record(name: string, params: unknown, result: unknown): void {
		if (isToolFailure(result) || result === undefined || BOOKKEEPING_TOOLS.has(name)) return
		const key = createHash("sha256")
			.update(canonical([name, params, result]))
			.digest("hex")
		if (!this.results.has(key)) this.madeProgress = true
		this.results.delete(key)
		this.results.add(key)
		if (this.results.size > 128) this.results.delete(this.results.keys().next().value!)
	}

	finishTurn(recoveryAfter = 3): "continue" | "redirect" | "handoff" {
		const recoveryThreshold = Number.isFinite(recoveryAfter) && recoveryAfter > 0 ? Math.ceil(recoveryAfter) : 3
		if (this.madeProgress) this.redirected = false
		this.stalledTurns = this.madeProgress ? 0 : this.stalledTurns + 1
		this.madeProgress = false
		if (this.stalledTurns >= Math.max(8, recoveryThreshold + 5)) return "handoff"
		if (this.stalledTurns >= recoveryThreshold && !this.redirected) {
			this.redirected = true
			return "redirect"
		}
		return "continue"
	}
}
