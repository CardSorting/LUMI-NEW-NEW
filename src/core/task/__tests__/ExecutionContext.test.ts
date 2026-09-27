import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import type { DietCodeStorageMessage } from "@/shared/messages"
import { withExecutionContext } from "../ExecutionContext"
import type { ExecutionState } from "../ExecutionState"

describe("execution context at model dispatch", () => {
	function fixture() {
		const state: ExecutionState = {
			commands: { active: [], recent: [] },
			actions: {
				active: [{ execution_id: "sibling", kind: "helper", label: "Review", owner: "helper:one", status: "running" }],
				recent: [],
			},
		}
		const conversation = [
			{ role: "user", content: [{ type: "text", text: "Original assignment" }] },
		] as DietCodeStorageMessage[]
		return { state, conversation }
	}
	it("refreshes after preparation and retries without changing stored history or accumulating snapshots", () => {
		const { state, conversation } = fixture()
		const saved = JSON.stringify(conversation)
		Object.freeze(conversation[0].content)
		Object.freeze(conversation[0])
		Object.freeze(conversation)
		const first = withExecutionContext(conversation, () => state)
		state.actions.active[0].status = "awaiting_completion"
		const retry = withExecutionContext(first, () => state, "helper:two")
		assert.equal(JSON.stringify(conversation), saved)
		assert.ok(JSON.stringify(first).includes("running"))
		assert.ok(JSON.stringify(retry).includes("awaiting_completion"))
		assert.ok(JSON.stringify(retry).includes("helper:two"))
		assert.equal(JSON.stringify(retry).match(/<execution_state>/g)?.length, 1)
	})
	it("keeps native tool-result adjacency and preserves user or tool text containing snapshot tags", () => {
		const { state, conversation } = fixture()
		conversation.push({
			role: "assistant",
			content: [{ type: "tool_use", id: "call", name: "read_file", input: { path: "a" } }],
		})
		const toolResult = {
			type: "tool_result" as const,
			tool_use_id: "call",
			content: "<execution_state>file data</execution_state>",
		}
		const userText = { type: "text" as const, text: "<execution_state>User supplied example</execution_state>" }
		conversation.push({ role: "user", content: [toolResult, userText] })
		const result = withExecutionContext(conversation, () => state)
		assert.equal(result.length, conversation.length)
		assert.equal(result[1], conversation[1])
		assert.ok(Array.isArray(result[2].content))
		assert.equal(result[2].content[0], toolResult)
		assert.equal(result[2].content[1], userText)
		assert.equal(result[2].content.length, 3)
	})
	it("reports unavailable observation instead of presenting a false empty inventory", () => {
		const { conversation } = fixture()
		for (const getter of [
			undefined,
			() => {
				throw new Error("host offline")
			},
		]) {
			const result = JSON.stringify(withExecutionContext(conversation, getter))
			assert.match(result, /inventory is unavailable/)
			assert.match(result, /does not mean no work is running/)
			assert.equal(JSON.stringify(conversation).includes("execution_state"), false)
		}
	})
	it("leaves an empty conversation unchanged", () => {
		const conversation: DietCodeStorageMessage[] = []
		assert.equal(
			withExecutionContext(conversation, () => {
				throw new Error("must not read")
			}),
			conversation,
		)
	})
	it("uses the dispatching model's context window to budget transient state", () => {
		const { state, conversation } = fixture()
		state.actions.active = Array.from({ length: 128 }, (_, i) => ({
			...state.actions.active[0],
			execution_id: `work-${i}`,
			input_preview: "Details ".repeat(100),
		}))
		const result = withExecutionContext(conversation, () => state, "parent", 32_000)
		assert.ok(Array.isArray(result[0].content))
		const block = result[0].content.at(-1)!
		assert.ok("text" in block)
		assert.ok(Buffer.byteLength(block.text) <= 3200)
		assert.match(block.text, /omitted/)
	})
})
