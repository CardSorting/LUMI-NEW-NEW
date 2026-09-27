import { strict as assert } from "node:assert"
import { getEventListeners } from "node:events"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { McpHub } from "../McpHub"

describe("MCP tool cancellation", () => {
	afterEach(() => sinon.restore())
	it("passes cancellation to the SDK while preserving the server's configured timeout", async () => {
		const controller = new AbortController()
		const request = sinon.stub().callsFake(
			(_request, _schema, options) =>
				new Promise((_resolve, reject) => {
					options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
				}),
		)
		const hub = Object.assign(Object.create(McpHub.prototype), {
			connections: [
				{
					server: { name: "test", config: JSON.stringify({ command: "test-server", timeout: 120 }) },
					client: { request },
				},
			],
			telemetryService: { captureMcpToolCall: sinon.stub() },
		}) as McpHub
		const result = assert.rejects(hub.callTool("test", "run", {}, "task", controller.signal), /abort/i)
		assert.notEqual(request.firstCall.args[2].signal, controller.signal)
		assert.equal(request.firstCall.args[2].timeout, 120_000)
		controller.abort()
		await result
		assert.equal(getEventListeners(controller.signal, "abort").length, 0)
		sinon.assert.calledOnce(request)
	})
	function fixture(timeout = 120) {
		const request = sinon.stub().resolves({ content: [], contents: [], messages: [] })
		const captureMcpToolCall = sinon.stub()
		const hub = Object.assign(Object.create(McpHub.prototype), {
			connections: [
				{ server: { name: "test", config: JSON.stringify({ command: "server", timeout }) }, client: { request } },
			],
			telemetryService: { captureMcpToolCall },
		}) as McpHub
		return { hub, request, captureMcpToolCall }
	}
	const invocations = {
		tool: (hub: McpHub, signal: AbortSignal) => hub.callTool("test", "run", {}, "task", signal),
		resource: (hub: McpHub, signal: AbortSignal) => hub.readResource("test", "docs://guide", signal),
		prompt: (hub: McpHub, signal: AbortSignal) => hub.getPrompt("test", "guide", undefined, signal),
	}
	for (const [kind, invoke] of Object.entries(invocations)) {
		it(`cancels a ${kind} request and does not dispatch an already cancelled request`, async () => {
			const { hub, request } = fixture()
			const controller = new AbortController()
			request.callsFake(
				(_input, _schema, options) =>
					new Promise((_resolve, reject) => {
						options.signal.addEventListener("abort", () => reject(options.signal.reason))
					}),
			)
			const waiting = assert.rejects(invoke(hub, controller.signal), /abort/i)
			assert.equal(request.firstCall.args[2].timeout, 120_000)
			controller.abort()
			await waiting
			assert.equal(getEventListeners(controller.signal, "abort").length, 0)
			await assert.rejects(invoke(hub, controller.signal), /abort/i)
			sinon.assert.calledOnce(request)
		})
		it(`releases task cancellation listeners after repeated ${kind} successes and failures`, async () => {
			const { hub, request } = fixture()
			const controller = new AbortController()
			for (let i = 0; i < 50; i++) {
				await invoke(hub, controller.signal)
				assert.equal(getEventListeners(controller.signal, "abort").length, 0)
			}
			request.rejects(new Error("server unavailable"))
			await assert.rejects(invoke(hub, controller.signal), /server unavailable/)
			assert.equal(getEventListeners(controller.signal, "abort").length, 0)
		})
	}
	for (const mode of ["throws", "rejects", "hangs"]) {
		it(`retains actual request outcomes when telemetry ${mode}`, async () => {
			const { hub, request, captureMcpToolCall } = fixture()
			captureMcpToolCall.callsFake(() => {
				if (mode === "throws") throw new Error("telemetry unavailable")
				if (mode === "rejects") return Promise.reject(new Error("telemetry unavailable"))
				return new Promise(() => {})
			})
			const result = { content: [], structuredContent: { saved: true } }
			request.resolves(result)
			assert.deepEqual(await hub.callTool("test", "run", {}, "task"), result)
			const failure = new Error("original request failure")
			request.rejects(failure)
			await assert.rejects(hub.callTool("test", "run", {}, "task"), (error) => error === failure)
			assert.equal(request.callCount, 2)
		})
	}
	it("uses safe fallback and clamped timers, and reports returned tool errors accurately", async () => {
		const { hub, request, captureMcpToolCall } = fixture(1e20)
		request.resolves({ content: [], isError: true })
		await hub.callTool("test", "run", {}, "task")
		assert.equal(request.firstCall.args[2].timeout, 2 ** 31 - 1)
		assert.equal(captureMcpToolCall.lastCall.args[3], "error")
		hub.connections[0].server.config = "invalid JSON"
		await hub.readResource("test", "docs://guide")
		assert.equal(request.lastCall.args[2].timeout, 60_000)
	})
	it("drains only the requesting server's pending notifications", () => {
		const { hub } = fixture()
		;(hub as any).pendingNotifications = [
			{ serverName: "one", message: "first" },
			{ serverName: "two", message: "second" },
		]
		assert.deepEqual(
			hub.getPendingNotifications("one").map((item) => item.message),
			["first"],
		)
		assert.deepEqual(
			hub.getPendingNotifications().map((item) => item.message),
			["second"],
		)
		assert.deepEqual(hub.getPendingNotifications(), [])
	})
})
