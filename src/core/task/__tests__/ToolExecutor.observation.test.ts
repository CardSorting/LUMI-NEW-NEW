import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import * as hooks from "@/core/hooks/hooks-utils"
import { formatResponse } from "@/core/prompts/responses"
import { DietCodeDefaultTool } from "@/shared/tools"
import { TaskState } from "../TaskState"
import { ToolExecutor } from "../ToolExecutor"
import { ToolResultUtils } from "../tools/utils/ToolResultUtils"

describe("tool execution and observation", () => {
	afterEach(() => sinon.restore())
	function fixture(hooksEnabled = false) {
		sinon.stub(hooks, "getHooksEnabledSafe").returns(hooksEnabled)
		const instance = Object.assign(Object.create(ToolExecutor.prototype), {
			taskState: new TaskState(),
			cwd: "/workspace",
			stateManager: { getGlobalSettingsKey: (key: string) => (key === "mode" ? "act" : { enabled: true }) },
			guard: {
				setMode: sinon.stub(),
				guardPreExecution: sinon.stub().resolves({ success: true }),
				guardPostExecution: sinon.stub().resolves({ success: true }),
				onRead: sinon.stub().callsFake(async (_path, result) => result),
			},
			coordinator: { execute: sinon.stub().resolves("operation succeeded") },
			pushToolResult: sinon.stub(),
			say: sinon.stub().resolves(),
			runPostToolUseHook: sinon.stub().resolves(false),
			updateFCListFromToolResponse: sinon.stub().resolves(),
		})
		const config = { callbacks: { cancelTask: sinon.stub().resolves() } }
		const block = { name: DietCodeDefaultTool.BASH, params: { command: "test" }, partial: false }
		return { instance, config, block }
	}
	it("keeps one successful result when post-execution observation throws", async () => {
		const { instance, config, block } = fixture()
		instance.guard.guardPostExecution.rejects(new Error("observer unavailable"))
		await instance.handleCompleteBlock(block, config)
		sinon.assert.calledOnce(instance.coordinator.execute)
		sinon.assert.calledOnceWithExactly(instance.pushToolResult, "operation succeeded", block)
	})
	it("passes repaired command operators to the policy guard and execution without rewriting the source block", async () => {
		const { instance, config, block } = fixture()
		block.params.command = "node --version &amp;&amp; npm --version"
		await instance.handleCompleteBlock(block, config)
		const expected = { params: { command: "node --version && npm --version" } }
		sinon.assert.calledOnceWithMatch(instance.guard.guardPreExecution, expected)
		sinon.assert.calledOnceWithMatch(instance.coordinator.execute, config, expected)
		assert.equal(block.params.command, "node --version &amp;&amp; npm --version")
	})
	it("dispatches one mutation for concurrent and repeated native deliveries, including late previews", async () => {
		const { instance, config, block } = fixture()
		instance.asToolConfig = sinon.stub().resolves(config)
		instance.coordinator.has = () => true
		instance.isParallelToolCallingEnabled = () => true
		instance.handlePartialBlock = sinon.stub().resolves()
		let release!: (value: string) => void
		instance.coordinator.execute.returns(
			new Promise<string>((resolve) => {
				release = resolve
			}),
		)
		const native = { ...block, tool_use_id: "provider-one", call_id: "transport-one" }
		const first = instance.executeTool(native)
		const repeated = instance.executeTool(native)
		const preview = instance.executeTool({ ...native, partial: true })
		release("changed workspace once")
		await Promise.all([first, repeated, preview])
		await instance.executeTool(native)
		sinon.assert.calledOnce(instance.coordinator.execute)
		sinon.assert.calledOnce(instance.pushToolResult)
		sinon.assert.notCalled(instance.handlePartialBlock)
		await instance.executeTool({ ...native, tool_use_id: "provider-two", call_id: "transport-two" })
		assert.equal(instance.coordinator.execute.callCount, 2)
	})
	it("retains uncertain dispatch ownership instead of replaying after a rejected promise", async () => {
		const { instance, block } = fixture()
		instance.execute = sinon.stub().rejects(new Error("outcome unknown"))
		const native = { ...block, tool_use_id: "one" }
		await assert.rejects(instance.executeTool(native), /outcome unknown/)
		await assert.rejects(instance.executeTool(native), /outcome unknown/)
		sinon.assert.calledOnce(instance.execute)
		instance.taskState.nativeToolExecutions.clear()
		instance.execute.resolves()
		await instance.executeTool(native)
		assert.equal(instance.execute.callCount, 2)
	})
	it("pairs an unavailable tool without preparing services or asking for approval", async () => {
		const { instance, block } = fixture()
		instance.coordinator.has = () => false
		instance.asToolConfig = sinon.stub().rejects(new Error("must not load configuration"))
		await instance.executeTool({ ...block, tool_use_id: "unknown-tool" })
		sinon.assert.notCalled(instance.asToolConfig)
		sinon.assert.notCalled(instance.coordinator.execute)
		sinon.assert.calledOnce(instance.pushToolResult)
		assert.match(instance.pushToolResult.firstCall.args[0], /unavailable/)
	})
	it("records setup failures before attempting their optional error display", async () => {
		const { instance, block } = fixture()
		instance.coordinator.has = () => true
		instance.asToolConfig = sinon.stub().rejects(new Error("configuration unavailable"))
		instance.say.rejects(new Error("display unavailable"))
		await instance.executeTool({ ...block, tool_use_id: "setup-failed" })
		sinon.assert.calledOnce(instance.pushToolResult)
		sinon.assert.callOrder(instance.pushToolResult, instance.say)
		sinon.assert.notCalled(instance.coordinator.execute)
	})
	it("lets a completed call proceed after a failed preview without recording a premature result", async () => {
		const { instance, config, block } = fixture()
		instance.coordinator.has = () => true
		instance.asToolConfig = sinon.stub().onFirstCall().rejects(new Error("preview unavailable"))
		instance.asToolConfig.onSecondCall().resolves(config)
		instance.isParallelToolCallingEnabled = () => true
		const native = { ...block, tool_use_id: "preview" }
		await instance.executeTool({ ...native, partial: true })
		sinon.assert.notCalled(instance.pushToolResult)
		await instance.executeTool(native)
		sinon.assert.calledOnce(instance.coordinator.execute)
		sinon.assert.calledOnce(instance.pushToolResult)
	})
	it("retains the browser through complete and streamed non-browser tools", async () => {
		const { instance, config, block } = fixture()
		const browser = { closeBrowser: sinon.stub(), setScreenshotFormat: sinon.stub() }
		instance.browserSession = browser
		instance.api = { getModel: () => ({ id: "test", info: {} }) }
		instance.asToolConfig = sinon.stub().resolves(config)
		instance.coordinator.has = () => true
		instance.isParallelToolCallingEnabled = () => true
		instance.handlePartialBlock = sinon.stub().resolves()
		instance.handleCompleteBlock = sinon.stub().resolves()
		await instance.executeTool({ ...block, partial: true })
		await instance.executeTool(block)
		sinon.assert.calledOnce(instance.handlePartialBlock)
		sinon.assert.calledOnce(instance.handleCompleteBlock)
		sinon.assert.notCalled(browser.closeBrowser)
		assert.equal(await instance.applyLatestBrowserSettings(), browser)
		sinon.assert.calledOnce(browser.setScreenshotFormat)
	})
	it("preserves a read result when enrichment fails before result recording", async () => {
		const { instance, config } = fixture()
		instance.guard.onRead.rejects(new Error("index unavailable"))
		const block = { name: DietCodeDefaultTool.FILE_READ, params: { path: "src/a.ts" }, partial: false }
		await instance.handleCompleteBlock(block, config)
		sinon.assert.calledOnceWithExactly(instance.pushToolResult, "operation succeeded", block)
	})
	it("tracks underlying evidence without letting changing read advice conceal a loop", async () => {
		const { instance, config } = fixture()
		const block = { name: DietCodeDefaultTool.FILE_READ, params: { path: "src/a.ts" }, partial: false }
		let observation = 0
		instance.guard.onRead.callsFake(async (_path: string, result: string) => `${result}\nAdvice ${observation++}`)
		for (let turn = 0; turn <= 8; turn++) {
			await instance.handleCompleteBlock(block, config)
			assert.equal(
				instance.taskState.executionProgress.finishTurn(),
				turn === 8 ? "handoff" : turn === 3 ? "redirect" : "continue",
			)
		}
		assert.equal(instance.coordinator.execute.callCount, 9)
	})
	it("runs the post hook exactly once on success and retains the outcome on hook failure", async () => {
		const { instance, config, block } = fixture(true)
		instance.runPostToolUseHook.rejects(new Error("hook unavailable"))
		instance.updateFCListFromToolResponse.rejects(new Error("checklist unavailable"))
		await instance.handleCompleteBlock(block, config)
		sinon.assert.calledOnce(instance.runPostToolUseHook)
		assert.equal(instance.runPostToolUseHook.firstCall.args[2], true)
		sinon.assert.calledOnceWithExactly(instance.pushToolResult, "operation succeeded", block)
	})
	it("reports a denial as failure without post-write observations", async () => {
		const { instance, config, block } = fixture(true)
		instance.coordinator.execute.resolves(formatResponse.toolDenied())
		await instance.handleCompleteBlock(block, config)
		sinon.assert.notCalled(instance.guard.guardPostExecution)
		assert.equal(instance.runPostToolUseHook.firstCall.args[2], false)
	})
	it("honors explicit hook cancellation after saving the result", async () => {
		const { instance, config, block } = fixture(true)
		instance.runPostToolUseHook.resolves(true)
		await instance.handleCompleteBlock(block, config)
		sinon.assert.callOrder(instance.pushToolResult, instance.runPostToolUseHook, config.callbacks.cancelTask)
		sinon.assert.notCalled(instance.updateFCListFromToolResponse)
	})
	it("does not execute a policy denial or a cancelled task", async () => {
		const { instance, config, block } = fixture()
		instance.guard.guardPreExecution.resolves({ success: false, error: "workspace policy" })
		await instance.handleCompleteBlock(block, config)
		instance.taskState.abort = true
		await instance.handleCompleteBlock(block, config)
		sinon.assert.notCalled(instance.coordinator.execute)
		sinon.assert.calledOnce(instance.pushToolResult)
	})
	it("pairs every skipped complete native call after rejection without emitting a result for partial arguments", async () => {
		const { instance, config } = fixture()
		instance.taskState.didRejectTool = true
		instance.asToolConfig = sinon.stub().resolves(config)
		instance.coordinator.has = () => true
		const ids = new Map([
			["call-a", "use-a"],
			["call-b", "use-b"],
		])
		instance.pushToolResult = (result: any, block: any) =>
			ToolResultUtils.pushToolResult(result, block, instance.taskState.userMessageContent, () => "read", undefined, ids)
		const block = {
			type: "tool_use",
			name: DietCodeDefaultTool.FILE_READ,
			params: { path: "a.ts" },
			partial: false,
			call_id: "call-a",
		}
		await instance.executeTool(block)
		await instance.executeTool({ ...block, call_id: "call-b" })
		await instance.executeTool({ ...block, partial: true, call_id: "call-c" })
		assert.deepEqual(
			instance.taskState.userMessageContent.map((result: any) => result.tool_use_id),
			["use-a", "use-b"],
		)
		sinon.assert.notCalled(instance.coordinator.execute)
	})
})
