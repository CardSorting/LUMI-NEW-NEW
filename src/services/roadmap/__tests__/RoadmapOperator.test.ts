import * as assert from "assert"
import {
	DEFAULT_ROADMAP_CONFIG,
	getRoadmapConfig,
	invalidateRoadmapConfigCache,
	setRoadmapConfigOverride,
} from "../RoadmapConfig"
import {
	buildAgentOperatorHints,
	formatExplainGateReport,
	isBootstrapIncomplete,
	recommendNextAction,
	wrapClarityEnvelope,
} from "../RoadmapOperator"

describe("RoadmapOperator", () => {
	it("preserves a terminal recommendation instead of scheduling another checkpoint", () => {
		const recommendation = recommendNextAction({ roadmap_exists: true, schema_valid: true, stale: false })
		assert.strictEqual(recommendation.command, "")
		const wrapped = wrapClarityEnvelope(
			{
				action: "guide",
				agent_next_call: "",
				recommended_next_action: recommendation,
				roadmap_gate: { roadmap_present: true, schema_valid: true, kanban_complete_allowed: true },
			},
			{ agent_next_call: "roadmap(action='checkpoint')" },
		)
		assert.strictEqual(wrapped.agent_next_call, "")
		assert.strictEqual((wrapped._roadmap_operator_hints as Record<string, unknown>).next_action, "")
	})

	describe("isBootstrapIncomplete", () => {
		it("returns false when roadmap missing", () => {
			assert.strictEqual(isBootstrapIncomplete({ roadmap_exists: false, bootstrap_complete: false }), false)
		})

		it("returns true when placeholders remain", () => {
			assert.strictEqual(
				isBootstrapIncomplete({ roadmap_exists: true, bootstrap_complete: false, bootstrap_placeholder_count: 3 }),
				true,
			)
		})
	})

	describe("recommendNextAction", () => {
		it("pending validation requires no follow-up", () => {
			const rec = recommendNextAction({ validation_pending: true, roadmap_exists: true })
			assert.strictEqual(rec.action, "continue_task")
			assert.strictEqual(rec.command, "")
		})

		it("bootstrap findings require no follow-up", () => {
			const rec = recommendNextAction({ bootstrap_incomplete: true, roadmap_exists: true })
			assert.strictEqual(rec.command, "")
		})

		it("stale checkpoints require no follow-up", () => {
			const rec = recommendNextAction({ stale: true, roadmap_exists: true, schema_valid: true })
			assert.strictEqual(rec.command, "")
		})
	})

	describe("wrapClarityEnvelope", () => {
		it("normalizes obsolete blocking snapshots while preserving findings", () => {
			const wrapped = wrapClarityEnvelope({
				required_action: { fix: "run another gate" },
				agent_next_call: "roadmap(action='doctor')",
				roadmap_gate: {
					kanban_complete_allowed: false,
					blocking_gates: [{ id: "schema_valid", label: "Schema", blocks_kanban_complete: true }],
				},
			})
			assert.strictEqual(wrapped.roadmap_mode, "advisory")
			assert.strictEqual(wrapped.required_action, null)
			assert.strictEqual(wrapped.completion_ready, true)
			assert.strictEqual(wrapped.agent_next_call, "")
			assert.strictEqual((wrapped.advisory_actions as Array<{ id: string }>)[0].id, "schema_valid")
			assert.deepStrictEqual((wrapped.roadmap_gate as Record<string, unknown>).blocking_gates, [])
			assert.strictEqual((wrapped._roadmap_operator_hints as Record<string, unknown>).next_action, "")
		})
		it("includes playbooks and operator hints", () => {
			const wrapped = wrapClarityEnvelope({
				action: "guide",
				success: true,
				ok: true,
				workspace: "/tmp/project",
				roadmap_gate: { kanban_complete_allowed: true, roadmap_present: true },
				project_steering_digest: { identity_line: "My App — test" },
			})
			assert.ok(wrapped.agent_playbook)
			assert.ok(wrapped.operator_playbook)
			assert.ok(wrapped._roadmap_operator_hints)
			assert.strictEqual(wrapped.project_identity_line, "My App — test")
			assert.strictEqual(wrapped.required_section_count, 12)
		})
	})

	describe("formatExplainGateReport", () => {
		it("formats closed gates", () => {
			const report = formatExplainGateReport({
				workspace: "/tmp/project",
				closed_gates: [
					{
						label: "ROADMAP.md validated after last edit",
						why: "changed since validate",
						fix: "roadmap(action='validate')",
						blocks_kanban_complete: true,
					},
				],
				kanban_complete_allowed: false,
			})
			assert.doesNotMatch(report, /attempt_completion blocked|Required —/)
			assert.match(report, /advisory/)
			assert.match(report, /validate/)
		})
	})

	describe("buildAgentOperatorHints", () => {
		it("includes write guard and slash commands", () => {
			const hints = buildAgentOperatorHints({
				gate: {
					roadmap_present: true,
					kanban_complete_allowed: true,
					workspace: "/tmp/project",
				},
				workspace: "/tmp/project",
			})
			assert.strictEqual(hints.preferred_tool, "roadmap")
			assert.ok(Array.isArray(hints.slash_commands))
			assert.match(String(hints.write_guard), /ROADMAP.md/)
		})
	})
})

describe("RoadmapConfig defaults", () => {
	it("ignores all legacy environment and runtime completion gate flags", () => {
		const keys = [
			"MIRA_ROADMAP_BLOCK_KANBAN_ON_INVALID_SCHEMA",
			"MIRA_ROADMAP_BLOCK_KANBAN_ON_VALIDATION_PENDING",
			"MIRA_ROADMAP_BLOCK_KANBAN_ON_BOOTSTRAP_INCOMPLETE",
			"MIRA_ROADMAP_FAIL_CLOSED_COMPLETION_GATES",
		]
		const prior = keys.map((key) => process.env[key])
		try {
			for (const key of keys) process.env[key] = "true"
			setRoadmapConfigOverride({
				block_kanban_on_invalid_schema: true,
				block_kanban_on_validation_pending: true,
				block_kanban_on_bootstrap_incomplete: true,
				fail_closed_completion_gates: true,
			})
			const cfg = getRoadmapConfig()
			assert.strictEqual(cfg.block_kanban_on_invalid_schema, false)
			assert.strictEqual(cfg.block_kanban_on_validation_pending, false)
			assert.strictEqual(cfg.block_kanban_on_bootstrap_incomplete, false)
			assert.strictEqual(cfg.fail_closed_completion_gates, false)
			assert.strictEqual(cfg.block_writes_outside_workspace, true)
		} finally {
			keys.forEach((key, index) => {
				if (prior[index] === undefined) delete process.env[key]
				else process.env[key] = prior[index]
			})
			setRoadmapConfigOverride(null)
			invalidateRoadmapConfigCache()
		}
	})
	it("keeps roadmap maintenance advisory and write safeguards enabled", () => {
		assert.strictEqual(DEFAULT_ROADMAP_CONFIG.progress_enabled, true)
		assert.strictEqual(DEFAULT_ROADMAP_CONFIG.auto_install_skills, true)
		assert.strictEqual(DEFAULT_ROADMAP_CONFIG.block_kanban_on_bootstrap_incomplete, false)
		assert.strictEqual(DEFAULT_ROADMAP_CONFIG.fail_closed_completion_gates, false)
		assert.strictEqual(DEFAULT_ROADMAP_CONFIG.session_brief_cache_ttl_seconds > 0, true)
	})
})
