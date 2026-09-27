import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { combineCommandSequences } from "./combineCommandSequences"

describe("command output snapshots", () => {
	it("replaces earlier streamed output with an authoritative snapshot without duplicating lines", () => {
		const [result] = combineCommandSequences([
			{ ts: 1, type: "say", say: "command", text: "build", commandOutput: "first\nfinished" },
			{ ts: 2, type: "say", say: "command_output", text: "first" },
		])
		assert.equal(result.commandOutput, "first\nfinished")
		assert.equal(result.text, "build")
	})
	it("preserves a deliberately empty snapshot and still combines legacy streamed output", () => {
		const results = combineCommandSequences([
			{ ts: 1, type: "say", say: "command", text: "empty", commandOutput: "" },
			{ ts: 2, type: "say", say: "command_output", text: "obsolete" },
			{ ts: 3, type: "say", say: "command", text: "legacy" },
			{ ts: 4, type: "say", say: "command_output", text: "current" },
		])
		assert.deepEqual(
			results.map((row) => row.commandOutput),
			["", "current"],
		)
	})
})
