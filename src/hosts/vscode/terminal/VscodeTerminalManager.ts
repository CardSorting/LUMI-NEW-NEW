import { arePathsEqual } from "@utils/path"
import { getShellForProfile } from "@utils/shell"
import pWaitFor from "p-wait-for"
import * as vscode from "vscode"
import {
	TerminalInfo as ITerminalInfo,
	ITerminalManager,
	TerminalProcessResultPromise as ITerminalProcessResultPromise,
} from "@/integrations/terminal/types"
import { Logger } from "@/shared/services/Logger"
import { mergePromise, VscodeTerminalProcess } from "./VscodeTerminalProcess"
import { TerminalInfo, TerminalRegistry } from "./VscodeTerminalRegistry"

/*
TerminalManager:
- Creates/reuses terminals
- Runs commands via runCommand(), returning a TerminalProcess
- Handles shell integration events

TerminalProcess extends EventEmitter and implements Promise:
- Emits 'line' events with output while promise is pending
- process.continue() resolves promise and stops event emission
- Allows real-time output handling or background execution

getUnretrievedOutput() fetches latest output for ongoing commands

Enables flexible command execution:
- Await for completion
- Listen to real-time events
- Continue execution in background
- Retrieve missed output later

Notes:
- it turns out some shellIntegration APIs are available on cursor, although not on older versions of vscode
- "By default, the shell integration script should automatically activate on supported shells launched from VS Code."
Supported shells:
Linux/macOS: bash, fish, pwsh, zsh
Windows: pwsh


Example:

const terminalManager = new TerminalManager(context);

// Run a command
const process = terminalManager.runCommand('npm install', '/path/to/project');

process.on('line', (line) => {
	Logger.log(line);
});

// To wait for the process to complete naturally:
await process;

// Or to continue execution even if the command is still running:
process.continue();

// Later, if you need to get the unretrieved output:
const unretrievedOutput = terminalManager.getUnretrievedOutput(terminalId);
Logger.log('Unretrieved output:', unretrievedOutput);

Resources:
- https://github.com/microsoft/vscode/issues/226655
- https://code.visualstudio.com/updates/v1_93#_terminal-shell-integration-api
- https://code.visualstudio.com/docs/terminal/shell-integration
- https://code.visualstudio.com/api/references/vscode-api#Terminal
- https://github.com/microsoft/vscode-extension-samples/blob/main/terminal-sample/src/extension.ts
- https://github.com/microsoft/vscode-extension-samples/blob/main/shell-integration-sample/src/extension.ts
*/

/*
The new shellIntegration API gives us access to terminal command execution output handling.
However, we don't update our VSCode type definitions or engine requirements to maintain compatibility
with older VSCode versions. Users on older versions will automatically fall back to using sendText
for terminal command execution.
Interestingly, some environments like Cursor enable these APIs even without the latest VSCode engine.
This approach allows us to leverage advanced features when available while ensuring broad compatibility.
*/
declare module "vscode" {
	// https://github.com/microsoft/vscode/blob/f0417069c62e20f3667506f4b7e53ca0004b4e3e/src/vscode-dts/vscode.d.ts#L7442
	interface Terminal {
		shellIntegration?: {
			cwd?: vscode.Uri
			executeCommand?: (command: string) => {
				read: () => AsyncIterable<string>
			}
		}
	}
	// https://github.com/microsoft/vscode/blob/f0417069c62e20f3667506f4b7e53ca0004b4e3e/src/vscode-dts/vscode.d.ts#L10794
	interface Window {
		onDidStartTerminalShellExecution?: (
			listener: (e: any) => any,
			thisArgs?: any,
			disposables?: vscode.Disposable[],
		) => vscode.Disposable
	}
}

export class VscodeTerminalManager implements ITerminalManager {
	private terminalIds: Set<number> = new Set()
	private processes: Map<number, VscodeTerminalProcess> = new Map()
	private disposables: vscode.Disposable[] = []
	private shellIntegrationTimeout = 4000
	private terminalReuseEnabled = true
	private terminalOutputLineLimit = 500
	private defaultTerminalProfile = "default"

