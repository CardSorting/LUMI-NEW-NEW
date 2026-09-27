import { EventEmitter } from "events"
import * as vscode from "vscode"
import { boundCommandOutput } from "@/integrations/terminal/commandPolicy"
import {
	isCompilingOutput,
	MAX_FULL_OUTPUT_SIZE,
	MAX_UNRETRIEVED_LINES,
	PROCESS_HOT_TIMEOUT_COMPILING,
	PROCESS_HOT_TIMEOUT_NORMAL,
	TRUNCATE_KEEP_LINES,
} from "@/integrations/terminal/constants"
import type { SupervisedShell } from "@/integrations/terminal/SupervisedShell"
import type { ITerminalProcess, TerminalCompletionDetails, TerminalProcessEvents } from "@/integrations/terminal/types"
import { Logger } from "@/shared/services/Logger"
import type { ManagedTerminal } from "./ManagedTerminal"
import { TerminalOutputDecoder } from "./TerminalOutputDecoder"

const MAX_LINE_LENGTH = 16_384
const COMPLETION_DRAIN_MS = 1_000
type ShellExecution = { read: () => AsyncIterable<string> }
type ShellEvents = {
	onDidEndTerminalShellExecution?: (
		listener: (event: { terminal: vscode.Terminal; execution: ShellExecution; exitCode?: number }) => void,
	) => vscode.Disposable
}

/** One command owns its stream, host listeners, and cancellation until actual completion. */
export class VscodeTerminalProcess extends EventEmitter<TerminalProcessEvents> implements ITerminalProcess {
	waitForShellIntegration = true
	isHot = false
	private isListening = true
	private buffer = ""
	private fullOutput = ""
	private lastRetrievedIndex = 0
	private outputTruncated = false
	private historyTruncated = false
	private hotTimer?: NodeJS.Timeout
	private completionTimer?: NodeJS.Timeout
	private completion: TerminalCompletionDetails = {}
	private terminal?: vscode.Terminal
	private managedExecution?: SupervisedShell
	private stopped = false
	private dispatched = false
	private stopRequested = false
	private streamEnded = false
	private hostEnded = false
	private lostTracking = false
	private disposables: vscode.Disposable[] = []
	private readonly failedObservers = new WeakSet<object>()
	private iterator?: AsyncIterator<string>
	private resolveStopped!: () => void
	private resolveTrackingUnavailable!: () => void
	private readonly trackingUnavailable = new Promise<void>((resolve) => {
		this.resolveTrackingUnavailable = resolve
	})
	private readonly stopping = new Promise<void>((resolve) => {
		this.resolveStopped = resolve
	})

	constructor(terminal?: vscode.Terminal) {
		super()
		if (terminal) this.watchTerminal(terminal)
	}

	private watchTerminal(terminal: vscode.Terminal) {
		if (this.terminal === terminal) return
		this.terminal = terminal
		const disposable = vscode.window.onDidCloseTerminal?.((closed) => {
			if (closed === terminal) this.finish({ ...this.completion, terminalClosed: true, cancelled: this.stopRequested })
		})
		if (disposable) this.disposables.push(disposable)
	}

	private clearHotState() {
		clearTimeout(this.hotTimer)
		this.hotTimer = undefined
		this.isHot = false
	}

	/** A failed observer must not prevent the owner or other readers from receiving an event. */
	override emit<K extends keyof TerminalProcessEvents>(event: K, ...args: TerminalProcessEvents[K]): boolean {
		const listeners = this.rawListeners(event)
		for (const listener of listeners) {
			const failed = (error: unknown) => {
				if (this.failedObservers.has(listener)) return
				this.failedObservers.add(listener)
				Logger.warn(`Terminal ${event} observer failed:`, error)
			}
			try {
				const result: unknown = Reflect.apply(listener, this, args)
				if (result && typeof (result as PromiseLike<unknown>).then === "function")
					void Promise.resolve(result).catch(failed)
			} catch (error) {
				failed(error)
			}
		}
		return listeners.length > 0
	}

	private disposeObservers(): void {
		for (const disposable of this.disposables.splice(0)) {
			try {
				disposable.dispose()
			} catch (error) {
				Logger.warn("Terminal observer cleanup failed:", error)
			}
		}
	}

	/** Disposal requests a stop. The host's close event confirms it; never invent a signal. */
	terminate(): void | Promise<void> {
		if (this.stopped || this.stopRequested || (this.hostEnded && typeof this.completion.exitCode === "number")) return
		this.stopRequested = true
		this.waitForShellIntegration = false
		if (!this.dispatched) {
			// No process was started, so cancellation can settle without a host close event.
			this.finish({ cancelled: true })
			return
		}
		if (this.managedExecution) {
			this.continue()
			return this.managedExecution.terminate().catch((error) => {
				this.stopRequested = false
				throw error
			})
		}
		try {
			this.terminal?.dispose()
		} catch (error) {
			this.stopRequested = false
			throw error
		}
		this.clearHotState()
		this.continue()
	}

