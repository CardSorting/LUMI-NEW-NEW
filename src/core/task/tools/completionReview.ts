import type { CompletionCheck, CompletionReview } from "@shared/CompletionReview"
import type { CommandExecutionState } from "@shared/ExtensionMessage"
import { parseFocusChainListCounts } from "../focus-chain/utils"
import type { CompletionAuditGateResult } from "./completionGatePipeline"
import type { TaskConfig } from "./types/TaskConfig"

/** Only record checks that ran. Gate acceptance alone is not evidence that tests passed. */
export function buildCompletionReview(
	config: TaskConfig,
	options: {
		audit: Extract<CompletionAuditGateResult, { status: "passed" | "skipped" }>
		taskProgress?: string
		command?: string
		commandExecution?: CommandExecutionState
	},
): CompletionReview {
	const checklist = config.focusChainSettings?.enabled
		? config.taskState.currentFocusChainChecklist || options.taskProgress
		: options.taskProgress
	const { totalItems, completedItems } = parseFocusChainListCounts(checklist ?? "")
	const checks: CompletionCheck[] = [
		{
			id: "checklist",
			status: totalItems > 0 ? (completedItems === totalItems ? "passed" : "unverified") : "not_run",
			detail:
				totalItems > 0 ? `${completedItems} of ${totalItems} items marked complete.` : "No task checklist was provided.",
		},
	]
	checks.push(
		options.audit.status === "passed"
			? {
					id: "audit",
					status: "passed",
					detail: `Score ${options.audit.gateDecision.score}/100 · policy threshold ${options.audit.gateDecision.effectiveThreshold}.`,
				}
			: {
					id: "audit",
					status: "not_run",
					detail: config.isSubagentExecution ? "Not required for this helper task." : "Not enabled for this task.",
				},
	)
	const reviewed = config.doubleCheckCompletionEnabled && config.taskState.doubleCheckCompletionPending
	checks.push({
		id: "review",
		status: reviewed ? "passed" : "not_run",
		detail: reviewed ? "Confirmed on a second completion attempt." : "A second review was not requested.",
	})
	if (options.command?.trim()) {
		const execution = options.commandExecution
		const passed = execution?.status === "completed" && execution.exitCode === 0
		const running = execution?.status === "running" || execution?.status === "background"
		checks.push({
			id: "demo",
			status: passed ? "passed" : running ? "running" : "unverified",
			detail: `${options.command.trim()}\n${passed ? "Finished with exit code 0." : running ? "Still running when this result was recorded. Check the terminal for its outcome." : "No successful exit was recorded. Check the terminal output."}`,
		})
	}
	return {
		schemaVersion: 1,
		attempt: Math.max(1, config.taskState.completionAttemptCount ?? 0),
		priorBlocks: config.taskState.completionGateBlockCount ?? 0,
		checks,
	}
}
