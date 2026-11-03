import { createHash } from "node:crypto"
import { dbPool } from "../db/BufferedDbPool"
import { getPersistentDb } from "../db/Config"

export interface LegionOperationReceipt {
	tool: string
	paths: string[]
	status: "started" | "returned" | "uncertain"
	startedAt: number
	finishedAt?: number
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
	const receipt: LegionOperationReceipt = {
		tool,
		paths: [...new Set(paths)].slice(0, 20).map((path) => path.slice(0, 512)),
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
	await dbPool.flush()
	const db = await getPersistentDb()
	await db
		.updateTable("agent_memory")
		.set({ value: JSON.stringify({ ...receipt, status, finishedAt: Date.now() }), updatedAt: Date.now() })
		.where("streamId", "=", streamId)
		.where("key", "=", receiptKey(callId))
		.execute()
}

/** Metadata only: tool inputs and file contents are intentionally not retained. */
export async function getLegionOperationEvidence(streamIds: string[]): Promise<LegionOperationReceipt[]> {
	if (!streamIds.length) return []
	await dbPool.flush()
	const db = await getPersistentDb()
	const rows = await db
		.selectFrom("agent_memory")
		.select("value")
		.where("streamId", "in", streamIds)
		.where("key", "like", "legion_op:%")
		.orderBy("updatedAt", "desc")
		.limit(50)
		.execute()
	return rows.flatMap((row) => {
		try {
			return [JSON.parse(row.value) as LegionOperationReceipt]
		} catch {
			return []
		}
	})
}

/** Detect a persisted formation decision even if the process died before creating the manifest. */
export async function hasLegionFormationIntent(parentStreamId: string): Promise<boolean> {
	await dbPool.flush()
	const db = await getPersistentDb()
	return !!(await db
		.selectFrom("agent_memory")
		.select("key")
		.where("streamId", "=", parentStreamId)
		.where("key", "like", "legion_auto_formation:%")
		.limit(1)
		.executeTakeFirst())
}
