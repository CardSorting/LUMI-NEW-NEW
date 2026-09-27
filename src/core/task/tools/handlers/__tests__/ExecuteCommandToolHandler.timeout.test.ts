import assert from "node:assert/strict"
import { describe, it } from "mocha"
import {
	isLikelyLongRunningCommand,
	resolveCommandReadTimeoutSeconds,
	resolveCommandTimeoutSeconds,
} from "@/integrations/terminal/commandPolicy"

describe("ExecuteCommandToolHandler timeout policy", () => {
	it("bounds read waits, preserves explicit zero, and rejects malformed values", () => {
		for (const invalid of [undefined, "", " ", "NaN", "Infinity", "5seconds", -1]) {
			assert.equal(resolveCommandReadTimeoutSeconds(invalid), 5)
		}
		assert.equal(resolveCommandReadTimeoutSeconds("0"), 0)
		assert.equal(resolveCommandReadTimeoutSeconds(0.25), 0.25)
		assert.equal(resolveCommandReadTimeoutSeconds(Number.MAX_VALUE), 30)
	})
	it("bounds waits for all approved commands", () => {
		const timeout = resolveCommandTimeoutSeconds("npm test", undefined)
		assert.equal(timeout, 300)
	})

	it("uses explicit timeout when provided", () => {
		const timeout = resolveCommandTimeoutSeconds("npm test", "45")
		assert.equal(timeout, 45)
	})

	it("falls back to default timeout for short commands", () => {
		const timeout = resolveCommandTimeoutSeconds("ls -la", undefined)
		assert.equal(timeout, 30)
	})

	it("uses extended timeout for known long-running commands", () => {
		const timeout = resolveCommandTimeoutSeconds("npm run build", undefined)
		assert.equal(timeout, 300)
	})

	it("honors explicit waits in manual mode and fractional seconds", () => {
		assert.equal(resolveCommandTimeoutSeconds("server", "0.5"), 0.5)
		assert.equal(resolveCommandTimeoutSeconds("server", "60"), 60)
	})
	it("rejects malformed timeout text and prevents timer overflow", () => {
		for (const invalid of ["30seconds", "Infinity", "NaN", "0", "-5", ""])
			assert.equal(resolveCommandTimeoutSeconds("server", invalid), 30)
		assert.equal(resolveCommandTimeoutSeconds("server", "9999999999"), 300)
		assert.equal(resolveCommandTimeoutSeconds("server", "0.00001"), 0.001)
	})

	it("detects common long-running command families", () => {
		assert.equal(isLikelyLongRunningCommand("cargo build --release"), true)
		assert.equal(isLikelyLongRunningCommand("docker build ."), true)
		assert.equal(isLikelyLongRunningCommand("pytest -q"), true)
	})
})
