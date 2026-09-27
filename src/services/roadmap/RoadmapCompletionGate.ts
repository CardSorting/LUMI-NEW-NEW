import type { RoadmapConfig } from "./RoadmapConfig"

export interface RoadmapCompletionBlock {
	blocked: boolean
	message?: string
	retryCommand?: string
	blockingGates?: Array<{ id?: string; label: string; why: string; fix: string }>
}

/**
 * @deprecated Compatibility API for older integrations. Roadmap findings are advisory.
 * Completion must never load roadmap status, perform filesystem I/O, or schedule repairs.
 */
export async function evaluateRoadmapCompletionBlock(
	_workspace: string,
	_status?: Record<string, unknown>,
): Promise<RoadmapCompletionBlock> {
	return { blocked: false }
}

/** @deprecated No checkpoint is required to finish a task. */
export async function requireFreshCheckpointBeforeComplete(_workspace: string): Promise<string | null> {
	return null
}

/** @deprecated Retained for integrations that display an unavailable-context notice. */
export function failClosedCompletionMessage(): string {
	return "Roadmap context unavailable. Continue scoped work; no roadmap repair is required to finish."
}

/** @deprecated Schema findings do not block task completion. */
export function isGateBlockingSchema(_closedGates: Array<{ id?: string }>, _cfg?: RoadmapConfig): boolean {
	return false
}
