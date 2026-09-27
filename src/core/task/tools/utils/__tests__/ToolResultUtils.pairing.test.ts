import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { formatResponse } from "@/core/prompts/responses"
import { DietCodeDefaultTool } from "@/shared/tools"
import { ToolResultUtils } from "../ToolResultUtils"

describe("tool result pairing", () => {
	it("marks a text failure before adding its human-readable description", () => {
		const results: any[] = []
		ToolResultUtils.pushToolResult(
			formatResponse.toolError("server conflict"),
			{
				type: "tool_use",
				name: DietCodeDefaultTool.MCP_USE,
				params: {},
				partial: false,
				tool_use_id: "failed-call",
			},
			results,
			() => "Remote action",
		)
		assert.equal(results[0].is_error, true)
		assert.match(results[0].content, /Remote action Result/)
	})
	it("records one multimodal result per call while preserving independent calls", () => {
		const results: any[] = []
		const ids = new Map([
			["call-a", "use-a"],
			["call-b", "use-b"],
		])
		const content = [{ type: "text" as const, text: "image result" }]
		const block = {
			type: "tool_use" as const,
			name: DietCodeDefaultTool.FILE_READ,
			params: {},
			partial: false,
			call_id: "call-a",
		}
		ToolResultUtils.pushToolResult(content, block, results, () => "read", undefined, ids)
		ToolResultUtils.pushToolResult(content, block, results, () => "read", undefined, ids)
		ToolResultUtils.pushToolResult(content, { ...block, call_id: "call-b" }, results, () => "read", undefined, ids)
		assert.deepEqual(
			results.map((result) => result.tool_use_id),
			["use-a", "use-b"],
		)
		assert.deepEqual(results[0].content, content)
	})
	it("does not replace an empty recorded outcome during recovery", () => {
		const results = [{ type: "tool_result", tool_use_id: "use-a", content: "" }]
		const block = { type: "tool_use" as const, name: DietCodeDefaultTool.BASH, params: {}, partial: false, call_id: "call-a" }
		ToolResultUtils.pushToolResult(
			"second outcome",
			block,
			results,
			() => "command",
			undefined,
			new Map([["call-a", "use-a"]]),
		)
		assert.equal(results.length, 1)
		assert.equal(results[0].content, "")
	})
	it("retains the provider ID and outcome when tool descriptions throw and no transport map exists", () => {
		const results: any[] = []
		ToolResultUtils.pushToolResult(
			"saved once",
			{ type: "tool_use", name: DietCodeDefaultTool.FILE_NEW, params: {}, partial: false, tool_use_id: "provider-id" },
			results,
			() => {
				throw new Error("description unavailable")
			},
		)
		assert.equal(results[0].tool_use_id, "provider-id")
		assert.match(results[0].content, /saved once/)
	})
})
