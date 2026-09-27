import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { isLikelyLongRunningCommand, resolveCommandTimeoutSeconds } from "../ExecuteCommandToolHandler"

describe("ExecuteCommandToolHandler timeout policy", () => {
	it("returns undefined when managed timeout is disabled", () => {
		const timeout = resolveCommandTimeoutSeconds("npm test", undefined, false)
		assert.equal(timeout, undefined)
	})

	it("uses explicit timeout when provided", () => {
		const timeout = resolveCommandTimeoutSeconds("npm test", "45", true)
		assert.equal(timeout, 45)
	})

	it("falls back to default timeout for short commands", () => {
		const timeout = resolveCommandTimeoutSeconds("ls -la", undefined, true)
		assert.equal(timeout, 30)
	})

	it("uses extended timeout for known long-running commands", () => {
		const timeout = resolveCommandTimeoutSeconds("npm run build", undefined, true)
		assert.equal(timeout, 300)
	})

	it("honors explicit waits in manual mode and fractional seconds", () => {
		assert.equal(resolveCommandTimeoutSeconds("server", "0.5", false), 0.5)
		assert.equal(resolveCommandTimeoutSeconds("server", "60", false), 60)
	})
	it("rejects malformed timeout text and prevents timer overflow", () => {
		assert.equal(resolveCommandTimeoutSeconds("server", "30seconds", true), 30)
		assert.equal(resolveCommandTimeoutSeconds("server", "Infinity", true), 30)
		assert.equal(resolveCommandTimeoutSeconds("server", "9999999999", true), 2_147_483_647 / 1000)
	})

	it("detects common long-running command families", () => {
		assert.equal(isLikelyLongRunningCommand("cargo build --release"), true)
		assert.equal(isLikelyLongRunningCommand("docker build ."), true)
		assert.equal(isLikelyLongRunningCommand("pytest -q"), true)
	})
})
