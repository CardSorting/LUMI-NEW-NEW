import type { DietCodeMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { groupMessages } from "./messageUtils"

const say = (ts: number, kind: DietCodeMessage["say"], text = ""): DietCodeMessage => ({ ts, type: "say", say: kind, text })
describe("interleaved browser sessions", () => {
	it("keeps edits in chronological order and resumes screenshot grouping without a relaunch", () => {
		const launch = say(1, "browser_action_launch", "http://localhost")
		const initial = say(2, "browser_action_result", '{"currentUrl":"http://localhost"}')
		const edit = say(3, "tool", '{"tool":"editedExistingFile"}')
		const refresh = say(4, "browser_action", '{"action":"refresh"}')
		const updated = say(5, "browser_action_result", '{"currentUrl":"http://localhost"}')
		expect(groupMessages([launch, initial, edit, refresh, updated])).toEqual([[launch, initial], edit, [refresh, updated]])
	})
	it("renders a recovered result even without a launch row and ends the group on close", () => {
		const result = say(1, "browser_action_result", '{"currentUrl":"http://localhost"}')
		const close = say(2, "browser_action", '{"action":"close"}')
		const text = say(3, "text", "Done")
		expect(groupMessages([result, close, text])).toEqual([[result, close], text])
	})
	it("does not swallow later chat text after an isolated close", () => {
		const close = say(1, "browser_action", '{"action":"close"}')
		const text = say(2, "text", "Done")
		expect(groupMessages([close, text])).toEqual([[close], text])
	})
})
