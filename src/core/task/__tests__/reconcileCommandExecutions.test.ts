import { strict as assert } from "node:assert"
import { COMMAND_EXECUTION_STATUSES, type DietCodeMessage, isActiveCommandExecution } from "@shared/ExtensionMessage"
import { describe, it } from "mocha"
import { reconcileCommandExecutions } from "../reconcileCommandExecutions"

describe("restored command history", () => {
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
				assert.equal(restored.commandExecution!.executionId, undefined)
				assert.equal(restored.commandExecution!.terminalId, undefined)
				assert.equal(restored.commandCompleted, false)
				assert.match(restored.commandExecution!.detail!, /no longer tracked/)
			} else assert.equal(restored, original)
			assert.equal(restored.commandOutput, "existing output")
			assert.equal(original.commandExecution!.executionId, "old-run")
		})
	}
})
