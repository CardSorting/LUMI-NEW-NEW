import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { PreToolUseHookCancellationError } from "@/core/hooks/PreToolUseHookCancellationError"
import * as telemetry from "@/services/telemetry"
import { executor } from "../../../ActionExecutor"
import { TaskState } from "../../../TaskState"
import { ToolProgressTracker } from "../../../ToolProgressTracker"
import type { TaskConfig } from "../../types/TaskConfig"
import { ToolHookUtils } from "../../utils/ToolHookUtils"
import { ToolResultUtils } from "../../utils/ToolResultUtils"
import { isToolFailure } from "../../utils/toolOutcome"
import { AccessMcpResourceHandler } from "../AccessMcpResourceHandler"
import { UseMcpToolHandler } from "../UseMcpToolHandler"

function fixture(resource = false, server = "docs") {
	const operation = sinon
		.stub()
		.resolves(
			resource
				? { contents: [{ uri: "docs://guide", text: "Saved result" }] }
				: { content: [{ type: "text", text: "Saved result" }] },
		)
	const say = sinon.stub().resolves()
	const ask = sinon.stub().rejects(new Error("Configured trust must not prompt"))
	const getPendingNotifications = sinon.stub().returns([])
	const config = {
		ulid: randomUUID(),
		cwd: "/workspace",
		mode: "act",
		taskState: new TaskState(),
		api: { getModel: () => ({ id: "test", info: { supportsImages: true } }) },
		callbacks: {
			say,
			ask,
			shouldAutoApproveTool: () => false,
			removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
		},
		services: {
			stateManager: {
				getTrustedMcpServers: () => ["docs", "slow", "fast"],
				getApiConfiguration: () => ({}),
				getGlobalSettingsKey: () => "act",
			},
			mcpHub: { connections: [], callTool: operation, readResource: operation, getPendingNotifications },
		},
	} as unknown as TaskConfig
	const handler = resource ? new AccessMcpResourceHandler() : new UseMcpToolHandler()
	const block = {
		type: "tool_use" as const,
		name: handler.name,
		params: { server_name: server, tool_name: "run", uri: "docs://guide", arguments: "{}" },
		partial: false,
	}
	return { config, operation, say, ask, getPendingNotifications, handler, block }
}

