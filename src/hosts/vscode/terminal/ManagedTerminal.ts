import * as vscode from "vscode"
import { SupervisedShell, type SupervisedShellOptions } from "@/integrations/terminal/SupervisedShell"
import { Logger } from "@/shared/services/Logger"

/** Persistent terminal display; each command gets a fresh, supervised shell in the requested cwd. */
export class ManagedTerminal {
	readonly terminal: vscode.Terminal
	private readonly writeEvent = new vscode.EventEmitter<string>()
	private readonly closeEvent = new vscode.EventEmitter<number>()
	private execution?: SupervisedShell
	private opened = false
	private closed = false
	private displayFailed = false
	private pending = ""

	constructor(
		readonly cwd: string,
		readonly shell: string,
	) {
		this.terminal = vscode.window.createTerminal({
			name: "LUMI · supervised shell",
			pty: {
				onDidWrite: this.writeEvent.event,
				onDidClose: this.closeEvent.event,
				open: () => {
					this.opened = true
					if (this.pending) this.display(this.pending)
					this.pending = ""
				},
				close: () => {
					this.closed = true
					void this.execution?.terminate().catch((error) => Logger.warn("Supervised shell stop failed:", error))
					this.writeEvent.dispose()
					this.closeEvent.dispose()
				},
				handleInput: (data: string) => {
					if (data === "\x03")
						void this.execution?.terminate().catch((error) => Logger.warn("Supervised shell stop failed:", error))
					else this.execution?.write(data.replace(/\r/g, "\n"))
				},
			},
		})
	}

	private display(data: string): void {
		if (this.closed || this.displayFailed) return
		const text = data.replace(/\r?\n/g, "\r\n")
		if (this.opened) {
			try {
				this.writeEvent.fire(text)
			} catch (error) {
				this.displayFailed = true
				Logger.warn("Terminal display unavailable; supervised execution and captured output remain active:", error)
			}
		} else this.pending = (this.pending + text).slice(-64_000)
	}

	run(command: string, callbacks: Pick<SupervisedShellOptions, "onData" | "onComplete" | "onError">): SupervisedShell {
		if (this.closed || this.execution) throw new Error("Command did not start: supervised terminal is closed or busy.")
		const execution = new SupervisedShell()
		this.execution = execution
		this.display(`\n${this.cwd}\n$ ${command}\n`)
		execution.start({
			cwd: this.cwd,
			shell: this.shell,
			command,
			onData: (data) => {
				this.display(data)
				callbacks.onData(data)
			},
			onComplete: (details) => {
				this.execution = undefined
				this.display(`\n[${details.cancelled ? "stopped" : `exit ${details.exitCode ?? details.signal ?? "unknown"}`}]\n`)
				callbacks.onComplete({ ...details, terminalClosed: this.closed })
			},
			onError: (error) => {
				this.execution = undefined
				this.display(`\n[not started: ${error.message}]\n`)
				callbacks.onError(error)
			},
		})
		return execution
	}
}
