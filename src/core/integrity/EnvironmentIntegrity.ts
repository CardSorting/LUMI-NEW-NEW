import { execFile } from "child_process"
import { createHash, randomUUID } from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"
import { Logger } from "@/shared/services/Logger"
import { StateManager } from "../storage/StateManager"

const execFileAsync = promisify(execFile)

async function probeCommand(file: string, args: string[]): Promise<{ stdout: string }> {
	return execFileAsync(file, args, {
		timeout: 3000,
		killSignal: "SIGKILL",
		windowsHide: true,
		encoding: "utf8",
		maxBuffer: 64 * 1024,
	})
}

export interface EnvironmentLease {
	fingerprint: string
	timestamp: number
	success: boolean
	error?: string
	details?: {
		nodeVersion?: string
		npmVersion?: string
		canWrite?: boolean
		nodePath?: string
		shell?: string
		diskSpaceGB?: string
		hasNodeModules?: boolean
		memoryFreeGB?: string
		detectedProjectTypes?: string[]
		toolchain?: Record<string, { version?: string; path?: string; status: "found" | "missing" | "broken" }>
		manifests?: string[]
		hostname?: string
		shadowingAlerts?: string[]
	}
}

/**
 * EnvironmentIntegrity: A deterministic gatekeeper for the agent's environment.
 * Implements "Environmental Leases" (L0-L2 tiered validation) with support for
 * multi-language discovery, binary integrity, and machine-anchored fingerprints.
 */
export class EnvironmentIntegrity {
	private lease: EnvironmentLease | null = null
	private probePromise: Promise<EnvironmentLease> | null = null
	private readonly LEASE_DURATION = 1000 * 60 * 60 // 1 hour lease

	private static readonly PROJECT_MARKERS: Record<string, { manifest: string; binary: string; args: string[] }> = {
		node: { manifest: "package.json", binary: "node", args: ["-v"] },
		python: { manifest: "requirements.txt", binary: "python3", args: ["--version"] },
		rust: { manifest: "Cargo.toml", binary: "cargo", args: ["--version"] },
		go: { manifest: "go.mod", binary: "go", args: ["version"] },
		dart: { manifest: "pubspec.yaml", binary: "dart", args: ["--version"] },
		ruby: { manifest: "Gemfile", binary: "ruby", args: ["-v"] },
	}

	constructor(
		private readonly cwd: string,
		private readonly stateManager?: StateManager,
		private readonly runCommand = probeCommand,
	) {}

	public getFingerprint(): string {
		const env = process.env
		const data = [
			os.hostname(),
			env.PATH,
			env.USER || env.USERNAME,
			this.cwd,
			process.platform,
			process.arch,
			process.version,
			"v3",
		].join("|")
		return createHash("sha256").update(data).digest("hex")
	}

	private getL0Lease(): EnvironmentLease | null {
		if (this.lease) return this.lease
		if (this.stateManager) {
			const persisted = this.stateManager.getGlobalStateKey("environmentalLease")
			if (persisted) {
				return persisted as EnvironmentLease
			}
		}
		return null
	}

	public isLeaseValid(lease: EnvironmentLease | null): boolean {
		if (!lease?.success || !Number.isFinite(lease.timestamp)) return false
		const age = Date.now() - lease.timestamp
		if (age < 0 || age > this.LEASE_DURATION) return false
		if (lease.fingerprint !== this.getFingerprint()) return false
		return true
	}

	public revokeLease(): void {
		this.lease = null
		if (this.stateManager) {
			this.stateManager.setGlobalState("environmentalLease", undefined)
		}
		Logger.warn("[EnvironmentIntegrity] Environmental Lease revoked.")
	}

	public async validateEnvironment(): Promise<EnvironmentLease> {
		if (this.probePromise) {
			return this.probePromise
		}

		const cachedLease = this.getL0Lease()
		if (this.isLeaseValid(cachedLease)) {
			this.lease = cachedLease
			return cachedLease as EnvironmentLease
		}

		this.probePromise = this.performFullProbe()
		try {
			const result = await this.probePromise
			return result
		} finally {
			this.probePromise = null
		}
	}

	private static readonly VERSION_MANIFESTS: Record<string, string[]> = {
		node: [".nvmrc", ".node-version"],
		python: [".python-version", "Pipfile"],
		rust: ["rust-toolchain", "rust-toolchain.toml"],
		ruby: [".ruby-version", ".tool-versions"],
	}

