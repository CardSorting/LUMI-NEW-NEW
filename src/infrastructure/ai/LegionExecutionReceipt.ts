import { createHash } from "node:crypto"
import { sql } from "kysely"
import { dbPool } from "../db/BufferedDbPool"
import { getPersistentDb } from "../db/Config"

export interface LegionOperationReceipt {
	tool: string
	paths: string[]
	pathsTruncated?: boolean
	status: "started" | "returned" | "uncertain"
	startedAt: number
	finishedAt?: number
}

export interface LegionOperationEvidence {
	receipts: Array<LegionOperationReceipt & { streamId: string; receiptId?: string; malformed?: boolean }>
	truncated: boolean
}

/** Bound untrusted metadata before embedding it in the specialist handoff. */
export function formatLegionOperationEvidence(evidence: LegionOperationEvidence): string {
	const receipts: Array<Record<string, unknown>> = []
	let detailsTruncated = false
	const render = () =>
		JSON.stringify({
			receipts,
			omitted_receipts: evidence.receipts.length - receipts.length,
			additional_receipts_omitted: evidence.truncated,
			details_truncated: detailsTruncated,
		}).replace(/[<>&]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
	for (const receipt of evidence.receipts) {
		const clipped =
			receipt.pathsTruncated === true ||
			receipt.streamId.length > 128 ||
			receipt.tool.length > 120 ||
			receipt.paths.length > 3 ||
			receipt.paths.some((path) => path.length > 160)
		const previousTruncated = detailsTruncated
		detailsTruncated ||= clipped
		receipts.push({
			streamId: receipt.streamId.slice(0, 128),
			...(receipt.receiptId && /^[a-f0-9]{64}$/.test(receipt.receiptId) ? { receiptId: receipt.receiptId } : {}),
			tool: receipt.tool.slice(0, 120),
			paths: receipt.paths.slice(0, 3).map((path) => path.slice(0, 160)),
			...(receipt.pathsTruncated ? { pathsTruncated: true } : {}),
			status: receipt.status,
			startedAt: receipt.startedAt,
			...(receipt.finishedAt !== undefined ? { finishedAt: receipt.finishedAt } : {}),
			...(receipt.malformed ? { malformed: true } : {}),
			...(clipped ? { details_truncated: true } : {}),
		})
		if (Buffer.byteLength(render(), "utf8") > 8000) {
			receipts.pop()
			detailsTruncated = previousTruncated
			break
		}
	}
	return render()
}

function receiptKey(callId: string): string {
	return `legion_op:${createHash("sha256").update(callId).digest("hex")}`
}

/** Persist before execution. A reused call ID is never dispatched again. */
export async function beginLegionOperation(
	streamId: string,
	callId: string,
	tool: string,
	input: unknown,
): Promise<LegionOperationReceipt> {
	const args = input as { path?: unknown; file_path?: unknown; filePath?: unknown; input?: unknown }
	const rawPath =
		typeof args?.path === "string"
			? args.path
			: typeof args?.file_path === "string"
				? args.file_path
				: typeof args?.filePath === "string"
					? args.filePath
					: undefined
	const paths = rawPath ? [rawPath] : []
	if (tool === "apply_patch" && typeof args?.input === "string") {
		for (const match of args.input.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+)$/gm))
			paths.push(match[1].trim())
	}
	const uniquePaths = [...new Set(paths)]
	const receipt: LegionOperationReceipt = {
		tool,
		paths: uniquePaths.slice(0, 20).map((path) => path.slice(0, 512)),
		...(uniquePaths.length > 20 || uniquePaths.some((path) => path.length > 512) ? { pathsTruncated: true } : {}),
		status: "started",
		startedAt: Date.now(),
	}
	await dbPool.flush()
	const db = await getPersistentDb()
	const inserted = await db
		.insertInto("agent_memory")
		.values({ streamId, key: receiptKey(callId), value: JSON.stringify(receipt), updatedAt: Date.now() })
		.onConflict((conflict) => conflict.columns(["streamId", "key"]).doNothing())
		.executeTakeFirst()
	if (inserted.numInsertedOrUpdatedRows !== 1n)
		throw new Error("Specialist operation ID already recorded; reconcile before retrying")
	return receipt
}

export async function finishLegionOperation(
	streamId: string,
	callId: string,
	receipt: LegionOperationReceipt,
	status: "returned" | "uncertain",
): Promise<void> {
	if (receipt.status !== "started") throw new Error("Specialist operation receipt is not in the started state")
	await dbPool.flush()
	const db = await getPersistentDb()
	const updated = await db
		.updateTable("agent_memory")
		.set({ value: JSON.stringify({ ...receipt, status, finishedAt: Date.now() }), updatedAt: Date.now() })
		.where("streamId", "=", streamId)
		.where("key", "=", receiptKey(callId))
		.where("value", "=", JSON.stringify(receipt))
		.executeTakeFirst()
	if (updated.numUpdatedRows !== 1n)
		throw new Error("Specialist operation receipt is missing or already settled; reconcile before retrying")
}

