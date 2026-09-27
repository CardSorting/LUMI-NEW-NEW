import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import type { StateManager } from "@/core/storage/StateManager"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@/shared/AutoApprovalSettings"
import * as auditPostTool from "@/shared/audit/auditPostTool"
import { DietCodeDefaultTool } from "@/shared/tools"
import { ActionAlreadyActiveError } from "../../../ActionExecutionRegistry"
import { executor } from "../../../ActionExecutor"
import { TaskState } from "../../../TaskState"
import { AutoApprove } from "../../autoApprove"
import type { ToolValidator } from "../../ToolValidator"
import type { TaskConfig } from "../../types/TaskConfig"
import { ToolHookUtils } from "../../utils/ToolHookUtils"
import { isToolFailure } from "../../utils/toolOutcome"
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
		sinon.assert.calledOnceWithMatch(callbacks.executeCommandTool, "npm test", 300, {
			interactive: false,
			cwd: "/workspace",
			signal: sinon.match.instanceOf(AbortSignal),
		})
	})
	for (const modelId of ["gpt-6-astra", "claude-sonnet", "gemini-3"]) {
		it(`repairs escaped command operators before approval, validation, hooks, and execution for ${modelId}`, async () => {
			const { config, callbacks, handler } = fixture(true, true)
			config.api.getModel = () => ({ id: modelId }) as never
			const validate = sinon.spy(config.services.commandPermissionController, "validateCommand")
			const command = "node --version && npm --version && node /tmp/concept-seed.mjs --scope direction --mode operate"
			await handler.execute(config, { ...block, params: { ...block.params, command: command.replace(/&/g, "&amp;") } })
			sinon.assert.calledOnceWithExactly(validate, command)
			sinon.assert.calledWith(callbacks.say, "command", command)
			sinon.assert.calledOnceWithMatch(ToolHookUtils.runPreToolUseIfEnabled as sinon.SinonStub, config, {
				params: { command },
			})
			sinon.assert.calledOnceWithMatch(callbacks.executeCommandTool, command)
		})
		it(`preserves literal HTML and complete flags in commands for ${modelId}`, async () => {
			const { config, callbacks, handler } = fixture(true, true)
			config.api.getModel = () => ({ id: modelId }) as never
			const command = "printf '%s' '&amp;&amp; &lt;div&gt; &quot;text&quot;' && node /tmp/concept-seed.mjs --mode operate"
			await handler.execute(config, { ...block, params: { ...block.params, command } })
			sinon.assert.calledOnceWithMatch(callbacks.executeCommandTool, command)
		})
	}
	it("validates the repaired command before it can receive trusted-command approval", async () => {
		const { config, callbacks, handler } = fixture(false, true)
		const validate = sinon.spy(config.services.commandPermissionController, "validateCommand")
		await handler.execute(config, { ...block, params: { command: "npm test &amp;&amp; blocked-command" } })
		sinon.assert.calledOnceWithExactly(validate, "npm test && blocked-command")
		sinon.assert.notCalled(callbacks.executeCommandTool)
		sinon.assert.notCalled(callbacks.ask)
	})
	it("shows the repaired command for manual approval and executes that same text", async () => {
		const { config, callbacks, handler } = fixture()
		callbacks.ask.resolves({ response: "yesButtonClicked" })
		const command = "node --version && npm --version"
		await handler.execute(config, { ...block, params: { ...block.params, command: command.replace(/&/g, "&amp;") } })
		sinon.assert.calledOnceWithMatch(
			callbacks.ask,
			"command",
			sinon.match((text: string) => text.startsWith(command)),
		)
		sinon.assert.calledOnceWithMatch(callbacks.executeCommandTool, command)
	})
	it("repairs helper commands through the same validation and execution path", async () => {
		const { config, callbacks, handler } = fixture()
		config.isSubagentExecution = true
		const validate = sinon.spy(config.services.commandPermissionController, "validateCommand")
		await handler.execute(config, { ...block, params: { command: "node --version &amp;&amp; npm --version" } })
		sinon.assert.calledOnceWithExactly(validate, "node --version && npm --version")
		sinon.assert.calledOnceWithMatch(callbacks.executeCommandTool, "node --version && npm --version")
		sinon.assert.notCalled(callbacks.ask)
		sinon.assert.notCalled(callbacks.say)
	})
	it("marks a suppressed duplicate as not started and points at its existing execution", async () => {
		const { config, callbacks, handler } = fixture()
		callbacks.say.resolves(2)
		const update = sinon.stub().resolves()
		config.messageState = {
			getDietCodeMessages: () => [
				{ ts: 1, say: "command" },
				{ ts: 2, say: "command" },
			],
			updateDietCodeMessage: update,
		} as never
		config.callbacks.postStateToWebview = sinon.stub().resolves()
		;(executor.execute as sinon.SinonStub).rejects(
			new ActionAlreadyActiveError({
				execution_id: "existing-action",
				kind: "command",
				label: "npm test",
				owner: "helper:one",
				status: "queued",
			}),
		)
		const result = await handler.execute(config, block)
		assert.ok(isToolFailure(result))
		assert.match(String(result), /existing-action/)
		sinon.assert.notCalled(callbacks.executeCommandTool)
		sinon.assert.calledOnceWithMatch(update, 1, { commandExecution: { status: "not_started" } })
		assert.equal(config.taskState.workspaceRevision, 0)
	})
	it("executes once when optional command presentation rejects", async () => {
		const { config, callbacks, handler } = fixture()
		callbacks.say.rejects(new Error("webview unavailable"))
		assert.equal(await handler.execute(config, block), "tests passed")
		sinon.assert.calledOnce(callbacks.executeCommandTool)
		sinon.assert.calledWithMatch(callbacks.executeCommandTool, "npm test", 300, { commandMessageTs: null })
	})
	it("bounds a hung presentation and does not queue further display work", async () => {
		const clock = sinon.useFakeTimers()
		const { config, callbacks, handler } = fixture()
		callbacks.removeLastPartialMessageIfExistsWithType.returns(new Promise(() => {}))
		const pending = handler.execute(config, block)
		await clock.tickAsync(1000)
		assert.equal(await pending, "tests passed")
		sinon.assert.notCalled(callbacks.say)
		sinon.assert.calledOnce(callbacks.executeCommandTool)
		assert.equal(clock.countTimers(), 0)
	})
	it("retains the command result when an optional output advisory stalls", async () => {
		const clock = sinon.useFakeTimers()
		const { config, callbacks, handler } = fixture()
		config.auditToolOutputAdvisoryEnabled = true
		config.messageState = { getDietCodeMessages: () => [] } as never
		const advisory = sinon.stub(auditPostTool, "buildCommandOutputAuditAdvisory").returns(new Promise(() => {}))
		const pending = handler.execute(config, block)
		await clock.tickAsync(1000)
		assert.equal(await pending, "tests passed")
		sinon.assert.calledOnce(advisory)
		sinon.assert.calledOnce(callbacks.executeCommandTool)
	})
	it("passes a workspace path as data without composing a cd command", async () => {
		const { config, callbacks, handler } = fixture()
		config.cwd = '/workspace/odd "name" $(literal) `text`'
		await handler.execute(config, block)
		sinon.assert.calledOnceWithMatch(callbacks.executeCommandTool, "npm test", 300, { cwd: config.cwd })
	})
	it("forwards cancellation for detached commands after the action observer has finished", async () => {
		const { config, callbacks, handler } = fixture()
		await handler.execute(config, block)
		const signal = callbacks.executeCommandTool.firstCall.args[2].signal as AbortSignal
		assert.equal(signal.aborted, false)
		config.taskState.abort = true
		assert.equal(signal.aborted, true)
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
	it("does not renew completion evidence for pending or failed commands", async () => {
		const { config, callbacks, handler } = fixture()
		for (const status of ["background", "unknown", "stopping", "stop_failed", "failed", "cancelled", "not_started"]) {
			callbacks.executeCommandTool.resolves([false, "shell output", { status, executionId: "run" }])
			const result = await handler.execute(config, block)
			assert.equal(isToolFailure(result), ["failed", "cancelled", "not_started"].includes(status))
			assert.equal(config.taskState.workspaceRevision, 0)
		}
		callbacks.executeCommandTool.resolves([false, "finished without exit status", { status: "completed" }])
		await handler.execute(config, block)
		assert.equal(config.taskState.workspaceRevision, 0)
	})
	it("uses host status rather than shell text and deduplicates successful evidence across run IDs", async () => {
		const { config, callbacks, handler } = fixture()
		for (const executionId of ["one", "two"]) {
			callbacks.executeCommandTool.resolves([
				false,
				`Command failed with exit code 1.\nExecution ID: ${executionId}`,
				{
					status: "completed",
					exitCode: 0,
					executionId,
					output: "a test deliberately printed failure text",
				},
			])
			assert.equal(isToolFailure(await handler.execute(config, block)), false)
			assert.equal(config.taskState.workspaceRevision, 1)
		}
		callbacks.executeCommandTool.resolves([false, "Command executed successfully.", { status: "failed", exitCode: 1 }])
		assert.equal(isToolFailure(await handler.execute(config, block)), true)
		assert.equal(config.taskState.workspaceRevision, 1)
	})
	it("keeps user image feedback when a command was cancelled", async () => {
		const { config, callbacks, handler } = fixture()
		const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "feedback" } }
		callbacks.executeCommandTool.resolves([true, [{ type: "text", text: "stop feedback" }, image], { status: "cancelled" }])
		const result = await handler.execute(config, block)
		assert.equal(isToolFailure(result), true)
		assert.ok(Array.isArray(result))
		assert.deepEqual(result[1], image)
		assert.equal(config.taskState.didRejectTool, true)
	})
})
