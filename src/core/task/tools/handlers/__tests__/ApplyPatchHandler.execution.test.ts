import { strict as assert } from "node:assert"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { FileEditProvider } from "@/integrations/editor/FileEditProvider"
import { DietCodeDefaultTool } from "@/shared/tools"
import * as pathUtils from "@/utils/path"
import { TaskState } from "../../../TaskState"
import type { TaskConfig } from "../../types/TaskConfig"
import { PartialPatchError } from "../../utils/FileProviderOperations"
import { ToolHookUtils } from "../../utils/ToolHookUtils"
import { isToolFailure } from "../../utils/toolOutcome"
import { ApplyPatchHandler } from "../ApplyPatchHandler"

describe("patch execution receipts", () => {
	let cwd: string
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "lumi-patch-receipt-"))
		sinon.stub(pathUtils, "isLocatedInWorkspace").resolves(true)
		sinon.stub(ToolHookUtils, "runPreToolUseIfEnabled").resolves()
	})
	afterEach(async () => {
		sinon.restore()
		await rm(cwd, { recursive: true, force: true })
	})
	function prepare(autoApprove = false) {
		const provider = new FileEditProvider(cwd)
		const callbacks = {
			shouldAutoApproveToolWithPath: sinon.stub().resolves(autoApprove),
			ask: sinon.stub().resolves({ response: "yesButtonClicked" }),
			say: sinon.stub().resolves(),
			removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
		}
		const tracker = { markFileAsEditedByDietCode: sinon.stub(), trackFileContext: sinon.stub().resolves() }
		const config = {
			cwd,
			ulid: "patch-task",
			taskState: new TaskState(),
			callbacks,
			autoApprovalSettings: { enableNotifications: false },
			api: { getModel: () => ({ id: "test" }) },
			services: {
				diffViewProvider: provider,
				fileContextTracker: tracker,
				stateManager: {
					getApiConfiguration: () => ({ actModeApiProvider: "test" }),
					getGlobalSettingsKey: () => "act",
				},
			},
		} as unknown as TaskConfig
		const handler = new ApplyPatchHandler({ checkDietCodeIgnorePath: async () => ({ ok: true }) } as never)
		const block = {
			type: "tool_use" as const,
			name: DietCodeDefaultTool.APPLY_PATCH,
			partial: false,
			params: {
				input: "*** Begin Patch\n*** Add File: first.txt\n+first\n*** Add File: second.txt\n+second\n*** End Patch",
			},
		}
		return { config, provider, callbacks, tracker, handler, block }
	}
	it("classifies a denied patch as failure without reporting or creating any file", async () => {
		const { config, callbacks, handler, block } = prepare()
		callbacks.ask.resolves({ response: "noButtonClicked" })
		assert.equal(isToolFailure(await handler.execute(config, block)), true)
		await assert.rejects(stat(join(cwd, "first.txt")), { code: "ENOENT" })
		assert.equal(config.taskState.didEditFile, false)
	})
	it("returns committed paths when a later file is denied, even if cleanup fails", async () => {
		const { config, provider, callbacks, handler, block } = prepare()
		callbacks.ask.onSecondCall().resolves({ response: "noButtonClicked" })
		sinon.stub(provider, "revertChanges").rejects(new Error("cleanup unavailable"))
		await assert.rejects(handler.execute(config, block), (error: unknown) => {
			assert.ok(error instanceof PartialPatchError)
			assert.deepEqual(error.committedPaths, ["first.txt"])
			assert.match(error.message, /user denied/)
			assert.match(error.message, /do not repeat the entire patch/)
			return true
		})
		assert.equal(await readFile(join(cwd, "first.txt"), "utf8"), "first")
		await assert.rejects(stat(join(cwd, "second.txt")), { code: "ENOENT" })
	})
	it("preserves the source when a move is cancelled after its destination was committed", async () => {
		const { config, provider, handler, block } = prepare(true)
		await writeFile(join(cwd, "original.txt"), "before\n")
		block.params.input =
			"*** Begin Patch\n*** Update File: original.txt\n*** Move to: renamed.txt\n@@\n-before\n+after\n*** End Patch"
		const save = provider.saveChanges.bind(provider)
		sinon.stub(provider, "saveChanges").callsFake(async () => {
			const result = await save()
			config.taskState.abort = true
			return result
		})
		await assert.rejects(handler.execute(config, block), (error: unknown) => {
			assert.ok(error instanceof PartialPatchError)
			assert.deepEqual(error.committedPaths, ["renamed.txt"])
			return true
		})
		assert.equal(await readFile(join(cwd, "original.txt"), "utf8"), "before\n")
		assert.equal(await readFile(join(cwd, "renamed.txt"), "utf8"), "after\n")
	})
	for (const failure of ["tracking", "display"])
		it(`retains the successful mutation when optional ${failure} fails`, async () => {
			const { config, callbacks, tracker, handler, block } = prepare(true)
			if (failure === "display") callbacks.say.rejects(new Error("display disconnected"))
			else tracker.trackFileContext.rejects(new Error("tracking unavailable"))
			const result = await handler.execute(config, block)
			assert.equal(isToolFailure(result), false)
			assert.match(String(result), /Successfully applied patch/)
			assert.equal(await readFile(join(cwd, "first.txt"), "utf8"), "first")
			assert.equal(await readFile(join(cwd, "second.txt"), "utf8"), "second")
			sinon.assert.notCalled(callbacks.ask)
		})
})
