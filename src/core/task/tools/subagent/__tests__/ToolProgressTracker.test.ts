import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { formatResponse } from "@/core/prompts/responses"
import { ToolProgressTracker } from "../../../ToolProgressTracker"

describe("agent progress tracking", () => {
	it("renews continuation for productive work beyond the old turn and tool limits", () => {
		const tracker = new ToolProgressTracker()
		for (let i = 0; i < 100; i++) {
			tracker.record("read_file", { path: `${i}.ts` }, `contents ${i}`)
			assert.equal(tracker.finishTurn(), "continue")
		}
	})
	it("redirects once and hands back an unchanged alternating loop", () => {
		const tracker = new ToolProgressTracker()
		for (const path of ["a", "b"]) {
			tracker.record("read_file", { path }, path)
			tracker.finishTurn()
		}
		const decisions = []
		for (let i = 0; i < 8; i++) {
			const path = i % 2 ? "a" : "b"
			tracker.record("read_file", { path, task_progress: `changed checklist ${i}` }, path)
			decisions.push(tracker.finishTurn())
		}
		assert.deepEqual(decisions, [
			"continue",
			"continue",
			"redirect",
			"continue",
			"continue",
			"continue",
			"continue",
			"handoff",
		])
	})
	it("counts changed evidence and ignores argument key ordering", () => {
		const tracker = new ToolProgressTracker()
		tracker.record("read_file", { path: "a", recursive: false }, "before")
		tracker.finishTurn()
		for (let i = 0; i < 3; i++) {
			tracker.record("read_file", { recursive: false, path: "a" }, "before")
			assert.equal(tracker.finishTurn(), i === 2 ? "redirect" : "continue")
		}
		tracker.record("read_file", { path: "a", recursive: false }, "after")
		assert.equal(tracker.finishTurn(), "continue")
		assert.equal(tracker.finishTurn(), "continue")
	})
	it("does not treat changing failed arguments as progress", () => {
		const tracker = new ToolProgressTracker()
		for (let i = 0; i < 8; i++) {
			tracker.record("execute_command", { command: `missing-${i}` }, formatResponse.toolError("unavailable"))
			assert.equal(tracker.finishTurn(), i === 7 ? "handoff" : i === 2 ? "redirect" : "continue")
		}
	})
	it("detects oscillating results from the same tool input", () => {
		const tracker = new ToolProgressTracker()
		for (const result of ["before", "after"]) {
			tracker.record("read_file", { path: "a" }, result)
			tracker.finishTurn()
		}
		for (let i = 0; i < 8; i++) {
			tracker.record("read_file", { path: "a" }, i % 2 ? "before" : "after")
			assert.equal(tracker.finishTurn(), i === 7 ? "handoff" : i === 2 ? "redirect" : "continue")
		}
	})
	it("does not renew execution for bookkeeping or undefined outcomes", () => {
		const tracker = new ToolProgressTracker()
		for (let i = 0; i < 8; i++) {
			tracker.record(["focus_chain", "condense", "summarize_task"][i % 3], { text: `new plan ${i}` }, `summary ${i}`)
			tracker.record("read_file", { path: `${i}` }, undefined)
			assert.equal(tracker.finishTurn(), i === 7 ? "handoff" : i === 2 ? "redirect" : "continue")
		}
	})
	it("respects the configured recovery window and renews it only on explicit reset or evidence", () => {
		const tracker = new ToolProgressTracker()
		for (let i = 1; i <= 15; i++) {
			assert.equal(tracker.finishTurn(10), i === 15 ? "handoff" : i === 10 ? "redirect" : "continue")
		}
		tracker.reset()
		assert.equal(tracker.finishTurn(10), "continue")
		tracker.record("read_file", { path: "a" }, "unchanged but user changed the task")
		assert.equal(tracker.finishTurn(), "continue")
	})
	it("uses a finite recovery window for invalid settings", () => {
		for (const threshold of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
			const tracker = new ToolProgressTracker()
			for (let i = 1; i <= 8; i++) {
				assert.equal(tracker.finishTurn(threshold), i === 8 ? "handoff" : i === 3 ? "redirect" : "continue")
			}
		}
	})
})
