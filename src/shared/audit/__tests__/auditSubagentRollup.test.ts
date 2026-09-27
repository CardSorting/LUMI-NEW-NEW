import {
	buildSubagentAuditSummary,
	buildSubagentHandoffMarkdown,
	formatSubagentParentSignal,
} from "@shared/audit/auditSubagentRollup"
import type { DietCodeMessage } from "@shared/ExtensionMessage"
import { expect } from "chai"

describe("auditSubagentRollup", () => {
	it("keeps the parent header usable when persisted helper records are malformed", () => {
		const summary = buildSubagentAuditSummary([
			{
				ts: 1,
				type: "say",
				say: "subagent",
				text: JSON.stringify({
					status: "cancelled",
					items: [
						null,
						{
							id: "a",
							prompt: "Check routes",
							status: "running",
							criticalSignals: [null, 42],
						},
						{ id: "b", prompt: "Check types", status: "completed", criticalSignals: "bad data" },
					],
				}),
			},
		])!
		expect(summary).to.include({ totalAgents: 2, runningCount: 0, completedCount: 1, failedCount: 0, cancelledCount: 1 })
		expect(summary.parentGateSignals).to.deep.equal([])
		expect(buildSubagentHandoffMarkdown(summary)).to.contain("1 cancelled")
	})

	it("aggregates parent gate signals from subagent swarm status", () => {
		const messages = [
			{
				ts: 1,
				type: "say",
				say: "subagent",
				text: JSON.stringify({
					status: "running",
					total: 2,
					completed: 0,
					successes: 0,
					failures: 0,
					toolCalls: 0,
					inputTokens: 0,
					outputTokens: 0,
					contextWindow: 0,
					maxContextTokens: 0,
					maxContextUsagePercentage: 0,
					items: [
						{
							id: "a",
							name: "Agent 1",
							index: 1,
							prompt: "fix tests",
							status: "running",
							toolCalls: 0,
							inputTokens: 0,
							outputTokens: 0,
							totalCost: 0,
							contextTokens: 0,
							contextWindow: 0,
							contextUsagePercentage: 0,
							criticalSignals: ["GATE: PARENT_BLOCKED (2)", "SIGNAL: PARENT_ADVISORY_FINDINGS"],
						},
						{
							id: "b",
							name: "Agent 2",
							index: 2,
							prompt: "lint",
							status: "pending",
							toolCalls: 0,
							inputTokens: 0,
							outputTokens: 0,
							totalCost: 0,
							contextTokens: 0,
							contextWindow: 0,
							contextUsagePercentage: 0,
							criticalSignals: ["SIGNAL: PARENT_GATE_BLOCKED"],
						},
					],
				}),
			},
		] as DietCodeMessage[]

		const summary = buildSubagentAuditSummary(messages)
		expect(summary?.totalAgents).to.equal(2)
		expect(summary?.runningCount).to.equal(1)
		expect(summary?.hasParentGateBlocked).to.equal(true)
		expect(summary?.hasParentAdvisoryFindings).to.equal(true)
		expect(summary?.parentGateSignals).to.have.length(3)
	})

	it("formats parent gate signals for UI labels", () => {
		expect(formatSubagentParentSignal("GATE: PARENT_BLOCKED (2)")).to.contain("Parent gate blocked")
		expect(formatSubagentParentSignal("SIGNAL: PARENT_ADVISORY_FINDINGS")).to.contain("advisory")
		expect(formatSubagentParentSignal("GATE: PARENT_ATTEMPTS (5)")).to.contain("Parent completion attempts")
		expect(formatSubagentParentSignal("GATE: PARENT_RETRY_STATUS (wait)")).to.contain("retry status")
		expect(formatSubagentParentSignal("GATE: PARENT_BLOCK_HISTORY (4)")).to.contain("block history")
	})

	it("builds markdown handoff section for audit export", () => {
		const summary = buildSubagentAuditSummary([
			{
				ts: 1,
				type: "say",
				say: "subagent",
				text: JSON.stringify({
					status: "running",
					total: 1,
					completed: 0,
					successes: 0,
					failures: 0,
					toolCalls: 0,
					inputTokens: 0,
					outputTokens: 0,
					contextWindow: 0,
					maxContextTokens: 0,
					maxContextUsagePercentage: 0,
					items: [
						{
							id: "a",
							name: "Agent 1",
							index: 1,
							prompt: "fix",
							status: "running",
							toolCalls: 0,
							inputTokens: 0,
							outputTokens: 0,
							totalCost: 0,
							contextTokens: 0,
							contextWindow: 0,
							contextUsagePercentage: 0,
							criticalSignals: ["SIGNAL: PARENT_GATE_BLOCKED"],
						},
					],
				}),
			},
		] as DietCodeMessage[])
		expect(summary).to.not.equal(undefined)
		const markdown = buildSubagentHandoffMarkdown(summary!)
		expect(markdown).to.contain("Subagent Audit Handoff")
		expect(markdown).to.contain("Parent gate blocked")
	})
})
