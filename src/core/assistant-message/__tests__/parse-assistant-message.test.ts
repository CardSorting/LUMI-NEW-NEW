import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { parseAssistantMessageV2, type ToolUse } from ".."

describe("streamed XML tool identity", () => {
	const assignment = "<use_subagents><prompt_1>Implement pure Minesweeper engine"
	const complete = `${assignment} and tests only.</prompt_1></use_subagents>`
	const tools = (text: string, previous?: ReturnType<typeof parseAssistantMessageV2>) =>
		parseAssistantMessageV2(text, previous).filter((block): block is ToolUse => block.type === "tool_use")

	it("keeps the helper preview and final assignment on the same call ID", () => {
		const partial = tools(assignment)
		const final = tools(complete, partial)
		assert.ok(partial[0].call_id)
		assert.equal(final[0].call_id, partial[0].call_id)
		assert.equal(final[0].partial, false)
		assert.equal(final[0].params.prompt_1, "Implement pure Minesweeper engine and tests only.")
	})

	it("preserves IDs through every appended chunk and separates identical calls", () => {
		const text = `Starting.\n${complete}\nNext.\n${complete}`
		let previous: ReturnType<typeof parseAssistantMessageV2> = []
		const ids = new Map<number, string>()
		for (let end = 1; end <= text.length; end++) {
			previous = parseAssistantMessageV2(text.slice(0, end), previous)
			const calls = previous.filter((block): block is ToolUse => block.type === "tool_use")
			calls.forEach((call, index) => {
				assert.ok(call.call_id)
				if (!ids.has(index)) ids.set(index, call.call_id)
				assert.equal(call.call_id, ids.get(index))
			})
		}
		assert.equal(ids.size, 2)
		assert.notEqual(ids.get(0), ids.get(1))
		assert.notEqual(tools(complete)[0].call_id, ids.get(0), "a new response owns new call IDs")
	})

	it("keeps an unfinished command partial and preserves its complete arguments", () => {
		const prefix = "<execute_command><command>node /tmp/concept-seed.mjs --scope direction --mode opera"
		const partial = tools(prefix)
		assert.equal(partial[0].partial, true)
		const final = tools(`${prefix}te</command><requires_approval>false</requires_approval></execute_command>`, partial)
		assert.equal(final[0].partial, false)
		assert.equal(final[0].call_id, partial[0].call_id)
		assert.equal(final[0].params.command, "node /tmp/concept-seed.mjs --scope direction --mode operate")
	})
})