	runCommand(terminalInfo: ITerminalInfo, command: string): ITerminalProcessResultPromise {
		// Cast to VSCode-specific TerminalInfo for internal use
		// Using unknown as intermediate cast due to structural differences between ITerminal and vscode.Terminal
		const vscodeTerminalInfo = terminalInfo as unknown as TerminalInfo
		if (vscodeTerminalInfo.busy || vscodeTerminalInfo.terminal.exitStatus !== undefined) {
			throw new Error(
				"Command did not start: the selected terminal is busy or closed. Inspect the existing terminal before retrying.",
			)
		}
		Logger.log(`[TerminalManager] Running command on terminal ${vscodeTerminalInfo.id}: "${command}"`)
		Logger.log(`[TerminalManager] Terminal ${vscodeTerminalInfo.id} busy state before: ${vscodeTerminalInfo.busy}`)

		vscodeTerminalInfo.busy = true
		vscodeTerminalInfo.lastCommand = command
		const process = new VscodeTerminalProcess(vscodeTerminalInfo.terminal)
		this.processes.set(vscodeTerminalInfo.id, process)

		process.once("completed", (details) => {
			vscodeTerminalInfo.busy = false
			if (details?.terminalClosed) {
				TerminalRegistry.removeTerminal(vscodeTerminalInfo.id)
				this.terminalIds.delete(vscodeTerminalInfo.id)
				this.processes.delete(vscodeTerminalInfo.id)
			}
		})
		process.once("error", () => {
			// Only a failure before dispatch emits error. The terminal can be reused.
			vscodeTerminalInfo.busy = false
		})
		process.once("no_shell_integration", () => {
			// Keep unknown/running commands owned and visible; never reuse their terminal.
			vscodeTerminalInfo.busy = true
		})

		const promise = new Promise<void>((resolve, reject) => {
			process.once("continue", () => {
				resolve()
			})
			process.once("error", (error) => {
				Logger.error(`Error in terminal ${vscodeTerminalInfo.id}:`, error)
				reject(error)
			})
		})

		const start = () => {
			if (!process.waitForShellIntegration) return
			process.waitForShellIntegration = false
			void process.run(vscodeTerminalInfo.terminal, command).catch((error) => {
				process.emit("error", error instanceof Error ? error : new Error(String(error)))
			})
		}
		// Defer dispatch until the caller has attached output and completion listeners.
		if (vscodeTerminalInfo.terminal.shellIntegration) {
			queueMicrotask(start)
		} else {
			void pWaitFor(() => !process.waitForShellIntegration || vscodeTerminalInfo.terminal.shellIntegration !== undefined, {
				timeout: this.shellIntegrationTimeout,
			})
				.catch(() => {})
				.then(start)
		}

		return mergePromise(process, promise)
	}

	async getOrCreateTerminal(cwd: string): Promise<ITerminalInfo> {
		const terminals = TerminalRegistry.getAllTerminals()
		const expectedShellPath =
			this.defaultTerminalProfile !== "default" ? getShellForProfile(this.defaultTerminalProfile) : undefined

		// Find available terminal from our pool first (created for this task)
		Logger.log(`[TerminalManager] Looking for terminal in cwd: ${cwd}`)
		Logger.log(`[TerminalManager] Available terminals: ${terminals.length}`)

		const matchingTerminal = this.terminalReuseEnabled
			? terminals.find((t) => {
					if (t.busy) {
						Logger.log(`[TerminalManager] Terminal ${t.id} is busy, skipping`)
						return false
					}
					// Check if shell path matches current configuration
					if (t.shellPath !== expectedShellPath) {
						return false
					}
					const terminalCwd = t.terminal.shellIntegration?.cwd // one of dietcode's commands could have changed the cwd of the terminal
					if (!terminalCwd) {
						Logger.log(`[TerminalManager] Terminal ${t.id} has no cwd, skipping`)
						return false
					}
					const matches = arePathsEqual(vscode.Uri.file(cwd).fsPath, terminalCwd.fsPath)
					Logger.log(`[TerminalManager] Terminal ${t.id} cwd: ${terminalCwd.fsPath}, matches: ${matches}`)
					return matches
				})
			: undefined
		if (matchingTerminal) {
			Logger.log(`[TerminalManager] Found matching terminal ${matchingTerminal.id} in correct cwd`)
			this.terminalIds.add(matchingTerminal.id)
			// Cast to ITerminalInfo for interface compatibility
			return matchingTerminal as unknown as ITerminalInfo
		}

		// Create directly in the requested directory. Hidden cd commands can hang or
		// leave the next command running in the wrong workspace.
		const newTerminalInfo = TerminalRegistry.createTerminal(cwd, expectedShellPath)
		this.terminalIds.add(newTerminalInfo.id)
		// Cast to ITerminalInfo for interface compatibility
		return newTerminalInfo as unknown as ITerminalInfo
	}

	getTerminals(busy: boolean): { id: number; lastCommand: string }[] {
		return Array.from(this.terminalIds)
			.map((id) => TerminalRegistry.getTerminal(id))
			.filter((t): t is TerminalInfo => t !== undefined && t.busy === busy)
			.map((t) => ({ id: t.id, lastCommand: t.lastCommand }))
	}

