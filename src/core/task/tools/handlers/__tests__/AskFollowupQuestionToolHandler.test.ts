import { strict as assert } from "node:assert"
import type { ToolUse } from "@core/assistant-message"
import { describe, it } from "mocha"
import sinon from "sinon"
import { DietCodeDefaultTool } from "@/shared/tools"
import { TaskState } from "../../../TaskState"
import type { TaskConfig } from "../../types/TaskConfig"
import { createUIHelpers } from "../../types/UIHelpers"
import { AskFollowupQuestionToolHandler } from "../AskFollowupQuestionToolHandler"

function fixture(yoloModeToggled: boolean, isSubagentExecution = false) {
	const callbacks = {
		ask: sinon.stub().resolves({ text: "blue" }),
		say: sinon.stub().resolves(),
		removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
		sayAndCreateMissingParamError: sinon.stub().resolves("missing question"),
	}
	const config = {
		yoloModeToggled,
		isSubagentExecution,
		callbacks,
		taskState: new TaskState(),
		autoApprovalSettings: { enableNotifications: false },
		messageState: { getDietCodeMessages: () => [], saveDietCodeMessagesAndUpdateHistory: sinon.stub().resolves() },
	} as unknown as TaskConfig
	const block: ToolUse = {
		type: "tool_use",
		name: DietCodeDefaultTool.ASK,
		params: { question: "Which color?", options: '["blue","red"]' },
		partial: false,
	}
	return { config, callbacks, block, handler: new AskFollowupQuestionToolHandler() }
}

describe("follow-up question flow", () => {
	for (const [autonomous, helper] of [
		[true, false],
		[false, true],
	]) {
		it(`keeps ${helper ? "helpers" : "autonomous tasks"} moving without flashing an unanswered question`, async () => {
			const { config, callbacks, block, handler } = fixture(autonomous, helper)
			await handler.handlePartialBlock({ ...block, partial: true }, createUIHelpers(config))
			const result = await handler.execute(config, block)
			sinon.assert.notCalled(callbacks.ask)
			sinon.assert.notCalled(callbacks.say)
			sinon.assert.calledOnceWithExactly(callbacks.removeLastPartialMessageIfExistsWithType, "ask", "followup")
			assert.match(String(result), /reasonable assumption and proceed/)
			assert.match(String(result), /Do not invent credentials/)
			if (helper) assert.match(String(result), /handoff to the parent/)
		})
	}
	it("retains interactive questions when the user chose that mode", async () => {
		const { config, callbacks, block, handler } = fixture(false)
		assert.match(String(await handler.execute(config, block)), /<answer>\nblue\n<\/answer>/)
		sinon.assert.calledOnce(callbacks.ask)
	})
	it("rejects whitespace-only questions", async () => {
		const { config, callbacks, block, handler } = fixture(true)
		block.params.question = " \n "
		assert.equal(await handler.execute(config, block), "missing question")
		sinon.assert.notCalled(callbacks.ask)
	})
	it("does not record an answer or resume work after cancellation", async () => {
		const { config, callbacks, block, handler } = fixture(false)
		callbacks.ask.callsFake(async () => {
			config.taskState.abort = true
			return {}
		})
		assert.match(String(await handler.execute(config, block)), /cancelled/)
		sinon.assert.notCalled(callbacks.say)
	})
})
