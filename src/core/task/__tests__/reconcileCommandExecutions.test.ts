import { strict as assert } from "node:assert"
import { COMMAND_EXECUTION_STATUSES, type DietCodeMessage, isActiveCommandExecution } from "@shared/ExtensionMessage"
import { describe, it } from "mocha"
import type { CommandExecutionSnapshot } from "@/integrations/terminal/types"
import { reconcileCommandExecutions } from "../reconcileCommandExecutions"

describe("restored command history", () => {
	const original: DietCodeMessage = {
		ts: 12,
		type: "say",
		say: "command",
		text: "build",
		commandOutput: "old output",
		commandExecution: { status: "background", executionId: "owned", taskId: "task", terminalId: 1 },
	}
	const snapshot: CommandExecutionSnapshot = {
		execution_id: "owned",
		action_id: "owned",
		terminal_id: 1,
		command: "build",
		cwd: "/workspace",
		status: "stopping",
		output: "current output",
	}
	it("restores live controls and current output from the owning runtime", () => {
		const [restored] = reconcileCommandExecutions([original], (id) => {
			assert.equal(id, "owned")
			return snapshot
		})
		assert.equal(restored.commandExecution?.executionId, "owned")
		assert.equal(restored.commandExecution?.taskId, "task")
		assert.equal(restored.commandExecution?.status, "stopping")
		assert.equal(restored.commandOutput, "current output")
		assert.equal(restored.commandCompleted, false)
		assert.equal(original.commandExecution?.status, "background")
	})
	it("reconciles a late receipt instead of erasing its exit evidence", () => {
		const [restored] = reconcileCommandExecutions([original], () => ({
			...snapshot,
			status: "failed",
			exit_code: 7,
			log_notice: "Log saved",
		}))
		assert.equal(restored.commandExecution?.status, "failed")
		assert.equal(restored.commandExecution?.exitCode, 7)
		assert.equal(restored.commandCompleted, true)
		assert.equal(restored.commandOutput, "current output\nLog saved")
	})
	it("does not reuse controls for a different execution occupying the same terminal", () => {
		const [restored] = reconcileCommandExecutions([original], () => ({ ...snapshot, execution_id: "other-run" }))
		assert.equal(restored.commandExecution?.status, "unknown")
		assert.equal(restored.commandExecution?.executionId, "owned")
		assert.equal(restored.commandExecution?.recovery?.authority, "none")
		assert.equal(restored.commandOutput, "old output")
	})
	for (const status of COMMAND_EXECUTION_STATUSES) {
		it(`reconciles ${status} without replaying or inventing completion`, () => {
			const original: DietCodeMessage = {
				ts: 1,
				type: "say",
				say: "command",
				text: "server",
				commandOutput: "existing output",
				commandExecution: { status, executionId: "old-run", taskId: "task", terminalId: 1 },
			}
			const [restored] = reconcileCommandExecutions([original])
			if (isActiveCommandExecution(original.commandExecution!)) {
				assert.equal(restored.commandExecution!.status, "unknown")
				assert.equal(restored.commandExecution!.executionId, "old-run")
				assert.equal(restored.commandExecution!.recovery?.authority, "none")
				assert.equal(restored.commandExecution!.terminalId, undefined)
				assert.equal(restored.commandCompleted, false)
				assert.match(restored.commandExecution!.detail!, /no longer tracked/)
			} else assert.equal(restored, original)
			assert.equal(restored.commandOutput, "existing output")
			assert.equal(original.commandExecution!.executionId, "old-run")
		})
	}
})
