/**
 * CommandExecutor - VS Code extension command execution.
 *
 * This class uses the host-provided VS Code terminal manager plus the shared
 * CommandOrchestrator for buffering, user interaction, and result formatting.
 */

import { findLastIndex } from "@shared/array"
import { DietCodeToolResponseContent } from "@shared/messages"
import { Logger } from "@/shared/services/Logger"
import { orchestrateCommandExecution } from "./CommandOrchestrator"
import type {
	CommandExecutionOptions,
	CommandExecutorCallbacks,
	CommandExecutorConfig,
	ITerminalManager,
	ShellIntegrationWarningTracker,
	TerminalProcessResultPromise,
} from "./types"

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

	// Processes remain owned until terminal completion, even after a timed wait returns.
	private readonly activeProcesses = new Map<
		TerminalProcessResultPromise,
		{ command: string; detached: boolean; cancelled: boolean; cancel: () => void }
	>()
	private launchQueue: Promise<void> = Promise.resolve()

	// Track shell integration warnings to determine when to show the stronger troubleshooting suggestion
	private shellIntegrationWarningTracker: ShellIntegrationWarningTracker = {
		timestamps: [],
		lastSuggestionShown: undefined,
	}

	constructor(config: CommandExecutorConfig, callbacks: CommandExecutorCallbacks) {
		this.cwd = config.cwd
		this.terminalManager = config.terminalManager
		this.callbacks = callbacks
	}

	/**
	 * Execute a command in the terminal.
	 *
	 * @param command The command to execute
	 * @param timeoutSeconds Optional timeout in seconds
	 * @returns [userRejected, result] tuple
	 */
	async execute(
		command: string,
		timeoutSeconds: number | undefined,
		options?: CommandExecutionOptions,
	): Promise<[boolean, DietCodeToolResponseContent]> {
		// Strip leading `cd` to workspace from command
		const workspaceCdPrefix = `cd ${this.cwd} && `
		if (command.startsWith(workspaceCdPrefix)) {
			command = command.substring(workspaceCdPrefix.length)
		}

		const manager = this.terminalManager
		Logger.info(`Executing command in VS Code terminal: ${command}`)

		// Only terminal acquisition/start is serialized. Once runCommand marks its
		// terminal busy, independent commands can execute concurrently in other terminals.
		const previousLaunch = this.launchQueue
		let releaseLaunch!: () => void
		this.launchQueue = new Promise<void>((resolve) => {
			releaseLaunch = resolve
		})
		let process: TerminalProcessResultPromise
		await previousLaunch
		try {
			options?.signal?.throwIfAborted()
			const terminalInfo = await manager.getOrCreateTerminal(this.cwd)
			options?.signal?.throwIfAborted()
			if (!options?.suppressUserInteraction) terminalInfo.terminal.show()
			process = manager.runCommand(terminalInfo, command)
		} finally {
			releaseLaunch()
		}

		const state = {
			command,
			detached: false,
			cancelled: false,
			cancel: () => {
				if (state.cancelled || !this.activeProcesses.has(process)) return
				state.cancelled = true
				if (process.terminate) {
					Promise.resolve()
						.then(() => process.terminate!())
						.catch((error) => Logger.warn("Command termination failed:", error))
				}
			},
		}
		this.activeProcesses.set(process, state)
		const clearProcess = () => {
			this.activeProcesses.delete(process)
			options?.signal?.removeEventListener("abort", state.cancel)
			process.removeListener("completed", clearProcess)
			process.removeListener("error", clearProcess)
			try {
				this.callbacks.updateBackgroundCommandState(this.activeProcesses.size > 0)
			} catch (error) {
				Logger.warn("Command status display unavailable; process ownership released:", error)
			}
		}
		process.once("completed", clearProcess)
		process.once("error", clearProcess)
		void process.catch(clearProcess)
		options?.signal?.addEventListener("abort", state.cancel, { once: true })
		if (options?.signal?.aborted) state.cancel()

		// Use shared orchestration logic.
		const result = await orchestrateCommandExecution(
			process,
			manager,
			{
				...this.callbacks,
				updateBackgroundCommandState: () => this.callbacks.updateBackgroundCommandState(this.activeProcesses.size > 0),
			},
			{
				command,
				timeoutSeconds,
				suppressUserInteraction: options?.suppressUserInteraction,
				interactive: options?.interactive,
				showShellIntegrationSuggestion: () => this.shouldShowBackgroundTerminalSuggestion(),
				terminalType: "vscode",
			},
		)
		state.detached = !result.completed

		// If the command was cancelled externally (via cancel button), return a clear cancellation message
		// This ensures the AI agent knows the command was cancelled by the user
		if (state.cancelled) {
			const outputSoFar =
				result.outputLines.length > 0
					? `\nOutput captured before cancellation:\n${manager.processOutput(result.outputLines)}`
					: ""
			return [true, `Command execution was cancelled.${outputSoFar}`]
		}

		return [result.userRejected, result.result]
	}

	/**
	 * Cancel the current foreground command if it is actively running.
	 *
	 * @returns true if any commands were cancelled, false otherwise
	 */
	async cancelBackgroundCommand(): Promise<boolean> {
		let cancelled = false

		for (const [process, state] of this.activeProcesses) {
			if (process.terminate && !state.cancelled) {
				state.cancel()
				cancelled = true
			}
		}

		// Update UI state and notify user by modifying existing message
		// We modify the previous command_output message instead of sending a new say()
		// to avoid interfering with any pending ask() dialogs (which would cause
		// "Current ask promise was ignored" errors)
		if (cancelled) {
			try {
				this.callbacks.updateBackgroundCommandState(this.activeProcesses.size > 0)

				// Find the last command_output message and update it
				const messages = this.callbacks.getDietCodeMessages()
				const lastCommandOutputIndex = findLastIndex(messages, (m) => m.ask === "command_output")
				if (lastCommandOutputIndex !== -1) {
					const existingText = messages[lastCommandOutputIndex].text || ""
					const cancellationNotice = "\n\nCommand(s) cancelled by user."
					await this.callbacks.updateDietCodeMessage(lastCommandOutputIndex, {
						text: existingText + cancellationNotice,
					})
				}
			} catch (error) {
				Logger.warn("Cancellation display unavailable; cancellation requests retained:", error)
			}
		}

		return cancelled
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
			? `Commands still running in existing terminals (do not relaunch):\n${running.map((state) => `- ${state.command}`).join("\n")}`
			: undefined
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