	getUnretrievedOutput(terminalId: number): string {
		if (!this.terminalIds.has(terminalId)) {
			return ""
		}
		const process = this.processes.get(terminalId)
		return process ? process.getUnretrievedOutput() : ""
	}

	isProcessHot(terminalId: number): boolean {
		const process = this.processes.get(terminalId)
		return process ? process.isHot : false
	}

	async disposeAll() {
		// for (const info of this.terminals) {
		// 	//info.terminal.dispose() // dont want to dispose terminals when task is aborted
		// }
		this.terminalIds.clear()
		this.processes.clear()
		this.disposables.forEach((disposable) => disposable.dispose())
		this.disposables = []
	}

	setShellIntegrationTimeout(timeout: number): void {
		this.shellIntegrationTimeout = Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 30_000) : 4_000
	}

	setTerminalReuseEnabled(enabled: boolean): void {
		this.terminalReuseEnabled = enabled
	}

	setTerminalOutputLineLimit(limit: number): void {
		this.terminalOutputLineLimit = limit
	}

	public processOutput(outputLines: string[], overrideLimit?: number): string {
		const limit = overrideLimit !== undefined ? overrideLimit : this.terminalOutputLineLimit
		if (outputLines.length > limit) {
			const halfLimit = Math.floor(limit / 2)
			const start = outputLines.slice(0, halfLimit)
			const end = outputLines.slice(outputLines.length - halfLimit)
			return `${start.join("\n")}\n... (output truncated) ...\n${end.join("\n")}`.trim()
		}
		return outputLines.join("\n").trim()
	}

	setDefaultTerminalProfile(profileId: string): { closedCount: number; busyTerminals: TerminalInfo[] } {
		// Only handle terminal change if profile actually changed
		if (this.defaultTerminalProfile === profileId) {
			return { closedCount: 0, busyTerminals: [] }
		}

		const _oldProfileId = this.defaultTerminalProfile
		this.defaultTerminalProfile = profileId

		// Get the shell path for the new profile
		const newShellPath = profileId !== "default" ? getShellForProfile(profileId) : undefined

		// Handle terminal management for the profile change
		const result = this.handleTerminalProfileChange(newShellPath)

		// Update lastActive for any remaining terminals
		const allTerminals = TerminalRegistry.getAllTerminals()
		allTerminals.forEach((terminal) => {
			if (terminal.shellPath !== newShellPath) {
				TerminalRegistry.updateTerminal(terminal.id, { lastActive: Date.now() })
			}
		})

		return result
	}

	/**
	 * Filters terminals based on a provided criteria function
	 * @param filterFn Function that accepts TerminalInfo and returns boolean
	 * @returns Array of terminals that match the criteria
	 */
	filterTerminals(filterFn: (terminal: TerminalInfo) => boolean): TerminalInfo[] {
		const terminals = TerminalRegistry.getAllTerminals()
		return terminals.filter(filterFn)
	}

	/**
	 * Closes terminals that match the provided criteria
	 * @param filterFn Function that accepts TerminalInfo and returns boolean for terminals to close
	 * @param force If true, closes even busy terminals (with warning)
	 * @returns Number of terminals closed
	 */
	closeTerminals(filterFn: (terminal: TerminalInfo) => boolean, force = false): number {
		const terminalsToClose = this.filterTerminals(filterFn)
		let closedCount = 0

		for (const terminalInfo of terminalsToClose) {
			// Skip busy terminals unless force is true
			if (terminalInfo.busy && !force) {
				continue
			}

			// Remove from our tracking
			if (this.terminalIds.has(terminalInfo.id)) {
				this.terminalIds.delete(terminalInfo.id)
			}
			this.processes.delete(terminalInfo.id)

			// Dispose the actual terminal
			terminalInfo.terminal.dispose()

			// Remove from registry
			TerminalRegistry.removeTerminal(terminalInfo.id)

			closedCount++
		}

		return closedCount
	}

	/**
	 * Handles terminal management when the terminal profile changes
	 * @param newShellPath New shell path to use
	 * @returns Object with information about closed terminals and remaining busy terminals
	 */
	handleTerminalProfileChange(newShellPath: string | undefined): {
		closedCount: number
		busyTerminals: TerminalInfo[]
	} {
		// Close non-busy terminals with different shell path
		const closedCount = this.closeTerminals((terminal) => !terminal.busy && terminal.shellPath !== newShellPath, false)

		// Get remaining busy terminals with different shell path
		const busyTerminals = this.filterTerminals((terminal) => terminal.busy && terminal.shellPath !== newShellPath)

		return {
			closedCount,
			busyTerminals,
		}
	}

	/**
	 * Forces closure of all terminals (including busy ones)
	 * @returns Number of terminals closed
	 */
	closeAllTerminals(): number {
		return this.closeTerminals(() => true, true)
	}
}
