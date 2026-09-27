import * as assert from "assert"
import { DEFAULT_ROADMAP_CONFIG } from "../RoadmapConfig"
import { blockingClosedGates, buildGateStateFromInputs, evaluateGateChecks, type GateInputs } from "../RoadmapGateCatalog"

function baseInputs(overrides: Partial<GateInputs> = {}): GateInputs {
	return {
		config: DEFAULT_ROADMAP_CONFIG,
		workspace: "/tmp/project",
		roadmap_path: "/tmp/project/ROADMAP.md",
		roadmap_present: true,
		validation: {
			valid: true,
			schema_complete: true,
			health_status: "Healthy",
			code_soup_risk: "Low",
			now_item_count: 2,
			issues: [],
		},
		freshness: { stale: false, reason: "fresh", summary: "ok" },
		workspace_state: { validation_pending: false, bootstrap_complete: true },
		bootstrap_complete: true,
		bootstrap_placeholder_count: 0,
		project_fingerprint: { steering_brief: "Audit Project — test" },
		evidence_roadmap: { sections_missing: [] },
		workspace_skill_installed: true,
		...overrides,
	}
}

describe("RoadmapGateCatalog", () => {
	it("allows completion with advisory findings by default", async () => {
		const state = await buildGateStateFromInputs(
			baseInputs({
				validation: { valid: false, schema_complete: false, now_item_count: 0, issues: [] },
				freshness: { stale: true },
				workspace_state: { validation_pending: true },
				bootstrap_complete: false,
			}),
		)
		assert.strictEqual(state.kanban_complete_allowed, true)
		assert.strictEqual(state.checkpoint_allowed, true)
		assert.ok(state.closed_gate_count >= 4)
		assert.ok(state.closed_gates.every((gate) => !gate.blocks_kanban_complete))
	})

	it("legacy gate flags cannot restore completion authority", async () => {
		const state = await buildGateStateFromInputs(
			baseInputs({
				config: {
					...DEFAULT_ROADMAP_CONFIG,
					block_kanban_on_validation_pending: true,
					block_kanban_on_bootstrap_incomplete: true,
				},
				workspace_state: { validation_pending: true },
				bootstrap_complete: false,
				freshness: { stale: true },
			}),
		)
		assert.strictEqual(state.kanban_complete_allowed, true)
		assert.strictEqual(state.checkpoint_allowed, true)
		assert.deepStrictEqual(state.blocking_gates, [])
		assert.strictEqual(state.mode, "advisory")
		assert.strictEqual(state.preferred_command, "")
		assert.ok(state.findings.some((item) => item.id === "validation_current"))
		assert.ok(state.findings.some((item) => item.id === "bootstrap_complete"))
		assert.strictEqual(state.closed_gates.find((gate) => gate.id === "checkpoint_fresh")?.blocks_kanban_complete, false)
	})

	it("continues to guard checkpoint writes in an extension installation", async () => {
		const state = await buildGateStateFromInputs(baseInputs({ workspace: "/tmp/.vscode/extensions/lumi" }))
		assert.strictEqual(state.checkpoint_allowed, false)
		assert.strictEqual(state.kanban_complete_allowed, true)
	})

	it("reports pending validation without blocking, even with a legacy override", () => {
		const { closed } = evaluateGateChecks(
			baseInputs({
				workspace_state: { validation_pending: true },
			}),
		)
		const blocking = blockingClosedGates(closed, { ...DEFAULT_ROADMAP_CONFIG, block_kanban_on_validation_pending: true })
		assert.deepStrictEqual(blocking, [])
		assert.ok(closed.some((item) => item.id === "validation_current"))
	})

	it("reports invalid schema without blocking, even with a legacy override", () => {
		const { closed } = evaluateGateChecks(
			baseInputs({
				validation: {
					valid: false,
					schema_complete: false,
					code_soup_risk: "Low",
					now_item_count: 0,
					issues: [{ severity: "error", code: "missing_section", message: "missing section" }],
				},
			}),
		)
		const blocking = blockingClosedGates(closed, {
			...DEFAULT_ROADMAP_CONFIG,
			block_kanban_on_invalid_schema: true,
		})
		assert.deepStrictEqual(blocking, [])
		assert.ok(closed.some((item) => item.id === "schema_valid"))
	})

	it("does not block on invalid schema when block_kanban_on_invalid_schema is false", () => {
		const { closed } = evaluateGateChecks(
			baseInputs({
				validation: {
					valid: false,
					schema_complete: false,
					code_soup_risk: "Low",
					now_item_count: 0,
					issues: [{ severity: "error", code: "missing_section", message: "missing section" }],
				},
			}),
		)
		const blocking = blockingClosedGates(closed, {
			...DEFAULT_ROADMAP_CONFIG,
			block_kanban_on_invalid_schema: false,
		})
		assert.strictEqual(
			blocking.some((g) => g.id === "schema_valid"),
			false,
		)
	})

	it("includes workspace_safe in closed gates for quarantined paths", () => {
		const { closed } = evaluateGateChecks(
			baseInputs({
				workspace: "/Users/dev/Downloads/codemarie-new/dist/extension",
			}),
		)
		assert.ok(closed.some((g) => g.id === "workspace_safe"))
	})
})
