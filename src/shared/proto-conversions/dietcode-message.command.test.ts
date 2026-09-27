import { strict as assert } from "node:assert"
import { COMMAND_EXECUTION_STATUSES, type DietCodeMessage } from "@shared/ExtensionMessage"
import { DietCodeMessage as ProtoMessage } from "@shared/proto/dietcode/ui"
import { describe, it } from "mocha"
import { convertDietCodeMessageToProto, convertProtoToDietCodeMessage } from "./dietcode-message"

describe("command state transport", () => {
	for (const status of COMMAND_EXECUTION_STATUSES) {
		it(`preserves ${status}, run identity, zero exit codes, false flags, and empty output`, () => {
			const message: DietCodeMessage = {
				ts: 1,
				type: "say",
				say: "command",
				text: "test",
				commandCompleted: false,
				commandOutput: "",
				commandExecution: {
					status,
					executionId: "run",
					taskId: "task",
					terminalId: 2,
					exitCode: 0,
					terminalClosed: false,
				},
			}
			const encoded = ProtoMessage.encode(convertDietCodeMessageToProto(message)).finish()
			const restored = convertProtoToDietCodeMessage(ProtoMessage.decode(encoded))
			assert.deepEqual(JSON.parse(JSON.stringify(restored.commandExecution)), message.commandExecution)
			assert.equal(restored.commandCompleted, false)
			assert.equal(restored.commandOutput, "")
		})
	}
	it("treats an unrecognized status as untracked instead of exposing stale controls", () => {
		const restored = convertProtoToDietCodeMessage(
			ProtoMessage.create({ commandExecution: { status: "new-unknown-state", executionId: "run" } }),
		)
		assert.equal(restored.commandExecution!.status, "unknown")
		assert.equal(restored.commandExecution!.executionId, undefined)
	})
})
