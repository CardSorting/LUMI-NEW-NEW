import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { z } from "zod"
import type { CommandExecutionSnapshot } from "@/integrations/terminal/types"
import { COMMAND_EXECUTION_STATUSES, type DietCodeSaySubagentStatus } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { parseSubagentStatusPayload } from "@/shared/subagents"

const VERSION = 1
const MAX_RECORDS = 1024
const MAX_BYTES = 1_048_576
const hostSession = randomUUID()
const text = z.string().max(128_000)
const id = z.string().min(1).max(512)
const timestamp = z.number().finite().nonnegative()
const identitySchema = z.object({ taskId: id, ulid: id, cwd: text.min(1) }).strict()
const manifestSchema = z.object({ version: z.literal(VERSION), identity: identitySchema, lease: id, host: id }).strict()
const evidenceSchema = z.object({ previousStatus: text, observedAt: timestamp, authority: z.literal("none") }).strict()
const commandSchema = z
	.object({
		execution_id: id,
		action_id: id.optional(),
		owner: id.optional(),
		terminal_id: z.number().int().optional(),
		command: text,
		cwd: text,
		status: z.enum(COMMAND_EXECUTION_STATUSES),
		output: text,
		exit_code: z.number().int().optional(),
		signal: text.optional(),
		terminal_closed: z.boolean().optional(),
		detail: text.optional(),
		log_file_path: text.optional(),
		log_notice: text.optional(),
		recovery: evidenceSchema.optional(),
	})
	.strict()
const actionSchema = z
	.object({
		execution_id: id,
		kind: z.enum(["command", "mcp_tool", "mcp_resource", "file_write", "helper"]),
		label: text,
		owner: id,
		status: z.enum([
			"queued",
			"running",
			"retrying",
			"awaiting_completion",
			"completed",
			"failed",
			"not_started",
			"cancelled",
			"unconfirmed",
		]),
		detail: text.optional(),
		result_preview: text.optional(),
		input_preview: text.optional(),
		concurrency_group: text.optional(),
		attempt: z.number().int().nonnegative().optional(),
		max_attempts: z.number().int().positive().optional(),
		queue_timeout_ms: timestamp.optional(),
		recovery: evidenceSchema.optional(),
		helper_handoff: z
			.object({
				files_modified: z.array(text).max(256),
				files_viewed: z.array(text).max(256),
				pending_command_ids: z.array(id).max(256),
				result: text.optional(),
				error: text.optional(),
				truncated: z.boolean(),
			})
			.strict()
			.optional(),
	})
	.strict()
const recordSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("command"),
			snapshot: commandSchema,
			messageTs: timestamp.nullish(),
			transport: z
				.object({
					kind: z.enum(["vscode_terminal", "supervised", "unknown"]),
					shell: text.optional(),
					terminalName: text.optional(),
					processId: z.number().int().positive().optional(),
				})
				.strict(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("action"),
			key: z.string().regex(/^[a-f0-9]{64}$/),
			snapshot: actionSchema,
			finished: z.boolean(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("batch"),
			fingerprint: id,
			result: text.optional(),
			status: text.optional(),
			messageTs: timestamp.optional(),
		})
		.strict(),
	z.object({ kind: z.literal("tool"), fingerprint: id, result: text.optional() }).strict(),
])
const envelopeSchema = z
	.object({ version: z.literal(VERSION), identity: identitySchema, id, host: id, observedAt: timestamp, record: recordSchema })
	.strict()
export type RecoveryIdentity = z.infer<typeof identitySchema>
export type RecoveryRecord = z.infer<typeof recordSchema>
export type CommandRecoveryRecord = Extract<RecoveryRecord, { kind: "command" }>
export type ActionRecoveryRecord = Extract<RecoveryRecord, { kind: "action" }>
type Envelope = z.infer<typeof envelopeSchema>

export const RESTART_DETAIL =
	"The previous extension host ended. Its execution handle cannot be reattached. The saved output is historical; the process may still exist. No command was replayed. Inspect the original terminal and files before issuing new work."

export function executionFingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function persistedToolResult(value: unknown): string {
	const result = typeof value === "string" ? value : (JSON.stringify(value) ?? "")
	return result.length <= 128_000
		? result
		: `[Stored result truncated. This excerpt is not a complete file baseline. Read affected files before further edits; do not repeat the original mutation.]\n${result.slice(0, 127_500)}\n[End of stored excerpt.]`
}