/** Metadata only: tool inputs and file contents are intentionally not retained. */
export async function getLegionOperationEvidence(streamIds: string[]): Promise<LegionOperationEvidence> {
	if (!streamIds.length) return { receipts: [], truncated: false }
	await dbPool.flush()
	const db = await getPersistentDb()
	const rows = await db
		.selectFrom("agent_memory")
		.select(["streamId", "key", "value"])
		.where("streamId", "in", streamIds)
		.where("key", "like", "legion_op:%")
		.orderBy(
			sql<number>`CASE WHEN json_valid(value) = 0 THEN 0
				WHEN json_extract(value, '$.status') = 'returned'
					AND json_type(value, '$.tool') = 'text'
					AND json_type(value, '$.paths') = 'array'
					AND NOT EXISTS (SELECT 1 FROM json_each(agent_memory.value, '$.paths') WHERE type <> 'text')
					AND (json_type(value, '$.pathsTruncated') IS NULL OR json_type(value, '$.pathsTruncated') IN ('true', 'false'))
					AND json_type(value, '$.startedAt') IN ('integer', 'real')
					AND abs(json_extract(value, '$.startedAt')) <= 1.7976931348623157e308
					AND json_type(value, '$.finishedAt') IN ('integer', 'real')
					AND abs(json_extract(value, '$.finishedAt')) <= 1.7976931348623157e308
				THEN 1 ELSE 0 END`,
			"asc",
		)
		.orderBy("updatedAt", "desc")
		.limit(51)
		.execute()
	const receipts = rows.slice(0, 50).map((row) => {
		// The stable reference identifies this stored receipt without exposing a tool-call ID.
		const receiptId = createHash("sha256").update(row.streamId).update("\0").update(row.key).digest("hex")
		let parsed: unknown
		try {
			parsed = JSON.parse(row.value)
			const value = parsed as LegionOperationReceipt
			if (
				!value ||
				typeof value.tool !== "string" ||
				!Array.isArray(value.paths) ||
				!value.paths.every((path) => typeof path === "string") ||
				(value.pathsTruncated !== undefined && typeof value.pathsTruncated !== "boolean") ||
				!Number.isFinite(value.startedAt) ||
				!["started", "returned", "uncertain"].includes(value.status) ||
				(value.status !== "started" && value.finishedAt === undefined) ||
				(value.finishedAt !== undefined && !Number.isFinite(value.finishedAt))
			)
				throw new Error("Malformed receipt")
			return {
				streamId: row.streamId,
				receiptId,
				tool: value.tool.slice(0, 120),
				paths: value.paths.slice(0, 20).map((path) => path.slice(0, 512)),
				...(value.pathsTruncated || value.paths.length > 20 || value.paths.some((path) => path.length > 512)
					? { pathsTruncated: true }
					: {}),
				status: value.status,
				startedAt: value.startedAt,
				...(value.finishedAt !== undefined ? { finishedAt: value.finishedAt } : {}),
			}
		} catch {
			const partial = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
			return {
				streamId: row.streamId,
				receiptId,
				tool: typeof partial?.tool === "string" ? partial.tool.slice(0, 120) : "Unreadable receipt",
				paths: Array.isArray(partial?.paths)
					? partial.paths
							.filter((path): path is string => typeof path === "string")
							.slice(0, 20)
							.map((path) => path.slice(0, 512))
					: [],
				...(partial?.pathsTruncated === true ||
				(Array.isArray(partial?.paths) &&
					(partial.paths.length > 20 || partial.paths.some((path) => typeof path === "string" && path.length > 512)))
					? { pathsTruncated: true }
					: {}),
				status: "uncertain" as const,
				startedAt: typeof partial?.startedAt === "number" && Number.isFinite(partial.startedAt) ? partial.startedAt : 0,
				malformed: true,
			}
		}
	})
	return { receipts, truncated: rows.length > 50 }
}

/** Detect a persisted formation decision even if the process died before creating the manifest. */
export async function hasLegionFormationIntent(parentStreamId: string): Promise<boolean> {
	await dbPool.flush()
	const db = await getPersistentDb()
	return !!(await db
		.selectFrom("agent_memory")
		.select("key")
		.where("streamId", "=", parentStreamId)
		.where((eb) => eb.or([eb("key", "like", "legion_auto_formation:%"), eb("key", "=", "legion_formation_reservation")]))
		.limit(1)
		.executeTakeFirst())
}

/** An outstanding reservation may belong to a newer attempt than the last saved manifest. */
export async function hasOutstandingFormationReservation(parentStreamId: string): Promise<boolean> {
	await dbPool.flush()
	const db = await getPersistentDb()
	return !!(await db
		.selectFrom("agent_memory")
		.select("key")
		.where("streamId", "=", parentStreamId)
		.where("key", "=", "legion_formation_reservation")
		.executeTakeFirst())
}