	private finish(details: TerminalCompletionDetails = this.completion) {
		if (this.stopped) return
		this.stopped = true
		this.waitForShellIntegration = false
		this.completion = details
		this.clearHotState()
		clearTimeout(this.completionTimer)
		this.emitRemainingBufferIfListening()
		this.isListening = false
		this.disposeObservers()
		this.resolveStopped()
		// Iterator cleanup must never prevent completion if the host stream is broken.
		if (this.iterator?.return)
			void Promise.resolve()
				.then(() => this.iterator!.return!())
				.catch((error) => Logger.warn("Terminal stream cleanup failed:", error))
		this.emit("completed", details)
		this.emit("continue")
	}

	async runManaged(terminal: ManagedTerminal, command: string) {
		if (this.stopped || this.stopRequested || this.dispatched) return
		this.disposeObservers()
		this.terminal = terminal.terminal
		const decoder = new TerminalOutputDecoder()
		this.appendOutput(
			"[Supervised shell: each command starts with fresh shell state. Include environment setup and dependent commands in the same invocation.]\n",
		)
		if (this.stopped || this.stopRequested) return
		try {
			this.managedExecution = terminal.run(command, {
				onData: (data) => this.appendOutput(decoder.write(data)),
				onComplete: (details) => this.finish(details),
				onError: (error) => this.failBeforeDispatch(error),
			})
			this.dispatched = true
		} catch (error) {
			this.failBeforeDispatch(error)
		}
	}

	private failBeforeDispatch(error: unknown) {
		if (this.stopped) return
		this.stopped = true
		this.waitForShellIntegration = false
		this.clearHotState()
		this.disposeObservers()
		this.resolveStopped()
		this.emit("error", error instanceof Error ? error : new Error(String(error)))
	}

	async run(terminal: vscode.Terminal, command: string, fallback?: () => ManagedTerminal) {
		if (this.stopped || this.stopRequested || this.dispatched) return
		this.watchTerminal(terminal)
		try {
			if (
				!terminal.shellIntegration?.executeCommand ||
				!(vscode.window as typeof vscode.window & ShellEvents).onDidEndTerminalShellExecution
			) {
				if (!fallback) throw new Error("Command did not start: no observable shell transport is available.")
				// Transport selection is only allowed before dispatch. Never replay an uncertain command.
				this.disposeObservers()
				await this.runManaged(fallback(), command)
				return
			}
			let execution: ShellExecution | undefined
			const earlyEvents: { terminal: vscode.Terminal; execution: ShellExecution; exitCode?: number }[] = []
			const onEnd = (event: { terminal: vscode.Terminal; execution: ShellExecution; exitCode?: number }) => {
				if (
					event.terminal !== terminal ||
					this.stopped ||
					(this.hostEnded && typeof this.completion.exitCode === "number")
				)
					return
				if (!execution) {
					if (earlyEvents.length < 8) earlyEvents.push(event)
					return
				}
				if (event.execution !== execution) return
				this.hostEnded = true
				this.completion = { exitCode: event.exitCode }
				if (event.exitCode === undefined) {
					clearTimeout(this.completionTimer)
					this.trackingLost("The terminal did not report an exit code.")
					return
				}
				if (this.streamEnded) this.finish()
				else {
					clearTimeout(this.completionTimer)
					this.completionTimer = setTimeout(() => this.finish(), COMPLETION_DRAIN_MS)
				}
			}
			const endSubscription = (vscode.window as typeof vscode.window & ShellEvents).onDidEndTerminalShellExecution?.(onEnd)
			if (endSubscription) this.disposables.push(endSubscription)
			execution = terminal.shellIntegration.executeCommand(command)
			this.dispatched = true
			earlyEvents.forEach(onEnd)
			// Subscribe before read() can throw, and read before yielding to avoid missing output.
			this.iterator = execution.read()[Symbol.asyncIterator]()
			const read = async () => {
				const decoder = new TerminalOutputDecoder()
				while (!this.stopped) {
					const next = await this.iterator!.next()
					if (this.stopped) return
					if (next.done) break
					this.appendOutput(decoder.write(next.value))
				}
				this.streamEnded = true
				this.emitRemainingBufferIfListening()
				if (this.hostEnded && typeof this.completion.exitCode === "number") this.finish()
				else if (!this.lostTracking) {
					// EOF is not a host exit. Detach once if confirmation never arrives,
					// retaining ownership and the end listener for late completion.
					await Promise.race([
						this.stopping,
						this.trackingUnavailable,
						new Promise<void>((resolve) => {
							this.completionTimer = setTimeout(() => {
								this.trackingLost("Output ended without command completion confirmation.")
								resolve()
							}, COMPLETION_DRAIN_MS)
						}),
					])
				}
			}
			await Promise.race([read(), this.stopping, this.trackingUnavailable])
		} catch (error) {
			this.clearHotState()
			if (this.stopped) return
			this.streamEnded = true
			if (!this.dispatched) {
				this.failBeforeDispatch(error)
			} else if (this.hostEnded && typeof this.completion.exitCode === "number") {
				this.appendOutput("\nTerminal output capture was interrupted: " + String(error) + "\n")
				this.finish()
			} else
				this.trackingLost(
					"Terminal output tracking failed: " + (error instanceof Error ? error.message : String(error)) + ".",
				)
		}
	}

