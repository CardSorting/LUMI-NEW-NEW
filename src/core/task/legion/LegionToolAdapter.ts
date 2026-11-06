import { randomUUID } from "node:crypto"
import type { ApiHandler } from "@core/api"
import type { ToolParamName, ToolUse } from "@core/assistant-message"
import { EnvironmentIntegrity } from "@core/integrity/EnvironmentIntegrity"
import { TaskState } from "@core/task/TaskState"
import { UseSkillToolHandler } from "@core/task/tools/handlers/UseSkillToolHandler"
import { ToolExecutorCoordinator } from "@core/task/tools/ToolExecutorCoordinator"
import { ToolValidator } from "@core/task/tools/ToolValidator"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import { isToolFailure } from "@core/task/tools/utils/toolOutcome"
import { FileEditProvider } from "@integrations/editor/FileEditProvider"
import type { CommandExecutionState } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import { DietCodeDefaultTool, type DietCodeTool } from "@shared/tools"
import {
	beginLegionOperation,
	finishLegionOperation,
	type LegionOperationReceipt,
} from "@/infrastructure/ai/LegionExecutionReceipt"
import type { LegionAgentTools } from "./LegionAgentHost"

/** These handlers retain the parent's approval callbacks, ignore rules and execution guard. */
export const LEGION_TOOL_NAMES: readonly DietCodeDefaultTool[] = [
	DietCodeDefaultTool.FILE_READ,
	DietCodeDefaultTool.LIST_FILES,
	DietCodeDefaultTool.SEARCH,
	DietCodeDefaultTool.LIST_CODE_DEF,
	DietCodeDefaultTool.FILE_NEW,
	DietCodeDefaultTool.FILE_EDIT,
	DietCodeDefaultTool.APPLY_PATCH,
	DietCodeDefaultTool.BASH,
	DietCodeDefaultTool.READ_COMMAND_OUTPUT,
	DietCodeDefaultTool.GET_EXECUTION_STATE,
	DietCodeDefaultTool.USE_SKILL,
]

/**
 * Create a separate handler state and editor for one specialist. The parent must
 * remain idle while this adapter is active: approval UI and guard are task-owned.
 */
