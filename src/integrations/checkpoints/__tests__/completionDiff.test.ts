import { strict as assert } from "node:assert"
import type { MessageStateHandler } from "@core/task/message-state"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { COMPLETION_REVIEW_ERRORS } from "@shared/CompletionReview"
import type { DietCodeMessage } from "@shared/ExtensionMessage"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { TaskCheckpointManager } from "../index"
import { MultiRootCheckpointManager } from "../MultiRootCheckpointManager"

const file = { relativePath: "a.ts", absolutePath: "/one/a.ts", before: "before", after: "after" }
const messages: DietCodeMessage[] = [
	{ ts: 1, type: "say", say: "checkpoint_created", lastCheckpointHash: "initial" },
	{ ts: 2, type: "say", say: "completion_result", lastCheckpointHash: "previous" },
	{ ts: 3, type: "say", say: "completion_result", partial: true },
	{ ts: 4, type: "say", say: "completion_result", lastCheckpointHash: "current" },
]

function singleFixture(history = messages, enabled = true) {
	const getDiffSet = sinon.stub().resolves([file])
	const services = { messageStateHandler: { getDietCodeMessages: () => history, setCheckpointTracker: sinon.spy() } }
	type Args = ConstructorParameters<typeof TaskCheckpointManager>
	const manager = new TaskCheckpointManager(
		{ taskId: "task" },
		{ enableCheckpoints: enabled },
		services as unknown as Args[2],
		{} as Args[3],
		{ checkpointTracker: { getDiffSet } as unknown as NonNullable<Args[4]["checkpointTracker"]> },
	)
	return { manager, getDiffSet }
}

describe("completion snapshot access", () => {
	afterEach(() => sinon.restore())

	it("compares the selected result with the previous saved completion, skipping drafts", async () => {
		const { manager, getDiffSet } = singleFixture()
		assert.deepEqual(await manager.getCheckpointDiff(4, true), [file])
		assert.deepEqual(getDiffSet.firstCall.args, ["previous", "current"])
	})

	it("uses the initial checkpoint for the first result and preserves snapshot comparison", async () => {
		const { manager, getDiffSet } = singleFixture()
		await manager.getCheckpointDiff(2, true)
		await manager.getCheckpointDiff(4, false)
		assert.deepEqual(getDiffSet.firstCall.args, ["initial", "previous"])
		assert.deepEqual(getDiffSet.secondCall.args, ["current"])
	})

	it("rejects disabled, missing, and unbased snapshots instead of showing an empty success", async () => {
		await assert.rejects(singleFixture(messages, false).manager.getCheckpointDiff(4, true), {
			message: COMPLETION_REVIEW_ERRORS.checkpointsDisabled,
		})
		await assert.rejects(singleFixture().manager.getCheckpointDiff(99, true), {
			message: COMPLETION_REVIEW_ERRORS.snapshotUnavailable,
		})
		await assert.rejects(singleFixture([messages[3]]).manager.getCheckpointDiff(4, true), {
			message: COMPLETION_REVIEW_ERRORS.baselineUnavailable,
		})
	})

	it("opens the same saved diff and propagates host failures", async () => {
		const open = sinon.stub().resolves()
		sinon.stub(HostProvider, "diff").get(() => ({ openMultiFileDiff: open }))
		const { manager } = singleFixture()
		await manager.presentMultifileDiff(4, true)
		assert.deepEqual(open.firstCall.args[0].diffs, [
			{ filePath: file.absolutePath, leftContent: "before", rightContent: "after" },
		])
		open.rejects(new Error("editor unavailable"))
		await assert.rejects(manager.presentMultifileDiff(4, true), /editor unavailable/)
	})

	it("reports empty diffs and storage failures to the caller", async () => {
		const { manager, getDiffSet } = singleFixture()
		getDiffSet.resolves([])
		await assert.rejects(manager.presentMultifileDiff(4, true), { message: COMPLETION_REVIEW_ERRORS.noChanges })
		getDiffSet.rejects(new Error("storage unavailable"))
		await assert.rejects(manager.getCheckpointDiff(4, true), /storage unavailable/)
	})

	it("returns changes from both workspace roots through the public API", async () => {
		const secondFile = { ...file, absolutePath: "/two/a.ts" }
		const firstDiff = sinon.stub().resolves([file])
		const secondDiff = sinon.stub().resolves([secondFile])
		const workspace = {
			getPrimaryRoot: () => ({ path: "/one" }),
			getRoots: () => [{ path: "/one" }, { path: "/two" }],
		} as unknown as WorkspaceRootManager
		const state = { getDietCodeMessages: () => messages } as unknown as MessageStateHandler
		const manager = new MultiRootCheckpointManager(workspace, "task", true, state)
		Object.assign(manager, {
			initialized: true,
			trackers: new Map([
				["/one", { getDiffSet: firstDiff }],
				["/two", { getDiffSet: secondDiff }],
			]),
			messageCommitHashes: new Map([
				[
					2,
					new Map([
						["/one", "previous-one"],
						["/two", "previous-two"],
					]),
				],
				[
					4,
					new Map([
						["/one", "current-one"],
						["/two", "current-two"],
					]),
				],
			]),
		})
		assert.deepEqual(await manager.getCheckpointDiff(4, true), [file, secondFile])
		assert.deepEqual(firstDiff.firstCall.args, ["previous-one", "current-one"])
		assert.deepEqual(secondDiff.firstCall.args, ["previous-two", "current-two"])
		secondDiff.rejects(new Error("second root unavailable"))
		await assert.rejects(manager.getCheckpointDiff(4, true), /second root unavailable/)
	})
})
