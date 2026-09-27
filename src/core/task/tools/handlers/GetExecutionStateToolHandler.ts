import type { ToolUse } from "@core/assistant-message"
import { PreToolUseHookCancellationError } from "@core/hooks/PreToolUseHookCancellationError"
import { formatResponse } from "@core/prompts/responses"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { TaskConfig } from "../types/TaskConfig"
import type { IFullyManagedTool, ToolResponse } from "../types/ToolContracts"
import { ToolHookUtils } from "../utils/ToolHookUtils"

export class GetExecutionStateToolHandler implements IFullyManagedTool {
	readonly name = DietCodeDefaultTool.GET_EXECUTION_STATE
	getDescription(): string {
		return "[Inspect tracked executions]"
	}
	async handlePartialBlock(): Promise<void> {}
	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		try {
			config.taskState.abortSignal.throwIfAborted()
			await ToolHookUtils.runPreToolUseIfEnabled(config, block)
			config.taskState.abortSignal.throwIfAborted()
			if (!config.callbacks.getExecutionState)
				throw new Error(
					"Execution inventory is unavailable in this session. Inspect known results before resubmitting work.",
				)
			return JSON.stringify(config.callbacks.getExecutionState(block.params.execution_id?.trim() || undefined))
		} catch (error) {
			if (error instanceof PreToolUseHookCancellationError) return formatResponse.toolDenied()
			return formatResponse.toolError(error instanceof Error ? error.message : String(error))
		}
	}
}
