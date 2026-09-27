/** Unified evidence invalidation. Session decisions are always live. */

import { invalidateSnapshotCache } from "./RoadmapSnapshot"

export function invalidateRoadmapWorkspaceCache(workspace?: string): void {
	invalidateSnapshotCache(workspace)
}
