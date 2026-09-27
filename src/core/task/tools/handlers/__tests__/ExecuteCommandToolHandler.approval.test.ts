import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import type { StateManager } from "@/core/storage/StateManager"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@/shared/AutoApprovalSettings"
import { DietCodeDefaultTool } from "@/shared/tools"
import { executor } from "../../../ActionExecutor"
import { TaskState } from "../../../TaskState"
import { AutoApprove } from "../../autoApprove"
import type { ToolValidator } from "../../ToolValidator"
import type { TaskConfig } from "../../types/TaskConfig"
import { ToolHookUtils } from "../../utils/ToolHookUtils"
import { ExecuteCommandToolHandler } from "../ExecuteCommandToolHandler"

describe("command approval execution", () => {
	afterEach(() => sinon.restore())
	function fixture(allowed = true, autonomous = false) {
		const state = {
			getApiConfiguration: () => ({}),
			getTrustedCommands: () => ["npm test"],
			getTrustedTools: () => [],
			getGlobalSettingsKey: (key: string) =>
				key === "autoApprovalSettings"
					? DEFAULT_AUTO_APPROVAL_SETTINGS
					: key === "mode"
						? "act"
						: key === "yoloModeToggled" && autonomous,
		} as unknown as StateManager
		const callbacks = {
			ask: sinon.stub().resolves({ response: "noButtonClicked" }),
			say: sinon.stub().resolves(),
			removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
			executeCommandTool: sinon.stub().resolves([false, "tests passed"]),
		}
		const config = {
			cwd: "/workspace",
			ulid: "test",
			taskState: new TaskState(),
			mode: "act",
			api: { getModel: () => ({ id: "test" }) },
			services: {
				stateManager: state,
				commandPermissionController: { validateCommand: () => ({ allowed, reason: "denied" }) },
			},
			autoApprover: new AutoApprove(state),
			autoApprovalSettings: { ...DEFAULT_AUTO_APPROVAL_SETTINGS, enableNotifications: false },
			callbacks,
		} as unknown as TaskConfig
		sinon.stub(ToolHookUtils, "runPreToolUseIfEnabled").resolves()
		sinon.stub(executor, "execute").callsFake(async (_id, action) => action(new AbortController().signal))
		const handler = new ExecuteCommandToolHandler({ validateCommand: () => ({ ok: true }) } as unknown as ToolValidator)
		return { config, callbacks, handler }
	}
	const block = {
		type: "tool_use" as const,
		name: DietCodeDefaultTool.BASH,
		params: { command: "npm test", requires_approval: "true" },
		partial: false,
	}

	it("uses saved command trust even when the model requests approval again", async () => {
		const { config, callbacks, handler } = fixture()
		assert.equal(await handler.execute(config, block), "tests passed")
		sinon.assert.notCalled(callbacks.ask)
		sinon.assert.calledOnceWithExactly(callbacks.executeCommandTool, "npm test", 300, { interactive: false })
	})
	it("keeps explicit command policy denials effective despite saved trust", async () => {
		const { config, callbacks, handler } = fixture(false)
		assert.match(String(await handler.execute(config, block)), /denied/)
		sinon.assert.notCalled(callbacks.executeCommandTool)
	})
	it("uses saved trust when the model omits the approval hint", async () => {
		const { config, callbacks, handler } = fixture()
		assert.equal(await handler.execute(config, { ...block, params: { command: "npm test" } }), "tests passed")
		sinon.assert.notCalled(callbacks.ask)
	})
	it("uses autonomous authority when an untrusted command omits the approval hint", async () => {
		const { config, callbacks, handler } = fixture(true, true)
		assert.equal(await handler.execute(config, { ...block, params: { command: "npm run build" } }), "tests passed")
		sinon.assert.notCalled(callbacks.ask)
	})
	it("asks once for an untrusted command in manual mode instead of requesting new arguments", async () => {
		const { config, callbacks, handler } = fixture()
		assert.match(String(await handler.execute(config, { ...block, params: { command: "npm run build" } })), /denied/)
		sinon.assert.calledOnce(callbacks.ask)
		sinon.assert.notCalled(callbacks.executeCommandTool)
	})
	it("renews completion evidence only when the command or its result changes", async () => {
		const { config, callbacks, handler } = fixture()
		await handler.execute(config, block)
		assert.equal(config.taskState.workspaceRevision, 1)
		await handler.execute(config, block)
		assert.equal(config.taskState.workspaceRevision, 1)
		callbacks.executeCommandTool.resolves([false, "different test result"])
		await handler.execute(config, block)
		assert.equal(config.taskState.workspaceRevision, 2)
		assert.equal(callbacks.executeCommandTool.callCount, 3)
	})
})
