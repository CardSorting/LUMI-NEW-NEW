import { describe, expect, it } from "vitest"
import {
	type DietCodeMessage,
	filterVisibleMessages,
	findApiReqInfoForCheckpoint,
	findNextSegmentCost,
	groupLowStakesTools,
	isToolGroup,
} from "./messageUtils"

const createTextMessage = (ts: number, text: string): DietCodeMessage => ({
	type: "say",
	say: "text",
	text,
	ts,
})

const createToolMessage = (ts: number, tool: string): DietCodeMessage => ({
	type: "say",
	say: "tool",
	text: JSON.stringify({ tool, path: "src/file.ts" }),
	ts,
})

const createReasoningMessage = (ts: number, text: string): DietCodeMessage => ({
	type: "say",
	say: "reasoning",
	text,
	ts,
})

describe("filterVisibleMessages", () => {
	it("filters out empty text messages", () => {
		const messages: DietCodeMessage[] = [createTextMessage(1, "Visible text"), createTextMessage(2, "")]
		expect(filterVisibleMessages(messages)).toEqual([messages[0]])
	})

	it("filters out task_progress and deleted_api_reqs messages", () => {
		const messages: DietCodeMessage[] = [
			createTextMessage(1, "Visible text"),
			{ type: "say", say: "task_progress", ts: 2, text: "progress" },
			{ type: "say", say: "deleted_api_reqs", ts: 3, text: "{}" },
		]
		expect(filterVisibleMessages(messages)).toEqual([messages[0]])
	})
})

describe("groupLowStakesTools", () => {
	it("ignores text that arrives after a low-stakes tool group has started", () => {
		const grouped = groupLowStakesTools([
			createTextMessage(1, "Initial text"),
			createToolMessage(2, "readFile"),
			createTextMessage(3, "Late text that should be ignored"),
		])

		expect(grouped).toHaveLength(2)
		expect(grouped[0]).toMatchObject({ type: "say", say: "text", text: "Initial text" })
		expect(isToolGroup(grouped[1])).toBe(true)

		if (isToolGroup(grouped[1])) {
			expect(grouped[1].every((message) => message.say !== "text")).toBe(true)
		}
	})

	it("keeps text when no low-stakes tool group is active", () => {
		const grouped = groupLowStakesTools([
			createTextMessage(1, "Initial text"),
			createToolMessage(2, "editedExistingFile"),
			createTextMessage(3, "Follow-up text"),
		])

		expect(grouped).toHaveLength(3)
		expect(grouped[0]).toMatchObject({ type: "say", say: "text", text: "Initial text" })
		expect(grouped[1]).toMatchObject({ type: "say", say: "tool" })
		expect(grouped[2]).toMatchObject({ type: "say", say: "text", text: "Follow-up text" })
	})

	it("keeps standalone reasoning when no low-stakes tool group follows", () => {
		const grouped = groupLowStakesTools([
			createReasoningMessage(1, "Thinking through options"),
			createTextMessage(2, "Answer text"),
		])

		expect(grouped).toHaveLength(2)
		expect(grouped[0]).toMatchObject({ type: "say", say: "reasoning", text: "Thinking through options" })
		expect(grouped[1]).toMatchObject({ type: "say", say: "text", text: "Answer text" })
	})

	it("keeps standalone reasoning before a non-low-stakes tool", () => {
		const grouped = groupLowStakesTools([
			createReasoningMessage(1, "Thinking through options"),
			createToolMessage(2, "editedExistingFile"),
		])

		expect(grouped).toHaveLength(2)
		expect(grouped[0]).toMatchObject({ type: "say", say: "reasoning", text: "Thinking through options" })
		expect(grouped[1]).toMatchObject({ type: "say", say: "tool" })
	})

	it("keeps reasoning visible when low-stakes tool group starts immediately after", () => {
		const grouped = groupLowStakesTools([createReasoningMessage(1, "Planning next read"), createToolMessage(2, "readFile")])

		expect(grouped).toHaveLength(2)
		expect(grouped[0]).toMatchObject({ type: "say", say: "reasoning", text: "Planning next read" })
		expect(isToolGroup(grouped[1])).toBe(true)
	})
})

describe("findNextSegmentCost", () => {
	it("combines parent cost and specialistUsage cost", () => {
		const messages: DietCodeMessage[] = [
			{ type: "say", say: "checkpoint_created", ts: 10 },
			{
				type: "say",
				say: "api_req_started",
				ts: 20,
				text: JSON.stringify({
					cost: 0.05,
					specialistUsage: { tokensIn: 100, tokensOut: 20, cacheWrites: 0, cacheReads: 0, cost: 0.02 },
				}),
			},
		]
		const cost = findNextSegmentCost(10, messages)
		expect(cost).toBeCloseTo(0.07, 5)
	})

	it("returns cost when only specialistUsage cost exists", () => {
		const messages: DietCodeMessage[] = [
			{ type: "say", say: "checkpoint_created", ts: 10 },
			{
				type: "say",
				say: "api_req_started",
				ts: 20,
				text: JSON.stringify({
					specialistUsage: { tokensIn: 100, tokensOut: 20, cacheWrites: 0, cacheReads: 0, cost: 0.03 },
				}),
			},
		]
		const cost = findNextSegmentCost(10, messages)
		expect(cost).toBeCloseTo(0.03, 5)
	})
})

describe("findApiReqInfoForCheckpoint", () => {
	it("includes specialistUsage cost in checkpoint cost calculation", () => {
		const messages: DietCodeMessage[] = [
			{
				type: "say",
				say: "api_req_started",
				ts: 10,
				text: JSON.stringify({
					request: "Do task",
					cost: 0.1,
					specialistUsage: { tokensIn: 50, tokensOut: 10, cacheWrites: 0, cacheReads: 0, cost: 0.04 },
				}),
			},
			{ type: "say", say: "checkpoint_created", ts: 20 },
		]
		const info = findApiReqInfoForCheckpoint(20, messages)
		expect(info.cost).toBeCloseTo(0.14, 5)
		expect(info.request).toBe("Do task")
	})
})
