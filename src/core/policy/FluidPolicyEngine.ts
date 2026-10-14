import { DietCodeDefaultTool } from "@shared/tools"
import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as path from "path"
import { orchestrator } from "@/infrastructure/ai/Orchestrator"
import { Logger } from "@/shared/services/Logger"
import { getLayer, suggestLayerForContent } from "@/utils/joy-zoning"
import { ToolUse } from "../assistant-message"
import { ContextStalenessTracker } from "../context/ContextStalenessTracker"
import { AnomalyRegistry } from "../integrity/AnomalyRegistry"
import { AuditRecorder } from "../integrity/AuditRecorder"
import { DashboardGenerator } from "../integrity/DashboardGenerator"
import { EnvironmentIntegrity, EnvironmentLease } from "../integrity/EnvironmentIntegrity"
import { StabilityMonitor } from "../integrity/StabilityMonitor"
import { StateManager } from "../storage/StateManager"
import { ForensicDiagnostic, RefactorHealer } from "../task/tools/RefactorHealer"
import { AxiomVerificationService } from "./AxiomVerificationService"
import { IntegrityGarbageCollector } from "./IntegrityGarbageCollector"
import { IntegrityOptimizer } from "./IntegrityOptimizer"
import { SemanticAxiomEngine } from "./SemanticAxiomEngine"
import { StabilityForensics } from "./StabilityForensics"
import { StabilityPolicy } from "./StabilityPolicy"
import { StabilityTelemetrics } from "./StabilityTelemetrics"
import { SpiderEngine } from "./spider/SpiderEngine"
import { TspPolicyPlugin } from "./TspPolicyPlugin"

export interface PolicyResult {
	success: boolean
	error?: string
	warning?: string
	isAlarmed?: boolean
	violations?: string[]
	buildErrors?: string[]
	entropyScore?: number
	correctionHint?: string
}

/**
 * FluidPolicyEngine: The single point of enforcement for architectural (Stability),
 * concurrency (Collision), and structural (Entropy) rules.
 *
 * Progressive Enforcement Strategy:
 * - Strike 1 (domain only): Hard block — the write is rejected with correction hints.
 * - Strike 2+: Graceful degradation — the write proceeds with a strong warning injected.
 * - Core layer: Always warning-only (never hard-blocked).
 * - Other layers: Warning-only.
 * This prevents infinite deadlock while still educating the agent.
 */
export class FluidPolicyEngine {
	private readonly tspPlugin = new TspPolicyPlugin()
	private readonly spiderEngine: SpiderEngine
	private mode: "plan" | "act" = "act"
	private commitSeal: string | null = null
	private layerCache: Map<string, string> = new Map()
	private sessionFiles: Map<string, string> = new Map()
	private auditRecorder: AuditRecorder
	private stalenessTracker: ContextStalenessTracker
	private dashboardGenerator: DashboardGenerator
	private axiomEngine: SemanticAxiomEngine
	private stabilityMonitor: StabilityMonitor
	private optimizer: IntegrityOptimizer
	private anomalies: AnomalyRegistry
	private buildAlarmActive = false
	private alarmViolations: string[] = []
	private lastBuildHealth = 100
	private telemetrics: StabilityTelemetrics
	private verification: AxiomVerificationService
	private refactorTurnsRemaining = 0 // V70: Stability Refactor Window
	private lastEntropyScore = 1.0 // V80: Karma Tracking
	private restorationTokens: Map<string, number> = new Map() // V100: Recovery Buffers
	private gracePeriods: Map<string, number> = new Map() // V100: Soft-Lock attempts
	private refactorHealer: RefactorHealer
	private forensics: StabilityForensics
	private garbageCollector: IntegrityGarbageCollector
	private readonly envIntegrity: EnvironmentIntegrity
	private karma = 1000 // High-Velocity: Initial Karma bonus

	private isChecking = false

	constructor(
		private cwd: string,
		private streamId?: string,
		private stateManager?: StateManager,
		private virtualResolver?: (path: string) => string | undefined,
	) {
		this.spiderEngine = new SpiderEngine(this.cwd)
		this.auditRecorder = new AuditRecorder(this.cwd)
		this.stalenessTracker = new ContextStalenessTracker(this.cwd)
		this.dashboardGenerator = new DashboardGenerator(this.cwd)
		this.axiomEngine = new SemanticAxiomEngine()
		this.stabilityMonitor = new StabilityMonitor(this.cwd)
		this.optimizer = new IntegrityOptimizer()
		this.anomalies = new AnomalyRegistry(this.cwd)
		this.refactorHealer = new RefactorHealer(this.cwd)
		this.forensics = new StabilityForensics(this.cwd, this.stabilityMonitor, this.spiderEngine)
		this.garbageCollector = new IntegrityGarbageCollector(this.cwd, this.spiderEngine, this.anomalies, this.stabilityMonitor)
		this.telemetrics = new StabilityTelemetrics(this.cwd, this.stabilityMonitor, this.spiderEngine, this.anomalies)
		this.verification = new AxiomVerificationService(
			this.cwd,
			this.spiderEngine,
			this.axiomEngine,
			this.anomalies,
			this.forensics,
		)
		this.envIntegrity = new EnvironmentIntegrity(this.cwd, this.stateManager)

		// V16: Warm graph startup
		this.restoreStabilitySubstrate().catch((e: unknown) =>
			Logger.error("[FluidPolicyEngine] Failed to restore Stability Substrate:", e),
		)
	}

