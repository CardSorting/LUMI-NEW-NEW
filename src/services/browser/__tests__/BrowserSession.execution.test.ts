import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { afterEach, describe, it } from "mocha"
import { TimeoutError } from "puppeteer-core"
import sinon from "sinon"
import type { StateManager } from "@/core/storage/StateManager"
import * as telemetry from "@/services/telemetry"
import { BrowserSession } from "../BrowserSession"

describe("browser session observation", () => {
	afterEach(() => sinon.restore())
	function fixture() {
		const page = Object.assign(new EventEmitter(), {
			isClosed: () => false,
			url: () => "http://localhost/app",
			screenshot: sinon.stub().resolves("aW1hZ2U="),
			mouse: { click: sinon.stub().resolves() },
		})
		const session = new BrowserSession({} as StateManager)
		Object.assign(session, { page })
		return { session, page }
	}
	it("captures console events and releases only its own listeners", async () => {
		const { session, page } = fixture()
		const existing = sinon.stub()
		page.on("console", existing)
		const result = await session.doAction(async () => {
			page.emit("console", { type: () => "warn", text: () => "app warning" })
			page.emit("pageerror", new Error("render failed"))
		})
		assert.match(result.logs!, /app warning/)
		assert.match(result.logs!, /render failed/)
		assert.equal(page.listenerCount("console"), 1)
		assert.equal(page.listenerCount("pageerror"), 0)
		sinon.assert.calledOnce(existing)
	})
	it("retains a completed interaction when screenshots fail, without repeating it", async () => {
		const { session, page } = fixture()
		page.screenshot.rejects(new Error("capture failed"))
		const action = sinon.stub().resolves()
		const result = await session.doAction(action)
		sinon.assert.calledOnce(action)
		sinon.assert.calledTwice(page.screenshot)
		assert.equal(result.error, undefined)
		assert.match(result.logs!, /Use inspect/)
		assert.equal(page.listenerCount("console"), 0)
		assert.equal(page.listenerCount("pageerror"), 0)
	})
	it("reports navigation timeouts with the current page instead of false success", async () => {
		const { session } = fixture()
		const result = await session.doAction(async () => {
			throw new TimeoutError("navigation timed out")
		})
		assert.match(result.error!, /timed out/)
		assert.equal(result.currentUrl, "http://localhost/app")
		assert.ok(result.screenshot)
	})
	it("releases click listeners after a failed interaction", async () => {
		const { session, page } = fixture()
		page.mouse.click.rejects(new Error("target closed"))
		assert.match((await session.click("1,2")).error!, /target closed/)
		assert.equal(page.listenerCount("request"), 0)
	})
	it("closes the task browser even when end telemetry fails", async () => {
		const { session } = fixture()
		const browser = { close: sinon.stub().resolves() }
		Object.assign(session, { browser, sessionStartTime: 1, ulid: "test" })
		sinon
			.stub(telemetry, "telemetryService")
			.value({ captureBrowserToolEnd: sinon.stub().rejects(new Error("telemetry unavailable")) })
		await session.dispose()
		sinon.assert.calledOnce(browser.close)
		assert.equal(session.getConnectionInfo().isConnected, false)
		await assert.rejects(session.inspect(), /action=launch/)
	})
})
