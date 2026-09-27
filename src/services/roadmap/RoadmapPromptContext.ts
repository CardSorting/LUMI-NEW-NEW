import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { getRoadmapConfig } from "./RoadmapConfig"
import { roadmapRevision } from "./RoadmapDocument"
import { getSectionBody } from "./RoadmapSchema"

export const ROADMAP_CONTEXT_BUDGET_MS = 100
const MAX_CONTEXT_BYTES = 256 * 1024
const MAX_PENDING_READS = 16
const pending = new Map<string, Promise<Record<string, unknown> | null>>()

/** A read-only observation: no git scans, schema repair, state writes, or skill installation. */
async function readContext(workspace: string): Promise<Record<string, unknown> | null> {
	const roadmapPath = path.join(workspace, "ROADMAP.md")
	// Nonblocking/no-follow avoids hanging on named pipes or following an unexpected symlink.
	const handle = await fs.open(roadmapPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
	try {
		const before = await handle.stat()
		if (!before.isFile() || before.size > MAX_CONTEXT_BYTES) return null
		const buffer = Buffer.alloc(before.size + 1)
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
		const after = await handle.stat()
		if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null
		// An atomic replacement/deletion changes the directory entry, not this open handle.
		const current = await fs.lstat(roadmapPath)
		if (
			!current.isFile() ||
			current.ino !== after.ino ||
			current.dev !== after.dev ||
			current.mtimeMs !== after.mtimeMs ||
			current.size !== after.size
		)
			return null
		const content = buffer.subarray(0, bytesRead).toString("utf8")
		const excerpt = (section: string) => getSectionBody(content, section).trim().slice(0, 1600)
		return {
			enabled: true,
			success: true,
			roadmap_mode: "advisory",
			workspace,
			roadmap_path: roadmapPath,
			roadmap_exists: true,
			document_revision: roadmapRevision(content),
			project_identity_line: /^#\s+(.+)$/m.exec(content)?.[1]?.slice(0, 180) || path.basename(workspace),
			center_of_gravity_excerpt: excerpt("1. Project Center of Gravity"),
			now_excerpt: excerpt("4. Now"),
			agent_next_call: "",
			required_action: null,
			completion_ready: true,
			kanban_complete_allowed: true,
		}
	} finally {
		await handle.close()
	}
}

/**
 * Optional prompt context has a fixed latency budget, not a dependency on diagnostics.
 * Concurrent readers share one deadline. A stuck read occupies one bounded slot until it
 * settles; subsequent turns do not pile up more reads. Late results are discarded, never
 * cached as current context. Each settled observation is reread on the next request.
 */
export function getRoadmapPromptContext(workspace: string): Promise<Record<string, unknown> | null> {
	if (!getRoadmapConfig().enabled) return Promise.resolve(null)
	const key = path.resolve(workspace)
	const existing = pending.get(key)
	if (existing) return existing
	if (pending.size >= MAX_PENDING_READS) return Promise.resolve(null)

	let timer: ReturnType<typeof setTimeout>
	const deadline = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), ROADMAP_CONTEXT_BUDGET_MS)
	})
	const read = readContext(key).catch(() => null)
	const result = Promise.race([read, deadline])
	pending.set(key, result)
	void read.finally(() => {
		clearTimeout(timer)
		if (pending.get(key) === result) pending.delete(key)
	})
	return result
}