	/**
	 * Clears architectural alarms and activity alerts.
	 * Explicitly used by orchestrator during a Cognitive Reflection Nudge to grant a clean slate.
	 */
	public resetSystemPressure(): void {
		this.telemetrics.resetSystemPressure()
		this.alarmViolations = []
	}

	public getSystemDiagnostics(): string {
		// V18: Forwarding entropy context for velocity calculation
		return this.telemetrics.getSystemDiagnostics(this.lastEntropyScore)
	}

	/**
	 * Explicitly triggers environmental validation.
	 */
	public async validateEnvironment(): Promise<EnvironmentLease> {
		return await this.envIntegrity.validateEnvironment()
	}

	/**
	 * Revokes the current environmental lease.
	 */
	public revokeLease(): void {
		this.envIntegrity.revokeLease()
	}

	/**
	 * V200: Industrial Hygiene (Disposal).
	 * Shuts down all engines and releases persistence buffers to prevent memory leaks.
	 */
	public dispose(): void {
		this.spiderEngine.dispose()
		this.stabilityMonitor.dispose()
		this.optimizer.dispose()
		this.forensics.dispose()
		this.garbageCollector.dispose()
		this.telemetrics.dispose()
		this.refactorHealer.dispose()
		this.verification.dispose()

		this.layerCache.clear()
		this.sessionFiles.clear()
		this.restorationTokens.clear()
		this.gracePeriods.clear()
		this.isChecking = false
		this.buildAlarmActive = false

		Logger.info("[FluidPolicyEngine] Stability Teardown Complete. All substrates released.")
	}

	/**
	 * Increments and persists the strike count for a file.
	 */
	private async incrementStrikes(filePath: string): Promise<number> {
		if (!this.streamId) return 0
		const key = `strikes:${path.basename(filePath)}`
		const currentRaw = await orchestrator.recallMemory(this.streamId, key)
		const newCount = (currentRaw ? Number.parseInt(currentRaw, 10) : 0) + 1
		await orchestrator.storeMemory(this.streamId, key, newCount.toString())

		// Global project memory (legacy tracking)
		if (this.stateManager) {
			const strikes = { ...this.stateManager.getGlobalStateKey("architecturalStrikes") }
			strikes[filePath] = newCount
			this.stateManager.setGlobalState("architecturalStrikes", strikes)
		}

		return newCount
	}

	/**
	 * Resets strikes for a file once it's clean.
	 */
	private async resetStrikes(filePath: string): Promise<void> {
		if (this.streamId) {
			await orchestrator.storeMemory(this.streamId, `strikes:${path.basename(filePath)}`, "0")
		}
		if (this.stateManager) {
			const strikes = { ...this.stateManager.getGlobalStateKey("architecturalStrikes") }
			if (strikes[filePath]) {
				delete strikes[filePath]
				this.stateManager.setGlobalState("architecturalStrikes", strikes)
			}
		}
	}

	public setMode(mode: "plan" | "act") {
		this.mode = mode
	}

	public setStreamId(streamId: string) {
		this.streamId = streamId
	}

	public setCommitSeal(seal: string, _reason?: string) {
		this.commitSeal = seal
	}

	public getFileLayerContext(filePath: string): string {
		const layer = this.getCachedLayer(filePath)
		return this.verification.getFileLayerContext(filePath, layer)
	}

	public getCorrectionHint(errors: string[], filePath?: string): string {
		const layer = filePath ? this.getCachedLayer(filePath) : undefined
		return this.verification.getCorrectionHint(errors, filePath, layer)
	}

	public computeBuildHealth(violations: string[]): number {
		const lastScore = this.lastBuildHealth
		const score = this.telemetrics.computeBuildHealth(violations)
		const config = StabilityPolicy.getInstance(this.cwd).getGlobalConfig()
		const threshold = config.integrityAlertThreshold || 70
		const isDeclining = score < lastScore
		const isRecovering = score > lastScore

		if (score < threshold && !this.buildAlarmActive && isDeclining) {
			this.triggerBuildAlarm(violations)
		} else if (this.buildAlarmActive && (score >= 90 || isRecovering)) {
			this.clearBuildAlarm()
		}

		return score
	}

	/**
	 * Records the current scan results to history.
	 */
	public async recordScanHistory(violations: string[]) {
		const score = this.computeBuildHealth(violations)
		const fileCount = this.spiderEngine.nodes.size
		await this.auditRecorder.record(score, violations.length, fileCount)

		// Passive Dashboard Update
		await this.dashboardGenerator.updateDashboard(
			this.spiderEngine,
			this.auditRecorder,
			this.stabilityMonitor,
			this.optimizer,
			this.anomalies,
		)

		// V150: Substrate Stabilization (Ghost Persistence)
		await this.persistStabilitySubstrate()
	}

	private triggerBuildAlarm(violations: string[]) {
		this.buildAlarmActive = true
		this.alarmViolations = violations
		Logger.warn("🚨 [HEALTH ALERT] System entering safety mode due to linter/build errors. Forced cleanup started.")
	}

	private clearBuildAlarm() {
		this.buildAlarmActive = false
		this.alarmViolations = []
		this.lastBuildHealth = 100 // Reset baseline
		Logger.info("💚 [HEALTH ALERT] Health restored. System stability confirmed.")
	}

