import { strict as assert } from "node:assert"
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
})
