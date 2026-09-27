import type { CommandExecutionState } from "@shared/ExtensionMessage"
import { type CommandRecoveryRecord, ExecutionRecoveryStore, restoredCommand } from "@/core/task/ExecutionRecovery"
import { Logger } from "@/shared/services/Logger"
import type { CommandExecutionSnapshot, ITerminal, TerminalProcessResultPromise } from "./types"

export interface OwnedCommand {
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

interface RuntimeObserver {
	commandChanged: (messageTs: number | null | undefined, state: CommandExecutionState, output?: string) => unknown
	activityChanged: (running: boolean) => unknown
}

/** Process ownership outlives the task view. Reattaching replaces presentation, never the process. */
export class CommandRuntime {
	recovery?: ExecutionRecoveryStore
	readonly activeProcesses = new Map<TerminalProcessResultPromise, OwnedCommand>()
	readonly receipts = new Map<string, { snapshot: CommandExecutionSnapshot; messageTs?: number | null }>()
	readonly backgroundCompletions: string[] = []
	launchQueue: Promise<void> = Promise.resolve()
	pendingLaunches = 0
	private view?: { observer: RuntimeObserver; controller: AbortController }

	constructor(
		readonly taskId: string,
		readonly ulid: string,
		private readonly onIdle: () => void = () => {},
	) {}

	enableRecovery(directory: string, cwd: string): ExecutionRecoveryStore {
		if (this.recovery) return this.recovery
		const store = new ExecutionRecoveryStore(directory, { taskId: this.taskId, ulid: this.ulid, cwd })
		this.recovery = store
		for (const { record, observedAt } of store.entries("command")) {
			const snapshot = restoredCommand(record, observedAt)
			this.receipts.set(snapshot.execution_id, { snapshot, messageTs: record.messageTs })
		}
		return store
	}

	persist(
		snapshot: CommandExecutionSnapshot,
		messageTs?: number | null,
		transport?: CommandRecoveryRecord["transport"],
		required = false,
	): void {
		if (!this.recovery || snapshot.recovery) return
		const record: CommandRecoveryRecord = {
			kind: "command",
			snapshot,
			messageTs,
			transport: transport ?? this.recovery.get("command", snapshot.execution_id)?.transport ?? { kind: "unknown" },
		}
		if (required) this.recovery.put(snapshot.execution_id, record)
		else this.recovery.observe(snapshot.execution_id, record)
	}

	attach(observer: RuntimeObserver): { signal: AbortSignal; detach: () => void } {
		const previous = this.view
		const view = { observer, controller: new AbortController() }
		this.view = view
		// Fence queued launches and controls from the old view. Already dispatched
		// commands keep their own cancellation signal and completion observers.
		previous?.controller.abort(new Error("The task view was replaced. Inspect the existing execution from the current task."))
		return {
			signal: view.controller.signal,
			detach: () => {
				if (this.view === view) this.view = undefined
				view.controller.abort(new Error("The task view was closed. Reopen the task to inspect its executions."))
				this.onIdle()
			},
		}
	}

	get retainedWork(): boolean {
		return !!this.view || this.pendingLaunches > 0 || this.activeProcesses.size > 0
	}

	publish(messageTs: number | null | undefined, state: CommandExecutionState, output?: string): void {
		this.observe(() => this.view?.observer.commandChanged(messageTs, structuredClone(state), output))
	}

	activityChanged(): void {
		this.observe(() => this.view?.observer.activityChanged(this.activeProcesses.size > 0))
		this.onIdle()
	}

	private observe(action: () => unknown): void {
		try {
			void Promise.resolve(action()).catch((error) => Logger.warn("Command runtime display unavailable:", error))
		} catch (error) {
			Logger.warn("Command runtime display unavailable:", error)
		}
	}
}

/** Bounded idle history; active processes and attached views are never evicted. */
export class CommandRuntimeRegistry {
	private readonly runtimes = new Map<string, CommandRuntime>()

	constructor(private readonly maxIdle = 4) {
		if (!Number.isInteger(maxIdle) || maxIdle < 0) throw new Error("Invalid command runtime retention limit")
	}

	get(taskId: string, ulid: string): CommandRuntime {
		const key = JSON.stringify([taskId, ulid])
		const runtime = this.runtimes.get(key) ?? new CommandRuntime(taskId, ulid, () => this.prune())
		this.runtimes.delete(key)
		this.runtimes.set(key, runtime)
		this.prune(key)
		return runtime
	}

	private prune(reserved?: string): void {
		const idle = [...this.runtimes].filter(([key, runtime]) => key !== reserved && !runtime.retainedWork)
		for (const [key] of idle.slice(0, Math.max(0, idle.length - this.maxIdle))) this.runtimes.delete(key)
	}
}

export const commandRuntimes = new CommandRuntimeRegistry()
