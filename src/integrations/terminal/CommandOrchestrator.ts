/** Capture command output independently of presentation, and release each wait exactly once. */
import { formatResponse } from "@core/prompts/responses"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { TerminalHangStage, TerminalUserInterventionAction, telemetryService } from "@services/telemetry"
import { findLastIndex } from "@shared/array"
import { COMMAND_CANCEL_TOKEN, type CommandExecutionState } from "@shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { CommandOutputCollector } from "./CommandOutputCollector"
import { commandOutcome } from "./commandOutcome"
import { resolveCommandTimeoutSeconds } from "./commandPolicy"
import { BUFFER_STUCK_TIMEOUT_MS, CHUNK_BYTE_SIZE, CHUNK_DEBOUNCE_MS, CHUNK_LINE_COUNT, COMPLETION_TIMEOUT_MS } from "./constants"
import type {
	CommandExecutorCallbacks,
	ITerminalManager,
	OrchestrationOptions,
	OrchestrationResult,
	TerminalCompletionDetails,
	TerminalProcessResultPromise,
} from "./types"

export async function orchestrateCommandExecution(
	process: TerminalProcessResultPromise,
	terminalManager: ITerminalManager,
	callbacks: CommandExecutorCallbacks,
	options: OrchestrationOptions,
): Promise<OrchestrationResult> {
	const { showShellIntegrationSuggestion, terminalType = "vscode", suppressUserInteraction = false } = options
	const timeoutSeconds = resolveCommandTimeoutSeconds(options.command, options.timeoutSeconds)
	const output = new CommandOutputCollector()
	let observing = true
	let completed = false
	let completionDetails: TerminalCompletionDetails | undefined
	let didContinue = false
	let didCancelViaUi = false
	let timedOut = false
	let trackingLost = false
	let userFeedback: { text?: string; images?: string[]; files?: string[] } | undefined
	let outputBuffer: string[] = []
	let outputBufferSize = 0
	let skippedDisplayLines = 0
	let publishing = false
	let chunkTimer: NodeJS.Timeout | undefined
	let bufferStuckTimer: NodeJS.Timeout | undefined
	let completionTimer: NodeJS.Timeout | undefined
	let waitTimer: NodeJS.Timeout | undefined
	let resolveTerminalEvent!: () => void
	let rejectTerminalEvent!: (error: Error) => void
	const terminalEvent = new Promise<void>((resolve, reject) => {
		resolveTerminalEvent = resolve
		rejectTerminalEvent = reject
	})
	let resolveCancellation!: () => void
	const cancellation = new Promise<void>((resolve) => {
		resolveCancellation = resolve
	})

	// EventEmitter ignores returned promises. Every observer handles both sync throws and rejected promises.
	const observe = (label: string, action: () => unknown) => {
		try {
			void Promise.resolve(action()).catch((error) => Logger.warn(`[CommandOrchestrator] ${label}:`, error))
		} catch (error) {
			Logger.warn(`[CommandOrchestrator] ${label}:`, error)
		}
	}
	const say = (...args: Parameters<CommandExecutorCallbacks["say"]>) => {
		if (!suppressUserInteraction) observe("Output display unavailable; execution retained", () => callbacks.say(...args))
	}
	observe("Status display unavailable", () => callbacks.updateBackgroundCommandState(true))
	let commandRow: ReturnType<CommandExecutorCallbacks["getDietCodeMessages"]>[number] | undefined
	if (!suppressUserInteraction && !options.onStateChange)
		observe("Command row unavailable", () => {
			const messages = callbacks.getDietCodeMessages()
			commandRow =
				options.commandMessageTs !== undefined
					? messages.find((message) => message.ts === options.commandMessageTs)
					: messages[findLastIndex(messages, (message) => message.ask === "command" || message.say === "command")]
		})
	let commandStateCleared = false
	const updateCommandState = (state: CommandExecutionState) => {
		if (options.onStateChange) {
			observe("Command state observer unavailable", () => options.onStateChange!(state))
			return
		}
		if (!commandRow) return
		observe("Command row update unavailable", () => {
			const index = callbacks
				.getDietCodeMessages()
				.findIndex((message) => (commandRow!.ts !== undefined ? message.ts === commandRow!.ts : message === commandRow))
			if (index >= 0)
				return callbacks.updateDietCodeMessage(index, {
					commandCompleted: ["completed", "failed", "cancelled", "not_started", "unconfirmed"].includes(state.status),
					commandExecution: state,
				})
			return undefined
		})
	}
	const clearCommandState = () => {
		if (commandStateCleared) return
		commandStateCleared = true
		process.removeListener("completed", onCompleted)
		process.removeListener("error", onError)
		process.removeListener("no_shell_integration", onNoShellIntegration)
		options.signal?.removeEventListener("abort", onCancellation)
		observe("Status display unavailable", () => callbacks.updateBackgroundCommandState(false))
	}
	const onCancellation = () => {
		if (completed || commandStateCleared) return
		didCancelViaUi = true
		updateCommandState({ status: "stopping" })
		resolveCancellation()
		observe("Command wait could not detach", () => process.continue())
	}
	const clearTimers = () => {
		for (const timer of [chunkTimer, bufferStuckTimer, completionTimer, waitTimer]) if (timer) clearTimeout(timer)
		chunkTimer = bufferStuckTimer = completionTimer = waitTimer = undefined
	}
	const takeOutput = () => {
		const prefix = skippedDisplayLines
			? `(${skippedDisplayLines} earlier lines omitted from live display; see captured output or the terminal.)\n`
			: ""
		const chunk = prefix + outputBuffer.join("\n")
		outputBuffer = []
		outputBufferSize = 0
		skippedDisplayLines = 0
		return chunk
	}
	const flushBuffer = () => {
		if (!observing || publishing || !outputBuffer.length) return
		const chunk = takeOutput()
		if (suppressUserInteraction) return
		if (options.interactive === false || didContinue || completed) {
			publishing = true
			observe("Output display unavailable; execution retained", async () => {
				try {
					await callbacks.say("command_output", chunk)
				} finally {
					publishing = false
					if (observing && outputBuffer.length) scheduleFlush()
				}
			})
			return
		}
		publishing = true
		bufferStuckTimer = setTimeout(() => {
			bufferStuckTimer = undefined
			observe("Hang telemetry unavailable", () =>
				telemetryService.captureTerminalHang(TerminalHangStage.BUFFER_STUCK, terminalType),
			)
		}, BUFFER_STUCK_TIMEOUT_MS)
		observe("Command output interaction unavailable", async () => {
			try {
				const interaction = await callbacks.ask("command_output", chunk)
				// A reply to an old output row cannot cancel or resume a finished command.
				if (!observing || completed) return
				const { response, text, images, files } = interaction
				didContinue = true
				if (response === "noButtonClicked" && text === COMMAND_CANCEL_TOKEN) {
					didCancelViaUi = true
					observe("Cancellation telemetry unavailable", () =>
						telemetryService.captureTerminalUserIntervention(TerminalUserInterventionAction.CANCELLED, terminalType),
					)
					say("command_output", "Stop requested. Waiting for terminal confirmation.")
					onCancellation()
					if (options.onCancel) observe("Command stop request failed", options.onCancel)
					else if (process.terminate) observe("Command termination failed", () => process.terminate!())
				} else {
					if (text || images?.length || files?.length) userFeedback = { text, images, files }
					observe("Continue telemetry unavailable", () =>
						telemetryService.captureTerminalUserIntervention(
							TerminalUserInterventionAction.PROCESS_WHILE_RUNNING,
							terminalType,
						),
					)
				}
				process.continue()
			} catch (error) {
				// The command is already authorized and running. A lost display must not
				// open another output prompt or strand the command's foreground wait.
				Logger.warn("[CommandOrchestrator] Output interaction unavailable:", error)
				if (observing && !completed) {
					didContinue = true
					process.continue()
				}
			} finally {
				publishing = false
				if (bufferStuckTimer) clearTimeout(bufferStuckTimer)
				bufferStuckTimer = undefined
				if (observing && outputBuffer.length) scheduleFlush()
			}
		})
	}
	const scheduleFlush = () => {
		if (!chunkTimer)
			chunkTimer = setTimeout(() => {
				chunkTimer = undefined
				flushBuffer()
			}, CHUNK_DEBOUNCE_MS)
	}
	const onLine = (line: string) => {
		if (!observing || didCancelViaUi) return
		output.append(line)
		// Presentation buffers stay bounded even while a manual interaction is pending.
		const display = line.length > CHUNK_BYTE_SIZE ? `${line.slice(0, CHUNK_BYTE_SIZE)} … (see terminal output)` : line
		outputBuffer.push(display)
		outputBufferSize += Buffer.byteLength(display, "utf8")
		if (outputBuffer.length > CHUNK_LINE_COUNT) {
			outputBufferSize -= Buffer.byteLength(outputBuffer.shift()!, "utf8")
			skippedDisplayLines++
		}
		if (outputBuffer.length >= CHUNK_LINE_COUNT || outputBufferSize >= CHUNK_BYTE_SIZE) flushBuffer()
		else scheduleFlush()
	}
	const onCompleted = (details?: TerminalCompletionDetails) => {
		if (commandStateCleared) return
		completed = true
		completionDetails = details
		updateCommandState(commandOutcome(details))
		resolveTerminalEvent()
		clearTimers()
		clearCommandState()
		// Completion is a notification, never a new approval gate.
		if (observing && (outputBuffer.length || publishing)) say("command_output", takeOutput())
	}
	const onError = (error: Error) => {
		if (commandStateCleared) return
		updateCommandState({ status: "not_started", detail: error.message })
		rejectTerminalEvent(error)
		clearTimers()
		clearCommandState()
	}
	const onNoShellIntegration = () => {
		trackingLost = true
		updateCommandState({ status: "unknown" })
		if (!observing) return
		observe("Shell integration warning unavailable", () => {
			const suggest =
				typeof showShellIntegrationSuggestion === "function"
					? showShellIntegrationSuggestion()
					: showShellIntegrationSuggestion
			say(suggest ? "shell_integration_warning_with_suggestion" : "shell_integration_warning")
		})
	}
	process.on("line", onLine)
	process.once("completed", onCompleted)
	process.once("error", onError)
	process.once("no_shell_integration", onNoShellIntegration)
	options.signal?.addEventListener("abort", onCancellation, { once: true })
	updateCommandState({ status: "running" })
	// A process can reject without emitting error; after a detached wait it can emit error after its promise resolved.
	void process.catch(onError)
	completionTimer = setTimeout(() => {
		completionTimer = undefined
		observe("Hang telemetry unavailable", () =>
			telemetryService.captureTerminalHang(TerminalHangStage.WAITING_FOR_COMPLETION, terminalType),
		)
	}, COMPLETION_TIMEOUT_MS)

	try {
		if (options.signal?.aborted) onCancellation()
		const outcome = await Promise.race([
			process,
			terminalEvent,
			cancellation,
			new Promise<"timeout">((resolve) => {
				waitTimer = setTimeout(() => resolve("timeout"), timeoutSeconds * 1000)
			}),
		])
		if (outcome === "timeout" && !completed) {
			timedOut = true
			didContinue = true
			process.continue()
		}
		if (!completed && !commandStateCleared)
			updateCommandState({ status: didCancelViaUi ? "stopping" : trackingLost ? "unknown" : "background" })
	} finally {
		observing = false
		clearTimers()
		process.removeListener("line", onLine)
		if (outputBuffer.length) say("command_output", takeOutput())
		await output.finish()
	}

	const snapshot = output.getSnapshot()
	if (snapshot.logNotice) say("command_output", snapshot.logNotice)
	const result = terminalManager.processOutput(snapshot.lines)
	const logNotice = snapshot.logNotice ? `\n${snapshot.logNotice}` : ""
	const common = {
		outputLines: snapshot.lines,
		logFilePath: snapshot.logFilePath,
		logNotice: snapshot.logNotice,
		exitCode: completionDetails?.exitCode,
		signal: completionDetails?.signal,
	}
	if (didCancelViaUi)
		return {
			...common,
			userRejected: true,
			result: formatResponse.toolResult(
				`${completed ? "Command finished after a stop request." : "Stop requested; command termination has not been confirmed. Inspect the existing terminal before retrying. Do not launch it again."}${result ? `\nOutput captured before cancellation:\n${result}` : ""}${logNotice}`,
			),
			completed,
		}
	if (userFeedback) {
		say("user_feedback", userFeedback.text, userFeedback.images, userFeedback.files)
		let fileContent = ""
		if (userFeedback.files?.length) {
			try {
				fileContent = await processFilesIntoText(userFeedback.files)
			} catch (error) {
				fileContent = `Feedback attachments could not be read: ${String(error)}`
			}
		}
		return {
			...common,
			userRejected: true,
			result: formatResponse.toolResult(
				`Command ${completed ? "has finished" : "is still running in the existing terminal"}.${result ? `\nOutput:\n${result}` : ""}${logNotice}\n\nThe user provided feedback:\n<feedback>\n${userFeedback.text ?? ""}\n</feedback>`,
				userFeedback.images,
				fileContent,
			),
			completed,
		}
	}
	if (completed) {
		const { exitCode, signal } = common
		const status =
			typeof exitCode === "number"
				? exitCode === 0
					? "Command executed successfully (exit code 0)."
					: `Command failed with exit code ${exitCode}.`
				: signal
					? `Command terminated by signal ${signal}.`
					: completionDetails?.terminalClosed
						? "Terminal closed; command exit status was not reported."
						: "Command execution finished; exit status was not reported. Verify the result before rerunning."
		return {
			...common,
			userRejected: false,
			result: `${status}${result ? `\nOutput:\n${result}` : ""}${logNotice}`,
			completed: true,
		}
	}
	return {
		...common,
		userRejected: false,
		result: `Command is still running in the terminal${timedOut ? ` after ${timeoutSeconds} seconds` : " or its completion could not be observed"}. It has not been confirmed finished. Do not launch it again; inspect the existing terminal output or continue independent work.${result ? `\nOutput so far:\n${result}` : ""}${logNotice}`,
		completed: false,
	}
}
