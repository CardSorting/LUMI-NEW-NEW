import { strict as assert } from "node:assert"
import * as api from "@core/api"
import type { IController } from "@core/controller/types"
import { COMPLETION_REVIEW_ERRORS } from "@shared/CompletionReview"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { explainChanges, runCompletionWalkthrough } from "../explainChanges"
import * as explanation from "../explainChangesShared"

const files = ["a.ts", "b.ts", "c.ts"].map((name) => ({
	relativePath: name,
	absolutePath: `/workspace/${name}`,
	before: "before",
	after: "after",
}))

function fixture() {
	const getCheckpointDiff = sinon.stub().resolves(files)
	const task = {
		checkpointManager: { getCheckpointDiff },
		messageStateHandler: { getApiConversationHistory: () => [] },
		taskState: { abort: false },
	}
	const controller = { task, stateManager: { getApiConfiguration: () => ({}) } } as unknown as IController
	const comments = {
		startStreamingComment: sinon.spy(),
		appendToStreamingComment: sinon.spy(),
		endStreamingComment: sinon.spy(),
		clearAllComments: sinon.spy(),
		closeDiffViews: sinon.stub().resolves(),
	}
	sinon.stub(explanation, "setupCommentController").resolves(comments as never)
	const open = sinon.stub(explanation, "openDiffView").resolves()
	const stream = sinon.stub(explanation, "streamAIExplanationComments").resolves(1)
	return { controller, task, getCheckpointDiff, comments, open, stream }
}

