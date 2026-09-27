import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { TaskState } from "@/core/task/TaskState"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { TaskConfig } from "../../types/TaskConfig"
import { recordExecutionEvidence } from "../../utils/executionEvidence"
import { ToolHookUtils } from "../../utils/ToolHookUtils"
import { isToolFailure } from "../../utils/toolOutcome"
import { ReadCommandOutputToolHandler } from "../ReadCommandOutputToolHandler"

describe("command observation tool", () => {
	afterEach(() => sinon.restore())
	function fixture() {
		sinon.stub(ToolHookUtils, "runPreToolUseIfEnabled").resolves(true)
		const snapshot = {
			execution_id: "run",
			terminal_id: 1,
			command: "build",
			cwd: "/workspace",
			status: "background",
			output: "build output",
			exit_code: undefined as number | undefined,
		}
		const readCommandOutput = sinon.stub().callsFake(async () => ({ ...snapshot }))
		const config = { callbacks: { readCommandOutput }, taskState: new TaskState() } as unknown as TaskConfig
		const block = {
			name: DietCodeDefaultTool.READ_COMMAND_OUTPUT,
			params: { execution_id: "run", timeout: "9999999" },
			partial: false,
			type: "tool_use" as const,
		}
		return { config, block, snapshot, readCommandOutput, handler: new ReadCommandOutputToolHandler() }
	}
	it("clamps a wait, forwards cancellation, and returns failed command status as a successful observation", async () => {
		const { config, block, snapshot, readCommandOutput, handler } = fixture()
		snapshot.status = "failed"
		snapshot.exit_code = 2
		const result = await handler.execute(config, block)
		assert.equal(isToolFailure(result), false)
		assert.deepEqual(JSON.parse(String(result)), snapshot)
		sinon.assert.calledOnceWithExactly(readCommandOutput, "run", 30, config.taskState.abortSignal)
		assert.equal(config.taskState.workspaceRevision, 0)
	})
	it("records successful completion once across foreground and background observation", async () => {
		const { config, block, snapshot, handler } = fixture()
		await handler.execute(config, block)
		assert.equal(config.taskState.workspaceRevision, 0)
		snapshot.status = "completed"
		snapshot.exit_code = 0
		recordExecutionEvidence(config.taskState, "command", [snapshot.cwd, snapshot.command], {
			exitCode: 0,
			output: snapshot.output,
		})
		await handler.execute(config, block)
		await handler.execute(config, block)
		assert.equal(config.taskState.workspaceRevision, 1)
		snapshot.output = "changed output"
		await handler.execute(config, block)
		assert.equal(config.taskState.workspaceRevision, 2)
	})
	it("returns explicit errors for unavailable, missing, and stale handles without dispatching work", async () => {
		const { config, block, readCommandOutput, handler } = fixture()
		block.params.execution_id = " "
		assert.ok(isToolFailure(await handler.execute(config, block)))
		sinon.assert.notCalled(readCommandOutput)
		block.params.execution_id = "stale"
		readCommandOutput.rejects(new Error("not tracked"))
		assert.ok(isToolFailure(await handler.execute(config, block)))
		config.callbacks.readCommandOutput = undefined
		assert.ok(isToolFailure(await handler.execute(config, block)))
		sinon.assert.calledOnce(readCommandOutput)
	})
})
