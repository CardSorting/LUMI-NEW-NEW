import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { WorkspacePathAdapter } from "@core/workspace/WorkspacePathAdapter"
import { showSystemNotification } from "@integrations/notifications"
import { resolveCommandTimeoutSeconds } from "@integrations/terminal/commandPolicy"
import { normalizeShellCommand } from "@integrations/terminal/normalizeCommand"
import type { CommandExecutionResult } from "@integrations/terminal/types"
import {
	appendTextToToolResponse,
	buildCommandOutputAuditAdvisory,
	extractTextFromToolResponse,
} from "@shared/audit/auditPostTool"
import { COMMAND_REQ_APP_STRING } from "@shared/combineCommandSequences"
import { DietCodeAsk } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import { arePathsEqual } from "@utils/path"
import pTimeout from "p-timeout"
import { telemetryService } from "@/services/telemetry"
import { DietCodeDefaultTool } from "@/shared/tools"
import { ActionAlreadyActiveError } from "../../ActionExecutionRegistry"
import { executor } from "../../ActionExecutor"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import type { IFullyManagedTool, ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { recordExecutionEvidence } from "../utils/executionEvidence"
import { ToolDisplay } from "../utils/ToolDisplay"
import { ToolResultUtils } from "../utils/ToolResultUtils"
import { getInitialTaskPreview } from "../utils/taskPreview"

export class ExecuteCommandToolHandler implements IFullyManagedTool {
	readonly name = DietCodeDefaultTool.BASH

	constructor(private readonly validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${normalizeShellCommand(block.params.command ?? "")}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const command = block.params.command === undefined ? undefined : normalizeShellCommand(block.params.command)
		if (uiHelpers.getConfig().isSubagentExecution) {
			return
		}

		// Check if this should be auto-approved to determine UI flow
		const shouldAutoApprove = uiHelpers.shouldAutoApproveTool(this.name)

		if (shouldAutoApprove) {
			// For auto-approved commands, we can't partially stream a say prematurely
			// since it may become an ask based on the requires_approval parameter
			// So we wait for the complete block
			return
		}
		await uiHelpers
			.ask("command" as DietCodeAsk, uiHelpers.removeClosingTag(block, "command", command), block.partial)
			.catch(() => {})
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		config.taskState.abortSignal.throwIfAborted()
		const display = new ToolDisplay(config, "Command")
		let command: string | undefined = block.params.command
		const requiresApprovalRaw: string | undefined = block.params.requires_approval
		// Missing or unrecognized model annotations defer to configured authority, not another model round-trip.
		const requiresApprovalPerLLM = requiresApprovalRaw?.toLowerCase() !== "false"
		const timeoutParam: string | undefined = block.params.timeout

		// Extract provider using the proven pattern from ReportBugHandler
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
		const provider = (currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

		// Validate required parameters
		if (!command?.trim()) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(this.name, "command")
		}

		config.taskState.consecutiveMistakeCount = 0

		command = normalizeShellCommand(command)

		// Handle multi-workspace command execution
		let executionDir: string = config.cwd
		let actualCommand: string = command

		let workspaceHintUsed = false
		let workspaceHint: string | undefined

		if (config.isMultiRootEnabled && config.workspaceManager) {
			// Check if command has a workspace hint prefix
			// e.g., "@backend:npm install" or just "npm install"
			const commandMatch = command.match(/^@(\w+):(.+)$/)

			if (commandMatch) {
				workspaceHintUsed = true
				workspaceHint = commandMatch[1]
				actualCommand = commandMatch[2].trim()

				// Find the workspace root for this hint
				const adapter = new WorkspacePathAdapter({
					cwd: config.cwd,
					isMultiRootEnabled: true,
					workspaceManager: config.workspaceManager,
				})

				// Resolve to get the workspace directory
				executionDir = adapter.resolvePath(".", workspaceHint)

				// Update command to remove the workspace prefix for display
				command = actualCommand
			}
			// If no hint, use primary workspace (cwd)
		}

		// Hooks inspect the same command that validation, approval, and execution receive.
		block = { ...block, params: { ...block.params, command: actualCommand } }

		// Check command permission validation (CLINE_COMMAND_PERMISSIONS env var)
		const permissionResult = config.services.commandPermissionController.validateCommand(actualCommand)
		if (!permissionResult.allowed) {
			let errorMessage: string
			if (permissionResult.failedSegment) {
				errorMessage =
					`Command "${actualCommand}" was denied by CLINE_COMMAND_PERMISSIONS. ` +
					`Segment "${permissionResult.failedSegment}" ${permissionResult.reason}.`
			} else {
				const matchedPattern = permissionResult.matchedPattern
					? ` (matched pattern: ${permissionResult.matchedPattern})`
					: ""
				errorMessage =
					`Command "${actualCommand}" was denied by CLINE_COMMAND_PERMISSIONS. ` +
					`Reason: ${permissionResult.reason}${matchedPattern}`
			}
			if (!config.isSubagentExecution) {
				await display.observe(() => config.callbacks.say("command_permission_denied", errorMessage))
			}
			return formatResponse.toolError(formatResponse.permissionDeniedError(errorMessage))
		}

		// Check dietcodeignore validation for command
		const commandValidation = this.validator.validateCommand(actualCommand)
		if (!commandValidation.ok) {
			if (!config.isSubagentExecution) {
				await display.observe(() => config.callbacks.say("dietcodeignore_error", commandValidation.error))
			}
			return formatResponse.toolError(commandValidation.error)
		}

		let didAutoApprove = false
		let commandMessageTs: number | null | undefined

		// If the model says this command is safe and auto approval for safe commands is true, execute the command
		// If the model says the command is risky, but *BOTH* auto approve settings are true, execute the command
		const autoApproveResult = config.autoApprover?.shouldAutoApproveTool(block.name)
		const [autoApproveSafe, autoApproveAll] = Array.isArray(autoApproveResult)
			? autoApproveResult
			: [autoApproveResult, false]

		// Determine workspace context for telemetry
		const resolvedToNonPrimary = !arePathsEqual(executionDir, config.cwd)
		const workspaceContext = {
			isMultiRootEnabled: config.isMultiRootEnabled || false,
			usedWorkspaceHint: workspaceHintUsed,
			resolvedToNonPrimary,
			resolutionMethod: (workspaceHintUsed ? "hint" : "primary_fallback") as "hint" | "primary_fallback",
		}

		// Capture workspace path resolution telemetry
		if (config.isMultiRootEnabled && config.workspaceManager) {
			const workspaceIndex = config.workspaceManager.getRoots().findIndex((r) => arePathsEqual(r.path, executionDir))
			telemetryService.captureWorkspacePathResolved(
				config.ulid,
				"ExecuteCommandToolHandler",
				workspaceHintUsed ? "hint_provided" : "fallback_to_primary",
				workspaceHintUsed ? "workspace_name" : undefined,
				resolvedToNonPrimary, // resolution success = resolved to different workspace
				workspaceIndex >= 0 ? workspaceIndex : undefined,
				true,
			)
		}

		if (
			config.isSubagentExecution ||
			config.autoApprover?.shouldAutoApproveCommand?.(actualCommand) ||
			(!requiresApprovalPerLLM && autoApproveSafe) ||
			(requiresApprovalPerLLM && autoApproveSafe && autoApproveAll)
		) {
			// Auto-approve flow
			if (!config.isSubagentExecution) {
				await display.observe(() => config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "command"))
				commandMessageTs =
					(await display.observe(() => config.callbacks.say("command", actualCommand, undefined, undefined, false))) ??
					null
			}
			didAutoApprove = true
			telemetryService.captureToolUsage(
				config.ulid,
				block.name,
				config.api.getModel().id,
				provider,
				true,
				true,
				workspaceContext,
				block.isNativeToolCall,
			)
		} else {
			// Manual approval flow
			const didApprove = await ToolResultUtils.askApprovalAndPushFeedback(
				"command",
				`${actualCommand}${autoApproveSafe && requiresApprovalPerLLM ? COMMAND_REQ_APP_STRING : ""}`,
				config,
				`DietCode wants to execute a command: ${actualCommand}`,
			)
			if (!didApprove) {
				telemetryService.captureToolUsage(
					config.ulid,
					block.name,
					config.api.getModel().id,
					provider,
					false,
					false,
					workspaceContext,
					block.isNativeToolCall,
				)
				return formatResponse.toolDenied()
			}
			telemetryService.captureToolUsage(
				config.ulid,
				block.name,
				config.api.getModel().id,
				provider,
				false,
				true,
				workspaceContext,
				block.isNativeToolCall,
			)
		}

		// Run PreToolUse hook after approval but before execution
		try {
			const { ToolHookUtils } = await import("../utils/ToolHookUtils")
			await ToolHookUtils.runPreToolUseIfEnabled(config, block)
		} catch (error) {
			const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
			if (error instanceof PreToolUseHookCancellationError) {
				return formatResponse.toolDenied()
			}
			throw error
		}

		// Approval grants execution, not an unlimited foreground wait.
		const timeoutSeconds = resolveCommandTimeoutSeconds(actualCommand, timeoutParam)

		// Setup timeout notification for long-running auto-approved commands
		let timeoutId: NodeJS.Timeout | undefined
		if (didAutoApprove && config.autoApprovalSettings.enableNotifications && !config.isSubagentExecution) {
			// if the command was auto-approved, and it's long running we need to notify the user after some time has passed without proceeding
			timeoutId = setTimeout(() => {
				void display.observe(async () =>
					showSystemNotification({
						subtitle: "Command is still running",
						message: "An auto-approved command has been running for 30s, and may need your attention.",
					}),
				)
			}, 30_000)
		}

		const [userRejected, rawResult, execution] = await executor
			.execute(
				config.ulid,
				(signal, actionId) =>
					config.callbacks.executeCommandTool(actualCommand, timeoutSeconds, {
						actionId,
						onStateChange: (state) => executor.executions.reconcileCommand(config.ulid, actionId, state),
						owner: config.executionOwner ?? "parent",
						cwd: executionDir,
						commandMessageTs,
						// Keep the task signal after this foreground action yields, so detached work stays cancellable.
						signal: AbortSignal.any([signal, config.taskState.abortSignal]),
						interactive: !didAutoApprove,
					}),
				{
					concurrencyGroup: "shell",
					execution: {
						kind: "command",
						input: { cwd: executionDir, command: actualCommand.trim() },
						label: actualCommand,
						owner: config.executionOwner,
					},
					signal: config.taskState.abortSignal,
				},
			)
			.catch(async (error): Promise<CommandExecutionResult> => {
				if (!(error instanceof ActionAlreadyActiveError)) throw error
				const state = { status: "not_started" as const, detail: error.message }
				if (typeof commandMessageTs === "number") {
					await display.observe(async () => {
						const messages = config.messageState
						const index =
							messages
								?.getDietCodeMessages?.()
								.findIndex(
									(message) =>
										message.ts === commandMessageTs &&
										(message.say === "command" || message.ask === "command"),
								) ?? -1
						if (index < 0) return
						await messages.updateDietCodeMessage(index, { commandExecution: state })
						await config.callbacks.postStateToWebview()
					})
				}
				return [false, error.message, state]
			})
			.finally(() => clearTimeout(timeoutId))

		if (userRejected) {
			config.taskState.didRejectTool = true
		} else if (execution?.status === "completed" && execution.exitCode === 0) {
			recordExecutionEvidence(config.taskState, "command", [executionDir, actualCommand], {
				exitCode: execution.exitCode,
				output: execution.output ?? rawResult,
			})
		} else if (!execution) {
			// Compatibility for hosts that have not yet adopted structured completion metadata.
			recordExecutionEvidence(config.taskState, "command", [executionDir, actualCommand], rawResult)
		}
		const failed = execution && ["failed", "cancelled", "not_started"].includes(execution.status)
		let result = rawResult
		if (failed) {
			const errorText = formatResponse.toolError(extractTextFromToolResponse(rawResult))
			// Preserve image feedback supplied while stopping a command, alongside its failed status.
			result =
				typeof rawResult === "string"
					? errorText
					: [{ type: "text", text: errorText }, ...rawResult.filter((part) => part.type !== "text")]
		}

		if (!userRejected && config.auditToolOutputAdvisoryEnabled && !config.isSubagentExecution) {
			try {
				const outputText = extractTextFromToolResponse(result)
				const taskPreview = getInitialTaskPreview(config) || ""
				const advisory = await pTimeout(
					buildCommandOutputAuditAdvisory(config.taskId, taskPreview, actualCommand, outputText, {
						cwd: executionDir,
						settings: config,
					}),
					{ milliseconds: 1_000, signal: config.taskState.abortSignal },
				)
				if (advisory) {
					return appendTextToToolResponse(result, advisory) as ToolResponse
				}
			} catch (error) {
				Logger.warn("[ExecuteCommandToolHandler] Command output audit advisory failed:", error)
			}
		}

		return result
	}
}
