import { expect } from "chai"
import type { DietCodeMessage } from "../ExtensionMessage"
import { applySubagentMessage, parseSubagentStatusPayload, preserveSubagentProgress } from "../subagents"

describe("live helper delivery", () => {
	const message = (revision: number, status = "running", taskId = "task"): DietCodeMessage => ({
		ts: 100,
		type: "say",
		say: "subagent",
		partial: status === "running",
		text: JSON.stringify({ taskId, revision, items: [{ id: "helper", prompt: "Work", status }] }),
	})
	it("inserts an initial row before full state delivery, only for its owning task", () => {
		const row = message(1)
		expect(applySubagentMessage([], row, "task")).to.deep.equal([row])
		expect(applySubagentMessage([], row, "other")).to.deep.equal([])
		expect(applySubagentMessage([], row)).to.deep.equal([])
	})
	it("rejects older, duplicate, foreign, and post-terminal progress", () => {
		const rows = [message(3, "completed")]
		for (const incoming of [message(1), message(3), message(4), message(4, "completed", "other")]) {
			expect(applySubagentMessage(rows, incoming, "task")).to.equal(rows)
		}
		const conflict = { ...message(5), text: message(5).text!.replace('"helper"', '"sibling"') }
		expect(applySubagentMessage(rows, conflict, "task")).to.equal(rows)
		expect(applySubagentMessage([{ ts: 100, type: "say", say: "text" }], message(2), "task")[0].say).to.equal("text")
	})
	it("protects a newer row against delayed full snapshots without reviving removed rows", () => {
		const latest = message(3, "completed")
		expect(preserveSubagentProgress([message(2)], [latest], "task")).to.deep.equal([latest])
		expect(preserveSubagentProgress([], [latest], "task")).to.deep.equal([])
		expect(preserveSubagentProgress([message(2)], [latest], "other")).to.deep.equal([message(2)])
	})
	it("bounds event and output history and accepts all valid command lifecycle states", () => {
		const parsed = parseSubagentStatusPayload(
			JSON.stringify({
				items: [
					{
						prompt: "Work",
						status: "running",
						activityEvents: Array.from({ length: 70 }, (_, id) => ({
							id: String(id),
							at: 1e99,
							kind: "phase",
							label: "Step",
						})),
						commands: [
							{ id: "command", command: "npm test", status: "background", output: "x".repeat(5000) },
							{ id: "bad", command: "fake", status: "invented" },
						],
					},
				],
			}),
		)!
		expect(parsed.items[0].activityEvents).to.have.length(60)
		expect(() => new Date(parsed.items[0].activityEvents![0].at).toISOString()).not.to.throw()
		expect(parsed.items[0].commands).to.have.length(1)
		expect(parsed.items[0].commands![0].output).to.have.length(4000)
	})
})

describe("parseSubagentStatusPayload", () => {
	it("retains usable results and sanitizes malformed stored entries", () => {
		const parsed = parseSubagentStatusPayload(
			JSON.stringify({
				items: [
					null,
					{ prompt: 1, status: "running" },
					{
						id: "review",
						prompt: "Review schema",
						status: "completed",
						result: "Verified",
						criticalSignals: [null, 8, "SIGNAL: PARENT_GATE_BLOCKED", "SIGNAL: PARENT_GATE_BLOCKED"],
						filesModified: { invalid: true },
						toolCalls: -3,
						inputTokens: "100",
						contextUsagePercentage: 120,
					},
				],
			}),
		)!
		expect(parsed.items).to.have.length(1)
		expect(parsed.items[0]).to.include({
			id: "review",
			name: "Helper 3",
			result: "Verified",
			toolCalls: 0,
			inputTokens: 0,
			contextUsagePercentage: 100,
		})
		expect(parsed.items[0].criticalSignals).to.deep.equal(["SIGNAL: PARENT_GATE_BLOCKED"])
		expect(parsed.items[0].filesModified).to.deep.equal([])
	})

	it("derives consistent totals from the recorded outcomes", () => {
		const parsed = parseSubagentStatusPayload(
			JSON.stringify({
				status: "completed",
				total: 99,
				completed: 99,
				failures: 99,
				items: [
					{ id: "done", prompt: "Check", status: "completed", toolCalls: 2 },
					{ id: "live", prompt: "Repair", status: "running", toolCalls: 3 },
					{ id: "stopped", prompt: "Inspect", status: "cancelled" },
				],
			}),
		)!
		expect(parsed).to.include({
			status: "running",
			total: 3,
			completed: 2,
			successes: 1,
			failures: 0,
			cancelled: 1,
			toolCalls: 5,
		})
	})

	it("preserves live progress while bounding and validating stored activity", () => {
		const parsed = parseSubagentStatusPayload(
			JSON.stringify({
				items: [
					{
						id: "helper",
						prompt: "Build game",
						status: "running",
						startedAt: 1000,
						activity: { phase: "tool", detail: "Editing src/domain/game.ts" },
						latestMessage: "x".repeat(2000),
						recentTools: [
							{ id: "old", label: "Older tool", status: "returned" },
							null,
							{ id: "bad", label: 123, status: "running" },
							{ id: "bad-status", label: "Bad status", status: "invented" },
							...Array.from({ length: 5 }, (_, index) => ({
								id: String(index),
								label: "Reading file",
								status: "returned",
							})),
							{ id: "4", label: "Duplicate", status: "running" },
						],
					},
				],
			}),
		)!
		expect(parsed.items[0].activity).to.include({ phase: "tool", detail: "Editing src/domain/game.ts" })
		expect(parsed.items[0].startedAt).to.equal(1000)
		expect(parsed.items[0].latestMessage).to.have.length(1200)
		expect(parsed.items[0].recentTools?.map((tool) => tool.id)).to.deep.equal(["0", "1", "2", "3", "4"])
	})

	it("applies explicit batch cancellation only to unfinished helpers", () => {
		const parsed = parseSubagentStatusPayload(
			JSON.stringify({
				status: "cancelled",
				items: ["completed", "running", "pending", "failed"].map((status, index) => ({
					id: String(index),
					prompt: "Check",
					status,
				})),
			}),
		)!
		expect(parsed.items.map((item) => item.status)).to.deep.equal(["completed", "cancelled", "cancelled", "failed"])
		expect(parsed).to.include({ completed: 4, successes: 1, failures: 1, cancelled: 2 })
	})

	it("provides distinct identities for legacy or duplicated helper IDs", () => {
		const parsed = parseSubagentStatusPayload(
			JSON.stringify({
				items: ["same", "same", undefined].map((id) => ({ id, prompt: "Check", status: "pending" })),
			}),
		)!
		expect(new Set(parsed.items.map((item) => item.id)).size).to.equal(3)
		expect(parsed.items[0].id).to.equal("same")
	})

	for (const raw of [undefined, "{", "null", "[]", "{}", '{"items":[null]}']) {
		it(`rejects unusable history: ${raw}`, () => {
			expect(parseSubagentStatusPayload(raw)).to.equal(undefined)
		})
	}
})
