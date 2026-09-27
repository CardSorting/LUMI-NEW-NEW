/**
 * CommandExecutor - VS Code extension command execution.
 *
 * This class uses the host-provided VS Code terminal manager plus the shared
 * CommandOrchestrator for buffering, user interaction, and result formatting.
 */

import { randomUUID } from "node:crypto"
import { findLastIndex } from "@shared/array"
import { type CommandExecutionState, isActiveCommandExecution } from "@shared/ExtensionMessage"
import pTimeout from "p-timeout"
import { Logger } from "@/shared/services/Logger"
import { orchestrateCommandExecution } from "./CommandOrchestrator"
import {
	boundCommandOutput,
	MAX_ACTIVE_COMMANDS,
	MAX_COMMAND_READ_WAITERS,
	MAX_COMMAND_RECEIPTS,
	resolveCommandReadTimeoutSeconds,
	TERMINAL_START_TIMEOUT_MS,
} from "./commandPolicy"
import type {
	CommandExecutionOptions,
	CommandExecutionResult,
	CommandExecutionSnapshot,
	CommandExecutionSummary,
	CommandExecutorCallbacks,
	CommandExecutorConfig,
	ITerminal,
	ITerminalManager,
	ShellIntegrationWarningTracker,
	TerminalCompletionDetails,
	TerminalProcessResultPromise,
} from "./types"

interface OwnedCommand {
	command: string
	cwd: string
	executionId: string
	actionId?: string
	owner?: string
	terminalId: number
	terminal: ITerminal
	detached: boolean
	cancelled: boolean
	stopError?: string
	logFilePath?: string
	logNotice?: string
	latest: CommandExecutionState
	messageTs?: number | null
	waiters: Set<() => void>
	cancel: () => void
}

/**
 * CommandExecutor - command executor for the VS Code extension.
 *
 * Uses the shared CommandOrchestrator for common logic and delegates process
 * management to the configured terminal manager.
 */
export class CommandExecutor {
	private cwd: string
	private terminalManager: ITerminalManager
	private callbacks: CommandExecutorCallbacks
	private readonly taskId: string

	// Processes remain owned until terminal completion, even after a timed wait returns.
	private readonly activeProcesses = new Map<TerminalProcessResultPromise, OwnedCommand>()
	// Completed receipts hold bounded plain data, never terminal instances or process closures.
	private readonly receipts = new Map<string, { snapshot: CommandExecutionSnapshot; messageTs?: number | null }>()
	private launchQueue: Promise<void> = Promise.resolve()
	private readonly backgroundCompletions: string[] = []

	// Track shell integration warnings to determine when to show the stronger troubleshooting suggestion
	private shellIntegrationWarningTracker: ShellIntegrationWarningTracker = {
		timestamps: [],
		lastSuggestionShown: undefined,
	}

	constructor(config: CommandExecutorConfig, callbacks: CommandExecutorCallbacks) {
		this.cwd = config.cwd
		this.taskId = config.taskId
		this.terminalManager = config.terminalManager
		this.callbacks = callbacks
	}

