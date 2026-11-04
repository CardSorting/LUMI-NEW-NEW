import { strict as assert } from "node:assert"
import { StreamResponseHandler } from "@core/task/StreamResponseHandler"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { OpenAiCodexHandler } from "../providers/openai-codex"
import type { ApiStreamChunk } from "../transform/stream"

async function collect(stream: AsyncIterable<ApiStreamChunk>): Promise<ApiStreamChunk[]> {
	const chunks: ApiStreamChunk[] = []
	for await (const chunk of stream) chunks.push(chunk)
	return chunks
}

function text(chunks: ApiStreamChunk[]): string {
	return chunks.map((chunk) => (chunk.type === "text" ? chunk.text : "")).join("")
}

function message(id: string, content: string[]) {
	return { id, type: "message", content: content.map((value) => ({ type: "output_text", text: value })) }
}

describe("Codex response streaming", () => {
	afterEach(() => sinon.restore())

	function fixture() {
		const handler = new OpenAiCodexHandler({}) as any
		const model = handler.getModel()
		return { handler, model }
	}

	it("emits the reported roadmap narration once when deltas are followed by complete message snapshots", async () => {
		const { handler, model } = fixture()
		const sentences = [
			"I’ll map the existing workspace and its roadmap first, then ground the implementation plan in the actual project structure.",
			"The workspace currently appears to contain only `ROADMAP.md`, so I’m checking whether any starter code, conventions, or roadmap direction exists before choosing a minimal architecture.",
		]
		const chunks: ApiStreamChunk[] = []
		for (const [index, sentence] of sentences.entries()) {
			const id = `message-${index}`
			const events = [
				{ type: "response.output_item.added", item: message(id, []) },
				...sentence.match(/.{1,17}/gu)!.map((delta) => ({
					type: "response.output_text.delta",
					item_id: id,
					content_index: 0,
					delta,
				})),
				{ type: "response.output_text.done", item_id: id, content_index: 0, text: sentence },
				{ type: "response.output_item.done", item: message(id, [sentence]) },
			]
			for (const event of events) chunks.push(...(await collect(handler.processEvent(event, model))))
		}
		assert.equal(text(chunks), sentences.join(""))
	})

	it("retains missing final text and separate content parts without suppressing legitimate repeated phrases", async () => {
		const { handler, model } = fixture()
		const chunks: ApiStreamChunk[] = []
		for (const event of [
			{ type: "response.output_text.delta", item_id: "one", content_index: 0, delta: "Hello" },
			{ type: "response.output_item.done", item: message("one", ["Hello world.", "Hello world."]) },
			{ type: "response.output_item.done", item: message("one", ["Hello world.", "Hello world."]) },
			{ type: "response.output_item.done", item: message("two", ["Hello world."]) },
		])
			chunks.push(...(await collect(handler.processEvent(event, model))))
		assert.equal(text(chunks), "Hello world.Hello world.Hello world.")
	})

	it("does not duplicate legacy text or reasoning snapshots", async () => {
		const { handler, model } = fixture()
		assert.equal(text(await collect(handler.processEvent({ type: "response.text.delta", delta: "Hello" }, model))), "Hello")
		assert.deepEqual(
			await collect(
				handler.processEvent({ type: "response.output_item.done", item: { type: "text", text: "Hello" } }, model),
			),
			[],
		)
		await collect(handler.processEvent({ type: "response.reasoning.delta", item_id: "reason", delta: "Checking" }, model))
		assert.deepEqual(
			await collect(
				handler.processEvent(
					{ type: "response.output_item.done", item: { id: "reason", type: "reasoning", text: "Checking" } },
					model,
				),
			),
			[],
		)
	})

	it("applies the same snapshot handling to manual SSE streams", async () => {
		const { handler, model } = fixture()
		const events = [
			{ type: "response.output_text.delta", item_id: "one", delta: "Once." },
			{ type: "response.output_item.done", item: message("one", ["Once."]) },
		]
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
				controller.close()
			},
		})
		assert.equal(text(await collect(handler.handleStreamResponse(body, model))), "Once.")
	})

	it("starts a new text accumulator for each user turn", async () => {
		const { handler, model } = fixture()
		sinon.stub(openAiCodexOAuthManager, "listModels").resolves({ test: model.info })
		sinon.stub(openAiCodexOAuthManager, "getAccessToken").resolves("test-token")
		sinon.stub(handler, "useWebsocketMode").returns(false)
		sinon.stub(handler, "executeRequest").callsFake(async function* () {
			yield* handler.processEvent({ type: "response.output_item.done", item: message("reused-id", ["Done."]) }, model)
		})
		assert.equal(text(await collect(handler.createMessage("test", []))), "Done.")
		assert.equal(text(await collect(handler.createMessage("test", []))), "Done.")
	})

	for (const event of [
		{ type: "response.output_text.delta", item_id: "one", delta: "Already delivered" },
		{
			type: "response.output_item.done",
			item: { type: "function_call", call_id: "saved", name: "write_to_file", arguments: "{}" },
		},
	]) {
		it(`does not replay ${event.type} through SSE after a partial SDK failure`, async () => {
			const { handler, model } = fixture()
			sinon.stub(openAiCodexOAuthManager, "getAccountId").resolves(undefined)
			handler.client = {
				responses: {
					create: async function* () {
						yield event
						throw new Error("stream disconnected")
					},
				},
			}
			const fallback = sinon.stub(handler, "makeCodexRequest")
			const stream = handler.executeRequest({}, model, "test-token", false)
			assert.equal((await stream.next()).done, false)
			await assert.rejects(stream.next(), /stream disconnected/)
			sinon.assert.notCalled(fallback)
		})
	}

	it("still falls back when the SDK fails before emitting output", async () => {
		const { handler, model } = fixture()
		sinon.stub(openAiCodexOAuthManager, "getAccountId").resolves(undefined)
		handler.client = { responses: { create: sinon.stub().rejects(new Error("SDK unavailable")) } }
		const fallback = sinon.stub(handler, "makeCodexRequest").callsFake(async function* () {
			yield { type: "text", text: "Recovered" }
		})
		assert.equal(text(await collect(handler.executeRequest({}, model, "test-token", false))), "Recovered")
		sinon.assert.calledOnce(fallback)
	})

	it("propagates a partial websocket failure without reconnecting or switching transports", async () => {
		const { handler, model } = fixture()
		sinon.stub(openAiCodexOAuthManager, "getAccountId").resolves(undefined)
		const events = sinon.stub(handler, "createResponseEventsViaWebsocket").callsFake(async function* () {
			yield { type: "response.output_text.delta", item_id: "one", delta: "Already delivered" }
			throw Object.assign(new Error("socket disconnected"), { code: "websocket_closed" })
		})
		handler.client = { responses: { create: sinon.stub() } }
		const fallback = sinon.stub(handler, "makeCodexRequest")
		const stream = handler.executeRequest({}, model, "test-token", true)
		assert.equal((await stream.next()).value.text, "Already delivered")
		await assert.rejects(stream.next(), /socket disconnected/)
		sinon.assert.calledOnce(events)
		sinon.assert.notCalled(handler.client.responses.create)
		sinon.assert.notCalled(fallback)
	})

	it("does not replay partially delivered output through the authentication retry", async () => {
		const { handler, model } = fixture()
		sinon.stub(openAiCodexOAuthManager, "listModels").resolves({ test: model.info })
		sinon.stub(openAiCodexOAuthManager, "getAccessToken").resolves("test-token")
		sinon.stub(handler, "useWebsocketMode").returns(false)
		const refresh = sinon.stub(openAiCodexOAuthManager, "forceRefreshAccessToken")
		const execute = sinon.stub(handler, "executeRequest").callsFake(async function* () {
			yield { type: "text", text: "Already delivered" }
			throw new Error("401 unauthorized")
		})
		const stream = handler.createMessage("test", [])
		assert.equal((await stream.next()).value.text, "Already delivered")
		await assert.rejects(stream.next(), /401 unauthorized/)
		sinon.assert.calledOnce(execute)
		sinon.assert.notCalled(refresh)
	})

	it("deduplicates tool call argument snapshots when deltas are followed by output_item.done", async () => {
		const { handler, model } = fixture()
		const events = [
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "item-1", call_id: "call-1", name: "list_files", arguments: "" },
			},
			{
				type: "response.function_call_arguments.delta",
				call_id: "call-1",
				name: "list_files",
				delta: '{"path":',
			},
			{
				type: "response.function_call_arguments.delta",
				call_id: "call-1",
				name: "list_files",
				delta: ' "."}',
			},
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "item-1",
					call_id: "call-1",
					name: "list_files",
					arguments: '{"path": "."}',
				},
			},
		]

		const chunks: ApiStreamChunk[] = []
		for (const event of events) {
			chunks.push(...(await collect(handler.processEvent(event, model))))
		}

		// Verify emitted tool call chunks
		const toolCallChunks = chunks.filter((c): c is Extract<ApiStreamChunk, { type: "tool_calls" }> => c.type === "tool_calls")
		const accumulatedArgs = toolCallChunks.map((c) => c.tool_call.function.arguments).join("")
		assert.equal(accumulatedArgs, '{"path": "."}')

		// Feed into StreamResponseHandler and verify end-to-end integration
		const streamHandler = new StreamResponseHandler().getHandlers().toolUseHandler
		for (const chunk of toolCallChunks) {
			streamHandler.processToolUseDelta(
				{
					id: chunk.tool_call.function.id,
					type: "tool_use",
					name: chunk.tool_call.function.name,
					input: chunk.tool_call.function.arguments,
				},
				chunk.tool_call.call_id,
			)
		}

		// assertCompleteToolUses must succeed without throwing "Incomplete arguments" or syntax error
		assert.doesNotThrow(() => streamHandler.assertCompleteToolUses())
		const finalized = streamHandler.getAllFinalizedToolUses()
		assert.equal(finalized.length, 1)
		assert.deepEqual(finalized[0].input, { path: "." })
	})

	it("slices trailing argument suffix if output_item.done contains unstreamed content", async () => {
		const { handler, model } = fixture()
		const events = [
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "item-2", call_id: "call-2", name: "read_file", arguments: "" },
			},
			{
				type: "response.tool_call_arguments.delta",
				call_id: "call-2",
				name: "read_file",
				delta: '{"path":',
			},
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "item-2",
					call_id: "call-2",
					name: "read_file",
					arguments: '{"path": "foo.ts"}',
				},
			},
		]

		const chunks: ApiStreamChunk[] = []
		for (const event of events) {
			chunks.push(...(await collect(handler.processEvent(event, model))))
		}

		const toolCallChunks = chunks.filter((c): c is Extract<ApiStreamChunk, { type: "tool_calls" }> => c.type === "tool_calls")
		const accumulatedArgs = toolCallChunks.map((c) => c.tool_call.function.arguments).join("")
		assert.equal(accumulatedArgs, '{"path": "foo.ts"}')
	})

	it("delivers full arguments when provider emits only output_item.done without deltas", async () => {
		const { handler, model } = fixture()
		const event = {
			type: "response.output_item.done",
			item: {
				type: "function_call",
				id: "item-3",
				call_id: "call-3",
				name: "list_files",
				arguments: '{"path": "src"}',
			},
		}

		const chunks = await collect(handler.processEvent(event, model))
		const toolCallChunks = chunks.filter((c): c is Extract<ApiStreamChunk, { type: "tool_calls" }> => c.type === "tool_calls")
		assert.equal(toolCallChunks.length, 1)
		assert.equal(toolCallChunks[0].tool_call.function.arguments, '{"path": "src"}')
	})

	it("handles function_call_arguments.done followed by output_item.done without duplication", async () => {
		const { handler, model } = fixture()
		const events = [
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "item-4", call_id: "call-4", name: "list_files", arguments: "" },
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "item-4",
				delta: '{"path": "."}',
			},
			{
				type: "response.function_call_arguments.done",
				item_id: "item-4",
				name: "list_files",
				arguments: '{"path": "."}',
			},
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "item-4",
					call_id: "call-4",
					name: "list_files",
					arguments: '{"path": "."}',
				},
			},
		]

		const chunks: ApiStreamChunk[] = []
		for (const event of events) {
			chunks.push(...(await collect(handler.processEvent(event, model))))
		}

		const toolCallChunks = chunks.filter((c): c is Extract<ApiStreamChunk, { type: "tool_calls" }> => c.type === "tool_calls")
		const accumulatedArgs = toolCallChunks.map((c) => c.tool_call.function.arguments).join("")
		assert.equal(accumulatedArgs, '{"path": "."}')
	})

	it("preserves correct tool names across multiple interleaved tool calls in a single response", async () => {
		const { handler, model } = fixture()
		const events = [
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "item-a", call_id: "call-a", name: "read_file", arguments: "" },
			},
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "item-b", call_id: "call-b", name: "list_files", arguments: "" },
			},
			// Delta for item-a without name property
			{
				type: "response.function_call_arguments.delta",
				item_id: "item-a",
				delta: '{"path": "a.txt"}',
			},
			// Delta for item-b without name property
			{
				type: "response.function_call_arguments.delta",
				item_id: "item-b",
				delta: '{"path": "dir"}',
			},
			// Done for item-a without name property
			{
				type: "response.function_call_arguments.done",
				item_id: "item-a",
				arguments: '{"path": "a.txt"}',
			},
			// Done for item-b without name property
			{
				type: "response.function_call_arguments.done",
				item_id: "item-b",
				arguments: '{"path": "dir"}',
			},
		]

		const chunks: ApiStreamChunk[] = []
		for (const event of events) {
			chunks.push(...(await collect(handler.processEvent(event, model))))
		}

		const toolCallChunks = chunks.filter((c): c is Extract<ApiStreamChunk, { type: "tool_calls" }> => c.type === "tool_calls")
		const chunksA = toolCallChunks.filter((c) => c.tool_call.call_id === "call-a")
		const chunksB = toolCallChunks.filter((c) => c.tool_call.call_id === "call-b")

		assert.equal(chunksA[0].tool_call.function.name, "read_file")
		assert.equal(chunksA.map((c) => c.tool_call.function.arguments).join(""), '{"path": "a.txt"}')

		assert.equal(chunksB[0].tool_call.function.name, "list_files")
		assert.equal(chunksB.map((c) => c.tool_call.function.arguments).join(""), '{"path": "dir"}')
	})
})
