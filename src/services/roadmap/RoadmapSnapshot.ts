import * as path from "path"
import { getRoadmapConfig } from "./RoadmapConfig"
import { readRoadmapDocument } from "./RoadmapDocument"

export type EvidenceTier = "light" | "standard" | "full"

export interface WorkspaceSnapshot {
	workspace: string
	tier: EvidenceTier
	evidence: Record<string, unknown>
	cachedAt: number
}

// Cache expensive evidence, never decisions about current content or policy.
const snapshotCache = new Map<string, WorkspaceSnapshot>()
const MAX_SNAPSHOTS = 64

export async function getCachedSnapshotKey(workspace: string, tier: EvidenceTier): Promise<string> {
	return (await buildSnapshotKey(workspace, tier)).key
}

export function getSnapshotFromCache(key: string): WorkspaceSnapshot | undefined {
	const entry = snapshotCache.get(key)
	if (!entry) return undefined
	const ttlMs = getRoadmapConfig().evidence_cache_ttl_seconds * 1000
	if (Date.now() - entry.cachedAt >= ttlMs) {
		snapshotCache.delete(key)
		return undefined
	}
	return structuredClone(entry)
}

export function setSnapshotCache(key: string, snapshot: WorkspaceSnapshot): void {
	snapshotCache.delete(key)
	snapshotCache.set(key, structuredClone(snapshot))
	while (snapshotCache.size > MAX_SNAPSHOTS) {
		const oldest = snapshotCache.keys().next()
		if (oldest.done) break
		snapshotCache.delete(oldest.value)
	}
}

export function invalidateSnapshotCache(workspace?: string): void {
	if (!workspace) {
		snapshotCache.clear()
		return
	}
	const prefix = `${path.resolve(workspace)}::`
	for (const key of snapshotCache.keys()) {
		if (key.startsWith(prefix)) {
			snapshotCache.delete(key)
		}
	}
}

export async function buildSnapshotKey(workspace: string, tier: EvidenceTier) {
	const document = await readRoadmapDocument(workspace)
	return { ...document, key: `${path.resolve(workspace)}::${tier}::${document.revision}` }
}