	/**
	 * Execute a command in the terminal.
	 *
	 * @param command The command to execute
	 * @param timeoutSeconds Optional timeout in seconds
	 * @returns Result text plus authoritative execution state and bounded output.
	 */
	async execute(
		command: string,
		timeoutSeconds: number | undefined,
		options?: CommandExecutionOptions,
	): Promise<CommandExecutionResult> {
		const cwd = options?.cwd ?? this.cwd
		const manager = this.terminalManager
		let commandMessageTs = options?.commandMessageTs
		if (!options?.suppressUserInteraction && commandMessageTs === undefined) {
			try {
				const messages = this.callbacks.getDietCodeMessages()
				commandMessageTs =
					messages[findLastIndex(messages, (message) => message.ask === "command" || message.say === "command")]?.ts
			} catch (error) {
				Logger.warn("Command row unavailable:", error)
			}
		}
		const showNotStarted = (detail: string) => {
			if (commandMessageTs == null) return
			try {
				const index = this.callbacks.getDietCodeMessages().findIndex((message) => message.ts === commandMessageTs)
				const commandExecution: CommandExecutionState = { status: "not_started", detail }
				if (index >= 0)
					void this.callbacks
						.updateDietCodeMessage(index, { commandCompleted: true, commandExecution })
						.catch((error) => Logger.warn("Command row unavailable:", error))
			} catch (error) {
				Logger.warn("Command row unavailable:", error)
			}
		}
		Logger.info(`Executing command in VS Code terminal: ${command}`)

		// Only terminal acquisition/start is serialized. Once runCommand marks its
		// terminal busy, independent commands can execute concurrently in other terminals.
		const previousLaunch = this.launchQueue
		let releaseLaunch!: () => void
		const launchSlot = new Promise<void>((resolve) => {
			releaseLaunch = resolve
		})
		// A cancelled waiter must not let later launches jump an occupied slot.
		this.launchQueue = previousLaunch.then(() => launchSlot)
		let process: TerminalProcessResultPromise
		let terminalId: number
		let terminal: ITerminal
		try {
			await pTimeout(previousLaunch, {
				milliseconds: TERMINAL_START_TIMEOUT_MS,
				signal: options?.signal,
				message: "Command did not start: terminal launch queue timed out. Inspect existing commands before retrying.",
			})
			options?.signal?.throwIfAborted()
			const duplicate = [...this.activeProcesses.entries()].find(
				([, active]) => active.cwd === cwd && active.command.trim() === command.trim(),
			)
			if (duplicate) {
				const [existing, active] = duplicate
				showNotStarted(`Already active in terminal ${active.terminalId}. No duplicate was started.`)
				const output = this.snapshot(existing, active).output
				return [
					false,
					`Command already active in terminal ${active.terminalId}; no duplicate was started. ${active.cancelled ? "A stop was requested but termination is not confirmed." : "It has not been confirmed finished."} ${this.readInstruction(active.executionId)}${output ? `\nOutput so far:\n${output}` : ""}`,
					{ ...active.latest },
				]
			}
			if (this.activeProcesses.size >= MAX_ACTIVE_COMMANDS) {
				throw new Error(
					`Command did not start: ${MAX_ACTIVE_COMMANDS} commands are already active. Inspect or stop existing terminals before launching more work.`,
				)
			}
			const terminalInfo = await pTimeout(manager.getOrCreateTerminal(cwd), {
				milliseconds: TERMINAL_START_TIMEOUT_MS,
				signal: options?.signal,
				message: "Command did not start: terminal creation timed out. Inspect terminal availability before retrying.",
			})
			options?.signal?.throwIfAborted()
			if (!options?.suppressUserInteraction) {
				try {
					terminalInfo.terminal.show()
				} catch (error) {
					Logger.warn("Terminal display unavailable; executing the approved command:", error)
				}
			}
			process = manager.runCommand(terminalInfo, command)
			terminalId = terminalInfo.id
			terminal = terminalInfo.terminal
		} catch (error) {
			showNotStarted(error instanceof Error ? error.message : String(error))
			throw error
		} finally {
			releaseLaunch()
		}

		const stopController = new AbortController()
		const publish = (next: CommandExecutionState) => {
			if (!this.activeProcesses.has(process) && isActiveCommandExecution(next)) return
			// Stop failures and in-flight stops cannot be overwritten by a late
			// foreground-detach notification. Only actual completion supersedes them.
			const commandExecution: CommandExecutionState = {
				...next,
				executionId: state.executionId,
				taskId: this.taskId,
				terminalId,
				...(state.cancelled && isActiveCommandExecution(next)
					? state.stopError
						? { status: "stop_failed", detail: state.stopError }
						: { status: "stopping" }
					: {}),
			}
			state.latest = commandExecution
			this.updateCommandMessage(state.messageTs, commandExecution)
		}
		const state: OwnedCommand = {
			command,
			cwd,
			executionId: randomUUID(),
			actionId: options?.actionId,
			owner: options?.owner ?? "parent",
			terminalId,
			terminal,
			detached: false,
			cancelled: false,
			latest: { status: "running" },
			messageTs: options?.suppressUserInteraction ? undefined : commandMessageTs,
			waiters: new Set(),
			cancel: () => {
				if (state.cancelled || !this.activeProcesses.has(process)) return
				state.cancelled = true
				state.stopError = undefined
				publish({ status: "stopping" })
				stopController.abort(new Error("Command stop requested"))
				void Promise.resolve()
					.then(() => {
						if (!this.activeProcesses.has(process)) return
						if (!process.terminate) throw new Error("This terminal does not support stopping commands.")
						return process.terminate()
					})
					.catch((error) => {
						Logger.warn("Command termination failed:", error)
						if (!this.activeProcesses.has(process)) return
						state.stopError =
							"The stop request failed. Open the terminal to inspect it, or retry stopping this command."
						publish({ status: "stop_failed" })
					})
			},
		}
		this.activeProcesses.set(process, state)
		const clearProcess = () => {
			this.activeProcesses.delete(process)
			options?.signal?.removeEventListener("abort", state.cancel)
			process.removeListener("completed", onCompleted)
			process.removeListener("error", onError)
			try {
				this.callbacks.updateBackgroundCommandState(this.activeProcesses.size > 0)
			} catch (error) {
				Logger.warn("Command status display unavailable; process ownership released:", error)
			}
		}
		const finish = (next: CommandExecutionState) => {
			if (!this.activeProcesses.has(process)) return
			publish(next)
			const snapshot = this.snapshot(process, state)
			this.receipts.set(state.executionId, { snapshot, messageTs: state.messageTs })
			this.displaySnapshot(state.messageTs, snapshot)
			if (this.receipts.size > MAX_COMMAND_RECEIPTS) this.receipts.delete(this.receipts.keys().next().value!)
			clearProcess()
			for (const resolve of state.waiters) resolve()
			state.waiters.clear()
		}
		const onCompleted = (details?: TerminalCompletionDetails) => {
			if (!this.activeProcesses.has(process)) return
			if (state.detached) {
				const status = details?.cancelled
					? "stopped"
					: typeof details?.exitCode === "number"
						? `exit code ${details.exitCode}`
						: details?.terminalClosed
							? "terminal closed; command exit status unknown"
							: "finished; exit status unknown"
				this.backgroundCompletions.push(
					`Terminal ${terminalId}: ${command.slice(0, 1000)} — ${status}. Execution ID: ${state.executionId}.`,
				)
				if (this.backgroundCompletions.length > MAX_ACTIVE_COMMANDS) this.backgroundCompletions.shift()
			}
			finish({
				status: details?.cancelled
					? "cancelled"
					: (typeof details?.exitCode === "number" && details.exitCode !== 0) || details?.signal
						? "failed"
						: "completed",
				exitCode: details?.exitCode ?? undefined,
				signal: details?.signal ?? undefined,
				terminalClosed: details?.terminalClosed,
			})
		}
		const onError = (error: unknown) =>
			finish({ status: "failed", detail: error instanceof Error ? error.message : String(error) })
		process.once("completed", onCompleted)
		process.once("error", onError)
		void process.catch(onError)
		options?.signal?.addEventListener("abort", state.cancel, { once: true })

		// Use shared orchestration logic.
		const pending = orchestrateCommandExecution(
			process,
			manager,
			{
				...this.callbacks,
				updateBackgroundCommandState: () => this.callbacks.updateBackgroundCommandState(this.activeProcesses.size > 0),
			},
			{
				command,
				onStateChange: publish,
				commandMessageTs,
				signal: stopController.signal,
				onCancel: state.cancel,
				timeoutSeconds,
				suppressUserInteraction: options?.suppressUserInteraction,
				interactive: options?.interactive,
				showShellIntegrationSuggestion: () => this.shouldShowBackgroundTerminalSuggestion(),
				terminalType: "vscode",
			},
		)
		if (options?.signal?.aborted) state.cancel()
		const result = await pending
		state.detached = !result.completed
		state.logFilePath = result.logFilePath
		state.logNotice = result.logNotice
		const snapshot = this.snapshot(process, state)
		const saved = this.receipts.get(state.executionId)
		if (saved) saved.snapshot = snapshot
		// Log capture finishes after the host completion event. Preserve its final notice in refreshed output.
		if (state.logNotice) this.displaySnapshot(state.messageTs, snapshot)

		const receipt = `Execution ID: ${state.executionId}. ${isActiveCommandExecution(state.latest) ? this.readInstruction(state.executionId) : ""}`
		const content =
			typeof result.result === "string"
				? `${result.result}\n\n${receipt}`
				: [...result.result, { type: "text" as const, text: receipt }]
		return [result.userRejected, content, { ...state.latest, output: snapshot.output }]
	}

