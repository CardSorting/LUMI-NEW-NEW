import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { writeAtomic } from "@utils/fs"

export function roadmapRevision(text: string | null): string {
	return text === null ? "missing" : createHash("sha256").update(text).digest("hex")
}

/** Missing and empty are different revisions. Unreadable must never mean missing. */
export async function readRoadmapDocument(workspace: string) {
	const roadmapPath = path.join(path.resolve(workspace), "ROADMAP.md")
	let text: string | null
	try {
		text = await fs.readFile(roadmapPath, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		text = null
	}
	return { roadmapPath, text: text ?? "", exists: text !== null, revision: roadmapRevision(text) }
}

/** Do not follow a root roadmap symlink when performing automatic maintenance. */
export async function assertRoadmapWritableTarget(workspace: string): Promise<void> {
	const roadmapPath = path.join(path.resolve(workspace), "ROADMAP.md")
	try {
		const stat = await fs.lstat(roadmapPath)
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new Error(`Roadmap writes require a regular file, not a symlink or directory: ${roadmapPath}`)
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
}

const pending = new Map<string, Promise<unknown>>()

/** Serialize local read/modify/write operations, including separate service instances. */
export async function withRoadmapLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = pending.get(key) ?? Promise.resolve()
	const next = previous.catch(() => undefined).then(operation)
	pending.set(key, next)
	try {
		return await next
	} finally {
		if (pending.get(key) === next) pending.delete(key)
	}
}

export function roadmapStatePath(workspace: string): string {
	return path.join(path.resolve(workspace), ".dietcode", "roadmap-state.json")
}

export async function readRoadmapState(workspace: string): Promise<Record<string, unknown>> {
	try {
		const value = JSON.parse(await fs.readFile(roadmapStatePath(workspace), "utf8"))
		return value && typeof value === "object" && !Array.isArray(value) ? value : {}
	} catch (error) {
		// State is derived from the document; missing or interrupted legacy JSON can be rebuilt.
		if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return {}
		return { _read_failed: true }
	}
}

export async function updateRoadmapState(
	workspace: string,
	update: (current: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const statePath = roadmapStatePath(workspace)
	return withRoadmapLock(statePath, async () => {
		const current = await readRoadmapState(workspace)
		const patch = await update(current)
		if (Object.entries(patch).every(([key, value]) => current[key] === value)) return current
		const merged = { ...current, ...patch, updated_at: new Date().toISOString() }
		try {
			await fs.mkdir(path.dirname(statePath), { recursive: true })
			await writeAtomic(statePath, JSON.stringify(merged, null, 2))
			return merged
		} catch {
			// Validation remains usable in this request even if its derived cache cannot be persisted.
			return { ...merged, _write_failed: true }
		}
	})
}