	/**
	 * Validates a tool block before execution.
	 * Uses progressive enforcement: first domain violation blocks, subsequent ones degrade to warnings.
	 */
	public async validatePreExecution(block: ToolUse): Promise<PolicyResult> {
		const result: PolicyResult = { success: true }

		const isModifying =
			block.name === DietCodeDefaultTool.FILE_NEW ||
			block.name === DietCodeDefaultTool.FILE_EDIT ||
			block.name === DietCodeDefaultTool.NEW_RULE ||
			block.name === DietCodeDefaultTool.APPLY_PATCH ||
			block.name === DietCodeDefaultTool.BASH

		if (this.mode === "plan" && isModifying && this.stateManager?.getGlobalSettingsKey("strictPlanModeEnabled")) {
			return {
				success: false,
				error: "Strict Plan mode is enabled. Finalize the plan with plan_mode_respond to switch to Act before running commands or changing files. Read-only file and search tools remain available.",
			}
		}

		// Step -1: Strategic Environment Check (SEC)
		// Ensuring essential tools are available to prevent progress issues.
		const lease = await this.envIntegrity.validateEnvironment()
		if (!lease.success || (lease.details?.diskSpaceGB && Number.parseFloat(lease.details.diskSpaceGB) < 0.5)) {
			const details = lease.details

			// V192 Hardening: Categorized Forensics
			const substrateContext = [
				`• Machine: ${details?.hostname || "Unknown"}`,
				`• Shell: ${details?.shell || "Unknown"}`,
				...(details?.shadowingAlerts || []),
			].join("\n")

			const toolchainContext = [
				details?.nodeVersion ? `• Node: ${details.nodeVersion} (${details.nodePath})` : "• Node: Missing/Inaccessible",
				details?.hasNodeModules === false ? "• Dependencies: node_modules missing (Run npm install)" : "",
			]
				.filter(Boolean)
				.join("\n")

			const stabilityContext = [
				details?.diskSpaceGB ? `• Disk: ${details.diskSpaceGB} available` : "• Disk: Sensing failed",
				details?.memoryFreeGB ? `• Memory: ${details.memoryFreeGB}GB free` : "",
			]
				.filter(Boolean)
				.join("\n")

			const forensicReport = `📊 [ENVIRONMENT]\n${substrateContext}\n\n🛠️ [TOOLCHAIN]\n${toolchainContext}\n\n🔋 [ACTIVITY]\n${stabilityContext}`

			// V191 Hardening: Physical Blockade
			if (isModifying && lease.details?.diskSpaceGB && Number.parseFloat(lease.details.diskSpaceGB) < 0.5) {
				return {
					success: false,
					error:
						`🛑 PHYSICAL BLOCKADE [CRITICAL]: Disk space dangerously low.\n\n` +
						`I've detected your environment has less than 500MB of free space (${lease.details.diskSpaceGB}).\n\n` +
						`💡 WHY THIS MATTERS: Coding with near-zero disk space causes silent corruption of the database and source files during write operations.\n\n` +
						`📊 STATE:\n${forensicReport}\n\n` +
						`🛠️ RECOVERY: Please free up space in ${this.cwd} before proceeding.`,
				}
			}

			// V191 Hardening: Shell Health Warning
			let shellWarning = ""
			if (details?.shell?.includes("cmd.exe")) {
				shellWarning = `⚠️ WARNING: Restricted Shell detected (cmd.exe). Many advanced coding tools and terminal features work more reliably in PowerShell or Git Bash.\n\n`
			}

			// V192 Hardening: Adaptive Multi-Language Recipes
			const recipes: string[] = []
			const detected = details?.detectedProjectTypes || []
			const toolchain = details?.toolchain || {}

			if (detected.includes("node")) {
				if (toolchain.node?.status !== "found")
					recipes.push("• **Node.js**: Toolchain missing. Please install Node.js and npm.")
				else if (details?.hasNodeModules === false)
					recipes.push("• **Node.js**: `node_modules` missing. Run `npm install`.")
			}
			if (detected.includes("python") && toolchain.python?.status !== "found") {
				recipes.push("• **Python**: Toolchain missing. Run `pip install -r requirements.txt` after installing python3.")
			}
			if (detected.includes("rust") && toolchain.rust?.status !== "found") {
				recipes.push("• **Rust**: Toolchain missing. Run `cargo build` after installing rustup.")
			}
			if (detected.includes("go") && toolchain.go?.status !== "found") {
				recipes.push("• **Go**: Toolchain missing. Run `go mod download` after installing Go.")
			}
			if (detected.includes("ruby") && toolchain.ruby?.status !== "found") {
				recipes.push("• **Ruby**: Toolchain missing. Run `bundle install` after installing Ruby.")
			}
			if (detected.includes("dart") && toolchain.dart?.status !== "found") {
				recipes.push("• **Dart/Flutter**: Toolchain missing. Run `flutter pub get`.")
			}

			let guidedSetup = recipes.length > 0 ? `🛠️ **ADAPTIVE REPAIR RECIPES**:\n${recipes.join("\n")}\n\n` : ""

			guidedSetup +=
				`1. Ensure essential tools are in your PATH.\n` +
				`2. Check write permissions for ${this.cwd}.\n` +
				`3. If using NVM/Version managers, ensure the correct version is activated.`

			if (lease.error?.includes("Git Not Found")) {
				guidedSetup = `⚠️ **CRITICAL**: Git is missing. Checkpoints and forensics are disabled. Please install git.\n\n${guidedSetup}`
			}

			const isCriticalPhysicalResource =
				(lease.details?.diskSpaceGB && Number.parseFloat(lease.details.diskSpaceGB) < 0.5) ||
				lease.error?.includes("Permission Denied")

			if (isModifying && isCriticalPhysicalResource) {
				return {
					success: false,
					error: `🛑 ENVIRONMENT ALERT [GATEKEEPER]\n\nCritical physical environment requirements not met.\n\n❌ ISSUE: ${lease.error || "Substrate health critical"}\n\n${forensicReport}\n\n${shellWarning}💡 WHY THIS MATTERS: Attempting to modify code without disk space or permissions causes data loss.\n\n🛠️ GUIDED SETUP:\n${guidedSetup}\n\n⚙️ I will re-probe the environment on your next attempt.`,
				}
			}

			result.warning =
				(result.warning ? `${result.warning}\n` : "") +
				`⚠️ [ADVISORY] Environment Toolchain issues detected:\n${lease.error}\n\n${guidedSetup}`
		}

		return result
	}

