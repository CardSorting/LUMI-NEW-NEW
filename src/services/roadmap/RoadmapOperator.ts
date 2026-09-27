import * as path from "path"
import { REQUIRED_SECTIONS } from "./RoadmapSchema"

export const OPERATOR_PLAYBOOK = `
Auto-rolling roadmap checkpoint (operators)

The roadmap is the project's steering surface — not a backlog or wishlist.

| Your job | Command |
|----------|---------|
| See one-screen status | /roadmap cockpit or roadmap(action='cockpit') |
| Check production health | /roadmap doctor or roadmap(action='doctor') |
| Gather evidence for roadmap work | roadmap(action='checkpoint') |
| Inspect document structure (optional) | /roadmap validate or roadmap(action='validate') |
| Bootstrap placeholders remain | roadmap(action='apply_bootstrap_fill', context='write') |
| Explain advisory findings | /roadmap explain-gate or roadmap(action='explain_gate') |
| Checkpoint outdated vs git activity | /roadmap explain-stale or roadmap(action='explain_stale') |
| Activity timeline | /roadmap progress --timeline |

Write guard: ROADMAP.md only at workspace root — out-of-tree writes blocked at pre_tool_call.
`.trim()

export const AGENT_PLAYBOOK = `
Roadmap workflow (agents)

1. Use roadmap(action='guide') when roadmap context is relevant to the assignment.
2. For a requested checkpoint or meaningful direction change, gather evidence once with roadmap(action='checkpoint').
3. Edit only affected sections of ROADMAP.md at the workspace root. Non-goals and template suggestions are advisory; do not invent constraints.
4. Live status checks the current revision automatically. Inspect roadmap(action='validate') only when document diagnostics are useful; no validation is required to finish a task.
5. Roadmap findings are advisory, including missing sections, incomplete bootstrap, checkpoint age, and diagnostic errors. They never restrict task completion.
6. Finish with the outcome and any unresolved limitations. Do not repeat checkpoints, audits, or passing tests without new evidence.

Keep Now focused on the current work. Review section 9 only when architecture or risk changes. Use the smallest relevant verification; research-only tasks do not require test runs. If an unchanged failure cannot be repaired, report the blocker instead of looping.

Reuse the workspace evidence already gathered. A workspace containing only ROADMAP.md is a new project; proceed with the requested implementation or ask for essential missing requirements. Repeated planning, unchanged workspace scans, and roadmap activity timestamps are not progress. Finish the assigned outcome before considering any other Now/Next/Later item; the roadmap does not authorize continuing into new work.

Authority: perform routine, reversible roadmap repairs and evidence-backed updates within the user's assigned task without asking for ceremonial approval. Preserve user-authored history, explicit non-goals, permissions and scope. Do not fabricate project decisions or mark incomplete work complete. Ask only for a genuinely missing decision or permission.

Navigation: there are no roadmap prerequisites. required_action is always null and agent_next_call is empty. advisory_actions are optional context, not a new assignment. Resume or finish the assigned task after each observation. Timestamps, journal activity, and rereading the same revision never authorize another pass. Retry a failed repair only after its cause or the document revision changes.
`.trim()

export interface GateSnapshot {
	workspace?: string
	roadmap_present?: boolean
	schema_valid?: boolean | null
	kanban_complete_allowed?: boolean
	validation_pending?: boolean
	checkpoint_stale?: boolean
	bootstrap_complete?: boolean
	bootstrap_placeholder_count?: number
	blocking_gates?: Array<{ id?: string; label?: string; why?: string; fix?: string; blocks_kanban_complete?: boolean }>
	closed_gates?: Array<{ id?: string; label?: string; why?: string; fix?: string; blocks_kanban_complete?: boolean }>
	workspace_state?: Record<string, unknown>
	roadmap_path?: string
}