export function createLegionToolAdapter(
	base: TaskConfig,
	api: ApiHandler,
	definitions: DietCodeTool[],
	streamId?: string,
	parentSignal?: AbortSignal,
): LegionAgentTools {
	const state = new TaskState()
	state.recovery = base.taskState.recovery
	const owner = `legion:${streamId ?? randomUUID()}`
	const coordinator = new ToolExecutorCoordinator()
	const validator = new ToolValidator(base.services.dietcodeIgnoreController, base.universalGuard)
	for (const name of LEGION_TOOL_NAMES) coordinator.registerByName(name, validator)
	if (!coordinator.has(DietCodeDefaultTool.USE_SKILL)) {
		coordinator.register(new UseSkillToolHandler())
	}
	const allowedNames = new Set<string>([...LEGION_TOOL_NAMES, "use_skill"])
	const onAbort = () => {
		state.abort = true
	}
	if (parentSignal) {
		if (parentSignal.aborted) onAbort()
		else parentSignal.addEventListener("abort", onAbort, { once: true })
	}
	if (base.taskState.abortSignal.aborted) {
		onAbort()
	} else {
		base.taskState.abortSignal.addEventListener("abort", onAbort, { once: true })
	}
	let currentSignal: AbortSignal | undefined
	const observedSignals = new Set<AbortSignal>()
	let commandStarted = false
	let actionObservationRequired = false
	const uncertainCommands = new Set<string>()
	const unresolvedCommandIds = new Set<string>()
	const unsettledOperations = new Set<string>()
	const matchesCommand = (value: unknown, id: string): value is { status: string; execution_id?: string; action_id?: string } =>
		!!value &&
		typeof value === "object" &&
		"status" in value &&
		typeof value.status === "string" &&
		(("execution_id" in value && value.execution_id === id) || ("action_id" in value && value.action_id === id))
	const config: TaskConfig = {
		...base,
		api,
		taskState: state,
		executionOwner: owner,
		coordinator,
		callbacks: {
			...base.callbacks,
			executeCommandTool: async (command, timeout, options) => {
				commandStarted = true
				const invocation = randomUUID()
				uncertainCommands.add(invocation)
				const signals = [
					base.taskState.abortSignal,
					state.abortSignal,
					currentSignal,
					options?.signal,
					parentSignal,
				].filter((value): value is AbortSignal => !!value)
				const userOnStateChange = options?.onStateChange
				const settledIds = new Set<string>()
				const onStateChange = (commandState: CommandExecutionState) => {
					if (options?.actionId && commandState?.executionId && commandState.executionId !== options.actionId) {
						userOnStateChange?.(commandState)
						return
					}
					if (
						commandState?.executionId &&
						["completed", "failed", "cancelled", "not_started"].includes(commandState.status)
					) {
						settledIds.add(commandState.executionId)
						uncertainCommands.delete(invocation)
						unresolvedCommandIds.delete(commandState.executionId)
					} else if (commandState?.executionId && !settledIds.has(commandState.executionId)) {
						uncertainCommands.delete(invocation)
						unresolvedCommandIds.add(commandState.executionId)
					}
					userOnStateChange?.(commandState)
				}
				try {
					const result = await base.callbacks.executeCommandTool(command, timeout, {
						...options,
						signal: AbortSignal.any(signals),
						interactive: false,
						onStateChange,
					})
					const execution = result[2]
					if (
						execution &&
						["completed", "failed", "cancelled", "not_started"].includes(execution.status) &&
						(!options?.actionId || !execution.executionId || execution.executionId === options.actionId)
					) {
						uncertainCommands.delete(invocation)
						if (execution.executionId) {
							settledIds.add(execution.executionId)
							unresolvedCommandIds.delete(execution.executionId)
						}
					} else if (
						execution?.executionId &&
						!["completed", "failed", "cancelled", "not_started"].includes(execution.status)
					) {
						uncertainCommands.delete(invocation)
						if (!settledIds.has(execution.executionId)) unresolvedCommandIds.add(execution.executionId)
					}
					return result
				} catch (error) {
					// A rejected callback does not establish whether dispatch occurred.
					// Keep the unknown outcome until a state notification resolves it.
					throw error
				}
			},
			readCommandOutput: async (executionId, timeout, signal) => {
				if (!base.callbacks.readCommandOutput) throw new Error("readCommandOutput unavailable")
				const snapshot = await base.callbacks.readCommandOutput(executionId, timeout, signal)
				if (
					matchesCommand(snapshot, executionId) &&
					["completed", "failed", "cancelled", "not_started"].includes(snapshot.status)
				) {
					unresolvedCommandIds.delete(executionId)
					unresolvedCommandIds.delete(snapshot.execution_id)
					if (snapshot.action_id) unresolvedCommandIds.delete(snapshot.action_id)
				}
				return snapshot
			},
		},
		services: {
			...base.services,
			diffViewProvider: new FileEditProvider(base.cwd, state.abortSignal, () => state.recovery?.assertCanExecute(owner)),
		},
	}
	return {
		definitions,
		allowedNames,
		dispose() {
			parentSignal?.removeEventListener("abort", onAbort)
			base.taskState.abortSignal.removeEventListener("abort", onAbort)
			for (const observed of observedSignals) observed.removeEventListener("abort", onAbort)
			observedSignals.clear()
			state.abort = true
		},
		getModifiedArtifacts() {
			return [...state.workspaceArtifacts]
		},
		getPendingWork() {
			if (unsettledOperations.size)
				return "A specialist operation's outcome or durable receipt is unconfirmed. Inspect existing work before repeating it."
			if (uncertainCommands.size)
				return "A command's execution identity or outcome is unconfirmed. Inspect the terminal before repeating work."
			const snapshot = base.callbacks.getExecutionState?.()
			const ownedCommands =
				snapshot && "commands" in snapshot
					? [
							...snapshot.commands.active,
							...(snapshot.commands.unresolved ?? []),
							...snapshot.commands.recent.filter(
								(entry) => entry.status === "unknown" || entry.status === "unconfirmed",
							),
						].filter((entry) => entry.owner === owner)
					: []
			if (!commandStarted) {
				if (!snapshot || !("actions" in snapshot)) {
					if (ownedCommands.length)
						return `Specialist commands are active or unconfirmed: ${ownedCommands.map((entry) => entry.execution_id).join(", ")}.`
					return actionObservationRequired
						? "Specialist action status is unavailable. Inspect existing work before repeating it."
						: undefined
				}
				const actions = [...snapshot.actions.active, ...(snapshot.actions.unresolved ?? [])].filter(
					(entry) => entry.owner === owner,
				)
				const pending = [
					...ownedCommands.map((entry) => entry.execution_id),
					...actions.map((entry) => entry.execution_id),
				]
				if (!pending.length) return undefined
				return `Specialist commands or actions are active or unconfirmed: ${[...new Set(pending)].join(", ")}.`
			}
			if (!snapshot || !("commands" in snapshot) || snapshot.coverage?.commands === "unavailable") {
				return "Command status is unavailable. Inspect existing executions before repeating work."
			}
			const actions = [...snapshot.actions.active, ...(snapshot.actions.unresolved ?? [])].filter(
				(entry) => entry.owner === owner,
			)
			const unresolved = new Set([
				...ownedCommands.map((entry) => entry.execution_id),
				...actions.map((entry) => entry.execution_id),
			])
			for (const id of unresolvedCommandIds) {
				try {
					const observed = base.callbacks.getExecutionState?.(id)
					const terminalStatus = ["completed", "failed", "cancelled", "not_started"]
					let status: string | undefined
					if (observed && typeof observed === "object") {
						if (!("kind" in observed) && matchesCommand(observed, id)) {
							status = observed.status
						} else if ("command" in observed && matchesCommand(observed.command, id)) {
							status = observed.command.status
						}
					}
					if (status && terminalStatus.includes(status)) {
						unresolvedCommandIds.delete(id)
					} else {
						unresolved.add(id)
					}
				} catch {
					// An expired or unavailable receipt is not evidence that execution stopped.
					unresolved.add(id)
				}
			}
			if (!unresolved.size) return undefined
			return `Specialist commands or actions are active or unconfirmed: ${[...unresolved].join(", ")}.`
		},
		async execute(name, input, signal, callId = randomUUID()) {
			if (!allowedNames.has(name)) throw new Error(`Tool ${name} is unavailable to specialists`)
			if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid tool parameters")
			const params: Partial<Record<ToolParamName, string>> = {}
			for (const [key, value] of Object.entries(input)) {
				if (value !== undefined && value !== null)
					params[key as ToolParamName] = typeof value === "string" ? value : JSON.stringify(value)
			}
			const block: ToolUse = {
				type: "tool_use",
				name: name as DietCodeDefaultTool,
				params,
				partial: false,
				isNativeToolCall: true,
			}
			const previousRevision = state.workspaceRevision
			currentSignal = signal
			let receipt: LegionOperationReceipt | undefined
			let returned = false
			if (signal.aborted) onAbort()
			signal.addEventListener("abort", onAbort, { once: true })
			observedSignals.add(signal)
			try {
				signal.throwIfAborted()
				state.recovery?.assertCanExecute(owner)
				if (config.universalGuard) {
					const preflight = await config.universalGuard.guardPreExecution(block)
					if (!preflight.success) return `Tool denied: ${preflight.error ?? "execution policy"}`
				}
				signal.throwIfAborted()
				if (streamId) {
					unsettledOperations.add(callId)
					receipt = await beginLegionOperation(streamId, callId, name, input)
				}
				signal.throwIfAborted()
				if (name === DietCodeDefaultTool.FILE_NEW) actionObservationRequired = true
				const result = await coordinator.execute(config, block)
				returned = true
				if (state.didRejectTool) {
					throw new Error(`Specialist tool ${name} was denied. Stop and respect the user's decision.`)
				}
				if (config.universalGuard && !isToolFailure(result)) {
					try {
						await config.universalGuard.guardPostExecution(block, result)
					} catch (error) {
						Logger.warn("[Legion] Post-execution observation failed; retaining the tool result", error)
					}
				}
				if (!isToolFailure(result)) {
					const filePath =
						(params as Record<string, string>)?.path ||
						(params as Record<string, string>)?.targetFile ||
						(params as Record<string, string>)?.filePath
					if (
						name === DietCodeDefaultTool.FILE_NEW ||
						name === DietCodeDefaultTool.FILE_EDIT ||
						name === DietCodeDefaultTool.APPLY_PATCH ||
						name === "write_to_file" ||
						name === "replace_in_file" ||
						name === "apply_patch"
					) {
						const patch =
							typeof input === "object" && input !== null ? (input as Record<string, unknown>).input : undefined
						const paths = filePath ? [filePath] : []
						if (name === DietCodeDefaultTool.APPLY_PATCH && typeof patch === "string") {
							for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
								paths.push(match[1].trim())
							}
						}
						for (const changedPath of paths) {
							state.trackWorkspaceArtifact(changedPath)
							base.taskState.trackWorkspaceArtifact(changedPath)
						}
						if (paths.some((changedPath) => EnvironmentIntegrity.isManifest(changedPath))) {
							EnvironmentIntegrity.invalidateCache()
						}
					}
				}
				// Preserve the actual outcome even if cancellation arrived during execution.
				return typeof result === "string" ? result : JSON.stringify(result)
			} finally {
				if (streamId && receipt) {
					try {
						await finishLegionOperation(streamId, callId, receipt, returned ? "returned" : "uncertain")
						if (returned) unsettledOperations.delete(callId)
					} catch (error) {
						Logger.warn("[Legion] Could not record tool settlement; outcome remains uncertain", error)
					}
				}
				// Specialists have isolated state, but committed edits must invalidate the
				// parent's completion evidence and appear in its environment refresh.
				const revisions = Math.max(0, state.workspaceRevision - previousRevision)
				if (revisions > 0) {
					base.taskState.workspaceRevision += revisions
					base.taskState.didEditFile = true
					for (const art of state.workspaceArtifacts) {
						base.taskState.trackWorkspaceArtifact(art)
					}
				}
				if (!unresolvedCommandIds.size && !uncertainCommands.size) {
					signal.removeEventListener("abort", onAbort)
					observedSignals.delete(signal)
				}
				currentSignal = undefined
			}
		},
	}
}
