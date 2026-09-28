import { createHash, randomUUID } from "node:crypto"
import { type CommandExecutionState, isActiveCommandExecution } from "@shared/ExtensionMessage"
import type { ExecutionRecoveryStore } from "./ExecutionRecovery"

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
	status:
		| "queued"
		| "running"
		| "retrying"
		| "awaiting_completion"
		| "completed"
		| "failed"
		| "not_started"
		| "cancelled"
		| "unconfirmed"
	detail?: string
	result_preview?: string
	input_preview?: string
	concurrency_group?: string
	attempt?: number
	max_attempts?: number
	queue_timeout_ms?: number
	recovery?: CommandExecutionState["recovery"]
	/** Structured evidence survives a caller timeout and cannot be hidden by a long prose preview. */
	helper_handoff?: {
		files_modified: string[]
		files_viewed: string[]
		pending_command_ids: string[]
		result?: string
		error?: string
		truncated: boolean
	}
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

function snapshot(entry: Entry): ActionExecutionSnapshot {
	const handoff = entry.snapshot.helper_handoff
	return {
		...entry.snapshot,
		...(entry.snapshot.recovery ? { recovery: { ...entry.snapshot.recovery } } : {}),
		...(handoff
			? {
					helper_handoff: {
						...handoff,
						files_modified: [...handoff.files_modified],
						files_viewed: [...handoff.files_viewed],
						pending_command_ids: [...handoff.pending_command_ids],
					},
				}
			: {}),
	}
}