export function isBootstrapIncomplete(params: {
	roadmap_exists?: boolean
	bootstrap_complete?: boolean | null
	bootstrap_placeholder_count?: number | null
	workspace_state?: Record<string, unknown>
}): boolean {
	if (!params.roadmap_exists) return false
	const ws = params.workspace_state || {}
	const complete =
		params.bootstrap_complete !== undefined && params.bootstrap_complete !== null
			? params.bootstrap_complete
			: ws.bootstrap_complete
	const count =
		params.bootstrap_placeholder_count !== undefined && params.bootstrap_placeholder_count !== null
			? params.bootstrap_placeholder_count
			: (ws.bootstrap_placeholder_count as number | undefined)
	if (complete === false) return true
	if (complete === true) return false
	return !!(count && count > 0)
}

export function determinePhase(params: {
	roadmap_exists: boolean
	sections_missing: string[]
	health_status: string | null
	validation_valid: boolean | undefined
	bootstrap_incomplete: boolean
}): { phase: string; operator_summary: string; agent_next_call: string; agent_blocked: boolean } {
	if (params.roadmap_exists && params.validation_valid === false) {
		return {
			phase: "structure_repair",
			operator_summary: "ROADMAP.md has structural findings; repair only if relevant to the assigned work.",
			agent_next_call: "",
			agent_blocked: false,
		}
	}
	if (!params.roadmap_exists) {
		return {
			phase: "bootstrap",
			operator_summary: "No ROADMAP.md. Continue the assigned task; create one only when useful to that work.",
			agent_next_call: "",
			agent_blocked: false,
		}
	}
	if (params.bootstrap_incomplete) {
		return {
			phase: "bootstrap_fill",
			operator_summary:
				"Bootstrap template phrases remain. Evidence-based autofill is available when relevant; missing decisions need not be invented.",
			agent_next_call: "",
			agent_blocked: false,
		}
	}
	if (params.sections_missing.length > 6) {
		return {
			phase: "structure_repair",
			operator_summary: `ROADMAP.md missing ${params.sections_missing.length} sections — repair schema without losing history.`,
			agent_next_call: "",
			agent_blocked: false,
		}
	}
	if (params.health_status && ["Fragmenting", "Overloaded", "Blocked", "Drifting"].includes(params.health_status)) {
		return {
			phase: "coherence_recovery",
			operator_summary: `Roadmap health is ${params.health_status}; consider this context when choosing relevant work.`,
			agent_next_call: "",
			agent_blocked: false,
		}
	}
	return {
		phase: "checkpoint",
		operator_summary: "Roadmap present — continue the assigned task. Checkpoint after meaningful direction or risk changes.",
		agent_next_call: "",
		agent_blocked: false,
	}
}

export function roadmapToolCommandToSlash(command?: string): string {
	const raw = String(command || "").trim()
	if (!raw) return ""
	if (raw.startsWith("/roadmap")) return raw

	const actionMatch = /roadmap\(action='([^']+)'(?:,\s*context='([^']*)')?\)/.exec(raw)
	if (!actionMatch) return "/roadmap cockpit"

	const action = actionMatch[1].replace(/_/g, "-")
	const context = actionMatch[2]?.trim()
	if (context) return `/roadmap ${action} ${context}`
	return `/roadmap ${action}`
}

export function recommendNextAction(params: {
	phase?: string
	roadmap_exists?: boolean
	schema_valid?: boolean | null
	stale?: boolean
	validation_pending?: boolean
	bootstrap_incomplete?: boolean
	last_error?: Record<string, unknown> | null
}): { action: string; command: string; detail: string } {
	return {
		action: "continue_task",
		command: "",
		detail: params.last_error
			? "Roadmap diagnostics are unavailable. Continue the assigned task; retry only if relevant and the cause changes."
			: "Roadmap findings are advisory. Continue or finish the assigned task; no further roadmap call is required.",
	}
}

