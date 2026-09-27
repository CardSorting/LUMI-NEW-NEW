import type { DietCodeSaySubagentStatus, SubagentActivity, SubagentExecutionStatus, SubagentStatusItem } from "./ExtensionMessage"

const STATUSES = new Set<SubagentExecutionStatus>(["pending", "running", "completed", "failed", "cancelled", "interrupted"])
const PHASES = new Set<SubagentActivity["phase"]>(["preparing", "waiting", "responding", "tool", "retrying", "recovering"])
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const amount = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0)
const count = (value: unknown): number => Math.floor(amount(value))
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const strings = (value: unknown): string[] =>
	Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === "string"))] : []

/** One validated representation for stored/streamed helper rows and the parent task header. */
export function parseSubagentStatusPayload(raw: string | undefined): DietCodeSaySubagentStatus | undefined {
	if (!raw) return undefined
	let payload: unknown
	try {
		payload = JSON.parse(raw)
	} catch {
		return undefined
	}
	if (!record(payload) || !Array.isArray(payload.items)) return undefined
	const ids = new Set<string>()
	const items: SubagentStatusItem[] = []
	for (const [index, entry] of payload.items.entries()) {
		if (!record(entry) || typeof entry.prompt !== "string" || !STATUSES.has(entry.status as SubagentExecutionStatus)) continue
		const baseId = text(entry.id)?.trim() || `helper-${index}`
		let id = baseId
		while (ids.has(id)) id = `${id}-${index}`
		ids.add(id)
		const activity =
			record(entry.activity) && PHASES.has(entry.activity.phase as SubagentActivity["phase"])
				? {
						phase: entry.activity.phase as SubagentActivity["phase"],
						attempt: count(entry.activity.attempt) || undefined,
						maxAttempts: count(entry.activity.maxAttempts) || undefined,
						retryAt: amount(entry.activity.retryAt) || undefined,
					}
				: undefined
		items.push({
			id,
			executionId: text(entry.executionId),
			pendingCommandIds: strings(entry.pendingCommandIds),
			index: count(entry.index) || index + 1,
			name: text(entry.name)?.trim() || `Helper ${index + 1}`,
			prompt: entry.prompt,
			status:
				payload.status === "cancelled" && (entry.status === "running" || entry.status === "pending")
					? "cancelled"
					: (entry.status as SubagentExecutionStatus),
			toolCalls: count(entry.toolCalls),
			inputTokens: count(entry.inputTokens),
			outputTokens: count(entry.outputTokens),
			totalCost: amount(entry.totalCost),
			contextTokens: count(entry.contextTokens),
			contextWindow: count(entry.contextWindow),
			contextUsagePercentage: Math.min(100, amount(entry.contextUsagePercentage)),
			latestToolCall: text(entry.latestToolCall),
			activity,
			result: text(entry.result),
			error: text(entry.error),
			criticalSignals: strings(entry.criticalSignals),
			filesModified: strings(entry.filesModified),
			filesViewed: strings(entry.filesViewed),
			durationMs: amount(entry.durationMs),
		})
	}
	if (!items.length) return undefined
	const successes = items.filter((item) => item.status === "completed").length
	const failures = items.filter((item) => item.status === "failed").length
	const cancelled = items.filter((item) => item.status === "cancelled").length
	const interrupted = items.filter((item) => item.status === "interrupted").length
	const active = items.some((item) => item.status === "running" || item.status === "pending")
	return {
		batchId: text(payload.batchId)?.trim() || undefined,
		status: active ? "running" : interrupted ? "interrupted" : cancelled ? "cancelled" : failures ? "failed" : "completed",
		total: items.length,
		completed: successes + failures + cancelled + interrupted,
		successes,
		failures,
		cancelled,
		toolCalls: items.reduce((sum, item) => sum + item.toolCalls, 0),
		inputTokens: items.reduce((sum, item) => sum + item.inputTokens, 0),
		outputTokens: items.reduce((sum, item) => sum + item.outputTokens, 0),
		contextWindow: Math.max(...items.map((item) => item.contextWindow)),
		maxContextTokens: Math.max(...items.map((item) => item.contextTokens)),
		maxContextUsagePercentage: Math.max(...items.map((item) => item.contextUsagePercentage)),
		items,
	}
}
