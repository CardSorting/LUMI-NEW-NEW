import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { PreToolUseHookCancellationError } from "@/core/hooks/PreToolUseHookCancellationError"
import { DietCodeDefaultTool } from "@/shared/tools"
import { TaskState } from "../../../TaskState"
import type { TaskConfig } from "../../types/TaskConfig"
import { createUIHelpers } from "../../types/UIHelpers"
import { ToolHookUtils } from "../../utils/ToolHookUtils"
import { ToolResultUtils } from "../../utils/ToolResultUtils"
import { isToolFailure } from "../../utils/toolOutcome"
import { BrowserToolHandler } from "../BrowserToolHandler"

describe("browser execution recovery", () => {
	afterEach(() => sinon.restore())
	function fixture(approval: boolean | [boolean, boolean] = true) {
		const hook = sinon.stub(ToolHookUtils, "runPreToolUseIfEnabled").resolves()
		const browser: any = {}
		for (const method of [
			"launchBrowser",
			"closeBrowser",
			"navigateToUrl",
			"inspect",
			"refresh",
			"click",
			"type",
			"scrollUp",
			"scrollDown",
		]) {
			browser[method] = sinon.stub().resolves({ currentUrl: "http://localhost/app", logs: "ready" })
		}
		const callbacks = {
			shouldAutoApproveTool: () => approval,
			ask: sinon.stub().rejects(new Error("unexpected approval")),
			say: sinon.stub().resolves(),
			removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
			applyLatestBrowserSettings: sinon.stub().resolves(browser),
			sayAndCreateMissingParamError: sinon.stub().resolves("missing parameter"),
		}
		const config = {
			taskState: new TaskState(),
			callbacks,
			services: { browserSession: browser },
			autoApprover: { shouldAutoApproveTool: () => approval },
		} as unknown as TaskConfig
		return { config, callbacks, browser, hook, handler: new BrowserToolHandler() }
	}
	const block = (action: string, params = {}) => ({
		type: "tool_use" as const,
		name: DietCodeDefaultTool.BROWSER,
		params: { action, ...params },
		partial: false,
	})
	it("uses configured authority for launch preview and execution", async () => {
		const { config, callbacks, browser, handler } = fixture()
		const launch = block("launch", { url: "http://localhost" })
		await handler.handlePartialBlock({ ...launch, partial: true }, createUIHelpers(config))
		assert.equal(isToolFailure(await handler.execute(config, launch)), false)
		sinon.assert.notCalled(callbacks.ask)
		sinon.assert.calledOnce(browser.launchBrowser)
	})
	it("does not interpret a false approval tuple as authorization", async () => {
		const { config, callbacks, browser, handler } = fixture([false, false])
		const approval = sinon.stub(ToolResultUtils, "askApprovalAndPushFeedback").resolves(false)
		const launch = block("launch", { url: "http://localhost" })
		await handler.handlePartialBlock({ ...launch, partial: true }, createUIHelpers(config))
		assert.equal(isToolFailure(await handler.execute(config, launch)), true)
		sinon.assert.calledOnce(callbacks.ask)
		sinon.assert.calledOnce(approval)
		sinon.assert.notCalled(browser.launchBrowser)
	})
	for (const [action, method] of [
		["navigate", "navigateToUrl"],
		["refresh", "refresh"],
		["inspect", "inspect"],
	]) {
		it(`reuses the existing session for ${action}`, async () => {
			const { config, callbacks, browser, handler, hook } = fixture(false)
			await handler.execute(config, block(action, { url: "http://localhost/next" }))
			sinon.assert.calledOnce(browser[method])
			sinon.assert.calledOnce(hook)
			sinon.assert.notCalled(browser.launchBrowser)
			sinon.assert.notCalled(browser.closeBrowser)
			sinon.assert.notCalled(callbacks.ask)
		})
	}
	it("keeps the session on malformed arguments, action failure, and display failure", async () => {
		const { config, callbacks, browser, handler } = fixture()
		await handler.execute(config, block("click"))
		await handler.execute(config, block("click", { coordinate: "NaN,3" }))
		sinon.assert.notCalled(browser.click)
		browser.click.resolves({ error: "target disappeared", currentUrl: "http://localhost" })
		assert.equal(isToolFailure(await handler.execute(config, block("click", { coordinate: "1,2" }))), true)
		browser.click.resolves({ logs: "clicked" })
		callbacks.say.rejects(new Error("display disconnected"))
		assert.equal(isToolFailure(await handler.execute(config, block("click", { coordinate: "1,2" }))), false)
		sinon.assert.calledTwice(browser.click)
		sinon.assert.notCalled(browser.closeBrowser)
	})
	it("honors cancellation on every action and closes a browser created after Stop", async () => {
		const { config, browser, handler, hook } = fixture()
		hook.rejects(new PreToolUseHookCancellationError())
		assert.equal(isToolFailure(await handler.execute(config, block("click", { coordinate: "1,2" }))), true)
		sinon.assert.notCalled(browser.click)
		hook.resolves()
		browser.launchBrowser.callsFake(async () => {
			config.taskState.abort = true
		})
		assert.match(String(await handler.execute(config, block("launch", { url: "http://localhost" }))), /cancelled/)
		sinon.assert.calledOnce(browser.closeBrowser)
		sinon.assert.notCalled(browser.navigateToUrl)
		await handler.execute(config, block("inspect"))
		sinon.assert.notCalled(browser.inspect)
	})
})
