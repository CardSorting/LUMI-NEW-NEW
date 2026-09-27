import { getRoadmapConfig } from "@/services/roadmap/RoadmapConfig"
import { sessionBrief } from "@/services/roadmap/RoadmapSession"
import { SystemPromptSection } from "../templates/placeholders"
import type { ComponentFunction } from "../types"

export const getRoadmapSteeringSection: ComponentFunction = async (_variant, context) => {
	const cfg = getRoadmapConfig()
	if (!cfg.enabled || !context.cwd || context.isSubagentRun) {
		return ""
	}

	const brief = await sessionBrief(context.cwd)
	if (!brief || brief.success === false) {
		return ""
	}

	const identity = brief.project_identity_line || brief.steering_brief || "this project"
	const nextCall = brief.agent_next_call || brief.first_call || "Continue the assigned task; no roadmap call is needed."

	return `=== ${SystemPromptSection.ROADMAP_STEERING} ===

# Auto-Rolling Roadmap

ROADMAP.md at the workspace root is the long-horizon steering surface — not a backlog.

**Project:** ${identity}
**Phase:** ${brief.phase || "unknown"}
**Health:** ${brief.health_status || "unknown"}
**Prime directive:** Did the latest work strengthen or weaken the project's center of gravity?

Roadmap advice does not expand the user's task. Anti-goals, template placeholders, and checkpoint age are advisory by default. Only explicitly configured blocking gates require repair. Do not repeat audits, tests, or unchanged validation to improve advisory status.

After editing ROADMAP.md, run \`roadmap(action='validate')\` once after the final edit. Stop when relevant checks pass; rerun only after a repair or new evidence.

**Roadmap suggestion (only when relevant):** ${nextCall}

Tool actions (all return _roadmap_operator_hints + project_identity_line):
- \`/roadmap cockpit\` — operator one-screen summary (runs synchronously in chat)
- \`/roadmap doctor\` — production health checks
- \`/roadmap explain-gate\` / \`/roadmap explain-stale\` — gate and freshness diagnostics
- \`roadmap(action='guide')\` — phase, gates, steering digest
- \`roadmap(action='cockpit')\` — one-screen operator summary with gate report
- \`roadmap(action='checkpoint')\` — full evidence before major direction changes
- \`roadmap(action='validate')\` — schema gate after ROADMAP.md edits
- \`roadmap(action='doctor')\` — production health checks + recommendations
- \`roadmap(action='apply_bootstrap_fill', context='write')\` — evidence autofill for template phrases
- \`roadmap(action='explain_gate')\` — why attempt_completion may be blocked
- \`roadmap(action='explain_stale')\` — why checkpoint may be outdated vs git activity
- \`roadmap(action='progress', context='--current')\` — gate snapshot + recent activity
- \`roadmap(action='watch')\` — compact last-action line
- \`roadmap(action='last_error')\` — recovery from last failure`
}
