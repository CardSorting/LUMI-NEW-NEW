import { strict as assert } from "node:assert"
import type { DietCodeMessage } from "@shared/ExtensionMessage"
import { describe, it } from "mocha"
import sinon from "sinon"
import { TaskState } from "../../../TaskState"
import type { TaskConfig } from "../../types/TaskConfig"
import { ToolResultUtils } from "../ToolResultUtils"

function fixture() {
	const messages: DietCodeMessage[] = []
	const ask = sinon.stub().resolves({ response: "noButtonClicked" })
	const config = {
		cwd: "/workspace",
		mode: "act",
		taskState: new TaskState(),
		messageState: { getDietCodeMessages: () => messages },
		autoApprovalSettings: { enableNotifications: false },
		callbacks: { ask, removeLastPartialMessageIfExistsWithType: sinon.stub().resolves() },
	} as unknown as TaskConfig
	return { config, ask, messages }
}

describe("approval denial memory", () => {
	it("does not prompt again for the same denied action on subsequent agent turns", async () => {
		const { config, ask } = fixture()
		assert.equal(await ToolResultUtils.askApprovalAndPushFeedback("command", "npm test", config), false)
		config.taskState.didRejectTool = false
		assert.equal(await ToolResultUtils.askApprovalAndPushFeedback("command", "npm test", config), false)
		sinon.assert.calledOnce(ask)
		assert.equal(config.taskState.didRejectTool, true)
		sinon.assert.calledWith(config.callbacks.removeLastPartialMessageIfExistsWithType as sinon.SinonStub, "ask", "command")
	})
	it("does not execute after cancellation while an approval was pending", async () => {
		const { config, ask } = fixture()
		ask.callsFake(async () => {
			config.taskState.abort = true
			return { response: "yesButtonClicked" }
		})
		assert.equal(await ToolResultUtils.askApprovalAndPushFeedback("command", "npm test", config), false)
		assert.equal(config.taskState.deniedToolApprovals.size, 0)
	})
	it("allows a fresh decision after new user direction, without automatically granting it", async () => {
		const { config, ask, messages } = fixture()
		await ToolResultUtils.askApprovalAndPushFeedback("command", "npm test", config)
		messages.push({ ts: 2, type: "say", say: "user_feedback", text: "Run the tests now" })
		ask.resolves({ response: "yesButtonClicked" })
		assert.equal(await ToolResultUtils.askApprovalAndPushFeedback("command", "npm test", config), true)
		sinon.assert.calledTwice(ask)
	})
	it("keeps independent actions and other workspaces eligible for approval", async () => {
		const { config, ask } = fixture()
		await ToolResultUtils.askApprovalAndPushFeedback("command", "npm test", config)
		await ToolResultUtils.askApprovalAndPushFeedback("command", "npm run build", config)
		config.cwd = "/another-workspace"
		await ToolResultUtils.askApprovalAndPushFeedback("command", "npm test", config)
		sinon.assert.calledThrice(ask)
	})
})