	/** Read or wait for an existing execution once. Never launches, retries, or cancels a command. */
	async readCommandOutput(
		executionId: string,
		timeoutSeconds?: number,
		signal?: AbortSignal,
	): Promise<CommandExecutionSnapshot> {
		signal?.throwIfAborted()
		const active = [...this.activeProcesses.entries()].find(([, state]) => state.executionId === executionId)
		if (active) {
			const [process, state] = active
			const waitMs = resolveCommandReadTimeoutSeconds(timeoutSeconds) * 1000
			if (waitMs > 0) {
				if (state.waiters.size >= MAX_COMMAND_READ_WAITERS) {
					throw new Error("Too many concurrent waits for this execution. Reuse the pending read or request timeout 0.")
				}
				await new Promise<void>((resolve, reject) => {
					const cleanup = () => {
						clearTimeout(timer)
						state.waiters.delete(done)
						signal?.removeEventListener("abort", abort)
					}
					const done = () => {
						cleanup()
						resolve()
					}
					const abort = () => {
						cleanup()
						reject(signal?.reason ?? new Error("Command observation cancelled"))
					}
					const timer = setTimeout(done, waitMs)
					state.waiters.add(done)
					signal?.addEventListener("abort", abort, { once: true })
					if (signal?.aborted) abort()
				})
			}
			signal?.throwIfAborted()
			// A retained local reference also handles receipt eviction during a concurrent burst of completions.
			const snapshot = this.receipts.get(executionId)?.snapshot ?? this.snapshot(process, state)
			this.displaySnapshot(state.messageTs, snapshot)
			return { ...snapshot }
		}
		const receipt = this.receipts.get(executionId)
		if (!receipt)
			throw new Error(
				"Execution ID is not tracked by this task. It may be expired or from a previous session. Inspect the terminal panel; do not rerun a command just to check its status.",
			)
		this.displaySnapshot(receipt.messageTs, receipt.snapshot)
		return { ...receipt.snapshot }
	}

