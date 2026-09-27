import { getRoadmapConfig } from "./RoadmapConfig"

/**
 * @deprecated Task startup no longer performs implicit roadmap maintenance.
 * Agents may create/update ROADMAP.md within their assigned work using the normal tools.
 * Kept side-effect free for older callers; no I/O can delay startup or outlive cancellation.
 */
export async function initRoadmapSession(workspace: string, taskId?: string): Promise<Record<string, unknown> | null> {
	if (!getRoadmapConfig().enabled) return null
	return { workspace, taskId: taskId || null, roadmap_mode: "advisory" }
}

/** @deprecated Completion and cancellation require no roadmap finalization. */
export async function finalizeRoadmapSession(_workspace: string, _taskId?: string): Promise<void> {}