export function formatExplainGateReport(params: {
	workspace?: string
	closed_gates?: Array<Record<string, unknown>>
	open_gates?: string[]
	blocking_gates?: Array<Record<string, unknown>>
	kanban_complete_allowed?: boolean
	validation?: Record<string, unknown>
	freshness?: Record<string, unknown>
}): string {
	const lines = [
		"🗺️ Roadmap findings (advisory)",
		`Workspace: ${params.workspace || "(auto)"}`,
		"No roadmap finding blocks task completion.",
		"",
	]

	const closed = params.closed_gates || params.blocking_gates || []
	if (closed.length > 0 || params.open_gates) {
		lines.push(`Findings: ${closed.length}; checks without findings: ${(params.open_gates || []).length}`)
		if (closed.length > 0) {
			lines.push("")
			for (const item of closed) {
				lines.push(`Advisory — ${item.label}: ${item.why}`)
				lines.push(`   Optional action: ${item.fix}`)
			}
		} else {
			lines.push("No roadmap findings.")
		}
		lines.push("")
		lines.push("Continue or finish the assigned task.")
		return lines.join("\n")
	}

	if (params.validation) {
		lines.push(`Schema valid: ${params.validation.valid}`)
		const issues = (params.validation.issues as unknown[]) || []
		if (issues.length > 0) {
			lines.push("", "Schema issues:")
			for (const issue of issues.slice(0, 8)) {
				const i = issue as Record<string, unknown>
				lines.push(`  • [${i.severity}] ${i.message}`)
			}
		}
		lines.push("", "Fix: edit ROADMAP.md, then roadmap(action='validate')")
	}

	if (params.freshness) {
		lines.push("", `Checkpoint stale: ${params.freshness.stale}`, `Reason: ${params.freshness.reason}`)
		if (params.freshness.summary) lines.push(String(params.freshness.summary))
	}

	return lines.join("\n")
}

export function buildAgentOperatorHints(params: {
	action?: string
	gate?: GateSnapshot | null
	workspace?: string
	last_error?: Record<string, unknown> | null
	operator_summary?: string
	agent_next_call?: string
	recommended_next_action?: { command?: string; detail?: string }
	project_steering_digest?: Record<string, unknown>
	bootstrap_fill_hint?: string
}): Record<string, unknown> {
	const snap = params.gate || {}
	const wsState = (snap.workspace_state || {}) as Record<string, unknown>
	const bootstrapInc = isBootstrapIncomplete({
		roadmap_exists: !!snap.roadmap_present,
		bootstrap_complete: snap.bootstrap_complete,
		bootstrap_placeholder_count: snap.bootstrap_placeholder_count,
		workspace_state: wsState,
	})
	const workspace = params.workspace || snap.workspace || ""
	const roadmapPath = snap.roadmap_path || (workspace ? path.join(workspace, "ROADMAP.md") : undefined)

	const nextRec =
		params.recommended_next_action ||
		recommendNextAction({
			phase: String(wsState.phase || ""),
			roadmap_exists: params.gate ? !!snap.roadmap_present : true,
			schema_valid: snap.schema_valid,
			stale: !!snap.checkpoint_stale,
			validation_pending: !!(snap.validation_pending || wsState.validation_pending),
			bootstrap_incomplete: bootstrapInc,
			last_error: params.last_error,
		})

	const digest = params.project_steering_digest || {}
	const hints: Record<string, unknown> = {
		preferred_tool: "roadmap",
		skill: "auto-rolling-roadmap",
		workspace: workspace || undefined,
		roadmap_path: roadmapPath,
		write_guard: roadmapPath
			? `ROADMAP.md lives only at ${roadmapPath}`
			: "ROADMAP.md must be written at the project workspace root",
		roadmap_mode: "advisory",
		kanban_complete_allowed: true,
		validation_pending: !!snap.validation_pending,
		preferred_command: "",
		slash_commands: [
			"/roadmap cockpit",
			"/roadmap explain-gate",
			"/roadmap explain-stale",
			"/roadmap progress --current",
			...(bootstrapInc ? ["/roadmap validate", "roadmap(action='apply_bootstrap_fill', context='write')"] : []),
		],
		next_action: "",
		recovery_suggestion: params.operator_summary || nextRec.detail,
		suggested_slash_command: "",
		diagnostic_command: "roadmap(action='explain_gate')",
		project_steering_digest: digest,
		project_identity_line: digest.identity_line,
		verification_commands: digest.verification_commands,
	}

	if (params.bootstrap_fill_hint) {
		hints.bootstrap_fill_hint = params.bootstrap_fill_hint
	}

	if (params.last_error) {
		hints.retry_command = params.last_error.retry_command
		hints.safe_to_retry = params.last_error.safe_to_retry
	}

	return hints
}

