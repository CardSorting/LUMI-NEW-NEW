import { type ChildProcess, spawn } from "node:child_process"
import { basename } from "node:path"
import { Logger } from "@/shared/services/Logger"
import type { TerminalCompletionDetails } from "./types"

export interface SupervisedShellOptions {
	cwd: string
	shell: string
	command: string
	onData: (data: string) => void
	onComplete: (details: TerminalCompletionDetails) => void
	onError: (error: Error) => void
	/** A post-spawn error does not establish that the process exited. */
	onObservationError?: (error: Error) => void
}

/** One dispatch, with OS-owned pipes and exit events, independent of shell integration. */
export class SupervisedShell {
	private child?: ChildProcess
	private started = false
	private ended = false
	private cancelled = false
	private stopPromise?: Promise<void>
	private resolveClosed!: () => void
	private readonly closed = new Promise<void>((resolve) => {
		this.resolveClosed = resolve
	})

	start(options: SupervisedShellOptions): void {
		if (this.started) throw new Error("This shell execution has already been dispatched.")
		this.started = true
		if (this.cancelled) {
			this.ended = true
			this.resolveClosed()
			options.onComplete({ cancelled: true })
			return
		}
		const name = basename(options.shell)
			.toLowerCase()
			.replace(/\.exe$/, "")
		const args =
			name === "pwsh" || name === "powershell"
				? ["-NoLogo", "-NonInteractive", "-Command", options.command]
				: name === "wsl"
					? ["--exec", "/bin/sh", "-c", options.command]
					: ["-c", options.command]
		const observationError = (error: unknown) => {
			try {
				options.onObservationError?.(error instanceof Error ? error : new Error(String(error)))
			} catch (observerError) {
				Logger.warn("Supervised shell observation callback failed:", observerError)
			}
		}
		try {
			const child =
				name === "cmd"
					? spawn(options.command, {
							shell: options.shell,
							cwd: options.cwd,
							env: this.environment(),
							windowsHide: true,
							stdio: "pipe",
						})
					: spawn(options.shell, args, {
							cwd: options.cwd,
							env: this.environment(),
							detached: process.platform !== "win32",
							windowsHide: true,
							stdio: "pipe",
						})
			this.child = child
			let spawned = false
			child.once("spawn", () => {
				spawned = true
			})
			for (const stream of [child.stdout, child.stderr]) {
				stream?.setEncoding("utf8")
				stream?.on("data", (data: string) => {
					try {
						options.onData(data)
					} catch (error) {
						observationError(error)
					}
				})
				stream?.on("error", observationError)
			}
			// Input can race a natural exit. A closed stdin must not crash the extension host.
			child.stdin?.on("error", () => {})
			child.on("error", (error) => {
				if (this.ended) return
				if (spawned) {
					observationError(error)
					return
				}
				this.ended = true
				this.resolveClosed()
				options.onError(error)
			})
			child.once("close", (exitCode, signal) => {
				if (this.ended) return
				this.ended = true
				this.resolveClosed()
				options.onComplete({ exitCode, signal, cancelled: this.cancelled })
			})
		} catch (error) {
			this.ended = true
			this.resolveClosed()
			options.onError(error instanceof Error ? error : new Error(String(error)))
		}
	}

	private environment(): NodeJS.ProcessEnv {
		return { ...process.env, DIETCODE_ACTIVE: "true", CLINE_ACTIVE: "true", TERM: "dumb" }
	}

	write(data: string): void {
		if (!this.ended && this.child?.stdin?.writable) this.child.stdin.write(data)
	}

	/** Stop the entire owned process group; a request is never substituted for an exit event. */
	terminate(): Promise<void> {
		if (this.ended) return Promise.resolve()
		if (this.stopPromise) return this.stopPromise
		this.cancelled = true
		const child = this.child
		if (!child) return Promise.resolve()
		this.stopPromise = (async () => {
			if (!child.pid && !this.ended) {
				await new Promise<void>((resolve) => {
					const ready = () => {
						child.removeListener("spawn", ready)
						resolve()
					}
					child.once("spawn", ready)
					void this.closed.then(ready)
				})
			}
			const pid = child.pid
			if (!pid || this.ended) return
			if (process.platform === "win32") {
				await new Promise<void>((resolve, reject) => {
					const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
					killer.once("error", reject)
					killer.once("close", (code) =>
						code === 0 || this.ended ? resolve() : reject(new Error(`Process-tree stop failed (${code}).`)),
					)
				})
				return
			}
			const signal = (value: NodeJS.Signals) => {
				try {
					process.kill(-pid, value)
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
				}
			}
			signal("SIGTERM")
			let timer: NodeJS.Timeout | undefined
			try {
				await Promise.race([
					this.closed,
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, 2_000)
					}),
				])
				if (!this.ended) signal("SIGKILL")
			} finally {
				clearTimeout(timer)
			}
		})().catch((error) => {
			this.stopPromise = undefined
			this.cancelled = false
			throw error
		})
		return this.stopPromise
	}
}
