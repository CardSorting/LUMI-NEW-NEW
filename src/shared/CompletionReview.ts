export const COMPLETION_CHECK_LABELS = {
	checklist: "Task checklist",
	audit: "Workspace audit",
	review: "Second review",
	demo: "Demo command",
} as const

export type CompletionCheckId = keyof typeof COMPLETION_CHECK_LABELS
export type CompletionCheckStatus = "passed" | "not_run" | "running" | "unverified"

/** Public recovery messages; raw host/provider errors stay out of the result card. */
export const COMPLETION_REVIEW_ERRORS = {
	taskUnavailable: "Reopen this task from history to review its changes.",
	checkpointsDisabled: "Enable checkpoints in settings to review saved changes.",
	snapshotUnavailable: "The saved changes for this result are unavailable. Try a more recent result.",
	baselineUnavailable: "The earlier snapshot for this result is unavailable. Try a more recent result.",
	noChanges: "No file changes were recorded for this result.",
	walkthroughBusy: "Another walkthrough is still running. Stop it before starting this one.",
} as const

export interface CompletionCheck {
	id: CompletionCheckId
	status: CompletionCheckStatus
	detail: string
}

/** A snapshot of observed checks at completion, independent of later task settings. */
export interface CompletionReview {
	schemaVersion: 1
	attempt: number
	priorBlocks: number
	checks: CompletionCheck[]
}

/** Render old gate-only info messages without replaying internal XML into chat. */
export function formatLegacyCompletionGateNotice(text: string | undefined): string | undefined {
	if (!text || !/^<completion_gate_envelope\b[^>]*>[\s\S]*<\/completion_gate_envelope>$/.test(text.trim())) return undefined
	const status = text.match(/<completion_gate_status\b[^>]*\/>/)?.[0]
	if (!status || !/\bpassed="true"/.test(status)) return "Completion check details aren’t available for this older notice."
	const score = status.match(/\bscore="(\d+(?:\.\d+)?)"/)?.[1]
	return `Completion checks passed.${score !== undefined && Number(score) <= 100 ? ` Audit score: ${score}/100.` : ""}`
}

/** Old or unrecognized records must never be presented as verified checks. */
export function parseCompletionReview(value: unknown): CompletionReview | undefined {
	if (!value || typeof value !== "object") return undefined
	const review = value as Record<string, unknown>
	if (
		review.schemaVersion !== 1 ||
		!Number.isSafeInteger(review.attempt) ||
		Number(review.attempt) < 1 ||
		!Number.isSafeInteger(review.priorBlocks) ||
		Number(review.priorBlocks) < 0 ||
		!Array.isArray(review.checks) ||
		review.checks.length === 0 ||
		review.checks.length > Object.keys(COMPLETION_CHECK_LABELS).length
	)
		return undefined
	const ids = new Set<string>()
	const checks: CompletionCheck[] = []
	for (const item of review.checks) {
		if (
			!item ||
			typeof item !== "object" ||
			!Object.hasOwn(COMPLETION_CHECK_LABELS, item.id) ||
			ids.has(item.id) ||
			!["passed", "not_run", "running", "unverified"].includes(item.status) ||
			typeof item.detail !== "string"
		)
			return undefined
		ids.add(item.id)
		checks.push({ id: item.id, status: item.status, detail: item.detail })
	}
	return { schemaVersion: 1, attempt: Number(review.attempt), priorBlocks: Number(review.priorBlocks), checks }
}