	private trackingLost(reason: string) {
		if (this.stopped || this.lostTracking) return
		this.lostTracking = true
		this.resolveTrackingUnavailable()
		this.appendOutput("\n" + reason + " The command may still be running. Inspect its existing terminal before retrying.\n")
		this.clearHotState()
		this.emit("no_shell_integration")
		this.continue()
	}

	private appendOutput(data: string) {
		if (!data) return
		this.isHot = true
		clearTimeout(this.hotTimer)
		this.hotTimer = setTimeout(
			() => this.clearHotState(),
			isCompilingOutput(data) ? PROCESS_HOT_TIMEOUT_COMPILING : PROCESS_HOT_TIMEOUT_NORMAL,
		)
		this.fullOutput += data
		if (this.fullOutput.length > MAX_FULL_OUTPUT_SIZE) {
			this.historyTruncated = true
			const dropped = this.fullOutput.length - MAX_FULL_OUTPUT_SIZE
			this.outputTruncated ||= dropped > this.lastRetrievedIndex
			this.fullOutput = this.fullOutput.slice(dropped)
			this.lastRetrievedIndex = Math.max(0, this.lastRetrievedIndex - dropped)
		}
		if (this.isListening) {
			this.emitIfEol(data)
			this.lastRetrievedIndex = Math.max(0, this.fullOutput.length - this.buffer.length)
		}
	}

	private emitIfEol(chunk: string) {
		this.buffer += chunk
		while (this.buffer.length) {
			const end = this.buffer.indexOf("\n")
			if (end !== -1 && end <= MAX_LINE_LENGTH) {
				const line = this.buffer.slice(0, end).replace(/\r$/, "")
				this.buffer = this.buffer.slice(end + 1)
				this.emit("line", line)
			} else if (this.buffer.length > MAX_LINE_LENGTH) {
				// Fragment oversized lines instead of retaining an unbounded no-newline buffer.
				const line = this.buffer.slice(0, MAX_LINE_LENGTH)
				this.buffer = this.buffer.slice(MAX_LINE_LENGTH)
				this.emit("line", line)
			} else break
		}
	}

	private emitRemainingBufferIfListening() {
		if (this.buffer && this.isListening) {
			const remaining = this.buffer
			this.buffer = ""
			this.lastRetrievedIndex = this.fullOutput.length
			this.emit("line", remaining)
		}
	}

	continue() {
		this.emitRemainingBufferIfListening()
		this.isListening = false
		this.removeAllListeners("line")
		this.emit("continue")
	}

	getUnretrievedOutput(): string {
		let output = this.fullOutput.slice(this.lastRetrievedIndex)
		this.lastRetrievedIndex = this.fullOutput.length
		if (this.outputTruncated) output = "[Earlier terminal output was truncated.]\n" + output
		this.outputTruncated = false
		return this.formatOutputSnapshot(output)
	}

	getOutputSnapshot(): string {
		return this.formatOutputSnapshot(
			(this.historyTruncated ? "[Earlier terminal output was truncated.]\n" : "") + this.fullOutput,
		)
	}

	private formatOutputSnapshot(output: string): string {
		const lines = output.split("\n")
		if (lines.length > MAX_UNRETRIEVED_LINES) {
			output = [
				...lines.slice(0, TRUNCATE_KEEP_LINES),
				"\n... (" + (lines.length - 2 * TRUNCATE_KEEP_LINES) + " lines truncated) ...\n",
				...lines.slice(-TRUNCATE_KEEP_LINES),
			].join("\n")
		}
		return boundCommandOutput(output)
	}

	getCompletionDetails(): TerminalCompletionDetails {
		return this.completion
	}
}

export type TerminalProcessResultPromise = VscodeTerminalProcess & Promise<void>

export function mergePromise(process: VscodeTerminalProcess, promise: Promise<void>): TerminalProcessResultPromise {
	for (const property of ["then", "catch", "finally"] as const) {
		Object.defineProperty(process, property, { configurable: true, value: promise[property].bind(promise) })
	}
	return process as TerminalProcessResultPromise
}