	public async execute(block: ToolUse): Promise<PolicyResult> {
		if (this.isChecking) return { success: true }
		this.isChecking = true

		let result: PolicyResult = { success: true }
		try {
			const preResult = await this.validatePreExecution(block)
			if (!preResult.success) {
				result = preResult
				return result
			}
			result = preResult

			// In PLAN mode, skip enforcement — agent is only planning, not writing
			// Return guidance instead of blocking
			if (this.mode === "plan" && block.params?.path) {
				// consolidated to top-level import
				const filePath = path.resolve(this.cwd, block.params.path)
				const layer = getLayer(filePath)

				// Predictive Collision Check: Warn early if another stream has a lock
				const collision = await orchestrator.checkCollision(this.streamId || "viewer", [filePath])
				if (collision) {
					return {
						success: true,
						warning: `⚠️ PREDICTIVE COLLISION: You are planning to edit \`${path.basename(filePath)}\`, but it's currently LOCKED by a sibling stream. Coordination is required before acting.`,
					}
				}

				return {
					success: true,
					warning: `📍 Planning a change in the **${layer.toUpperCase()}** layer (${path.basename(filePath)}).`,
				}
			}

			// v9 HARDENING: Pre-emptive Match Sensing for replace_in_file (simulated via FILE_EDIT validation)
			if (block.name === DietCodeDefaultTool.FILE_EDIT && block.params?.path && (block.params as { diff?: string }).diff) {
				const filePath = path.resolve(this.cwd, block.params.path)
				const diff = (block.params as { diff: string }).diff as string
				const searchBlocks = diff.match(/------- SEARCH\n([\s\S]*?)\n=======/)
				if (searchBlocks) {
					const searchContent = searchBlocks[1]
					try {
						const currentDiskContent = await fs.readFile(filePath, "utf-8")
						if (!currentDiskContent.includes(searchContent)) {
							// v9 AUTO-CORRECTION: Provide the agent with the actual lines to fix the search block
							const searchLines = searchContent.split("\n")
							const firstLine = searchLines[0].trim()
							const diskLines = currentDiskContent.split("\n")
							const matchIndex = diskLines.findIndex((l) => l.includes(firstLine))
							let hint = ""
							if (matchIndex !== -1) {
								const contextWindow = diskLines.slice(Math.max(0, matchIndex - 2), matchIndex + 5).join("\n")
								hint = `\n\n🔍 AUTO-CORRECTION HINT: Your SEARCH block failed, but I found a similar section starting at line ${matchIndex + 1}:\n\`\`\`typescript\n${contextWindow}\n\`\`\``
							}

							return {
								success: false,
								error: `🛑 PRE-EMPTIVE MATCH FAILURE: The SEARCH block in your edit does not match the current state of \`${path.basename(filePath)}\`.${hint}\n\n💡 RECOVERY: Update your SEARCH block to match the actual file content exactly.`,
							}
						}
					} catch (_e) {
						// File might not exist
					}
				}
			}

			// Architectural Policy: AST + Database Concurrent Pass
			if (
				(block.name === DietCodeDefaultTool.FILE_NEW || block.name === DietCodeDefaultTool.FILE_EDIT) &&
				block.params?.path &&
				block.params?.content
			) {
				const filePath = path.resolve(this.cwd, block.params.path)
				const content = block.params.content as string

				// 0. Rule: Contextual Integrity Guard (Staleness Protection)
				// PRODUCTION HARDENING: Proactively block edits based on verifiably stale context.
				const staleness = this.stalenessTracker.checkStaleness(filePath)
				if (staleness.isStale && !this.commitSeal) {
					const fileName = path.basename(filePath)
					// PRODUCTION HARDENING: Proactive recovery hint with a ready-to-use tool call snippet
					return {
						success: true,
						warning: `⚠️ STALE CONTEXT ALERT: You are attempting to edit \`${fileName}\` based on a stale mental model.\nReason: ${staleness.reason}\n\n💡 RECOVERY: Execute the following command to synchronize your context:\n\`\`\`json\n{\n  "name": "read_file",\n  "params": { "path": "${filePath}" }\n}\n\`\`\``,
					}
				}

				// Update Spider session cache with Incremental Node Sync (v16)
				this.sessionFiles.set(filePath, content)
				this.spiderEngine.updateNode(filePath, content)

				// 1. AST Validation (TSP)
				// V9: Pass trend signals for Absolute Activity Integrity
				const isRecovering = this.spiderEngine.isRecovering
				const isHealing = content.includes("[STABILITY_HEALING]") || content.includes("# HEALING TURN")
				const astValidation = this.tspPlugin.validateSource(
					filePath,
					content,
					this.virtualResolver,
					isRecovering || isHealing,
				)

				// Block on AST Failure (Strike 1 Domain)
				if (!astValidation.success) {
					const layer = this.getCachedLayer(filePath)
					const strikes = await this.incrementStrikes(filePath)
					const projectHealth = this.lastBuildHealth

					// V270: Sovereign Bypass
					const isSovereign = content.includes("#SOVEREIGN_MODE") || content.includes("#BYPASS")

					// PRODUCTION HARDENING: Layer-aware deblocking.
					// 1. DOMAIN: Block on Strike 1 ONLY if health is critical (< 50) or not sovereign.
					// 2. CORE: Never block on Strike 1, only warn. Block on Strike 3 if health is declining.

					const isRecoveringTrend = this.spiderEngine.isRecovering
					const shouldBlock =
						!isSovereign &&
						((layer === "domain" && projectHealth < 50 && !isHealing) ||
							(layer === "core" && strikes >= 3 && projectHealth < 60 && !isRecoveringTrend))

					if (shouldBlock) {
						const violationSummaryRejection = astValidation.errors.map((e: string) => `  - ${e}`).join("\n")
						const rejectionTitle = layer === "domain" ? "🛡️ DOMAIN INTEGRITY GUARD" : "🏗️ CORE STABILITY BLOCK"

						return {
							success: true, // V270: Still success to prevent total deadlock, but with a firm warning
							warning:
								`🚨 ${rejectionTitle} [RECOVERY_REQUIRED]\n` +
								`Layer file \`${path.basename(filePath)}\` has ${astValidation.errors.length} violation(s) (Strike ${strikes}):\n${violationSummaryRejection}\n\n` +
								`${this.getCorrectionHint(astValidation.errors, filePath)}\n\n` +
								`‼️ **SOVEREIGN RECOVERY REQUIRED**\n` +
								`Please prioritize resolving these violations in your next turn.`,
							violations: astValidation.errors,
						}
					}

					// Strike 2+ or other layers: Advisory Warning only
					const allWarnings = [...(astValidation.warnings || []), ...astValidation.errors]
					const violationSummary = allWarnings.map((e: string) => `  - ${e}`).join("\n")

					return {
						success: true,
						warning:
							`📍 [ARCHITECTURAL ADVISORY]: ${layer.toUpperCase()} layer file \`${path.basename(filePath)}\` has ${astValidation.errors.length} violation(s):\n${violationSummary}\n\n` +
							`*Proceeding with the write to maintain velocity. Correct these patterns when possible.*`,
						correctionHint: this.getCorrectionHint(astValidation.errors, filePath),
					}
				}

				// Clean file — reset strikes for this path
				await this.resetStrikes(filePath)

				// V10: Harmonic Decay (Forgiveness for historically stressed files)
				if (this.spiderEngine.isRecovering) {
					const isHistoricallyAlarmed =
						this.alarmViolations.some((v) => v.includes(filePath)) || this.anomalies.hasAnomaly(filePath)
					if (isHistoricallyAlarmed) {
						Logger.info(`[FluidPolicyEngine] Triggering Harmonic Decay for successfully healed file: ${filePath}`)
						this.anomalies.decay(filePath, 2)
					}
				}

				// Surface AST warnings if any
				if (astValidation.warnings && astValidation.warnings.length > 0) {
					return {
						success: true,
						warning: `⚠️ DISCERNMENT WARNING: Architectural smell(s) detected:\n${astValidation.warnings.map((w: string) => `  - ${w}`).join("\n")}`,
					}
				}

				// For new files: proactively suggest the best layer if content doesn't match location
				if (block.name === DietCodeDefaultTool.FILE_NEW && block.params.content) {
					// consolidated to top-level import
					const currentLayer = getLayer(filePath)
					const suggestion = suggestLayerForContent(block.params.content)
					if (suggestion && suggestion.layer !== currentLayer && currentLayer !== "core") {
						return {
							success: true,
							warning: `📍 This file is being created in the **${currentLayer.toUpperCase()}** layer, but its content looks like it belongs in **${suggestion.layer.toUpperCase()}**.\n${suggestion.reason}\nConsider placing it under \`src/${suggestion.layer}/\` instead. If the current location is intentional, proceed.`,
						}
					}
				}
			}

			// Concurrency Policy: Check for file collisions with sibling streams
			if (!this.streamId) return { success: true }

			if (
				block.name === DietCodeDefaultTool.FILE_NEW ||
				block.name === DietCodeDefaultTool.FILE_EDIT ||
				block.name === DietCodeDefaultTool.APPLY_PATCH
			) {
				const params = (block as unknown as { params: Record<string, unknown> }).params || {}
				const files = params.path ? [path.resolve(this.cwd, params.path as string)] : []
				if (files.length > 0) {
					const collision = await orchestrator.checkCollision(this.streamId, files)
					if (collision) {
						return {
							success: false,
							error: `🛑 FLUID COORDINATION ERROR: ${collision}\nYOUR COMMIT HAS BEEN BLOCKED TO PREVENT DATA CORRUPTION. Coordinate with the sibling stream or wait for its completion before proceeding.`,
						}
					}
				}
			}

			const isModifyingTool =
				block.name === DietCodeDefaultTool.FILE_NEW ||
				block.name === DietCodeDefaultTool.FILE_EDIT ||
				block.name === DietCodeDefaultTool.APPLY_PATCH

			if (block.params?.path && isModifyingTool) {
				const normalizedPath = this.normalize(block.params.path)
				this.stabilityMonitor.recordWrite(normalizedPath) // V31: Intent record (without content)

				// --- ZERO-FRICTION COMPLIANCE HOOK ---
				// Automatically align tags and fix outgoing imports in the backup
				try {
					const absolutePath = path.resolve(this.cwd, normalizedPath)
					await this.refactorHealer.alignTag(absolutePath)

					// --- VIBRATION SENSING (Blast Radius) ---
					// Heal the rattled dependents in the background to avoid blocking the agent turn
					this.refactorHealer.healCascade(absolutePath, this.spiderEngine).catch((e) => {
						Logger.warn("[FluidPolicyEngine] Background healCascade failed:", e)
					})
				} catch (e) {
					Logger.warn("[FluidPolicyEngine] Zero-friction hook failed:", e)
				}
			}

			// V150: Cognitive Immortality (Eager Persistence)
			if (this.streamId) {
				// V189: Unified Environment handles activity persistence
			}

			// V204: Non-Blocking Integrity Advisories (TIA)
			// Pull healing suggestions from the structural graph only for targeted files.
			const targetedPath = block.params?.path as string
			if (targetedPath && typeof targetedPath === "string") {
				const advisories = this.spiderEngine.getIntegrityAdvisories(targetedPath)
				const brittlePaths = this.refactorHealer.detectRelativeImports(
					targetedPath,
					block.params?.content as string,
					this.spiderEngine,
				)
				const missingExports = this.refactorHealer.detectMissingExports(targetedPath, block.params?.content as string)
				const shadowing = this.refactorHealer.detectShadowing(targetedPath, block.params?.content as string)
				const unusedImports = this.refactorHealer.detectUnusedImports(targetedPath, block.params?.content as string)
				const barrelGaps = this.refactorHealer.detectMissingFromBarrel(targetedPath)
				const vibrations = advisories.filter((a) => a.id === "SPI-105")

				if (
					advisories.length > 0 ||
					brittlePaths.length > 0 ||
					missingExports.length > 0 ||
					shadowing.length > 0 ||
					unusedImports.length > 0 ||
					(barrelGaps && barrelGaps.length > 0) ||
					vibrations.length > 0
				) {
					const advisoryHint = [
						...advisories.map((a) => {
							let msg = `  - 💡 [INTEGRITY_ADVISORY]: ${a.message}`
							if (a.id === "SPI-102") {
								const symbol = a.message.match(/SYMBOL: (.*?) ->/)?.[1]
								if (symbol) {
									const layer = this.getCachedLayer(a.path)
									const boilerplate = this.refactorHealer.materializeSymbolBoilerplate(symbol, layer)
									msg += `\n    \`\`\`typescript\n${boilerplate}\n    \`\`\``
								}
							}
							return msg
						}),
						...brittlePaths.map((p) => `  - 💡 [PATH_ADVISORY]: Relative path should be an alias: ${p}`),
						...missingExports.map((e) => `  - 💡 [VISIBILITY_ADVISORY]: ${e}`),
						...shadowing.map((s) => `  - 💡 [NAMING_ADVISORY]: ${s}`),
						...unusedImports.map((u) => `  - 💡 [DEADWOOD_ADVISORY]: ${u}`),
						...(barrelGaps || []).map((b) => `  - 💡 [BARREL_ADVISORY]: ${b}`),
						...vibrations.map((v) => `  - 🚨 [SUBSTRATE_VIBRATION]: ${v.message}`),
					].join("\n")

					result.warning = `${result.warning ? `${result.warning}\n\n` : ""}### 🔍 ARCHITECTURAL ADVISORIES\n${advisoryHint}\n\n*These are passive suggestions to improve structural health. You may address them in this turn or a subsequent stabilization phase.*`
				}
			}
		} finally {
			this.isChecking = false
		}

		return result
	}