/** Private, versioned receipts, never a queue of executable closures or a grant of authority. */
export class ExecutionRecoveryStore {
	private readonly lease = randomUUID()
	private readonly records = new Map<string, Envelope>()
	private readonly restored = new Set<string>()
	private readonly retiredOwners = new Set<string>()
	private readonly issues: string[] = []
	private readonly manifestPath: string
	readonly host = hostSession

	constructor(
		readonly directory: string,
		readonly identity: RecoveryIdentity,
	) {
		this.manifestPath = path.join(directory, "manifest.json")
		try {
			identitySchema.parse(identity)
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
			const files = fs.readdirSync(directory)
			if (files.includes("manifest.json")) {
				const manifest = manifestSchema.parse(this.read(this.manifestPath))
				if (!this.matches(manifest.identity)) throw new Error("Task or workspace identity does not match")
			} else if (files.some((file) => file.endsWith(".json"))) throw new Error("Recovery manifest is missing")
			const receipts = files.filter((file) => file !== "manifest.json" && file.endsWith(".json"))
			if (receipts.length > MAX_RECORDS) throw new Error("Recovery receipt capacity exceeded")
			for (const file of receipts) {
				try {
					const envelope = envelopeSchema.parse(this.read(path.join(directory, file)))
					if (!this.matches(envelope.identity) || file !== this.filename(envelope.record.kind, envelope.id))
						throw new Error("Receipt identity does not match its task or filename")
					this.validate(envelope.record, envelope.id)
					const key = this.key(envelope.record.kind, envelope.id)
					this.records.set(key, envelope)
					this.restored.add(key)
					if (
						(envelope.record.kind === "action" || envelope.record.kind === "command") &&
						envelope.record.snapshot.owner &&
						envelope.record.snapshot.owner !== "parent"
					)
						this.retiredOwners.add(envelope.record.snapshot.owner)
				} catch {
					this.problem(`Invalid or incompatible receipt: ${file}`)
				}
			}
			if (!this.issues.length)
				this.atomic(this.manifestPath, { version: VERSION, identity, lease: this.lease, host: this.host })
		} catch (error) {
			this.problem(`Recovery unavailable: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	get report(): { status: "available" | "blocked"; restoredRecords: number; issues: string[] } {
		return {
			status: this.issues.length ? "blocked" : "available",
			restoredRecords: this.restored.size,
			issues: [...this.issues],
		}
	}

	assertCanExecute(owner = "parent"): void {
		if (this.issues.length)
			throw new Error(`Execution blocked: persisted recovery state needs reconciliation. ${this.issues.join("; ")}`)
		const manifest = manifestSchema.parse(this.read(this.manifestPath))
		if (!this.matches(manifest.identity) || manifest.lease !== this.lease)
			throw new Error("Execution authority was replaced by another task recovery. Old callbacks cannot dispatch or write.")
		if (this.retiredOwners.has(owner))
			throw new Error("This helper belongs to an ended execution and has no recovered authority.")
	}

	get<K extends RecoveryRecord["kind"]>(kind: K, id: string): Extract<RecoveryRecord, { kind: K }> | undefined {
		const value = this.records.get(this.key(kind, id))?.record
		return value ? (structuredClone(value) as Extract<RecoveryRecord, { kind: K }>) : undefined
	}
	isRestored(kind: RecoveryRecord["kind"], id: string): boolean {
		return this.restored.has(this.key(kind, id))
	}

	entries<K extends RecoveryRecord["kind"]>(
		kind: K,
	): { id: string; record: Extract<RecoveryRecord, { kind: K }>; observedAt: number; restored: boolean }[] {
		return [...this.records.values()]
			.filter((entry) => entry.record.kind === kind)
			.map((entry) => ({
				id: entry.id,
				record: structuredClone(entry.record) as Extract<RecoveryRecord, { kind: K }>,
				observedAt: entry.observedAt,
				restored: this.restored.has(this.key(kind, entry.id)),
			}))
	}

	/** Admission is synchronous and durable before dispatch. There is no background write queue to resurrect. */
	put(id: string, record: RecoveryRecord): void {
		this.assertCanExecute()
		const key = this.key(record.kind, id)
		if (this.restored.has(key)) throw new Error("A recovered receipt is immutable; it cannot regain execution authority.")
		if (!this.records.has(key) && this.records.size >= MAX_RECORDS)
			throw new Error("Recovery receipt capacity reached. Continue in a new task after reconciliation.")
		const envelope = envelopeSchema.parse({
			version: VERSION,
			identity: this.identity,
			id,
			host: this.host,
			observedAt: Date.now(),
			record,
		})
		this.validate(envelope.record, id)
		this.atomic(path.join(this.directory, this.filename(record.kind, id)), envelope)
		this.records.set(key, envelope)
	}

	/** Post-commit persistence failure cannot replace the real result. Future dispatch fails closed. */
	observe(id: string, record: RecoveryRecord): void {
		try {
			this.put(id, record)
		} catch (error) {
			this.problem("Execution receipt could not be persisted; inspect the last saved evidence before further work.")
			Logger.warn("Execution recovery receipt unavailable:", error)
		}
	}

	private validate(record: RecoveryRecord, id: string): void {
		if ((record.kind === "command" || record.kind === "action") && record.snapshot.execution_id !== id)
			throw new Error("Execution identity mismatch")
		if (record.kind === "command" && record.snapshot.status === "completed" && record.snapshot.exit_code !== 0)
			throw new Error("Completion has no successful exit evidence")
		if (
			record.kind === "action" &&
			record.finished !==
				["completed", "failed", "not_started", "cancelled", "unconfirmed"].includes(record.snapshot.status)
		)
			throw new Error("Inconsistent action lifecycle")
		if (record.kind === "batch" && record.status !== undefined) {
			const payload = parseSubagentStatusPayload(record.status)
			if (!payload || payload.batchId !== id || payload.items.length !== JSON.parse(record.status).items.length)
				throw new Error("Invalid helper correlation")
		}
	}
	private matches(identity: RecoveryIdentity): boolean {
		return (
			identity.taskId === this.identity.taskId && identity.ulid === this.identity.ulid && identity.cwd === this.identity.cwd
		)
	}
	private key(kind: string, id: string): string {
		return `${kind}:${id}`
	}
	private filename(kind: string, id: string): string {
		return `${kind}-${executionFingerprint(id)}.json`
	}
	private problem(message: string): void {
		if (this.issues.length < 8 && !this.issues.includes(message)) this.issues.push(message)
	}
	private read(file: string): unknown {
		const stat = fs.lstatSync(file)
		if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Invalid recovery file or size")
		return JSON.parse(fs.readFileSync(file, "utf8"))
	}
	private atomic(file: string, value: unknown): void {
		const json = JSON.stringify(value)
		if (Buffer.byteLength(json) > MAX_BYTES) throw new Error("Recovery record exceeds its size limit")
		const temporary = `${file}.${randomUUID()}.tmp`
		try {
			const fd = fs.openSync(temporary, "wx", 0o600)
			try {
				fs.writeFileSync(fd, json)
				fs.fsyncSync(fd)
			} finally {
				fs.closeSync(fd)
			}
			fs.renameSync(temporary, file)
		} finally {
			fs.rmSync(temporary, { force: true })
		}
	}
}

export function restoredCommand(record: CommandRecoveryRecord, observedAt: number): CommandExecutionSnapshot {
	const saved = record.snapshot
	const unresolved = ["running", "background", "unknown", "stopping", "stop_failed"].includes(saved.status)
	return {
		...saved,
		terminal_id: undefined,
		...(unresolved
			? {
					status: "unknown" as const,
					exit_code: undefined,
					signal: undefined,
					terminal_closed: undefined,
					detail: RESTART_DETAIL,
				}
			: {}),
		recovery: saved.recovery ?? { previousStatus: saved.status, observedAt, authority: "none" },
	}
}

export function recoveredBatch(record: Extract<RecoveryRecord, { kind: "batch" }>): DietCodeSaySubagentStatus | undefined {
	const payload = parseSubagentStatusPayload(record.status)
	if (!payload) return undefined
	for (const item of payload.items)
		if (item.status === "pending" || item.status === "running") {
			item.status = "interrupted"
			item.activity = undefined
			item.error =
				"The extension host ended. This helper was not resumed. Reconcile its saved work and command IDs in the parent."
		}
	return parseSubagentStatusPayload(JSON.stringify(payload))
}

export function recoveryResult(record: Extract<RecoveryRecord, { kind: "batch" | "tool" }>): string {
	return (
		record.result ??
		"No settled result is retained for this execution. No work was replayed. Inspect get_execution_state and saved partial results before issuing a new assignment."
	)
}
