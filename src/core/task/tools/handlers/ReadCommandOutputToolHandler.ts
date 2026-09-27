import type { ToolUse } from "@core/assistant-message"
import { PreToolUseHookCancellationError } from "@core/hooks/PreToolUseHookCancellationError"
import { formatResponse } from "@core/prompts/responses"
import { resolveCommandReadTimeoutSeconds } from "@/integrations/terminal/commandPolicy"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { TaskConfig } from "../types/TaskConfig"
import type { IFullyManagedTool, ToolResponse } from "../types/ToolContracts"
import { recordExecutionEvidence } from "../utils/executionEvidence"
import { ToolHookUtils } from "../utils/ToolHookUtils"

/** Observation reuses command authority and ownership; it never dispatches shell text. */
export class ReadCommandOutputToolHandler implements IFullyManagedTool {
	readonly name = DietCodeDefaultTool.READ_COMMAND_OUTPUT

	getDescription(block: ToolUse): string {
		return `[${block.name} for execution '${block.params.execution_id ?? ""}']`
	}

	async handlePartialBlock(): Promise<void> {}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const executionId = block.params.execution_id?.trim()
		if (!executionId) return formatResponse.toolError(formatResponse.missingToolParameterError("execution_id"))
		if (!config.callbacks.readCommandOutput)
			return formatResponse.toolError(
				"Command observation is unavailable in this session. Inspect the existing terminal; do not relaunch the command to check its status.",
			)
		try {
			await ToolHookUtils.runPreToolUseIfEnabled(config, block)
			const snapshot = await config.callbacks.readCommandOutput(
				executionId,
				resolveCommandReadTimeoutSeconds(block.params.timeout),
				config.taskState.abortSignal,
			)
			if (snapshot.status === "completed" && snapshot.exit_code === 0) {
				// Same identity as foreground completion: reading a receipt cannot repeatedly renew the completion budget.
				recordExecutionEvidence(config.taskState, "command", [snapshot.cwd, snapshot.command], {
					exitCode: snapshot.exit_code,
					output: snapshot.output,
				})
			}
			return JSON.stringify(snapshot)
		} catch (error) {
			if (error instanceof PreToolUseHookCancellationError) return formatResponse.toolDenied()
			return formatResponse.toolError(error instanceof Error ? error.message : String(error))
		}
	}
}
