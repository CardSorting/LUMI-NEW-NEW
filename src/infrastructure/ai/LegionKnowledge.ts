import { createHash } from "node:crypto"
import * as path from "node:path"
import { Logger } from "@/shared/services/Logger"
import { dbPool } from "../db/BufferedDbPool"

const TYPE = "legion_workspace_heuristic"
const MAX_ITEMS = 20
export const LEGION_KNOWLEDGE_TTL_MS = 30 * 24 * 60 * 60 * 1000

// Conservative screening for common credential shapes. This is not a complete secret detector.
const CREDENTIAL_PATTERNS = [
	/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/,
	/\bsk-(?:proj-|ant-[A-Za-z0-9-]+-)?[A-Za-z0-9_-]{20,}\b/,
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
	/\bAIza[A-Za-z0-9_-]{30,}\b/,
	/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
	/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
	/[?&](?:token|key|sig|signature|credential|password)=[^\s&#]+/i,
]

/** Workspace-scoped observations are unverified hints, never instructions or authority. */
export function legionWorkspaceScope(cwd: string): string {
	return createHash("sha256").update(path.resolve(cwd)).digest("hex")
}

export function isReusableLegionObservation(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 500 &&
		!/[\r\n]/.test(value) &&
		!Array.from(value).some((char) => char.charCodeAt(0) <= 0x1f) &&
		!/(?:password|secret|api[_ -]?key|access[_ -]?token|bearer\s+|private[_ -]?key)/i.test(value) &&
		!CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))
	)
}

export async function recallLegionKnowledge(scope: string): Promise<string[]> {
	try {
		await dbPool.pruneExpiredAgentKnowledge(TYPE, Date.now())
	} catch (error) {
		Logger.warn("[Legion] Could not prune expired workspace observations", error)
	}
	try {
		const records = await dbPool.selectWhere("agent_knowledge", { column: "type", value: TYPE })
		return records
			.filter((row) => {
				try {
					return (
						JSON.parse(row.metadata ?? "{}").workspaceScope === scope &&
						typeof row.content === "string" &&
						isReusableLegionObservation(row.content) &&
						row.expiresAt !== null &&
						row.expiresAt > Date.now()
					)
				} catch {
					return false
				}
			})
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, MAX_ITEMS)
			.map((row) => row.content)
	} catch (error) {
		Logger.warn("[Legion] Workspace knowledge unavailable; continuing without saved observations", error)
		return []
	}
}

export async function rememberLegionKnowledge(scope: string, streamId: string, items: string[]): Promise<void> {
	const now = Date.now()
	let queued = false
	for (const item of [...new Set(items.map((value) => value.trim()))].filter(isReusableLegionObservation).slice(0, MAX_ITEMS)) {
		const id = createHash("sha256").update(`${scope}\0${item}`).digest("hex")
		try {
			await dbPool.push({
				type: "upsert",
				table: "agent_knowledge",
				layer: "infrastructure",
				values: {
					id,
					userId: "local",
					streamId,
					type: TYPE,
					content: item,
					tags: "[]",
					embedding: null,
					confidence: 0.25,
					hubScore: 0,
					expiresAt: now + LEGION_KNOWLEDGE_TTL_MS,
					metadata: JSON.stringify({ workspaceScope: scope, unverified: true }),
					createdAt: now,
				},
			})
			queued = true
		} catch (error) {
			Logger.warn("[Legion] Could not save workspace observation", error)
		}
	}
	if (queued) {
		try {
			await dbPool.flush()
		} catch (error) {
			Logger.warn("[Legion] Could not persist workspace observations", error)
		}
	}
}
