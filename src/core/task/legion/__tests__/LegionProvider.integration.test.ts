import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { gunzipSync } from "node:zlib"
import { OpenAiHandler } from "@core/api/providers/openai"
import { expect } from "chai"
import type { SpawnedLegionMember } from "@/infrastructure/ai/LegionCoordinator"
import { LegionAgentHost } from "../LegionAgentHost"

describe("Legion native provider integration", () => {
	let server: Server
	afterEach(async () => {
		if (server?.listening)
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
	})
	it("executes a multi-turn native tool conversation through the OpenAI-compatible provider", async function () {
		const requests: any[] = []
		const contentEncodings: Array<string | undefined> = []
		server = createServer((req, res) => {
			const chunks: Buffer[] = []
			req.on("data", (chunk) => {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
			})
			req.on("end", () => {
				const buf = Buffer.concat(chunks)
				contentEncodings.push(req.headers["content-encoding"])
				const raw = req.headers["content-encoding"] === "gzip" ? gunzipSync(buf).toString("utf8") : buf.toString("utf8")
				requests.push(JSON.parse(raw))
				const first = requests.length === 1
				res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
				const delta = first
					? {
							id: "call-read",
							type: "function",
							function: { name: "read_file", arguments: '{"path":"example' },
							index: 0,
						}
					: {
							id: "call-done",
							type: "function",
							function: { name: "attempt_completion", arguments: '{"result":"Inspected example.ts"}' },
							index: 0,
						}
				res.write(
					`data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { tool_calls: [delta] }, finish_reason: null }] })}\n\n`,
				)
				if (first)
					res.write(
						`data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '.ts"}' } }] }, finish_reason: null }] })}\n\n`,
					)
				res.write(
					`data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\n`,
				)
				res.end("data: [DONE]\n\n")
			})
		})
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject)
				server.listen(0, "127.0.0.1", resolve)
			})
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") this.skip()
			throw error
		}
		const port = (server.address() as AddressInfo).port
		const used: string[] = []
		const host = new LegionAgentHost({
			systemContext: "Project context ".repeat(400),
			createApi: () =>
				new OpenAiHandler({
					openAiApiKey: "test",
					openAiBaseUrl: `http://127.0.0.1:${port}/v1`,
					openAiModelId: "fixture",
				}),
			createTools: async () => ({
				definitions: [
					{
						type: "function",
						function: {
							name: "read_file",
							description: "Read a file",
							parameters: { type: "object", properties: { path: { type: "string" } } },
						},
					},
					{
						type: "function",
						function: {
							name: "attempt_completion",
							description: "Return the result",
							parameters: { type: "object", properties: { result: { type: "string" } } },
						},
					},
				],
				allowedNames: new Set(["read_file"]),
				execute: async (name, input) => {
					used.push(`${name}:${(input as { path: string }).path}`)
					return "file contents"
				},
			}),
		})
		const member = { assignment: { title: "Researcher", focusObjective: "Inspect example.ts" } } as SpawnedLegionMember
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result).to.deep.equal({ status: "completed", summary: "Inspected example.ts" })
		expect(used).to.deep.equal(["read_file:example.ts"])
		expect(requests).to.have.length(2)
		expect(contentEncodings).to.deep.equal(["gzip", "gzip"])
		expect(JSON.stringify(requests[1].messages)).to.include("file contents")
	})
})
