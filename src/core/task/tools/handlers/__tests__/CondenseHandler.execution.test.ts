import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import * as hooks from "@/core/hooks/hooks-utils"
import * as disk from "@/core/storage/disk"
import { DietCodeDefaultTool } from "@/shared/tools"
import { TaskState } from "../../../TaskState"
import type { TaskConfig } from "../../types/TaskConfig"
import { createUIHelpers } from "../../types/UIHelpers"
import { CondenseHandler } from "../CondenseHandler"
import { SummarizeTaskHandler } from "../SummarizeTaskHandler"

describe("context compaction continuation", () => {
	afterEach(() => sinon.restore())
	function fixture(automatic = true) {
		sinon.stub(disk, "ensureTaskDirectoryExists").resolves("/tmp/task")
		const callbacks = {
			ask: sinon.stub().resolves({ response: "yesButtonClicked" }),
			say: sinon.stub().resolves(),
			removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
		}
		const messageState = {
			getApiConversationHistory: () => [{ role: "user", content: "Fix parser" }],
			saveDietCodeMessagesAndUpdateHistory: sinon.stub().resolves(),
		}
		const contextManager = {
			getNextTruncationRange: sinon.stub().returns([2, 5]),
			triggerApplyStandardContextTruncationNoticeChange: sinon.stub().resolves(),
		}
		const config = {
			taskId: "task",
			cwd: "/workspace",
			mode: "act",
			yoloModeToggled: automatic,
			taskState: new TaskState(),
			callbacks,
			messageState,
			services: { contextManager, stateManager: { getGlobalSettingsKey: () => false } },
			autoApprovalSettings: { enableNotifications: false },
		} as unknown as TaskConfig
		return { config, callbacks, contextManager, messageState, handler: new CondenseHandler() }
	}
	const block = {
		type: "tool_use" as const,
		name: DietCodeDefaultTool.CONDENSE,
		params: { context: "Fix parser. Schema updated; remaining work: regression test. Permission already granted." },
		partial: false,
	}
	it("previews and compacts automatically while returning the summary for the next turn", async () => {
		const { config, callbacks, handler } = fixture()
		await handler.handlePartialBlock({ ...block, partial: true }, createUIHelpers(config))
		const result = String(await handler.execute(config, block))
		sinon.assert.notCalled(callbacks.ask)
		assert.match(result, /remaining work: regression test/)
		assert.match(result, /Preserve the user's objective/)
		assert.deepEqual(config.taskState.conversationHistoryDeletedRange, [2, 5])
		assert.equal(JSON.parse(callbacks.say.firstCall.args[1]).tool, "summarizeTask")
	})
	it("honors the automatic compaction preference without requiring autonomous mode", async () => {
		const { config, callbacks, handler } = fixture(false)
		config.services.stateManager.getGlobalSettingsKey = ((key: string) => key === "useAutoCondense") as never
		await handler.execute(config, block)
		sinon.assert.notCalled(callbacks.ask)
	})
	it("does not compact a denied request or repeatedly ask about the same summary", async () => {
		const { config, callbacks, contextManager, handler } = fixture(false)
		callbacks.ask.resolves({ response: "noButtonClicked" })
		assert.match(String(await handler.execute(config, block)), /denied/)
		assert.match(String(await handler.execute(config, block)), /denied/)
		sinon.assert.calledOnce(callbacks.ask)
		sinon.assert.notCalled(contextManager.getNextTruncationRange)
	})
	it("restores the previous context range when saving fails", async () => {
		const { config, handler, messageState, contextManager } = fixture()
		config.taskState.conversationHistoryDeletedRange = [2, 3]
		messageState.saveDietCodeMessagesAndUpdateHistory.rejects(new Error("disk full"))
		assert.match(String(await handler.execute(config, block)), /previous context retained/)
		assert.deepEqual(config.taskState.conversationHistoryDeletedRange, [2, 3])
		sinon.assert.notCalled(contextManager.triggerApplyStandardContextTruncationNoticeChange)
	})
	it("retains the summary when optional context notice persistence fails", async () => {
		const { config, handler, contextManager } = fixture()
		contextManager.triggerApplyStandardContextTruncationNoticeChange.rejects(new Error("notice unavailable"))
		assert.match(String(await handler.execute(config, block)), /remaining work: regression test/)
	})
	it("does not compact after cancellation during preview", async () => {
		const { config, handler, callbacks, contextManager } = fixture()
		callbacks.say.callsFake(async () => {
			config.taskState.abort = true
		})
		assert.match(String(await handler.execute(config, block)), /cancelled/)
		sinon.assert.notCalled(contextManager.getNextTruncationRange)
	})
	it("keeps the automatic summary when telemetry throws after compaction", async () => {
		const { config, contextManager } = fixture()
		sinon.stub(hooks, "getHooksEnabledSafe").returns(false)
		config.messageState.getDietCodeMessages = () => []
		Object.assign(contextManager, {
			getContextTelemetryData: () => {
				throw new Error("telemetry unavailable")
			},
		})
		const result = await new SummarizeTaskHandler({} as never).execute(config, {
			...block,
			name: DietCodeDefaultTool.SUMMARIZE_TASK,
		})
		assert.match(String(result), /remaining work: regression test/)
		assert.equal(config.taskState.currentlySummarizing, true)
	})
	it("does not consume the compaction continuation state when saving the summary fails", async () => {
		const { config, messageState } = fixture()
		sinon.stub(hooks, "getHooksEnabledSafe").returns(false)
		config.taskState.conversationHistoryDeletedRange = [2, 3]
		messageState.saveDietCodeMessagesAndUpdateHistory.rejects(new Error("disk full"))
		const result = await new SummarizeTaskHandler({} as never).execute(config, {
			...block,
			name: DietCodeDefaultTool.SUMMARIZE_TASK,
		})
		assert.match(String(result), /tool execution failed/)
		assert.deepEqual(config.taskState.conversationHistoryDeletedRange, [2, 3])
		assert.equal(config.taskState.currentlySummarizing, false)
	})
})