	/**
	 * Resolves the architectural layer for a file with in-memory caching.
	 * Tier 3 optimization for high-volume file batches.
	 */
	private getCachedLayer(filePath: string): string {
		let layer = this.layerCache.get(filePath)
		if (!layer) {
			// consolidated to top-level import
			layer = getLayer(filePath)
			if (layer) {
				this.layerCache.set(filePath, layer)
			}
		}
		return layer ?? "infrastructure"
	}

	/**
	 * Inspects and enriches tool results with proactive layer context.
	 * V300: Shadow Documentation & Strategic Guidance.
	 */
	public async observeToolOutcome(
		toolName: string,
		output: { success?: boolean; content?: unknown } | null | undefined,
	): Promise<{ hint?: string }> {
		if (this.mode === "act" && (toolName === DietCodeDefaultTool.FILE_EDIT || toolName === DietCodeDefaultTool.FILE_NEW)) {
			// If tool was successful, suggest documentation updates
			if (output?.success || output?.content) {
				const recentEdits = Array.from(this.sessionFiles.keys()).slice(-3)
				const changelogHint = `💡 [SHADOW DOCUMENTATION]: You've successfully modified ${recentEdits.length} file(s). Consider updating the \`CHANGELOG.md\` or \`wiki/\` with these changes to maintain architectural history.`
				return { hint: changelogHint }
			}
		}
		return {}
	}

