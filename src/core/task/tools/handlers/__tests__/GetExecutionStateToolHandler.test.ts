import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { PreToolUseHookCancellationError } from "@/core/hooks/PreToolUseHookCancellationError"
import { TaskState } from "@/core/task/TaskState"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { TaskConfig } from "../../types/TaskConfig"
import { ToolHookUtils } from "../../utils/ToolHookUtils"
import { isToolFailure } from "../../utils/toolOutcome"
import { GetExecutionStateToolHandler } from "../GetExecutionStateToolHandler"

describe("execution inventory tool", () => {
	afterEach(() => sinon.restore())
	function fixture() {
		const hook = sinon.stub(ToolHookUtils, "runPreToolUseIfEnabled").resolves(true)
		const snapshot = { commands: { active: [], recent: [] }, actions: { active: [], recent: [] } }
		const getExecutionState = sinon.stub().returns(snapshot)
		const config = { callbacks: { getExecutionState }, taskState: new TaskState() } as unknown as TaskConfig
		const block = {
			name: DietCodeDefaultTool.GET_EXECUTION_STATE,
			params: {} as { execution_id?: string },
			partial: false,
			type: "tool_use" as const,
		}
		return { config, block, snapshot, getExecutionState, hook, handler: new GetExecutionStateToolHandler() }
	}
	it("returns shared inventory or a scoped receipt without dispatching work or renewing completion evidence", async () => {
		const { config, block, snapshot, getExecutionState, handler } = fixture()
		assert.deepEqual(JSON.parse(String(await handler.execute(config, block))), snapshot)
		sinon.assert.calledWithExactly(getExecutionState, undefined)
		block.params.execution_id = " action-id "
		getExecutionState.returns({ execution_id: "action-id", status: "failed", result_preview: "connection closed" })
		assert.equal(isToolFailure(await handler.execute(config, block)), false)
		sinon.assert.calledWithExactly(getExecutionState, "action-id")
		assert.equal(config.taskState.workspaceRevision, 0)
	})
	it("reports unavailable and expired state explicitly", async () => {
		const { config, block, getExecutionState, handler } = fixture()
		getExecutionState.throws(new Error("Action ID is not tracked by this task"))
		assert.ok(isToolFailure(await handler.execute(config, block)))
		config.callbacks.getExecutionState = undefined
		assert.match(String(await handler.execute(config, block)), /inventory is unavailable/)
		sinon.assert.calledOnce(getExecutionState)
	})
	it("respects hooks and cancellation before reading inventory", async () => {
		const { config, block, getExecutionState, hook, handler } = fixture()
		hook.rejects(new PreToolUseHookCancellationError())
		assert.match(String(await handler.execute(config, block)), /denied/)
		hook.callsFake(async () => {
			config.taskState.abort = true
			return true
		})
		assert.ok(isToolFailure(await handler.execute(config, block)))
		assert.ok(isToolFailure(await handler.execute(config, block)))
		sinon.assert.calledTwice(hook)
		sinon.assert.notCalled(getExecutionState)
	})
})
