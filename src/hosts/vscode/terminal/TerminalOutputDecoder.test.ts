import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { TerminalOutputDecoder } from "./TerminalOutputDecoder"

describe("terminal output decoding", () => {
	it("removes split ANSI and OSC sequences at every possible chunk boundary", () => {
		const raw = "\x1b]633;C\x07工具\x1b[31m100%\x1b[0m\n\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\n\x1b]633;D;7\x07"
		for (let split = 0; split <= raw.length; split++) {
			const decoder = new TerminalOutputDecoder()
			assert.equal(decoder.write(raw.slice(0, split)) + decoder.write(raw.slice(split)), "工具100%\nlink\n")
		}
	})
	it("never uses text resembling an exit marker or control-C as lifecycle evidence", () => {
		const decoder = new TerminalOutputDecoder()
		const text = "]633;D;0\n^C\n# $HOME <tag> 100%\n"
		assert.equal(decoder.write(text), text)
	})
	it("handles an oversized escape sequence without retaining its payload", () => {
		const decoder = new TerminalOutputDecoder()
		assert.equal(decoder.write("\x1b]" + "x".repeat(1_000_000)), "")
		assert.equal(decoder.write("\x07ready"), "ready")
		assert.equal(JSON.stringify(decoder).length < 100, true)
	})
})
