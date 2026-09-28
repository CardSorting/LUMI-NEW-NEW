import type {
	DietCodeMessage,
	DietCodeSaySubagentStatus,
	SubagentActivity,
	SubagentActivityEvent,
	SubagentCommandActivity,
	SubagentExecutionStatus,
	SubagentStatusItem,
	SubagentToolActivity,
} from "./ExtensionMessage"
import { COMMAND_EXECUTION_STATUSES } from "./ExtensionMessage"

export const SUBAGENT_RECENT_TOOL_LIMIT = 8
export const SUBAGENT_MESSAGE_LIMIT = 1200
export const SUBAGENT_ACTIVITY_LIMIT = 60
export const SUBAGENT_HEARTBEAT_INTERVAL_MS = 3000
export const SUBAGENT_HEARTBEAT_STALE_MS = 12000
export const SUBAGENT_QUIET_WARNING_MS = 30000

const STATUSES = new Set<SubagentExecutionStatus>(["pending", "running", "completed", "failed", "cancelled", "interrupted"])
const PHASES = new Set<SubagentActivity["phase"]>(["preparing", "waiting", "responding", "tool", "retrying", "recovering"])
const TOOL_STATUSES = new Set<SubagentToolActivity["status"]>(["running", "returned", "failed"])
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const amount = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0)
const count = (value: unknown): number => Math.floor(amount(value))
const timestamp = (value: unknown): number => Math.min(amount(value), 8_640_000_000_000_000)
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
						detail: text(entry.activity.detail)?.slice(0, 300),
						startedAt: amount(entry.activity.startedAt) || undefined,
						deadlineAt: amount(entry.activity.deadlineAt) || undefined,
						attempt: count(entry.activity.attempt) || undefined,
						maxAttempts: count(entry.activity.maxAttempts) || undefined,
						retryAt: amount(entry.activity.retryAt) || undefined,
					}
				: undefined
		const recentTools: SubagentToolActivity[] = []
		if (Array.isArray(entry.recentTools)) {
			for (const tool of entry.recentTools.slice(-SUBAGENT_RECENT_TOOL_LIMIT)) {
				if (
					!record(tool) ||
					!text(tool.id)?.trim() ||
					!text(tool.label)?.trim() ||
					!TOOL_STATUSES.has(tool.status as SubagentToolActivity["status"]) ||
					recentTools.some((item) => item.id === tool.id)
				)
					continue
				recentTools.push({
					id: tool.id as string,
					label: (tool.label as string).slice(0, 300),
					status: tool.status as SubagentToolActivity["status"],
					startedAt: amount(tool.startedAt) || undefined,
					finishedAt: amount(tool.finishedAt) || undefined,
					output: text(tool.output)?.slice(-4000),
				})
			}
		}
		const activityEvents: SubagentActivityEvent[] = []
		if (Array.isArray(entry.activityEvents)) {
			for (const event of entry.activityEvents.slice(-SUBAGENT_ACTIVITY_LIMIT)) {
				if (
					!record(event) ||
					!text(event.id) ||
					!text(event.label) ||
					!["phase", "message", "tool", "warning"].includes(String(event.kind))
				)
					continue
				if (activityEvents.some((item) => item.id === event.id)) continue
				activityEvents.push({
					id: event.id as string,
					at: timestamp(event.at),
					kind: event.kind as SubagentActivityEvent["kind"],
					label: (event.label as string).slice(0, SUBAGENT_MESSAGE_LIMIT),
				})
			}
		}
		const commands: SubagentCommandActivity[] = []
		if (Array.isArray(entry.commands)) {
			for (const command of entry.commands.slice(-8)) {
				if (
					!record(command) ||
					!text(command.id) ||
					!text(command.command) ||
					!(COMMAND_EXECUTION_STATUSES as readonly string[]).includes(String(command.status))
				)
					continue
				if (commands.some((item) => item.id === command.id)) continue
				commands.push({
					id: command.id as string,
					command: (command.command as string).slice(0, 1000),
					status: command.status as SubagentCommandActivity["status"],
					output: text(command.output)?.slice(-4000) ?? "",
					exitCode:
						typeof command.exitCode === "number" && Number.isFinite(command.exitCode) ? command.exitCode : undefined,
				})
			}
		}
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
			latestMessage: text(entry.latestMessage)?.slice(0, SUBAGENT_MESSAGE_LIMIT),
			recentTools,
			startedAt: amount(entry.startedAt) || undefined,
			queuedAt: amount(entry.queuedAt) || undefined,
			queuePosition: count(entry.queuePosition) || undefined,
			lastActivityAt: amount(entry.lastActivityAt) || undefined,
			heartbeatAt: amount(entry.heartbeatAt) || undefined,
			responseChunks: count(entry.responseChunks),
			responseBytes: count(entry.responseBytes),
			requestCount: count(entry.requestCount),
			activityEvents,
			omittedActivityEvents: count(entry.omittedActivityEvents),
			commands,
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
		taskId: text(payload.taskId)?.trim() || undefined,
		revision: count(payload.revision) || undefined,
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

/** Task-scoped upsert for the lightweight stream; timestamps alone are not identity. */
export function applySubagentMessage(messages: DietCodeMessage[], message: DietCodeMessage, taskId?: string): DietCodeMessage[] {
	const next = message.say === "subagent" ? parseSubagentStatusPayload(message.text) : undefined
	if (!next || !taskId || next.taskId !== taskId || !next.revision) return messages
	const index = messages.findIndex((entry) => entry.ts === message.ts)
	if (index < 0) return [...messages, message].sort((a, b) => a.ts - b.ts)
	const currentMessage = messages[index]
	const current = currentMessage.say === "subagent" ? parseSubagentStatusPayload(currentMessage.text) : undefined
	if (
		!current ||
		(current.taskId && current.taskId !== next.taskId) ||
		current.batchId !== next.batchId ||
		current.items[0].id !== next.items[0].id ||
		(current.revision ?? 0) >= next.revision
	)
		return messages
	if (!currentMessage.partial && message.partial) return messages
	return messages.map((entry, i) => (i === index ? message : entry))
}

/** An older full-state response must not roll back a newer streamed helper row. */
export function preserveSubagentProgress(
	incoming: DietCodeMessage[],
	current: DietCodeMessage[],
	taskId?: string,
): DietCodeMessage[] {
	const byTimestamp = new Map(current.filter((entry) => entry.say === "subagent").map((entry) => [entry.ts, entry]))
	return incoming.map((message) => {
		const newer = byTimestamp.get(message.ts)
		if (!newer) return message
		return applySubagentMessage([message], newer, taskId)[0]
	})
}
