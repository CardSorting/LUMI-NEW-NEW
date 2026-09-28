import { strict as assert } from "node:assert"
import { describeSubagentTool, subagentMessagePreview } from "../SubagentProgress"

describe("helper progress previews", () => {
	it("streams public commentary without partial XML tool payloads or private reasoning", () => {
		assert.equal(
			subagentMessagePreview(
				"<thinking>Private plan</thinking>Checking safe openings.\n<write_to_file><path>game.ts</path><content>large source code",
			),
			"Checking safe openings.",
		)
		assert.equal(subagentMessagePreview("Checking safe openings.\n<write_to_"), "Checking safe openings.")
		assert.equal(subagentMessagePreview("<analysis>Unfinished private reasoning"), "")
		assert.equal(
			subagentMessagePreview(
				"<thinking>Private</thinking>Checking files.<read_file><path>game.ts</path></read_file>\nAdding tests.",
			),
			"Checking files.\nAdding tests.",
		)
		assert.equal(subagentMessagePreview("x".repeat(4000)).length, 1200)
	})

	it("names an operation and its target without exposing file or remote tool payloads", () => {
		assert.equal(
			describeSubagentTool("write_to_file", { path: "src/domain/game.ts", content: "source code" }),
			"Writing src/domain/game.ts",
		)
		assert.equal(
			describeSubagentTool("apply_patch", {
				input: "*** Begin Patch\n*** Update File: src/domain/game.ts\n+source code\n*** End Patch",
			}),
			"Applying changes to src/domain/game.ts",
		)
		assert.equal(
			describeSubagentTool("use_mcp_tool", { server_name: "docs", tool_name: "search", arguments: "private payload" }),
			"Using docs / search",
		)
		assert.ok(describeSubagentTool("execute_command", { command: "long command ".repeat(1000) }).length <= 300)
	})
})
