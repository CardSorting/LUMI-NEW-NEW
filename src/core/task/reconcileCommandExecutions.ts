import { type DietCodeMessage, isActiveCommandExecution } from "@shared/ExtensionMessage"

/** Persisted status is a last observation, not proof that this session owns a live process. */
export function reconcileCommandExecutions(messages: DietCodeMessage[]): DietCodeMessage[] {
	return messages.map((message) => {
		if (!message.commandExecution || !isActiveCommandExecution(message.commandExecution)) return message
		return {
			...message,
			commandCompleted: false,
			commandExecution: {
				status: "unknown",
				detail: "This task was reopened and the command is no longer tracked. Check View → Terminal before running it again.",
			},
		}
	})
}
