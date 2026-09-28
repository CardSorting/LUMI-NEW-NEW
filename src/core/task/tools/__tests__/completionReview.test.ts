import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { TaskState } from "../../TaskState"
import { buildCompletionReview } from "../completionReview"
import type { TaskConfig } from "../types/TaskConfig"

function config(): TaskConfig {
	return { taskState: new TaskState(), focusChainSettings: { enabled: true } } as TaskConfig
}

describe("completion review evidence", () => {
	it("records disabled checks as not run, not passed", () => {
		const result = buildCompletionReview(config(), { audit: { status: "skipped" } })
		assert.equal(result.attempt, 1)
		assert.ok(result.checks.every((check) => check.status === "not_run"))
	})
	it("records the completed checklist, actual audit threshold and second review without changing task state", () => {
		const task = config()
		task.taskState.currentFocusChainChecklist = "- [x] Implement\n- [x] Verify"
		task.doubleCheckCompletionEnabled = true
		task.taskState.doubleCheckCompletionPending = true
		task.taskState.completionAttemptCount = 2
		task.taskState.completionGateBlockCount = 1
		const review = buildCompletionReview(task, {
			audit: {
				status: "passed",
				auditMetadata: { hardening_score: 0 },
				gateDecision: { blocked: false, score: 0, effectiveThreshold: 0, grade: undefined, reasons: [] },
				gateOptions: {},
				policyProvenance: { source: "extension", workspacePolicyApplied: false, overriddenFields: [] },
			},
		})
		assert.equal(review.attempt, 2)
		assert.equal(review.priorBlocks, 1)
		assert.ok(review.checks.every((check) => check.status === "passed"))
		assert.equal(review.checks[1].detail, "Score 0/100 · policy threshold 0.")
		task.taskState.currentFocusChainChecklist = "- [ ] A later task"
		assert.equal(review.checks[0].detail, "2 of 2 items marked complete.")
		assert.equal(task.taskState.completionGateBlockCount, 1)
	})
	for (const [execution, expected] of [
		[{ status: "completed", exitCode: 0 }, "passed"],
		[{ status: "completed" }, "unverified"],
		[{ status: "completed", exitCode: 1 }, "unverified"],
		[{ status: "background" }, "running"],
		[undefined, "unverified"],
	] as const) {
		it(`reports ${execution?.status ?? "missing"} command evidence (${execution?.exitCode ?? "no exit code"}) as ${expected}`, () => {
			const review = buildCompletionReview(config(), {
				audit: { status: "skipped" },
				command: "npm test",
				commandExecution: execution,
			})
			assert.equal(review.checks.at(-1)?.status, expected)
		})
	}
})
