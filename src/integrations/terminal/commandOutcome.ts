import type { CommandExecutionState } from "@shared/ExtensionMessage"
import type { TerminalCompletionDetails } from "./types"

/** Only an observed zero exit code proves success. Closing a terminal does not. */
export function commandOutcome(details?: TerminalCompletionDetails): CommandExecutionState {
	return {
		status: details?.cancelled
			? "cancelled"
			: details?.signal || (typeof details?.exitCode === "number" && details.exitCode !== 0)
				? "failed"
				: details?.exitCode === 0
					? "completed"
					: "unconfirmed",
		exitCode: details?.exitCode ?? undefined,
		signal: details?.signal ?? undefined,
		terminalClosed: details?.terminalClosed,
		...(details?.exitCode == null && !details?.cancelled && !details?.signal
			? { detail: "Observation ended without a confirmed exit status. Inspect the result before repeating the command." }
			: {}),
	}
}
