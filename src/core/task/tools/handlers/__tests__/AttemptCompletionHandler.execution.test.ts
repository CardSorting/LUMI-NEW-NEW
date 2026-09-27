import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import * as hooks from "@/core/hooks/hooks-utils"
import type { StateManager } from "@/core/storage/StateManager"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@/shared/AutoApprovalSettings"
import { DietCodeDefaultTool } from "@/shared/tools"
import { executor } from "../../../ActionExecutor"
import { TaskState } from "../../../TaskState"
import * as completion from "../../attemptCompletionUtils"
import { AutoApprove } from "../../autoApprove"
import * as pipeline from "../../completionGatePipeline"
import type { ToolValidator } from "../../ToolValidator"
import type { TaskConfig } from "../../types/TaskConfig"
import { ToolHookUtils } from "../../utils/ToolHookUtils"
import { AttemptCompletionHandler } from "../AttemptCompletionHandler"
import { ExecuteCommandToolHandler } from "../ExecuteCommandToolHandler"

describe("completion command execution", () => {
	afterEach(() => sinon.restore())
	function fixture(allowed = true, trusted = true) {
		sinon.stub(hooks, "getHooksEnabledSafe").returns(false)
		sinon.stub(completion, "shouldEmitProactiveCompletionGuidance").returns(false)
		sinon.stub(completion, "shouldEmitPreflightReadinessHint").returns(false)
		sinon.stub(pipeline, "runCompletionPreflightChecks").resolves(null)
		sinon.stub(pipeline, "evaluateCompletionAuditGate").resolves({ status: "skipped" } as never)
		sinon.stub(ToolHookUtils, "runPreToolUseIfEnabled").resolves()
		sinon.stub(executor, "execute").callsFake(async (_id, action) => action(new AbortController().signal))
		const commandHandler = new ExecuteCommandToolHandler({
			validateCommand: () => ({ ok: true }),
		} as unknown as ToolValidator)
		const state = {
			getApiConfiguration: () => ({}),
			getTrustedCommands: () => (trusted ? ["npm test"] : []),
			getTrustedTools: () => [],
			getGlobalSettingsKey: (key: string) =>
				key === "autoApprovalSettings" ? DEFAULT_AUTO_APPROVAL_SETTINGS : key === "mode" ? "act" : false,
		} as unknown as StateManager
		const callbacks = {
			ask: sinon
				.stub()
				.callsFake(async (kind) => ({ response: kind === "completion_result" ? "yesButtonClicked" : "noButtonClicked" })),
			say: sinon.stub().resolves(),
			removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
			executeCommandTool: sinon.stub().resolves([false, "tests passed"]),
			saveCheckpoint: sinon.stub().resolves(),
			doesLatestTaskCompletionHaveNewChanges: sinon.stub().resolves(false),
			updateFCListFromToolResponse: sinon.stub().resolves(),
		}
		const config = {
			cwd: "/workspace",
			ulid: "test",
			taskId: "test",
			taskState: new TaskState(),
			mode: "act",
			api: { getModel: () => ({ id: "test" }) },
			messageState: { getDietCodeMessages: () => [] },
			services: {
				stateManager: state,
				browserSession: { closeBrowser: sinon.stub().resolves() },
				commandPermissionController: { validateCommand: () => ({ allowed, reason: "policy denied" }) },
			},
			autoApprover: new AutoApprove(state),
			autoApprovalSettings: { ...DEFAULT_AUTO_APPROVAL_SETTINGS, enableNotifications: false },
			focusChainSettings: { enabled: true },
			coordinator: { getHandler: () => commandHandler },
			callbacks,
		} as unknown as TaskConfig
		const block = {
			type: "tool_use" as const,
			name: DietCodeDefaultTool.ATTEMPT,
			params: { result: "The requested work is complete.", command: "npm test" },
			partial: false,
		}
		return { handler: new AttemptCompletionHandler(), config, callbacks, block }
	}
	it("reuses saved command trust and executes before publishing completion", async () => {
		const { handler, config, callbacks, block } = fixture()
		assert.match(String(await handler.execute(config, block)), /Result: Done/)
		sinon.assert.calledOnce(callbacks.executeCommandTool)
		sinon.assert.calledOnce(config.services.browserSession.closeBrowser as sinon.SinonStub)
		assert.deepEqual(
			callbacks.ask.getCalls().map((call) => call.args[0]),
			["completion_result"],
		)
		const completionMessage = callbacks.say.getCalls().find((call) => call.args[0] === "completion_result")!
		assert.ok(callbacks.executeCommandTool.firstCall.calledBefore(completionMessage))
	})
	for (const trusted of [true, false]) {
		it(
			trusted ? "honors command policy before completion" : "does not publish completion after command approval is denied",
			async () => {
				const { handler, config, callbacks, block } = fixture(!trusted, trusted)
				assert.match(String(await handler.execute(config, block)), /denied/)
				sinon.assert.notCalled(callbacks.executeCommandTool)
				sinon.assert.notCalled(config.services.browserSession.closeBrowser as sinon.SinonStub)
				assert.equal(
					callbacks.say.getCalls().some((call) => call.args[0] === "completion_result"),
					false,
				)
				assert.equal(
					callbacks.ask.getCalls().some((call) => call.args[0] === "completion_result"),
					false,
				)
			},
		)
	}
	it("retains completion after optional bookkeeping fails without replaying the command", async () => {
		const { handler, config, callbacks, block } = fixture()
		callbacks.saveCheckpoint.rejects(new Error("snapshot unavailable"))
		callbacks.doesLatestTaskCompletionHaveNewChanges.rejects(new Error("diff unavailable"))
		callbacks.updateFCListFromToolResponse.rejects(new Error("checklist unavailable"))
		assert.match(String(await handler.execute(config, block)), /Result: Done/)
		sinon.assert.calledOnce(callbacks.executeCommandTool)
		assert.deepEqual(
			callbacks.ask.getCalls().map((call) => call.args[0]),
			["completion_result"],
		)
	})
})
