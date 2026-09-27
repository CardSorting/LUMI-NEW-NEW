import * as path from "path"
import { formatRoadmapSteeringBlock } from "./RoadmapAgentSteering"
import { getRoadmapConfig } from "./RoadmapConfig"
import { getRoadmapPromptContext } from "./RoadmapPromptContext"
import { RoadmapService } from "./RoadmapService"
import { WORKSPACE_SKILL_REL } from "./RoadmapSkillInstall"
import { invalidateSnapshotCache } from "./RoadmapSnapshot"

export function invalidateSessionBriefCache(workspace?: string): void {
	invalidateSnapshotCache(workspace)
}

export async function sessionBrief(workspace: string, forceRefresh = false): Promise<Record<string, unknown> | null> {
	const cfg = getRoadmapConfig()
	if (!cfg.enabled) {
		return null
	}

	// Cache evidence in the service, never a completion decision or next action.
	if (forceRefresh) invalidateSnapshotCache(workspace)

	try {
		const status = await RoadmapService.getInstance().getOperationalStatus(workspace, "", "light")
		const gate = (status.roadmap_gate || {}) as Record<string, unknown>
		const nextRec = (status.recommended_next_action || {}) as Record<string, unknown>
		const hints = (status._roadmap_operator_hints || {}) as Record<string, unknown>

		const brief: Record<string, unknown> = {
			enabled: true,
			success: true,
			workspace,
			roadmap_path: path.join(workspace, "ROADMAP.md"),
			skill_path: WORKSPACE_SKILL_REL,
			phase: status.phase,
			roadmap_exists: status.roadmap_exists,
			health_status: status.health_status,
			code_soup_risk: status.code_soup_risk,
			schema_valid: status.schema_valid,
			validation_pending: status.validation_pending,
			bootstrap_complete: status.bootstrap_complete,
			bootstrap_placeholder_count: status.bootstrap_placeholder_count,
			recent_checkpoint_date: status.recent_checkpoint_date,
			now_item_count: status.now_item_count,
			last_validated_at: (status.workspace_state as Record<string, unknown>)?.last_validated_at,
			last_mutated_at: (status.workspace_state as Record<string, unknown>)?.last_mutated_at,
			steering_brief: status.steering_brief,
			stack_summary: status.stack_summary,
			project_archetype: status.project_archetype,
			project_fingerprint: status.project_fingerprint,
			project_identity_line: status.project_identity_line,
			project_steering_digest: status.project_steering_digest,
			steering_line: status.steering_line || status.project_identity_line,
			operator_summary: status.operator_summary,
			agent_next_call: status.agent_next_call ?? nextRec.command ?? "",
			recommended_next_action: status.recommended_next_action,
			roadmap_gate: gate,
			kanban_complete_allowed: status.kanban_complete_allowed,
			completion_ready: status.completion_ready,
			required_action: status.required_action,
			advisory_actions: status.advisory_actions,
			stop_reason: status.stop_reason,
			progress_evidence: status.progress_evidence,
			first_call: status.agent_next_call ?? nextRec.command ?? "",
			prime_directive: status.prime_directive,
			agent_playbook: status.agent_playbook,
			operator_playbook: status.operator_playbook,
			_roadmap_operator_hints: hints,
		}

		return brief
	} catch (error) {
		return {
			enabled: cfg.enabled,
			success: false,
			error: error instanceof Error ? error.message : String(error),
			first_call: "",
			agent_next_call: "",
			stop_reason: "Roadmap context unavailable. Continue scoped work; retry only after the reported cause changes.",
		}
	}
}

export function formatRoadmapEnvironmentSection(brief: Record<string, unknown>): string {
	return formatRoadmapSteeringBlock(brief)
}

export async function getRoadmapEnvironmentSection(workspace: string): Promise<string> {
	const cfg = getRoadmapConfig()
	if (!cfg.enabled) {
		return ""
	}
	const brief = await getRoadmapPromptContext(workspace)
	if (!brief || brief.success === false) {
		return ""
	}
	return `\n\n${formatRoadmapEnvironmentSection(brief)}`
}