	private snapshot(process: TerminalProcessResultPromise, state: OwnedCommand): CommandExecutionSnapshot {
		let output = "[Output snapshot unavailable; inspect the terminal panel.]"
		try {
			if (process.getOutputSnapshot) output = boundCommandOutput(process.getOutputSnapshot())
		} catch (error) {
			Logger.warn("Command output snapshot unavailable:", error)
		}
		return {
			execution_id: state.executionId,
			action_id: state.actionId,
			owner: state.owner,
			terminal_id: state.terminalId,
			command: state.command,
			cwd: state.cwd,
			status: state.latest.status,
			exit_code: state.latest.exitCode,
			signal: state.latest.signal,
			terminal_closed: state.latest.terminalClosed,
			detail: state.latest.detail,
			output,
			log_file_path: state.logFilePath,
			log_notice: state.logNotice,
		}
	}

	/** Non-consuming inventory includes foreground runs and remains available to every helper. */
	getExecutionInventory(): { active: CommandExecutionSummary[]; recent: CommandExecutionSummary[] } {
		return {
			active: [...this.activeProcesses].map(([process, state]) => this.summarize(this.snapshot(process, state))),
			recent: [...this.receipts.values()].slice(-8).map(({ snapshot }) => this.summarize(snapshot)),
		}
	}

	/** Resolve either identity against every retained receipt, not just the recent context window. */
	getExecutionSummary(executionId: string): CommandExecutionSummary | undefined {
		const active = [...this.activeProcesses].find(
			([, state]) => state.executionId === executionId || state.actionId === executionId,
		)
		if (active) return this.summarize(this.snapshot(active[0], active[1]))
		const receipt =
			this.receipts.get(executionId) ??
			[...this.receipts.values()].find(({ snapshot }) => snapshot.action_id === executionId)
		return receipt ? this.summarize(receipt.snapshot) : undefined
	}

	private summarize(snapshot: CommandExecutionSnapshot): CommandExecutionSummary {
		const { output, ...metadata } = snapshot
		return {
			...metadata,
			command: metadata.command.slice(0, 800),
			output_preview: output.slice(-600),
			command_truncated: metadata.command.length > 800,
			output_truncated: output.length > 600,
		}
	}

	private snapshotState(snapshot: CommandExecutionSnapshot): CommandExecutionState {
		return {
			status: snapshot.status,
			executionId: snapshot.execution_id,
			terminalId: snapshot.terminal_id,
			taskId: this.taskId,
			exitCode: snapshot.exit_code,
			signal: snapshot.signal,
			terminalClosed: snapshot.terminal_closed,
			detail: snapshot.detail,
		}
	}