describe("MCP execution outcomes", () => {
	beforeEach(() => sinon.stub(ToolHookUtils, "runPreToolUseIfEnabled").resolves())
	afterEach(() => sinon.restore())
	for (const resource of [false, true]) {
		const kind = resource ? "resource" : "tool"
		it(`shares one in-flight ${kind} across helpers, including after its caller stops waiting`, async () => {
			const clock = sinon.useFakeTimers()
			const { config, operation, handler, block } = fixture(resource)
			let finish!: (value: unknown) => void
			operation.returns(
				new Promise((resolve) => {
					finish = resolve
				}),
			)
			block.params.arguments = '{"a":1,"b":2}'
			const first = handler.execute(config, block)
			await clock.tickAsync(0)
			const id = executor.executions.list(config.ulid).active[0].execution_id
			const sibling: TaskConfig = { ...config, taskState: new TaskState(), executionOwner: "helper:two" }
			const reordered = { ...block, params: { ...block.params, arguments: '{"b":2,"a":1}' } }
			const duplicate = await handler.execute(sibling, reordered)
			assert.ok(isToolFailure(duplicate))
			assert.match(String(duplicate), /No duplicate was started/)
			assert.doesNotMatch(String(duplicate), /MCP request failed|remote action may already have completed/)
			assert.ok(String(duplicate).includes(id))
			config.taskState.abort = true
			assert.ok(isToolFailure(await first))
			assert.equal(executor.executions.get(config.ulid, id)?.status, "awaiting_completion")
			assert.ok(String(await handler.execute(sibling, reordered)).includes(id))
			sinon.assert.calledOnce(operation)
			finish(
				resource
					? { contents: [{ uri: "docs://guide", text: "Saved once" }] }
					: { content: [{ type: "text", text: "Saved once" }] },
			)
			await clock.tickAsync(0)
			assert.equal(executor.executions.get(config.ulid, id)?.status, "completed")
			assert.match(executor.executions.get(config.ulid, id)!.result_preview!, /Saved once/)
			assert.equal(clock.countTimers(), 0)
		})
		it(`retains a successful ${kind} result when result display and telemetry fail`, async () => {
			const { config, operation, say, ask, handler, block } = fixture(resource)
			say.withArgs("mcp_server_response").rejects(new Error("display failed"))
			sinon.stub(telemetry, "telemetryService").value({
				captureToolUsage: () => {
					throw new Error("telemetry failed")
				},
			})
			assert.match(String(await handler.execute(config, block)), /Saved result/)
			sinon.assert.calledOnce(operation)
			sinon.assert.notCalled(ask)
		})
		it(`does not wait repeatedly when the ${kind} display is stuck`, async () => {
			const clock = sinon.useFakeTimers()
			const { config, operation, say, handler, block } = fixture(resource)
			say.returns(new Promise(() => {}))
			const running = handler.execute(config, block)
			await clock.tickAsync(1_000)
			assert.match(String(await running), /Saved result/)
			sinon.assert.calledOnce(say)
			sinon.assert.calledOnce(operation)
			assert.equal(clock.countTimers(), 0)
		})
		it(`does not dispatch a ${kind} after Stop during a display wait or after a hook cancellation`, async () => {
			const clock = sinon.useFakeTimers()
			const { config, operation, say, handler, block } = fixture(resource)
			say.returns(new Promise(() => {}))
			const cancelled = assert.rejects(handler.execute(config, block), /abort/i)
			await clock.tickAsync(0)
			config.taskState.abort = true
			await cancelled
			assert.equal(clock.countTimers(), 0)
			sinon.assert.notCalled(operation)

			const next = fixture(resource)
			;(ToolHookUtils.runPreToolUseIfEnabled as sinon.SinonStub).rejects(new PreToolUseHookCancellationError())
			assert.match(String(await next.handler.execute(next.config, next.block)), /denied/)
			sinon.assert.notCalled(next.operation)
		})
		it(`propagates Stop to an active ${kind} request and never retries it`, async () => {
			const { config, operation, handler, block } = fixture(resource)
			let dispatched!: () => void
			const started = new Promise<void>((resolve) => {
				dispatched = resolve
			})
			operation.callsFake(
				(...args: any[]) =>
					new Promise((_resolve, reject) => {
						const signal = args[resource ? 2 : 4] as AbortSignal
						signal.addEventListener("abort", () => reject(signal.reason), { once: true })
						dispatched()
					}),
			)
			const running = handler.execute(config, block)
			await started
			config.taskState.abort = true
			assert.equal(isToolFailure(await running), true)
			sinon.assert.calledOnce(operation)
		})
	}
	for (const args of ["null", "[]", '"text"', "42", "true", "{incomplete"]) {
		it(`rejects non-object arguments before approval or dispatch: ${args}`, async () => {
			const { config, operation, ask, handler, block } = fixture()
			block.params.arguments = args
			assert.equal(isToolFailure(await handler.execute(config, block)), true)
			sinon.assert.notCalled(operation)
			sinon.assert.notCalled(ask)
		})
	}
	it("retains structured evidence and resource links when optional notification retrieval fails", async () => {
		const { config, operation, handler, block, getPendingNotifications } = fixture()
		operation.resolves({
			content: [{ type: "resource_link", uri: "docs://receipt", name: "receipt" }],
			structuredContent: { saved: true, id: "one" },
		})
		getPendingNotifications.throws(new Error("notifications unavailable"))
		const result = String(await handler.execute(config, block))
		assert.match(result, /docs:\/\/receipt/)
		assert.match(result, /"saved": true/)
		assert.match(result, /"id": "one"/)
		sinon.assert.calledOnce(operation)
	})
	it("does not duplicate equivalent structured data and marks multimodal errors as failed native results", async () => {
		const { config, operation, handler, block } = fixture()
		operation.resolves({ content: [{ type: "text", text: '{"b":2,"a":1}' }], structuredContent: { a: 1, b: 2 } })
		assert.equal(await handler.execute(config, block), '{"b":2,"a":1}')
		operation.resolves({
			isError: true,
			content: [
				{ type: "text", text: "conflict" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
		})
		const result = await handler.execute(config, block)
		assert.equal(isToolFailure(result), true)
		assert.ok(Array.isArray(result) && result.some((item) => item.type === "image"))
		const tracker = new ToolProgressTracker()
		for (let i = 0; i < 8; i++) {
			tracker.record(block.name, { arguments: `${i}` }, result)
			assert.equal(tracker.finishTurn(), i === 7 ? "handoff" : i === 2 ? "redirect" : "continue")
		}
		const results: any[] = []
		ToolResultUtils.pushToolResult(result, { ...block, tool_use_id: "call-one" }, results, () => "MCP")
		assert.equal(results[0].is_error, true)
		assert.equal(results[0].tool_use_id, "call-one")
		assert.deepEqual(results[0].content, result)
	})
	it("keeps binary resource metadata instead of reporting an empty response", async () => {
		const { config, operation, handler, block } = fixture(true)
		operation.resolves({ contents: [{ uri: "docs://report", mimeType: "application/pdf", blob: "YmluYXJ5" }] })
		const result = String(await handler.execute(config, block))
		assert.match(result, /docs:\/\/report/)
		assert.match(result, /application\/pdf/)
		assert.doesNotMatch(result, /Empty response|YmluYXJ5/)
	})
	it("reports uncertain request failures without replaying remote actions", async () => {
		const { config, operation, handler, block } = fixture()
		operation.rejects(new Error("connection lost"))
		const result = await handler.execute(config, block)
		assert.equal(isToolFailure(result), true)
		assert.match(String(result), /may already have completed/)
		sinon.assert.calledOnce(operation)
	})
	it("allows another server to execute while all slots for one server are occupied", async () => {
		const slow = fixture(false, "slow")
		const fast = fixture(false, "fast")
		fast.config.ulid = slow.config.ulid
		let fifthStarted!: () => void
		const saturated = new Promise<void>((resolve) => {
			fifthStarted = resolve
		})
		let count = 0
		slow.operation.callsFake(
			(...args: any[]) =>
				new Promise((_resolve, reject) => {
					args[4].addEventListener("abort", () => reject(args[4].reason), { once: true })
					if (++count === 5) fifthStarted()
				}),
		)
		const pending = Array.from({ length: 6 }, (_, index) =>
			slow.handler.execute(slow.config, {
				...slow.block,
				params: { ...slow.block.params, arguments: JSON.stringify({ item: index }) },
			}),
		)
		try {
			await saturated
			assert.match(String(await fast.handler.execute(fast.config, fast.block)), /Saved result/)
			assert.equal(slow.operation.callCount, 5)
		} finally {
			slow.config.taskState.abort = true
			await Promise.allSettled(pending)
		}
		assert.equal(slow.operation.callCount, 5, "Queued cancelled work must not be dispatched")
	})
})