export function wrapClarityEnvelope(
	payload: Record<string, unknown>,
	phaseInfo?: Record<string, unknown>,
): Record<string, unknown> {
	const rawGate = (payload.roadmap_gate || null) as GateSnapshot | null
	// Normalize legacy snapshots too: stale gate flags must never resurrect authority.
	const advisory = (rawGate?.closed_gates || rawGate?.blocking_gates || []).map((item) => ({
		...item,
		blocks_kanban_complete: false,
	}))
	const gate = rawGate
		? {
				...rawGate,
				mode: "advisory",
				findings: advisory,
				closed_gates: advisory,
				blocking_gates: [],
				blocking_gate_count: 0,
				kanban_complete_allowed: true,
				preferred_command: "",
			}
		: null
	payload = {
		...payload,
		...(gate ? { roadmap_gate: gate } : {}),
		roadmap_mode: "advisory",
		kanban_complete_allowed: true,
		completion_ready: true,
		agent_blocked: false,
		agent_status: advisory.length ? "ready_with_advisories" : "ready",
		required_action: null,
		advisory_actions: advisory,
		agent_next_call: "",
		first_call: "",
		recommended_next_action: recommendNextAction({ last_error: payload.last_error as Record<string, unknown> | null }),
		stop_reason: "Continue or finish the assigned task. Roadmap findings never require another call or expand scope.",
	}
	if (gate) {
		const state = gate.workspace_state || {}
		if (typeof state.observed_revision === "string") {
			payload.progress_evidence = {
				version: 1,
				workspace: gate.workspace,
				document_revision: state.observed_revision,
				validated_revision: state.validated_revision,
				schema_valid: gate.schema_valid,
				bootstrap_placeholder_count: gate.bootstrap_placeholder_count,
				blocking_gates: [],
			}
		}
	}
	const digest = (payload.project_steering_digest || {}) as Record<string, unknown>
	const operatorHints = buildAgentOperatorHints({
		action: String(payload.action || ""),
		gate,
		workspace: String(payload.workspace || ""),
		last_error: (payload.last_error as Record<string, unknown>) || null,
		operator_summary: String(payload.operator_summary || ""),
		agent_next_call: payload.agent_next_call as string | undefined,
		recommended_next_action: payload.recommended_next_action as { command?: string; detail?: string },
		project_steering_digest: digest,
		bootstrap_fill_hint: payload.bootstrap_fill_plan
			? `${(payload.bootstrap_fill_plan as Record<string, unknown>).remaining_count || 0} bootstrap phrase(s) — roadmap(action='apply_bootstrap_fill', context='write')`
			: undefined,
	})

	const identity =
		payload.project_identity_line || operatorHints.project_identity_line || digest.identity_line || payload.steering_brief

	return {
		...(phaseInfo || {}),
		...payload,
		success: payload.success ?? payload.ok ?? true,
		ok: payload.ok ?? payload.success ?? true,
		execution_path: "roadmap_checkpoint",
		agent_playbook: AGENT_PLAYBOOK,
		operator_playbook: OPERATOR_PLAYBOOK,
		required_section_count: REQUIRED_SECTIONS.length,
		steering_line: payload.steering_line || identity,
		project_identity_line: identity,
		_roadmap_operator_hints: {
			...operatorHints,
			skill_path: payload.skill_path,
			recovery_suggestion: operatorHints.recovery_suggestion || phaseInfo?.operator_summary || payload.operator_summary,
			next_action:
				operatorHints.next_action ??
				(payload.recommended_next_action as Record<string, unknown>)?.command ??
				phaseInfo?.agent_next_call ??
				payload.agent_next_call,
		},
	}
}
