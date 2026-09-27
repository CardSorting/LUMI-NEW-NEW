import { createHash, randomUUID } from "node:crypto"

export interface ActionIdentity {
	kind: "command" | "mcp_tool" | "mcp_resource" | "file_write" | "helper"
	input: unknown
	label: string
	owner?: string
}

export interface ActionExecutionSnapshot {
	execution_id: string
	kind: ActionIdentity["kind"]
	label: string
	owner: string
	status: "queued" | "running" | "retrying" | "awaiting_completion" | "completed" | "failed" | "not_started"
	detail?: string
	result_preview?: string
	input_preview?: string
	concurrency_group?: string
	attempt?: number
	max_attempts?: number
	queue_timeout_ms?: number
}

export interface ActionExecutionPolicy {
	concurrency_group: string
	max_attempts: number
	queue_timeout_ms: number
}

interface Entry {
	scope: string
	key: string
	snapshot: ActionExecutionSnapshot
	finished: boolean
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	if (value && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(",")}}`
	return JSON.stringify(value) ?? "undefined"
}

/** Bound serialization as well as storage. Unexpected/cyclic SDK values cannot lose an executed result. */
export function executionPreview(value: unknown, limit = 1600, redactCredentials = false): string {
	let remaining = limit
	const seen = new Set<object>()
	const credentialKeys = new Set([
		"password",
		"passwd",
		"token",
		"accesstoken",
		"refreshtoken",
		"apikey",
		"secret",
		"clientsecret",
		"authorization",
		"cookie",
		"credentials",
		"privatekey",
	])
	const visit = (item: unknown, depth: number): unknown => {
		if (remaining <= 0) return "…"
		if (typeof item === "string") {
			const text = item.slice(0, remaining)
			remaining -= text.length
			return text.length < item.length ? `${text}…` : text
		}
		if (item === null || typeof item === "number" || typeof item === "boolean") return item
		if (typeof item !== "object") return String(item).slice(0, 100)
		if (depth >= 4 || seen.has(item)) return "[details omitted]"
		seen.add(item)
		if (Array.isArray(item)) return item.slice(0, 20).map((value) => visit(value, depth + 1))
		const result: Record<string, unknown> = Object.create(null)
		let count = 0
		for (const key in item) {
			if (!Object.hasOwn(item, key)) continue
			if (++count > 20 || remaining <= 0) {
				result["…"] = "more details omitted"
				break
			}
			remaining -= key.length
			result[key.slice(0, 100)] =
				redactCredentials && credentialKeys.has(key.toLowerCase().replace(/[^a-z]/g, ""))
					? "[redacted]"
					: visit((item as Record<string, unknown>)[key], depth + 1)
		}
		return result
	}
	try {
		return (typeof value === "string" ? value : JSON.stringify(visit(value, 0))).slice(0, limit)
	} catch {
		return "[Result returned; preview unavailable.]"
	}
}

export class ActionAlreadyActiveError extends Error {
	constructor(readonly execution: ActionExecutionSnapshot) {
		super(
			`Action already ${execution.status}: ${execution.label}. No duplicate was started. Execution ID: ${execution.execution_id}. Use get_execution_state with this execution_id to inspect the existing action, or continue independent work. Cancellation or a caller timeout is not proof that work stopped.`,
		)
		this.name = "ActionAlreadyActiveError"
	}
}

/** An identity is reserved before queueing and released only when actual work settles. */
export class ActionExecutionRegistry {
	private readonly active = new Map<string, Entry>()
	private readonly keys = new Map<string, Entry>()
	private readonly completed = new Map<string, Entry>()

	claim(scope: string, identity: ActionIdentity, policy?: ActionExecutionPolicy): Entry {
		const key = createHash("sha256")
			.update(canonical([scope, identity.kind, identity.input]))
			.digest("hex")
		const existing = this.keys.get(key)
		if (existing) throw new ActionAlreadyActiveError({ ...existing.snapshot })
		if (this.active.size >= 512 || [...this.active.values()].filter((entry) => entry.scope === scope).length >= 128) {
			throw new Error(
				"Action did not start: tracked execution capacity is full. Use get_execution_state to inspect existing work.",
			)
		}
		const entry: Entry = {
			scope,
			key,
			finished: false,
			snapshot: {
				execution_id: randomUUID(),
				kind: identity.kind,
				label: identity.label.slice(0, 240),
				owner: (identity.owner ?? "parent").slice(0, 100),
				status: "queued",
				input_preview: executionPreview(identity.input, 800, true),
				...(policy ? { ...policy, attempt: 0 } : {}),
			},
		}
		this.active.set(entry.snapshot.execution_id, entry)
		this.keys.set(key, entry)
		return entry
	}

	update(entry: Entry | undefined, status: ActionExecutionSnapshot["status"], detail?: string, attempt?: number): void {
		if (!entry || entry.finished) return
		entry.snapshot = { ...entry.snapshot, status, detail, ...(attempt === undefined ? {} : { attempt }) }
	}

	finish(entry: Entry | undefined, status: "completed" | "failed" | "not_started", outcome: unknown): void {
		if (!entry || entry.finished) return
		this.update(entry, status)
		entry.snapshot.result_preview = executionPreview(outcome)
		entry.finished = true
		this.active.delete(entry.snapshot.execution_id)
		this.keys.delete(entry.key)
		this.completed.set(entry.snapshot.execution_id, entry)
		// Global bounded receipt cache. Active identities are never evicted to make room.
		if (this.completed.size > 128) this.completed.delete(this.completed.keys().next().value!)
	}

	get(scope: string, executionId: string): ActionExecutionSnapshot | undefined {
		const entry = this.active.get(executionId) ?? this.completed.get(executionId)
		return entry?.scope === scope ? { ...entry.snapshot } : undefined
	}

	list(scope: string): { active: ActionExecutionSnapshot[]; recent: ActionExecutionSnapshot[] } {
		const snapshots = (entries: Entry[]) =>
			entries.filter((entry) => entry.scope === scope).map((entry) => ({ ...entry.snapshot }))
		return { active: snapshots([...this.active.values()]), recent: snapshots([...this.completed.values()]).slice(-8) }
	}
}
