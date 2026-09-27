import * as assert from "assert"
import { DEFAULT_ROADMAP_CONFIG, getRoadmapConfig, setRoadmapConfigOverride } from "../RoadmapConfig"
import { determinePhase, recommendNextAction } from "../RoadmapOperator"

describe("RoadmapGates", () => {
	afterEach(() => {
		setRoadmapConfigOverride(null)
	})

	it("determinePhase returns bootstrap when roadmap missing", () => {
		const phase = determinePhase({
			roadmap_exists: false,
			sections_missing: [],
			health_status: null,
			validation_valid: undefined,
			bootstrap_incomplete: false,
		})
		assert.strictEqual(phase.phase, "bootstrap")
		assert.strictEqual(phase.agent_next_call, "")
	})

	it("determinePhase returns bootstrap_fill when placeholders remain", () => {
		const phase = determinePhase({
			roadmap_exists: true,
			sections_missing: [],
			health_status: "Healthy",
			validation_valid: true,
			bootstrap_incomplete: true,
		})
		assert.strictEqual(phase.phase, "bootstrap_fill")
	})

	it("schema findings do not schedule a diagnostic loop", () => {
		const rec = recommendNextAction({ schema_valid: false, roadmap_exists: true })
		assert.strictEqual(rec.command, "")
		assert.strictEqual(rec.action, "continue_task")
	})

	it("roadmap evaluation errors are advisory by default", () => {
		setRoadmapConfigOverride(null)
		assert.strictEqual(getRoadmapConfig().fail_closed_completion_gates, false)
		assert.strictEqual(DEFAULT_ROADMAP_CONFIG.fail_closed_completion_gates, false)
	})
})
