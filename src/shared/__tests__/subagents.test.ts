import { expect } from "chai"
import { parseSubagentStatusPayload } from "../subagents"

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
