import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { matchesTrustedCommand } from "./trustedCommands"

describe("saved command approvals", () => {
	it("reuses exact commands, executable grants, and argument prefixes", () => {
		assert.equal(matchesTrustedCommand(" npm test ", ["npm test"]), true)
		assert.equal(matchesTrustedCommand("git\tstatus --short", ["git"]), true)
		assert.equal(matchesTrustedCommand("npm run test -- --watch=false", ["npm run test *"]), true)
		assert.equal(matchesTrustedCommand("git status && npm test", ["git status", "npm test"]), true)
	})
	it("does not extend a prefix to another executable or untrusted shell operation", () => {
		for (const command of [
			"npm run testing",
			"npm run test; rm -rf build",
			"npm run test > out",
			"npm run test $(whoami)",
			"npm run test `whoami`",
			"npm run test\nwhoami",
			"npm run test & whoami",
			"npm run test $ARGS",
			"npm run test %ARGS%",
			"npm run test !ARGS!",
		]) {
			assert.equal(matchesTrustedCommand(command, ["npm run test *"]), false, command)
		}
		assert.equal(matchesTrustedCommand("git-malicious status", ["git*"]), false)
		assert.equal(matchesTrustedCommand("npm test --watch", ["npm test"]), false)
		assert.equal(matchesTrustedCommand("anything", ["*"]), false)
	})
	it("preserves an explicit full-command grant without inferring additional authority", () => {
		const command = "npm test > test.log"
		assert.equal(matchesTrustedCommand(command, [command]), true)
		assert.equal(matchesTrustedCommand(`${command} && whoami`, [command]), false)
	})
})