	public async onRead(
		filePath: string,
		content: string,
		_totalReadCount = 0,
		_perFileReadCount = 0,
		_globalFileReadCount = 0,
	): Promise<string> {
		const absolutePath = path.resolve(this.cwd, filePath)

		// Update Spider session cache
		this.sessionFiles.set(absolutePath, content)
		this.spiderEngine.updateNode(absolutePath, content)
		await this.stalenessTracker.recordRead(absolutePath, content)
		return content
	}

	/**
	 * Validates the outcome of a tool execution.
	 */
	public async validatePostExecution(block: ToolUse, toolOutput: unknown, _prevResultHash?: string): Promise<PolicyResult> {
		const result: PolicyResult = { success: true }
		if (block.name === DietCodeDefaultTool.BASH) {
			const output = toolOutput as { exitCode?: number }
			if (output?.exitCode === 127 || output?.exitCode === 126) this.envIntegrity.revokeLease()
		}

		// Observers record the completed operation. They never run a compiler, rewrite
		// source files, acquire a mutation lock, or turn successful work into a new gate.
		if (
			[
				DietCodeDefaultTool.FILE_NEW,
				DietCodeDefaultTool.FILE_EDIT,
				DietCodeDefaultTool.APPLY_PATCH,
				DietCodeDefaultTool.NEW_RULE,
			].includes(block.name)
		) {
			const filePath = block.params.path || (block.params as { target_file?: string }).target_file
			if (filePath) {
				const absolutePath = path.resolve(this.cwd, filePath)
				const content = await fs.readFile(absolutePath, "utf-8")
				const normalized = this.normalize(absolutePath)
				this.sessionFiles.set(normalized, content)
				this.spiderEngine.setSessionBuffer(this.sessionFiles)
				this.spiderEngine.updateNode(normalized, content)
				this.stabilityMonitor.recordWrite(normalized, content, 0, 0, this.streamId)
				result.violations = this.spiderEngine
					.getViolations()
					.filter((violation) => violation.path === normalized)
					.map((violation) => violation.message)
			}
		}
		if (this.refactorTurnsRemaining > 0) this.refactorTurnsRemaining--
		return result
	}

