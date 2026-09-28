import { strict as assert } from "node:assert"
import type { IController } from "@core/controller/types"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import * as grpc from "../../grpc-handler"
import * as walkthrough from "../explainChanges"
import { streamExplainChanges } from "../streamExplainChanges"

describe("walkthrough progress transport", () => {
	afterEach(() => sinon.restore())
	it("connects transport cancellation to the running operation and sends an explicit terminal outcome", async () => {
		let cancel!: () => void
		sinon.stub(grpc, "getRequestRegistry").returns({
			registerRequest: (_id: string, cleanup: () => void) => {
				cancel = cleanup
			},
		} as never)
		const send = sinon.stub().resolves()
		sinon.stub(walkthrough, "runCompletionWalkthrough").callsFake(async (_controller, _request, options) => {
			assert.equal(options?.signal?.aborted, false)
			await options?.onProgress?.({
				phase: "generating",
				filesTotal: 3,
				filesExplained: 1,
				commentCount: 1,
				currentFile: "a.ts",
			})
			cancel()
			assert.equal(options?.signal?.aborted, true)
			await options?.onProgress?.({
				phase: "cancelled",
				filesTotal: 3,
				filesExplained: 1,
				commentCount: 1,
				currentFile: "",
			})
		})
		await streamExplainChanges({} as IController, { metadata: {}, messageTs: 42 }, send, "request-id")
		assert.equal(send.firstCall.args[1], false)
		assert.equal(send.secondCall.args[1], true)
	})
})
