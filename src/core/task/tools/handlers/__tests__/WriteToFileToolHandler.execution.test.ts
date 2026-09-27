import { strict as assert } from "node:assert"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { FileEditProvider } from "@/integrations/editor/FileEditProvider"
import * as telemetry from "@/services/telemetry"
import { DietCodeDefaultTool } from "@/shared/tools"
import * as pathUtils from "@/utils/path"
import { TaskState } from "../../../TaskState"
import type { TaskConfig } from "../../types/TaskConfig"
import { ToolHookUtils } from "../../utils/ToolHookUtils"
import { isToolFailure } from "../../utils/toolOutcome"
import { WriteToFileToolHandler } from "../WriteToFileToolHandler"

describe("file write execution receipts", () => {
	let cwd: string
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "lumi-write-receipt-"))
		sinon.stub(pathUtils, "isLocatedInWorkspace").resolves(true)
		sinon.stub(ToolHookUtils, "runPreToolUseIfEnabled").resolves()
	})
	afterEach(async () => {
		sinon.restore()
		await rm(cwd, { recursive: true, force: true })
	})
	function prepare() {
		const taskState = new TaskState()
		const provider = new FileEditProvider(cwd, taskState.abortSignal)
		const tracker = { markFileAsEditedByDietCode: sinon.stub(), trackFileContext: sinon.stub().resolves() }
		const config = {
			cwd,
			ulid: cwd,
			taskState,
			isSubagentExecution: true,
			api: { getModel: () => ({ id: "test" }) },
			callbacks: {
				shouldAutoApproveToolWithPath: sinon.stub().resolves(true),
				ask: sinon.stub().resolves({ response: "yesButtonClicked" }),
				say: sinon.stub().resolves(),
				removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
			},
			services: {
				diffViewProvider: provider,
				fileContextTracker: tracker,
				stateManager: {
					getApiConfiguration: () => ({ actModeApiProvider: "test" }),
					getGlobalSettingsKey: () => "act",
				},
			},
		} as unknown as TaskConfig
		const handler = new WriteToFileToolHandler({ checkDietCodeIgnorePath: async () => ({ ok: true }) } as never)
		const block = {
			type: "tool_use" as const,
			name: DietCodeDefaultTool.FILE_NEW,
			partial: false,
			params: { path: "first.txt", content: "saved contents" },
		}
		return { config, provider, tracker, handler, block }
	}
	for (const cancelled of [false, true]) {
		it(`returns committed work when tracking ${cancelled ? "outlives cancellation" : "never responds"} without a late reset`, async () => {
			const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
			const { config, provider, tracker, handler, block } = prepare()
			let entered!: () => void
			const tracking = new Promise<void>((resolve) => {
				entered = resolve
			})
			let release!: () => void
			tracker.trackFileContext.callsFake(() => {
				entered()
				return new Promise<void>((resolve) => {
					release = resolve
				})
			})
			const pending = handler.execute(config, block)
			await tracking
			assert.equal(provider.isEditing, false, "Owned cleanup finishes before optional tracking")
			if (cancelled) config.taskState.abort = true
			else await clock.tickAsync(1001)
			const result = await pending
			assert.equal(isToolFailure(result), false)
			assert.match(String(result), /successfully saved/)
			assert.equal(await readFile(join(cwd, "first.txt"), "utf8"), "saved contents")
			assert.equal(config.taskState.didEditFile, true)
			assert.equal(config.taskState.workspaceRevision, 1)
			if (!cancelled) {
				provider.editType = "create"
				await provider.open("second.txt")
				await provider.update("next edit", true)
			}
			release()
			await clock.tickAsync(0)
			if (!cancelled) {
				assert.equal(provider.isEditing, true, "Late tracking must not reset the next edit")
				assert.equal((await provider.saveChanges()).finalContent, "next edit")
			}
		})
	}
	it("isolates telemetry failure from the approved mutation", async () => {
		const { config, handler, block } = prepare()
		sinon.stub(telemetry, "telemetryService").value({ captureToolUsage: sinon.stub().throws(new Error("telemetry offline")) })
		assert.equal(isToolFailure(await handler.execute(config, block)), false)
		assert.equal(await readFile(join(cwd, "first.txt"), "utf8"), "saved contents")
	})
	it("reports the save failure even when both cleanup steps also fail", async () => {
		const { config, provider, handler, block } = prepare()
		sinon.stub(provider, "saveChanges").rejects(new Error("original save failure"))
		sinon.stub(provider, "revertChanges").rejects(new Error("rollback failed"))
		const reset = provider.reset.bind(provider)
		sinon.stub(provider, "reset").callsFake(async () => {
			if (provider.isEditing) throw new Error("reset failed")
			return reset()
		})
		await assert.rejects(handler.execute(config, block), /original save failure/)
		await assert.rejects(stat(join(cwd, "first.txt")), { code: "ENOENT" })
	})
})