	/**
	 * Performs a final stability audit on a set of changes before they are committed.
	 * Only domain-layer changes with violations block the commit; others produce warnings.
	 */
	public async validateCommit(
		affectedFiles: Set<string>,
		ops: import("../../infrastructure/db/BufferedDbPool").WriteOp[],
	): Promise<{ success: boolean; errors: string[] }> {
		const allErrors: string[] = []
		const isDomainChange = ops.some((op) => op.layer === "domain")

		for (const filePath of Array.from(affectedFiles)) {
			try {
				const content = await fs.readFile(filePath, "utf-8")
				const validation = this.tspPlugin.validateSource(filePath, content, this.virtualResolver)
				if (!validation.success) {
					allErrors.push(...validation.errors)
				}

				// AST-based dependency detection
				const ts = require("typescript")
				const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)
				const crossViolations = this.tspPlugin.findCrossLayerViolations(sourceFile, filePath)
				if (crossViolations.length > 0) {
					const layer = getLayer(filePath)
					allErrors.push(...crossViolations.map((v) => `[${layer.toUpperCase()}] ${path.basename(filePath)}: ${v}`))
				}
			} catch (e) {
				Logger.error(`[FluidPolicyEngine] Commit validation failed for ${filePath}:`, e)
			}
		}

		const isSealed = !!this.commitSeal
		const success = isSealed || !isDomainChange || allErrors.length === 0

		if (success) {
			Logger.info("[FluidPolicyEngine] Commit validated. Focus shift tracking reset.")
		}

