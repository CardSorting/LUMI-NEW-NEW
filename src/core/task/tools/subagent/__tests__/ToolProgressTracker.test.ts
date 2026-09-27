import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { formatResponse } from "@/core/prompts/responses"
import { ToolProgressTracker } from "../../../ToolProgressTracker"

describe("agent progress tracking", () => {
	it("stops roadmap rescans despite changing timestamps, echoed plans, formatting, or the checkpoint alias", () => {
		const tracker = new ToolProgressTracker()
		for (let i = 0; i < 9; i++) {
			tracker.record(
				i % 2 ? "roadmap" : "roadmap_checkpoint",
				{ action: i % 2 ? "checkpoint" : undefined, context: `Re-map workspace ${i}`, user_request: `Plan ${i}` },
				JSON.stringify(
					{
						action: "checkpoint",
						success: true,
						user_request: `Plan ${i}`,
						evidence: { gathered_at: `${i}`, readmes: [], configs: [], _roadmap_text: "# Project direction" },
						roadmap_gate: {
							kanban_complete_allowed: true,
							workspace_state: { updated_at: `${i}`, last_validated_at: `${i}`, schema_valid: true },
						},
					},
					null,
					i % 2 ? 2 : 0,
				),
			)
			assert.equal(tracker.finishTurn(), i === 8 ? "handoff" : i === 3 ? "redirect" : "continue")
		}
	})

	it("does not let self-generated roadmap activity renew a stalled loop", () => {
		for (const action of ["progress", "watch"]) {
			const tracker = new ToolProgressTracker()
			for (let i = 0; i < 9; i++) {
				tracker.record(
					"roadmap",
					{ action, context: `--view-${i}` },
					JSON.stringify({
						action,
						success: true,
						phase: "checkpoint",
						context_mode: `--view-${i}`,
						current: { action, event_id: `${i}`, payload: { task_progress: `Replanning ${i}` } },
						recent_events: Array.from({ length: i }, (_, j) => ({ action, event_id: `${j}` })),
						events: [{ event_id: `${i}` }],
						report: `Timeline ${i}`,
						workspace_state: { schema_valid: true, updated_at: `${i}`, last_validated_at: `${i}` },
					}),
				)
				assert.equal(tracker.finishTurn(), i === 8 ? "handoff" : i === 3 ? "redirect" : "continue")
			}
		}
	})

	it("retains meaningful roadmap evidence, including changing gates and source contents", () => {
		const tracker = new ToolProgressTracker()
		for (const evidence of [
			{ roadmap_gate: { kanban_complete_allowed: false } },
			{ roadmap_gate: { kanban_complete_allowed: true } },
			{ evidence: { _roadmap_text: "# New direction" } },
			{ evidence: { configs: [{ path: "package.json", excerpt: "new starter" }] } },
		]) {
			for (let i = 0; i < 3; i++) tracker.finishTurn()
			tracker.record("roadmap", { action: "checkpoint" }, JSON.stringify({ success: true, ...evidence }))
			assert.equal(tracker.finishTurn(), "continue")
		}
	})

	it("does not treat changing roadmap failures as progress or strip timestamps from ordinary file contents", () => {
		const tracker = new ToolProgressTracker()
		for (let i = 0; i < 8; i++) {
			tracker.record("roadmap", { action: "checkpoint" }, JSON.stringify({ success: false, message: `failure ${i}` }))
			assert.equal(tracker.finishTurn(), i === 7 ? "handoff" : i === 2 ? "redirect" : "continue")
		}
		for (let i = 0; i < 10; i++) {
			tracker.record("read_file", { path: "data.json" }, JSON.stringify({ updated_at: i }))
			assert.equal(tracker.finishTurn(), "continue")
		}
	})

	it("does not renew work by polling execution inventory, even when sibling state changes", () => {
		const tracker = new ToolProgressTracker()
		for (let i = 0; i < 8; i++) {
			tracker.record(
				"get_execution_state",
				{ execution_id: `action-${i}` },
				JSON.stringify({ status: i % 2 ? "running" : "completed", result_preview: `sibling result ${i}` }),
			)
			assert.equal(tracker.finishTurn(), i === 7 ? "handoff" : i === 2 ? "redirect" : "continue")
		}
	})
	it("does not renew repeated command results through fresh read handles or log paths", () => {
		const tracker = new ToolProgressTracker()
		for (let i = 0; i < 9; i++) {
			tracker.record(
				"read_command_output",
				{ execution_id: `run-${i}`, timeout: i },
				JSON.stringify({
					execution_id: `run-${i}`,
					action_id: `action-${i}`,
					owner: `helper-${i}`,
					terminal_id: i,
					command: "build",
					cwd: "/workspace",
					status: "completed",
					exit_code: 0,
					output: "unchanged result",
					log_file_path: `/tmp/log-${i}`,
					log_notice: `Full captured output saved to: /tmp/log-${i}`,
				}),
			)
			assert.equal(tracker.finishTurn(), i === 8 ? "handoff" : i === 3 ? "redirect" : "continue")
		}
	})
	it("does not renew polling by changing the wait or risk hint", () => {
		for (const name of ["read_command_output", "execute_command"]) {
			const tracker = new ToolProgressTracker()
			tracker.record(name, { command: "build", execution_id: "run", timeout: 0 }, "unchanged")
			tracker.finishTurn()
			for (let i = 0; i < 8; i++) {
				tracker.record(name, { command: "build", execution_id: "run", timeout: i, requires_approval: i % 2 }, "unchanged")
				assert.equal(tracker.finishTurn(), i === 7 ? "handoff" : i === 2 ? "redirect" : "continue")
			}
			tracker.record(name, { command: "build", execution_id: "run" }, "new output")
			assert.equal(tracker.finishTurn(), "continue")
		}
	})
	it("ignores fresh execution receipt IDs when the same command returns unchanged output", () => {
		const tracker = new ToolProgressTracker()
		for (let i = 0; i < 9; i++) {
			tracker.record(
				"execute_command",
				{ command: "pwd" },
				`same output\n\nExecution ID: 00000000-0000-0000-0000-00000000000${i}. `,
			)
			assert.equal(tracker.finishTurn(), i === 8 ? "handoff" : i === 3 ? "redirect" : "continue")
		}
	})
	it("renews continuation for productive work beyond the old turn and tool limits", () => {
		const tracker = new ToolProgressTracker()
		for (let i = 0; i < 100; i++) {
			tracker.record("read_file", { path: `${i}.ts` }, `contents ${i}`)
			assert.equal(tracker.finishTurn(), "continue")
		}
	})
	it("does not renew identical helper work when reconciliation IDs change", () => {
		const tracker = new ToolProgressTracker()
		const handoff = (id: number, result = "same evidence") =>
			`### SWARM EXECUTION SUMMARY\nSuccess: 1\n\n### RECONCILIATION\nexecution_id helper-${id}\nPending command: command-${id}\n\n### AGENT DETAILS\n${result}\n\nRuntime handoff — commands still pending:\n- command-${id}: background. Inspect with read_command_output; do not relaunch.`
		for (let index = 0; index < 9; index++) {
			tracker.record("custom_helper", { prompt: "same assignment" }, handoff(index))
			assert.equal(tracker.finishTurn(), index === 8 ? "handoff" : index === 3 ? "redirect" : "continue")
		}
		tracker.record("custom_helper", { prompt: "same assignment" }, handoff(10, "new evidence"))
		assert.equal(tracker.finishTurn(), "continue")
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