describe("completion walkthrough", () => {
	afterEach(() => sinon.restore())

	it("uses the public checkpoint API and opens the full diff before streaming without stealing focus", async () => {
		const { controller, getCheckpointDiff, open, stream, comments } = fixture()
		stream.callsFake(async (_api, _diff, _context, _files, start, chunk, end) => {
			assert.equal(open.calledOnce, true)
			start(files[0].absolutePath, 0, 0)
			chunk("Explanation")
			end()
			return 1
		})
		await explainChanges(controller, { metadata: {}, messageTs: 42 })
		assert.deepEqual(getCheckpointDiff.firstCall.args, [42, true])
		assert.equal(open.callCount, 1)
		assert.deepEqual(comments.startStreamingComment.firstCall.args, [files[0].absolutePath, 0, 0, "a.ts", "after", false])
		assert.equal(comments.appendToStreamingComment.calledWith("Explanation"), true)
	})

	it("reports missing task and unsupported snapshot access to the result card", async () => {
		await assert.rejects(explainChanges({} as IController, { metadata: {}, messageTs: 42 }), {
			message: COMPLETION_REVIEW_ERRORS.taskUnavailable,
		})
		await assert.rejects(explainChanges({ task: {} } as IController, { metadata: {}, messageTs: 42 }), {
			message: COMPLETION_REVIEW_ERRORS.snapshotUnavailable,
		})
	})

	it("propagates snapshot failures and never starts generation", async () => {
		const { controller, getCheckpointDiff, stream, open } = fixture()
		getCheckpointDiff.rejects(new Error("snapshot unavailable"))
		await assert.rejects(explainChanges(controller, { metadata: {}, messageTs: 42 }), /snapshot unavailable/)
		assert.equal(stream.called || open.called, false)
	})

	it("reports an empty diff without generating an empty walkthrough", async () => {
		const { controller, getCheckpointDiff, stream } = fixture()
		getCheckpointDiff.resolves([])
		await assert.rejects(explainChanges(controller, { metadata: {}, messageTs: 42 }), {
			message: COMPLETION_REVIEW_ERRORS.noChanges,
		})
		assert.equal(stream.called, false)
	})

	it("propagates generation failures and empty responses instead of reporting success", async () => {
		const { controller, stream } = fixture()
		stream.onFirstCall().rejects(new Error("provider offline"))
		stream.onSecondCall().resolves(0)
		await assert.rejects(explainChanges(controller, { metadata: {}, messageTs: 42 }), /provider offline/)
		await assert.rejects(explainChanges(controller, { metadata: {}, messageTs: 42 }), /No walkthrough comments/)
	})

	it("stops when the task changes without closing the diff or deleting delivered comments", async () => {
		const { controller, stream, comments } = fixture()
		stream.callsFake(async (_api, _diff, _context, _files, _start, _chunk, _end, abort) => {
			controller.task = undefined
			assert.equal(abort?.(), true)
			return 0
		})
		await explainChanges(controller, { metadata: {}, messageTs: 42 })
		assert.equal(comments.clearAllComments.called, false)
		assert.equal(comments.closeDiffViews.called, false)
	})

	it("reports actual comment and file counts in order", async () => {
		const { controller, stream } = fixture()
		const updates: unknown[] = []
		stream.callsFake(async (_api, _diff, _context, _files, start, chunk, end) => {
			for (const file of [files[0], files[0], files[1]]) {
				start(file.absolutePath, 0, 0)
				chunk("Explanation")
				end()
			}
			return 3
		})
		await runCompletionWalkthrough(
			controller,
			{ metadata: {}, messageTs: 42 },
			{
				onProgress: async (progress) => {
					updates.push(progress)
				},
			},
		)
		assert.deepEqual(updates.at(-1), {
			phase: "complete",
			filesTotal: 3,
			filesExplained: 2,
			commentCount: 3,
			currentFile: "",
		})
		assert.equal((updates[0] as { phase: string }).phase, "loading")
	})

	it("rejects overlapping walkthroughs at the host and releases the slot after completion", async () => {
		const { controller, stream } = fixture()
		let finish!: () => void
		stream.onFirstCall().returns(
			new Promise<number>((resolve) => {
				finish = () => resolve(1)
			}),
		)
		const first = explainChanges(controller, { metadata: {}, messageTs: 42 })
		await assert.rejects(explainChanges(controller, { metadata: {}, messageTs: 43 }), {
			message: COMPLETION_REVIEW_ERRORS.walkthroughBusy,
		})
		finish()
		await first
		await explainChanges(controller, { metadata: {}, messageTs: 43 })
	})

	it("cancels during snapshot loading before opening or modifying the editor", async () => {
		const { controller, getCheckpointDiff, open, stream } = fixture()
		let loaded!: () => void
		getCheckpointDiff.returns(
			new Promise((resolve) => {
				loaded = () => resolve(files)
			}),
		)
		const cancellation = new AbortController()
		const run = runCompletionWalkthrough(controller, { metadata: {}, messageTs: 42 }, { signal: cancellation.signal })
		cancellation.abort()
		loaded()
		await run
		assert.equal(open.called || stream.called, false)
	})

	it("finalizes partial comments and propagates provider stream failures", async () => {
		sinon.stub(api, "buildApiHandler").returns({
			async *createMessage() {
				yield { type: "text", text: "@@@ FILE: /workspace/a.ts\n@@@ LINE: 0\nPartial explanation\n" }
				throw new Error("stream interrupted")
			},
		} as never)
		const end = sinon.spy()
		await assert.rejects(
			explanation.streamAIExplanationComments({}, "diff", "context", files, sinon.spy(), sinon.spy(), end),
			/stream interrupted/,
		)
		assert.equal(end.calledOnce, true)
	})

	it("stops a stalled provider immediately and requests provider cancellation", async () => {
		const abort = sinon.spy()
		const release = sinon.stub().resolves({ done: true })
		sinon.stub(api, "buildApiHandler").returns({
			abort,
			createMessage: () => ({ next: () => new Promise(() => {}), return: release }),
		} as never)
		const cancellation = new AbortController()
		const onChunk = sinon.spy()
		const run = explanation.streamAIExplanationComments(
			{},
			"diff",
			"context",
			files,
			sinon.spy(),
			onChunk,
			sinon.spy(),
			undefined,
			cancellation.signal,
		)
		cancellation.abort()
		assert.equal(await run, 0)
		assert.equal(abort.calledOnce, true)
		assert.equal(release.calledOnce, true)
		assert.equal(onChunk.called, false)
	})
})
