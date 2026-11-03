import { expect } from "chai"
import { explicitlyProhibitsDelegation } from "../delegationPolicy"

describe("explicitlyProhibitsDelegation", () => {
	it("recognizes common direct prohibitions without rejecting ordinary task descriptions", () => {
		for (const text of [
			"Do not delegate this task",
			"Don't spawn any subagents",
			"Work without a team",
			"No specialists please",
		]) {
			expect(explicitlyProhibitsDelegation(text), text).to.equal(true)
		}
		expect(explicitlyProhibitsDelegation("Build a team management dashboard")).to.equal(false)
	})
})
