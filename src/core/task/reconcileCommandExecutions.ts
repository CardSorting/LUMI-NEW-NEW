import { type DietCodeMessage, isActiveCommandExecution } from "@shared/ExtensionMessage"
import type { CommandExecutionSnapshot } from "@/integrations/terminal/types"

/** Persisted status is a last observation, not proof that this session owns a live process. */
export function reconcileCommandExecutions(
	messages: DietCodeMessage[],
	lookup?: (executionId: string) => CommandExecutionSnapshot | undefined,
): DietCodeMessage[] {
	return messages.map((message) => {
		const id = message.commandExecution?.executionId
		const live = id ? lookup?.(id) : undefined
		if (live && live.execution_id === id) {
			const state = {
				status: live.status,
				executionId: live.execution_id,
				taskId: message.commandExecution?.taskId,
				terminalId: live.terminal_id,
				exitCode: live.exit_code,
				signal: live.signal,
				terminalClosed: live.terminal_closed,
				detail: live.detail,
				recovery: live.recovery,
			}
			return {
				...message,
				commandCompleted: !isActiveCommandExecution(state),
				commandExecution: state,
				commandOutput: live.log_notice ? `${live.output}\n${live.log_notice}` : live.output,
			}
		}
		if (!message.commandExecution || !isActiveCommandExecution(message.commandExecution)) return message
		return {
			...message,
			commandCompleted: false,
			commandExecution: {
				status: "unknown",
				executionId: message.commandExecution.executionId,
				taskId: message.commandExecution.taskId,
				recovery: { previousStatus: message.commandExecution.status, observedAt: message.ts, authority: "none" },
				detail: "This command is no longer tracked by the current extension host. Check View → Terminal before running it again.",
			},
		}
	})
}