		return {
			success,
			errors: isSealed ? allErrors.map((e) => `[SEALED OVERRIDE] ${e}`) : allErrors,
		}
	}

	private normalize(p: string): string {
		return this.spiderEngine.normalizePath(p)
	}

	public getForensics(): StabilityForensics {
		return this.forensics
	}

	public getStabilityStats() {
		return this.stabilityMonitor.getStabilityStats()
	}

	public getViolations() {
		return this.spiderEngine.getViolations()
	}

	public getEntropy() {
		return this.spiderEngine.computeEntropy()
	}

	public getNodes() {
		return this.spiderEngine.nodes
	}
	/**
	 * V110: Substrate Stability Telemetry Proxy.
	 */
	public getStabilityTelemetry(filePath: string) {
		const layer = this.getCachedLayer(filePath)
		const tokens = this.restorationTokens.get(filePath) || 0
		return this.telemetrics.getStabilityTelemetry(filePath, layer, tokens)
	}

	/**
	 * V189: Industrial Hardening - Stability Substrate Stabilization.
	 * Consolidates Activity, Spider, and Telemetry trends into a single atomic persistence transaction.
	 */
	private async persistStabilitySubstrate() {
		if (!this.streamId) return
		try {
			const spiderData = this.spiderEngine.serialize()
			const stabilityState = this.stabilityMonitor.exportState()
			const telemetricsState = this.telemetrics.exportState()

			const checksum = crypto.createHash("sha256").update(spiderData).digest("hex")

			const payload = JSON.stringify({
				version: "V189",
				spider: spiderData.toString("base64"),
				stability: stabilityState,
				telemetrics: telemetricsState,
				karma: this.karma,
				checksum,
				timestamp: Date.now(),
			})

			await orchestrator.storeMemory(this.streamId, "stability_substrate_v189", payload)
			Logger.info(`[FluidPolicyEngine] Stability Substrate stabilized (Checksum: ${checksum.slice(0, 8)}).`)
		} catch (e) {
			Logger.error("[FluidPolicyEngine] Failed to stabilize Stability Substrate:", e)
		}
	}

	/**
	 * V189: Industrial Hardening - Stability Substrate Restoration.
	 * Restores the entire structural and activity context from memory.
	 */
	private async restoreStabilitySubstrate() {
		if (!this.streamId) {
			await this.spiderEngine.loadRegistry()
			return
		}
		try {
			const raw = await orchestrator.recallMemory(this.streamId, "stability_substrate_v189")
			if (raw) {
				const payload = JSON.parse(raw)
				const data = Buffer.from(payload.spider, "base64")
				const actualChecksum = crypto.createHash("sha256").update(data).digest("hex")

				if (actualChecksum !== payload.checksum) {
					Logger.error("[FluidPolicyEngine] Substrate Corruption sensed (Checksum Mismatch). Rebuilding...")
					await this.spiderEngine.loadRegistry()
					return
				}

				// Restore Sub-systems
				await this.spiderEngine.loadRegistry(data)
				this.stabilityMonitor.importState(payload.stability || payload.metabolic) // V215: Stability Migration
				this.telemetrics.importState(payload.telemetrics)
				this.karma = payload.karma || 0
				Logger.info(`[FluidPolicyEngine] Stability Substrate V189 restored and verified for stream ${this.streamId}.`)
			} else {
				// Fallback to legacy or rebuild
				await this.spiderEngine.loadRegistry()
			}
		} catch (e) {
			Logger.error("[FluidPolicyEngine] Failed to restore Stability Substrate:", e)
			await this.spiderEngine.loadRegistry()
		}
	}

	public getLayerForPath(filePath: string): string {
		const { getLayer } = require("@/utils/joy-zoning")
		return getLayer(filePath)
	}

	/**
	 * V202: Manual Trigger for Sovereign Sweep.
	 */
	public async runGarbageCollectorSweep(
		files: string[],
	): Promise<{ fixedCount: number; remainingErrors: string[]; repairLog: string[] }> {
		return this.garbageCollector.sweep(files)
	}

	/**
	 * V202: Manual Trigger for AST Repair.
	 */
	public async applyDiagnosticFix(diag: ForensicDiagnostic): Promise<boolean> {
		return this.refactorHealer.applyDiagnosticFix(diag, this.spiderEngine)
	}

	/**
	 * V226: Forensic Impact Analysis.
	 * Returns a summary of all files modified in the current session.
	 */
	public getSessionImpactSummary(): string {
		const registry = this.stabilityMonitor.getForensicRegistry()
		const summary: string[] = []

		for (const [p, m] of registry.entries()) {
			if (m.writes > 0) {
				const rel = path.relative(this.cwd, p)
				if (rel.startsWith(".wiki/")) continue
				summary.push(
					`- \`${rel}\` (${m.writes} writes, +${Math.round(m.linesAdded)}/-${Math.round(m.linesDeleted)} lines)`,
				)
			}
		}

		return summary.length > 0 ? summary.join("\n") : "_No code changes detected in the primary substrate._"
	}

	/**

	 * V225: Sovereign Forensic Gate (PASSIVE).
	 * Verifies if the Knowledge Ledger has been updated. Returns an advisory instead of blocking.
	 */
	public async checkForensicCompliance(): Promise<{ compliant: boolean; reason?: string; advisory?: string }> {
		const wikiPath = path.resolve(this.cwd, ".wiki")
		try {
			await fs.access(wikiPath)
		} catch {
			return { compliant: true } // No wiki, no enforcement
		}

		const registry = this.stabilityMonitor.getForensicRegistry()
		const changelogPath = path.resolve(this.cwd, ".wiki/changelog.md")
		const metrics = this.stabilityMonitor.getMetrics(changelogPath)

		if (!metrics || metrics.writes === 0) {
			return {
				compliant: false,
				advisory:
					"💡 [FORENSIC_ADVISORY]: The Knowledge Ledger (`.wiki/changelog.md`) has not been updated in this session. Consider documenting your changes before completion.",
			}
		}

		// V228: Strict Structural Verification
		const modifiedFiles: string[] = []
		for (const [p, m] of registry.entries()) {
			if (m.writes > 0 && !p.startsWith(".wiki") && !p.includes(".dietcode")) {
				modifiedFiles.push(p)
			}
		}

		if (modifiedFiles.length > 0) {
			try {
				const changelogContent = await fs.readFile(changelogPath, "utf-8")
				const missingCitations: string[] = []

				for (const f of modifiedFiles) {
					if (!changelogContent.toLowerCase().includes(f.toLowerCase())) {
						missingCitations.push(f)
					}
				}

				if (missingCitations.length > 0) {
					return {
						compliant: false,
						advisory: `💡 [FORENSIC_ADVISORY]: ${missingCitations.length} modified file(s) are missing citations in the Knowledge Ledger. Documentation alignment is recommended.`,
					}
				}
			} catch {
				// Non-fatal advisory failure
			}
		}

		return { compliant: true }
	}
}
