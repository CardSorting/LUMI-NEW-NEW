import type { DietCodeMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { filterVisibleMessages, groupLowStakesTools, isToolGroup } from "./messageUtils"

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

const createSubagentRequest = (
	ts: number,
	prompts: unknown[],
	type: "ask" | "say" = "ask",
	batchId?: string,
): DietCodeMessage => ({
	ts,
	type,
	...(type === "ask" ? { ask: "use_subagents" as const } : { say: "use_subagents" as const }),
	text: JSON.stringify({ prompts, batchId }),
})

const createSubagentStatus = (ts: number, prompts: string[], batch = String(ts), batchId?: string): DietCodeMessage => ({
	ts,
	type: "say",
	say: "subagent",
	text: JSON.stringify({
		batchId,
		status: "running",
		items: prompts.map((prompt, index) => ({ id: `${batch}-${index}`, prompt, status: "running" })),
	}),
})

describe("filterVisibleMessages subagent requests", () => {
	it("supersedes an identified partial request when its own batch starts", () => {
		const request = createSubagentRequest(1, ["Inspect"], "say", "batch-a")
		const status = createSubagentStatus(2, ["Inspect navigation"], "items-a", "batch-a")

		expect(filterVisibleMessages([request, status])).toEqual([status])
	})

	it("keeps requests from different identified batches visible even when their prompts match", () => {
		const firstRequest = createSubagentRequest(1, ["Inspect navigation"], "ask", "batch-a")
		const secondRequest = createSubagentRequest(2, ["Inspect navigation"], "ask", "batch-b")
		const status = createSubagentStatus(3, ["Inspect navigation"], "items-a", "batch-a")

		expect(filterVisibleMessages([firstRequest, secondRequest, status])).toEqual([secondRequest, status])
	})

	it.each([
		{ requestId: undefined, statusId: "native-batch" },
		{ requestId: "native-batch", statusId: undefined },
	])("does not prompt-match identified and legacy rows: %j", ({ requestId, statusId }) => {
		const request = createSubagentRequest(1, ["Inspect navigation"], "ask", requestId)
		const status = createSubagentStatus(2, ["Inspect navigation"], "items-a", statusId)

		expect(filterVisibleMessages([request, status])).toEqual([request, status])
	})

	it("consumes an explicit batch ID once even when repeated status item IDs change", () => {
		const request = createSubagentRequest(1, ["Inspect navigation"], "ask", "batch-a")
		const status = createSubagentStatus(2, ["Inspect navigation"], "items-a", "batch-a")
		const laterRequest = createSubagentRequest(3, ["Inspect navigation"], "ask", "batch-a")
		const repeatedStatus = createSubagentStatus(4, ["Inspect navigation"], "items-b", "batch-a")

		expect(filterVisibleMessages([request, status, laterRequest, repeatedStatus])).toEqual([
			status,
			laterRequest,
			repeatedStatus,
		])
	})

	it.each(["ask", "say"] as const)("only supersedes a %s request with its own batch status", (type) => {
		const unrelatedRequest = createSubagentRequest(1, ["Inspect navigation"], type)
		const request = createSubagentRequest(2, ["Verify cancellation"], type)
		const status = createSubagentStatus(3, ["Verify cancellation"])

		expect(filterVisibleMessages([unrelatedRequest, request, status])).toEqual([unrelatedRequest, status])
	})

	it("keeps a new request pending when the matching batch status is older", () => {
		const status = createSubagentStatus(1, ["Inspect navigation"])
		const request = createSubagentRequest(2, ["Inspect navigation"])

		expect(filterVisibleMessages([status, request])).toEqual([status, request])
	})

	it("only supersedes the nearest matching request when prompts are repeated", () => {
		const previousRequest = createSubagentRequest(1, ["Inspect navigation"])
		const request = createSubagentRequest(2, ["Inspect navigation"])
		const status = createSubagentStatus(3, ["Inspect navigation"])

		expect(filterVisibleMessages([previousRequest, request, status])).toEqual([previousRequest, status])
	})

	it("does not let repeated status snapshots consume a later pending request", () => {
		const request = createSubagentRequest(1, ["Inspect navigation"])
		const status = createSubagentStatus(2, ["Inspect navigation"], "first-batch")
		const pendingRequest = createSubagentRequest(3, ["Inspect navigation"])
		const repeatedStatus = createSubagentStatus(4, ["Inspect navigation"], "first-batch")

		expect(filterVisibleMessages([request, status, pendingRequest, repeatedStatus])).toEqual([
			status,
			pendingRequest,
			repeatedStatus,
		])
	})

	it("uses the status row identity for legacy batches without item IDs", () => {
		const firstRequest = createSubagentRequest(1, ["Inspect navigation"])
		const firstStatus = {
			...createSubagentStatus(2, ["Inspect navigation"]),
			text: JSON.stringify({ items: [{ prompt: "Inspect navigation", status: "running" }] }),
		}
		const secondRequest = createSubagentRequest(3, ["Inspect navigation"])
		const secondStatus = { ...firstStatus, ts: 4 }

		expect(filterVisibleMessages([firstRequest, firstStatus, secondRequest, secondStatus])).toEqual([
			firstStatus,
			secondStatus,
		])
	})

	it("matches interleaved batches by the complete ordered prompt list", () => {
		const firstRequest = createSubagentRequest(1, ["Inspect navigation", "Verify cancellation"])
		const secondRequest = createSubagentRequest(2, ["Inspect navigation"])
		const firstStatus = createSubagentStatus(3, ["Inspect navigation", "Verify cancellation"])
		const secondStatus = createSubagentStatus(4, ["Inspect navigation"])

		expect(filterVisibleMessages([firstRequest, secondRequest, firstStatus, secondStatus])).toEqual([
			firstStatus,
			secondStatus,
		])
	})

	it("normalizes surrounding whitespace without changing prompt contents or order", () => {
		const request = createSubagentRequest(1, [" Inspect navigation\n", "Verify cancellation"])
		const reorderedRequest = createSubagentRequest(2, ["Verify cancellation", "Inspect navigation"])
		const status = createSubagentStatus(3, ["Inspect navigation", "Verify cancellation"])

		expect(filterVisibleMessages([request, reorderedRequest, status])).toEqual([reorderedRequest, status])
	})

	it.each([null, "", 3])("keeps a request containing a malformed prompt visible: %j", (invalidPrompt) => {
		const request = createSubagentRequest(1, ["Inspect navigation", invalidPrompt])
		const status = createSubagentStatus(2, ["Inspect navigation"])

		expect(filterVisibleMessages([request, status])).toEqual([request, status])
	})

	it.each([
		"not JSON",
		"null",
		'{"items":[]}',
		'{"items":[{"prompt":"Inspect navigation","status":"unknown"}]}',
	])("keeps a request visible when its later status is unreadable: %s", (text) => {
		const request = createSubagentRequest(1, ["Inspect navigation"])
		const status = { ...createSubagentStatus(2, ["Inspect navigation"]), text }

		expect(filterVisibleMessages([request, status])).toEqual([request, status])
	})

	it("does not match a status after malformed entries were discarded", () => {
		const request = createSubagentRequest(1, ["Inspect navigation"])
		const status = {
			...createSubagentStatus(2, ["Inspect navigation"]),
			text: JSON.stringify({
				items: [{ id: "valid", prompt: "Inspect navigation", status: "running" }, null],
			}),
		}

		expect(filterVisibleMessages([request, status])).toEqual([request, status])
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
