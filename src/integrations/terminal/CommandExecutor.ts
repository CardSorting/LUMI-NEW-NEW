/**
 * CommandExecutor - VS Code extension command execution.
 *
 * This class uses the host-provided VS Code terminal manager plus the shared
 * CommandOrchestrator for buffering, user interaction, and result formatting.
 */

import { randomUUID } from "node:crypto"
import { findLastIndex } from "@shared/array"
import { type CommandExecutionState, type DietCodeMessage, isActiveCommandExecution } from "@shared/ExtensionMessage"
import pTimeout from "p-timeout"
import { restoredCommand } from "@/core/task/ExecutionRecovery"
import { Logger } from "@/shared/services/Logger"
import { orchestrateCommandExecution } from "./CommandOrchestrator"
import { CommandRuntime, type OwnedCommand } from "./CommandRuntime"
import { commandOutcome } from "./commandOutcome"
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
	ITerminalManager,
	ShellIntegrationWarningTracker,
	TerminalCompletionDetails,
	TerminalInfo,
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
	private readonly taskId: string

	private readonly attachment: ReturnType<CommandRuntime["attach"]>

	// Track shell integration warnings to determine when to show the stronger troubleshooting suggestion
	private shellIntegrationWarningTracker: ShellIntegrationWarningTracker = {
		timestamps: [],
		lastSuggestionShown: undefined,
	}

	constructor(
		config: CommandExecutorConfig,
		callbacks: CommandExecutorCallbacks,
		private readonly runtime = new CommandRuntime(config.taskId, config.ulid),
	) {
		if (runtime.taskId !== config.taskId || runtime.ulid !== config.ulid)
			throw new Error("Command runtime belongs to a different task")
		this.cwd = config.cwd
		this.taskId = config.taskId
		this.terminalManager = config.terminalManager
		this.callbacks = callbacks
		this.attachment = runtime.attach({
			commandChanged: (ts, state, output) => this.updateCommandMessage(ts, state, output),
			activityChanged: (running) => this.callbacks.updateBackgroundCommandState(running),
		})
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
		this.attachment.signal.throwIfAborted()
		const launchSignal = options?.signal ? AbortSignal.any([this.attachment.signal, options.signal]) : this.attachment.signal
		const cwd = options?.cwd ?? this.cwd
		const executionId = options?.actionId ?? randomUUID()
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
			if (commandMessageTs == null || this.attachment.signal.aborted) return
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
		this.runtime.pendingLaunches++
		const previousLaunch = this.runtime.launchQueue
		let releaseLaunch!: () => void
		const launchSlot = new Promise<void>((resolve) => {
			releaseLaunch = resolve
		})
		// A cancelled waiter must not let later launches jump an occupied slot.
		this.runtime.launchQueue = previousLaunch.then(() => launchSlot)
		let process: TerminalProcessResultPromise
		let terminalId: number
		let terminalInfo: TerminalInfo
		try {
			await pTimeout(previousLaunch, {
				milliseconds: TERMINAL_START_TIMEOUT_MS,
				signal: launchSignal,
				message: "Command did not start: terminal launch queue timed out. Inspect existing commands before retrying.",
			})
			launchSignal.throwIfAborted()
			if (options?.actionId) {
				const existing = this.getExecutionSnapshot(options.actionId)
				if (existing) {
					if (existing.command !== command || existing.cwd !== cwd)
						throw new Error(
							"Execution ID already belongs to a different command or working directory. Nothing was started.",
						)
					this.runtime.publish(commandMessageTs, this.snapshotState(existing), existing.output)
					return [
						false,
						`Existing execution ${existing.execution_id}: ${existing.status}. No duplicate was started.\n${this.readInstruction(existing.execution_id)}\n${existing.output}`,
						{ ...this.snapshotState(existing), output: existing.output },
					]
				}
			}
			const unresolved = [...this.runtime.receipts.values()].find(
				({ snapshot }) =>
					snapshot.recovery &&
					snapshot.status === "unknown" &&
					(snapshot.cwd === cwd || snapshot.cwd === "") &&
					snapshot.command.trim() === command.trim(),
			)
			if (unresolved) {
				const saved = unresolved.snapshot
				return [
					false,
					`Execution ${saved.execution_id} has unresolved pre-restart effects. No duplicate was started. ${this.readInstruction(saved.execution_id)}`,
					{ ...this.snapshotState(saved), output: saved.output },
				]
			}
			this.runtime.recovery?.assertCanExecute(options?.owner)
			const duplicate = [...this.runtime.activeProcesses.entries()].find(
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
			if (this.runtime.activeProcesses.size >= MAX_ACTIVE_COMMANDS) {
				throw new Error(
					`Command did not start: ${MAX_ACTIVE_COMMANDS} commands are already active. Inspect or stop existing terminals before launching more work.`,
				)
			}
			// Reserve durable identity before any host dispatch. Recovery never interprets
			// this write-ahead record as evidence that a process actually started.
			this.runtime.persist(
				{
					execution_id: executionId,
					action_id: options?.actionId,
					owner: options?.owner ?? "parent",
					command,
					cwd,
					status: "unknown",
					output: "",
					detail: "Dispatch reserved; process start not yet confirmed.",
				},
				commandMessageTs,
				undefined,
				true,
			)
			terminalInfo = await pTimeout(manager.getOrCreateTerminal(cwd), {
				milliseconds: TERMINAL_START_TIMEOUT_MS,
				signal: launchSignal,
				message: "Command did not start: terminal creation timed out. Inspect terminal availability before retrying.",
			})
			launchSignal.throwIfAborted()
			if (!options?.suppressUserInteraction) {
				try {
					terminalInfo.terminal.show()
				} catch (error) {
					Logger.warn("Terminal display unavailable; executing the approved command:", error)
				}
			}
			launchSignal.throwIfAborted()
			this.runtime.recovery?.assertCanExecute(options?.owner)
			process = manager.runCommand(terminalInfo, command)
			terminalId = terminalInfo.id
		} catch (error) {
			const reserved = this.runtime.recovery?.get("command", executionId)
			if (reserved && !this.runtime.receipts.has(executionId))
				this.runtime.persist(
					{
						...reserved.snapshot,
						status: "not_started",
						detail: error instanceof Error ? error.message : String(error),
					},
					commandMessageTs,
				)
			showNotStarted(error instanceof Error ? error.message : String(error))
			throw error
		} finally {
			releaseLaunch()
			this.runtime.pendingLaunches--
			queueMicrotask(() => this.runtime.activityChanged())
		}

		const stopController = new AbortController()
		const publish = (next: CommandExecutionState) => {
			// The owner finalizes once. A late orchestration notification cannot
			// overwrite that receipt or publish a second terminal outcome.
			if (!this.runtime.activeProcesses.has(process)) return
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
			let transport: ReturnType<NonNullable<ITerminalManager["getRecoveryMetadata"]>> | undefined
			try {
				transport = manager.getRecoveryMetadata?.(terminalId) ?? {
					kind: "unknown",
					terminalName: terminalInfo.terminal.name,
					shell: terminalInfo.shellPath,
				}
			} catch {
				/* Metadata cannot change the process result. */
			}
			this.runtime.persist(this.snapshot(process, state), state.messageTs, transport)
			try {
				void Promise.resolve(options?.onStateChange?.({ ...commandExecution })).catch((error) =>
					Logger.warn("Command lifecycle observer failed; execution retained:", error),
				)
			} catch (error) {
				Logger.warn("Command lifecycle observer failed; execution retained:", error)
			}
			this.runtime.publish(state.messageTs, commandExecution)
		}
		const state: OwnedCommand = {
			command,
			cwd,
			executionId,
			actionId: options?.actionId,
			owner: options?.owner ?? "parent",
			terminalId,
			get terminal() {
				return terminalInfo.terminal
			},
			detached: false,
			cancelled: false,
			latest: { status: "running" },
			messageTs: options?.suppressUserInteraction ? undefined : commandMessageTs,
			waiters: new Set(),
			cancel: () => {
				if (state.cancelled || !this.runtime.activeProcesses.has(process)) return
				state.cancelled = true
				state.stopError = undefined
				publish({ status: "stopping" })
				stopController.abort(new Error("Command stop requested"))
				void Promise.resolve()
					.then(() => {
						if (!this.runtime.activeProcesses.has(process)) return
						if (!process.terminate) throw new Error("This terminal does not support stopping commands.")
						return process.terminate()
					})
					.catch((error) => {
						Logger.warn("Command termination failed:", error)
						if (!this.runtime.activeProcesses.has(process)) return
						state.stopError =
							"The stop request failed. Open the terminal to inspect it, or retry stopping this command."
						publish({ status: "stop_failed" })
					})
			},
		}
		this.runtime.activeProcesses.set(process, state)
		const clearProcess = () => {
			this.runtime.activeProcesses.delete(process)
			options?.signal?.removeEventListener("abort", state.cancel)
			process.removeListener("completed", onCompleted)
			process.removeListener("error", onError)
			this.runtime.activityChanged()
		}
		const finish = (next: CommandExecutionState) => {
			if (!this.runtime.activeProcesses.has(process)) return
			publish(next)
			const snapshot = this.snapshot(process, state)
			this.runtime.persist(snapshot, state.messageTs)
			this.runtime.receipts.set(state.executionId, { snapshot, messageTs: state.messageTs })
			this.displaySnapshot(state.messageTs, snapshot)
			if (this.runtime.receipts.size > MAX_COMMAND_RECEIPTS) {
				const evictable = [...this.runtime.receipts].find(
					([, receipt]) => !(receipt.snapshot.recovery && receipt.snapshot.status === "unknown"),
				)
				if (evictable) this.runtime.receipts.delete(evictable[0])
			}
			clearProcess()
			for (const resolve of state.waiters) resolve()
			state.waiters.clear()
		}
		const onCompleted = (details?: TerminalCompletionDetails) => {
			if (!this.runtime.activeProcesses.has(process)) return
			if (state.detached) {
				const status = details?.cancelled
					? "stopped"
					: typeof details?.exitCode === "number"
						? `exit code ${details.exitCode}`
						: details?.terminalClosed
							? "terminal closed; command exit status unknown"
							: "finished; exit status unknown"
				this.runtime.backgroundCompletions.push(
					`Terminal ${terminalId}: ${command.slice(0, 1000)} — ${status}. Execution ID: ${state.executionId}.`,
				)
				if (this.runtime.backgroundCompletions.length > MAX_ACTIVE_COMMANDS) this.runtime.backgroundCompletions.shift()
			}
			finish(commandOutcome(details))
		}
		const onError = (error: unknown) =>
			finish({ status: "not_started", detail: error instanceof Error ? error.message : String(error) })
		process.once("completed", onCompleted)
		process.once("error", onError)
		let lastPersistedOutput = 0
		process.on("line", () => {
			if (Date.now() - lastPersistedOutput < 250 || !this.runtime.activeProcesses.has(process)) return
			lastPersistedOutput = Date.now()
			this.runtime.persist(this.snapshot(process, state), state.messageTs)
		})
		void process.catch(onError)
		options?.signal?.addEventListener("abort", state.cancel, { once: true })

		// Use shared orchestration logic.
		const pending = orchestrateCommandExecution(
			process,
			manager,
			{
				...this.callbacks,
				say: (...args) => (this.attachment.signal.aborted ? Promise.resolve(undefined) : this.callbacks.say(...args)),
				ask: async (...args) => {
					this.attachment.signal.throwIfAborted()
					const result = await this.callbacks.ask(...args)
					this.attachment.signal.throwIfAborted()
					return result
				},
				addToUserMessageContent: (...args) => {
					if (!this.attachment.signal.aborted) this.callbacks.addToUserMessageContent(...args)
				},
				updateBackgroundCommandState: () => this.runtime.activityChanged(),
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
		const saved = this.runtime.receipts.get(state.executionId)
		if (saved) saved.snapshot = snapshot
		this.runtime.persist(snapshot, state.messageTs)
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
		const active = [...this.runtime.activeProcesses.entries()].find(([, state]) => state.executionId === executionId)
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
			const snapshot = this.runtime.receipts.get(executionId)?.snapshot ?? this.snapshot(process, state)
			this.runtime.persist(snapshot, state.messageTs)
			this.displaySnapshot(state.messageTs, snapshot)
			return structuredClone(snapshot)
		}
		const receipt = this.runtime.receipts.get(executionId)
		const persisted = !receipt ? this.getExecutionSnapshot(executionId) : undefined
		if (persisted) return persisted
		if (!receipt)
			throw new Error(
				"Execution ID is not tracked by this task. It may be expired or from a previous session. Inspect the terminal panel; do not rerun a command just to check its status.",
			)
		this.displaySnapshot(receipt.messageTs, receipt.snapshot)
		return structuredClone(receipt.snapshot)
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
			active: [...this.runtime.activeProcesses].map(([process, state]) => this.summarize(this.snapshot(process, state))),
			recent: [...this.runtime.receipts.values()].slice(-8).map(({ snapshot }) => this.summarize(snapshot)),
		}
	}

	/** Resolve either identity against every retained receipt, not just the recent context window. */
	getExecutionSummary(executionId: string): CommandExecutionSummary | undefined {
		const snapshot = this.getExecutionSnapshot(executionId)
		return snapshot ? this.summarize(snapshot) : undefined
	}

	/** Synchronous observation for history reconciliation. Returned data cannot mutate ownership. */
	getExecutionSnapshot(executionId: string): CommandExecutionSnapshot | undefined {
		const active = [...this.runtime.activeProcesses].find(
			([, state]) => state.executionId === executionId || state.actionId === executionId,
		)
		if (active) return this.snapshot(active[0], active[1])
		const receipt =
			this.runtime.receipts.get(executionId) ??
			[...this.runtime.receipts.values()].find(({ snapshot }) => snapshot.action_id === executionId)
		if (receipt) return structuredClone(receipt.snapshot)
		const persisted = this.runtime.recovery
			?.entries("command")
			.find(({ record }) => record.snapshot.execution_id === executionId || record.snapshot.action_id === executionId)
		return persisted ? restoredCommand(persisted.record, persisted.observedAt) : undefined
	}

	/** Refresh after the reopened task has installed its history, including exits during history loading. */
	restoreCommandHistory(messages: DietCodeMessage[]): void {
		for (const message of messages) {
			const state = message.commandExecution
			if (
				!state?.executionId ||
				(state.taskId && state.taskId !== this.taskId) ||
				this.getExecutionSnapshot(state.executionId)
			)
				continue
			// Older installations persisted chat evidence without a journal. Preserve
			// its handle, but never invent a cwd, process owner or successful exit.
			const saved: CommandExecutionSnapshot = {
				execution_id: state.executionId,
				command: message.text ?? "",
				cwd: "",
				output: message.commandOutput ?? "",
				status: state.status === "completed" && state.exitCode !== 0 ? "unconfirmed" : state.status,
				exit_code: state.exitCode,
				signal: state.signal,
				terminal_closed: state.terminalClosed,
				detail: state.detail,
			}
			const record = {
				kind: "command" as const,
				snapshot: saved,
				messageTs: message.ts,
				transport: { kind: "unknown" as const },
			}
			const snapshot = restoredCommand(record, message.ts)
			this.runtime.receipts.set(state.executionId, { snapshot, messageTs: message.ts })
			this.runtime.recovery?.observe(state.executionId, { ...record, snapshot })
		}
	}

	refreshCommandMessages(): void {
		if (this.attachment.signal.aborted) return
		for (const [process, state] of this.runtime.activeProcesses)
			this.displaySnapshot(state.messageTs, this.snapshot(process, state))
		for (const receipt of this.runtime.receipts.values()) this.displaySnapshot(receipt.messageTs, receipt.snapshot)
		this.runtime.activityChanged()
	}

	/** Release the task view and fence its queued launches; live process observers keep running. */
	detach(): void {
		this.attachment.detach()
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
			recovery: snapshot.recovery,
		}
	}

	private readInstruction(executionId: string): string {
		return `Use read_command_output with execution_id "${executionId}" to inspect this same run (timeout 0 for an immediate snapshot, up to 30 seconds to wait). Do not launch it again to check progress.`
	}

	private displaySnapshot(messageTs: number | null | undefined, snapshot: CommandExecutionSnapshot): void {
		const output = snapshot.log_notice ? `${snapshot.output}\n${snapshot.log_notice}` : snapshot.output
		this.runtime.publish(messageTs, this.snapshotState(snapshot), output)
	}

	private updateCommandMessage(
		messageTs: number | null | undefined,
		commandExecution: CommandExecutionState,
		commandOutput?: string,
	): void {
		if (messageTs == null || this.attachment.signal.aborted) return
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
		if (this.attachment.signal.aborted) return false
		const owned = this.runtime.activeProcesses.size > 0
		for (const state of this.runtime.activeProcesses.values()) state.cancel()
		// An already requested stop still owns an active command. The caller must
		// not clear its running indicator until the host confirms completion.
		return owned
	}

	/** Explicit user controls target an execution, never a terminal that might be reused. */
	controlCommand(executionId: string, action: "show" | "stop"): void {
		this.attachment.signal.throwIfAborted()
		const state = [...this.runtime.activeProcesses.values()].find((active) => active.executionId === executionId)
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
		return [...this.runtime.activeProcesses.values()].some((state) => state.detached)
	}

	/**
	 * Get a summary of detached background commands for environment details.
	 */
	getBackgroundCommandSummary(): string | undefined {
		const running = [...this.runtime.activeProcesses.values()].filter((state) => state.detached)
		return running.length
			? `Commands still active in existing terminals (use read_command_output; do not relaunch):\n${running.map((state) => `- Terminal ${state.terminalId}, execution_id ${state.executionId}: ${state.command.slice(0, 1000)}${state.stopError ? " (stop failed; inspect terminal before retrying)" : state.cancelled ? " (stop requested; not confirmed)" : ""}`).join("\n")}`
			: undefined
	}

	/** Keep quiet background exits visible to the next model request, even after terminal reuse. */
	takeBackgroundCompletions(): string | undefined {
		return this.attachment.signal.aborted ? undefined : this.runtime.backgroundCompletions.splice(0).join("\n") || undefined
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