	private readInstruction(executionId: string): string {
		return `Use read_command_output with execution_id "${executionId}" to inspect this same run (timeout 0 for an immediate snapshot, up to 30 seconds to wait). Do not launch it again to check progress.`
	}

	private displaySnapshot(messageTs: number | null | undefined, snapshot: CommandExecutionSnapshot): void {
		const output = snapshot.log_notice ? `${snapshot.output}\n${snapshot.log_notice}` : snapshot.output
		this.updateCommandMessage(messageTs, this.snapshotState(snapshot), output)
	}

	private updateCommandMessage(
		messageTs: number | null | undefined,
		commandExecution: CommandExecutionState,
		commandOutput?: string,
	): void {
		if (messageTs == null) return
		try {
			const index = this.callbacks.getDietCodeMessages().findIndex((message) => message.ts === messageTs)
			if (index >= 0)
				void this.callbacks
					.updateDietCodeMessage(index, {
						commandCompleted: !isActiveCommandExecution(commandExecution),
						commandExecution,
						...(commandOutput !== undefined ? { commandOutput } : {}),
					})
					.catch((error) => Logger.warn("Command state display unavailable:", error))
		} catch (error) {
			Logger.warn("Command state display unavailable:", error)
		}
	}

	/** Stop all owned commands once. Presentation and host disposal never block cancellation. */
	async cancelBackgroundCommand(): Promise<boolean> {
		const owned = this.activeProcesses.size > 0
		for (const state of this.activeProcesses.values()) state.cancel()
		// An already requested stop still owns an active command. The caller must
		// not clear its running indicator until the host confirms completion.
		return owned
	}

	/** Explicit user controls target an execution, never a terminal that might be reused. */
	controlCommand(executionId: string, action: "show" | "stop"): void {
		const state = [...this.activeProcesses.values()].find((active) => active.executionId === executionId)
		if (!state) throw new Error("This command is no longer tracked. Inspect the terminal panel before retrying.")
		if (action === "show") state.terminal.show()
		else {
			// Only an explicit user retry may repeat a failed stop. Pending stops stay deduplicated.
			if (state.stopError) state.cancelled = false
			state.cancel()
		}
	}

	/**
	 * Check if any detached background commands are active.
	 */
	hasActiveBackgroundCommand(): boolean {
		return [...this.activeProcesses.values()].some((state) => state.detached)
	}

	/**
	 * Get a summary of detached background commands for environment details.
	 */
	getBackgroundCommandSummary(): string | undefined {
		const running = [...this.activeProcesses.values()].filter((state) => state.detached)
		return running.length
			? `Commands still active in existing terminals (use read_command_output; do not relaunch):\n${running.map((state) => `- Terminal ${state.terminalId}, execution_id ${state.executionId}: ${state.command.slice(0, 1000)}${state.stopError ? " (stop failed; inspect terminal before retrying)" : state.cancelled ? " (stop requested; not confirmed)" : ""}`).join("\n")}`
			: undefined
	}

	/** Keep quiet background exits visible to the next model request, even after terminal reuse. */
	takeBackgroundCompletions(): string | undefined {
		return this.backgroundCompletions.splice(0).join("\n") || undefined
	}

	/**
	 * Determines whether to show the stronger shell integration troubleshooting suggestion.
	 * Shows suggestion if there have been 3+ shell integration warnings in the last hour,
	 * and we haven't shown the suggestion in the last hour.
	 *
	 * @returns true if the suggestion should be shown, false otherwise
	 */
	private shouldShowBackgroundTerminalSuggestion(): boolean {
		const oneHourAgo = Date.now() - 60 * 60 * 1000

		// Clean old timestamps (older than 1 hour)
		this.shellIntegrationWarningTracker.timestamps = this.shellIntegrationWarningTracker.timestamps.filter(
			(ts) => ts > oneHourAgo,
		)

		// Add current warning
		this.shellIntegrationWarningTracker.timestamps.push(Date.now())

		// Check if we've shown suggestion recently (within last hour)
		if (
			this.shellIntegrationWarningTracker.lastSuggestionShown &&
			Date.now() - this.shellIntegrationWarningTracker.lastSuggestionShown < 60 * 60 * 1000
		) {
			return false
		}

		// Show suggestion if 3+ warnings in last hour
		if (this.shellIntegrationWarningTracker.timestamps.length >= 3) {
			this.shellIntegrationWarningTracker.lastSuggestionShown = Date.now()
			return true
		}

		return false
	}
}