function helperHandoff(
	outcome: unknown,
	previous?: ActionExecutionSnapshot["helper_handoff"],
): ActionExecutionSnapshot["helper_handoff"] {
	if (!outcome || typeof outcome !== "object") return previous
	try {
		const result = outcome as Record<string, unknown>
		let truncated = previous?.truncated ?? false
		let remaining = 32_000
		const text = (value: unknown, limit: number) => {
			if (typeof value !== "string") return undefined
			const kept = value.slice(0, Math.min(limit, remaining))
			remaining -= kept.length
			truncated ||= value.length > kept.length
			return kept
		}
		const paths = (value: unknown) => {
			if (!Array.isArray(value)) return []
			truncated ||= value.length > 256
			return value.slice(0, 256).flatMap((path) => {
				if (typeof path !== "string") return []
				if (!remaining) {
					truncated = true
					return []
				}
				return [text(path, 2048)!]
			})
		}
		const handoff = {
			pending_command_ids: paths(result.pendingCommandIds ?? previous?.pending_command_ids),
			files_modified: paths([
				...new Set([
					...(previous?.files_modified ?? []),
					...(Array.isArray(result.filesModified) ? result.filesModified : []),
				]),
			]),
			files_viewed: paths([
				...new Set([...(previous?.files_viewed ?? []), ...(Array.isArray(result.filesViewed) ? result.filesViewed : [])]),
			]),
			result: text(result.result ?? previous?.result, 8000),
			error: text(result.error ?? previous?.error, 2000),
		}
		return { ...handoff, truncated }
	} catch {
		return undefined
	}
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
	private readonly recovery = new Map<string, ExecutionRecoveryStore>()

	attachRecovery(scope: string, store: ExecutionRecoveryStore): void {
		if (this.recovery.get(scope) === store) return
		// Fence references held by callbacks from a replaced owner before importing evidence.
		for (const entry of [...this.active.values(), ...this.completed.values()])
			if (entry.scope === scope) {
				entry.finished = true
				this.active.delete(entry.snapshot.execution_id)
				this.completed.delete(entry.snapshot.execution_id)
				this.keys.delete(entry.key)
			}
		this.recovery.set(scope, store)
		for (const { record, observedAt } of store.entries("action")) {
			const saved = record.snapshot
			const unresolved = !record.finished
			const entry: Entry = {
				scope,
				key: record.key,
				finished: true,
				snapshot: {
					...saved,
					...(unresolved
						? {
								status: saved.status === "queued" ? ("not_started" as const) : ("unconfirmed" as const),
								detail: "The extension host ended. This action has no restored authority or queued operation. Reconcile saved evidence before new work.",
							}
						: {}),
					recovery: { previousStatus: saved.status, observedAt, authority: "none" },
				},
			}
			this.completed.set(saved.execution_id, entry)
			// Unresolved effects retain their semantic fence, without occupying a live scheduling slot.
			if (unresolved && saved.status !== "queued") this.keys.set(entry.key, entry)
		}
	}

	assertAuthority(scope: string, owner?: string): void {
		this.recovery.get(scope)?.assertCanExecute(owner)
	}

	recordHelperEvidence(scope: string, executionId: string | undefined, result: unknown): void {
		const entry = executionId ? this.active.get(executionId) : undefined
		if (!entry || entry.scope !== scope || entry.finished || entry.snapshot.kind !== "helper") return
		// Provider chunks/heartbeats are telemetry, not new durable execution evidence.
		if (
			!result ||
			typeof result !== "object" ||
			!["result", "error", "filesModified", "filesViewed", "pendingCommandIds"].some(
				(key) => (result as Record<string, unknown>)[key] !== undefined,
			)
		)
			return
		const next = helperHandoff(result, entry.snapshot.helper_handoff)
		if (JSON.stringify(next) === JSON.stringify(entry.snapshot.helper_handoff)) return
		entry.snapshot.helper_handoff = next
		this.persist(entry, false)
	}

	private persist(entry: Entry, required: boolean): void {
		const store = this.recovery.get(entry.scope)
		const record = { kind: "action" as const, key: entry.key, snapshot: entry.snapshot, finished: entry.finished }
		if (required) store?.put(entry.snapshot.execution_id, record)
		else store?.observe(entry.snapshot.execution_id, record)
	}

	claim(scope: string, identity: ActionIdentity, policy?: ActionExecutionPolicy): Entry {
		this.assertAuthority(scope, identity.owner)
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
		this.persist(entry, true)
		this.active.set(entry.snapshot.execution_id, entry)
		this.keys.set(key, entry)
		return entry
	}

	update(entry: Entry | undefined, status: ActionExecutionSnapshot["status"], detail?: string, attempt?: number): void {
		if (!entry || entry.finished) return
		entry.snapshot = { ...entry.snapshot, status, detail, ...(attempt === undefined ? {} : { attempt }) }
		this.persist(entry, true)
	}

	finish(
		entry: Entry | undefined,
		status: "completed" | "failed" | "not_started" | "cancelled" | "unconfirmed",
		outcome: unknown,
	): void {
		if (!entry || entry.finished) return
		entry.snapshot = { ...entry.snapshot, status }
		entry.snapshot.result_preview = executionPreview(outcome)
		if (entry.snapshot.kind === "helper")
			entry.snapshot.helper_handoff = helperHandoff(outcome, entry.snapshot.helper_handoff)
		entry.finished = true
		this.persist(entry, false)
		this.active.delete(entry.snapshot.execution_id)
		this.keys.delete(entry.key)
		this.completed.set(entry.snapshot.execution_id, entry)
		// Global bounded receipt cache. Active identities are never evicted to make room.
		if (this.completed.size > 128) this.completed.delete(this.completed.keys().next().value!)
	}

	/** A foreground return is not process completion. Retain the identity until host confirmation. */
	reconcileCommand(scope: string, executionId: string | undefined, state: CommandExecutionState): void {
		if (!executionId) return
		const entry = this.active.get(executionId)
		if (!entry || entry.scope !== scope || entry.snapshot.kind !== "command") return
		if (state.executionId && state.executionId !== executionId) {
			// The command owner deduplicated this request against another run. It cannot
			// complete a second active claim when that existing process eventually exits.
			this.finish(entry, "not_started", {
				existing_execution_id: state.executionId,
				detail: "No duplicate command was started. Inspect the existing execution for its outcome.",
			})
			return
		}
		if (isActiveCommandExecution(state)) {
			this.update(
				entry,
				state.status === "running" ? "running" : "awaiting_completion",
				state.detail ??
					`Command ${state.status}. Inspect execution ${state.executionId ?? executionId}; do not launch it again.`,
			)
		} else {
			this.finish(entry, state.status as "completed" | "failed" | "not_started" | "cancelled" | "unconfirmed", state)
		}
	}

	get(scope: string, executionId: string): ActionExecutionSnapshot | undefined {
		const entry = this.active.get(executionId) ?? this.completed.get(executionId)
		if (entry) return entry.scope === scope ? snapshot(entry) : undefined
		const saved = this.recovery
			.get(scope)
			?.entries("action")
			.find((entry) => entry.id === executionId)
		if (!saved) return undefined
		return {
			...saved.record.snapshot,
			...(!saved.record.finished
				? {
						status: saved.record.snapshot.status === "queued" ? ("not_started" as const) : ("unconfirmed" as const),
						detail: "No live owner is retained for this action. Reconcile its persisted evidence before new work.",
					}
				: {}),
			recovery: { previousStatus: saved.record.snapshot.status, observedAt: saved.observedAt, authority: "none" },
		}
	}

	list(scope: string): { active: ActionExecutionSnapshot[]; recent: ActionExecutionSnapshot[] } {
		const snapshots = (entries: Entry[]) => entries.filter((entry) => entry.scope === scope).map(snapshot)
		return { active: snapshots([...this.active.values()]), recent: snapshots([...this.completed.values()]).slice(-8) }
	}
}