	private async performFullProbe(): Promise<EnvironmentLease> {
		Logger.info("[EnvironmentIntegrity] Performing Structural Forensic Probe (L2)...")
		const fingerprint = this.getFingerprint()
		const lease: EnvironmentLease = {
			fingerprint,
			timestamp: Date.now(),
			success: true,
			details: {
				hostname: os.hostname(),
				detectedProjectTypes: [],
				toolchain: {},
				manifests: [],
				shadowingAlerts: [],
			},
		}

		const details = lease.details!

		try {
			details.shell = process.env.SHELL || (process.platform === "win32" ? "cmd" : "unknown")
			details.memoryFreeGB = (os.freemem() / (1024 * 1024 * 1024)).toFixed(2)

			// Filesystem metadata avoids shell quoting and keeps free space in a single unit.
			try {
				const disk = await fs.statfs(this.cwd)
				details.diskSpaceGB = ((disk.bavail * disk.bsize) / 1024 ** 3).toFixed(3)
			} catch {
				// Disk telemetry is optional; permission checks and tools still report concrete failures.
			}

			// An exclusive, unique probe must never overwrite a user's file or a parallel task's probe.
			const canaryPath = path.join(this.cwd, `.dietcode_canary-${randomUUID()}`)
			try {
				const canary = await fs.open(canaryPath, "wx")
				try {
					details.canWrite = true
				} finally {
					await canary.close()
					await fs.unlink(canaryPath)
				}
			} catch {
				lease.success = false
				lease.error = `Permission Denied: Cannot write to workspace directory (${this.cwd}).`
				details.canWrite = false
			}

			const rootFiles = await fs.readdir(this.cwd)

			// 1. Detect project types based on markers
			for (const [type, config] of Object.entries(EnvironmentIntegrity.PROJECT_MARKERS)) {
				const hasMarker =
					rootFiles.includes(config.manifest) ||
					(EnvironmentIntegrity.VERSION_MANIFESTS[type]?.some((m) => rootFiles.includes(m)) ?? false)

				if (hasMarker) {
					details.detectedProjectTypes?.push(type)
					if (rootFiles.includes(config.manifest)) details.manifests?.push(config.manifest)
					EnvironmentIntegrity.VERSION_MANIFESTS[type]?.forEach((m) => {
						if (rootFiles.includes(m)) details.manifests?.push(m)
					})
				}
			}

			// Independent probes run concurrently, once per relevant toolchain, with bounded process lifetimes.
			const toolsToProbe = [...(details.detectedProjectTypes || []), "git"]
			await Promise.all(
				toolsToProbe.map(async (type) => {
					const config = EnvironmentIntegrity.PROJECT_MARKERS[type] || { binary: "git", args: ["--version"] }
					try {
						const [version, location] = await Promise.allSettled([
							this.runCommand(config.binary, config.args),
							this.runCommand(process.platform === "win32" ? "where" : "which", [config.binary]),
						])
						if (version.status === "rejected") throw version.reason
						const binPath =
							location.status === "fulfilled" ? location.value.stdout.trim().split(/\r?\n/)[0] : undefined
						details.toolchain![type] = { status: "found", version: version.value.stdout.trim(), path: binPath }
						if (binPath) {
							const relativePath = path.relative(this.cwd, binPath)
							if (
								relativePath &&
								relativePath !== ".." &&
								!relativePath.startsWith(`..${path.sep}`) &&
								!path.isAbsolute(relativePath)
							) {
								details.shadowingAlerts?.push(
									`Advisory: ${config.binary} resolves inside the workspace: ${binPath}`,
								)
							}
						}
					} catch {
						if (type === "node") {
							// The extension's own runtime is known; do not launch another IDE process as a fallback.
							details.toolchain![type] = { status: "found", version: process.version, path: process.execPath }
							details.shadowingAlerts?.push("Node.js is unavailable on PATH; reporting the extension runtime.")
						} else {
							details.toolchain![type] = { status: "missing" }
						}
					}
				}),
			)

			if (details.toolchain?.node?.status === "found") {
				const execPath = process.execPath
				const nodeBinPath = details.toolchain.node.path
				if (nodeBinPath && !execPath.includes(path.basename(nodeBinPath))) {
					details.shadowingAlerts?.push(
						`⚠️ INTEGRITY: Active Node binary (${execPath}) differs from PATH Node (${nodeBinPath}).`,
					)
				}
				details.nodeVersion = details.toolchain.node.version
				details.nodePath = nodeBinPath
				details.hasNodeModules = rootFiles.includes("node_modules")
			}
		} catch (e) {
			const error = e as Error
			lease.success = false
			lease.error = `Structural Forensic Failure: ${error.message}`
		}

		this.lease = lease
		if (this.stateManager) {
			this.stateManager.setGlobalState("environmentalLease", lease)
		}

		if (lease.success) {
			Logger.info(
				`[EnvironmentIntegrity] Structural lease issued for ${details.hostname}. Detected: ${details.detectedProjectTypes?.join(", ")}`,
			)
		} else {
			Logger.error(`[EnvironmentIntegrity] Lease REJECTED: ${lease.error}`)
		}

		return lease
	}
}
