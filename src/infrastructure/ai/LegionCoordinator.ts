/**
 * [LAYER: INFRASTRUCTURE]
 */
import { createHash } from "node:crypto"
import type { IntentClassification } from "@shared/audit/types"
import * as path from "path"
import { v4 as uuidv4 } from "uuid"
import { Logger } from "@/shared/services/Logger"
import { dbPool } from "../db/BufferedDbPool"
import { getPersistentDb } from "../db/Config"
import {
	type CanonicalLegionSpecialistRole,
	type EffectiveAgentSwarmFeatureState,
	type LegionFormationStrategy,
	type LegionSpecialistRole,
	normalizeLegionSpecialistRole,
	resolveEffectiveAgentSwarmState,
} from "./AgentSwarmConfig"
import { hierarchicalDeferCoordinator } from "./HierarchicalDeferCoordinator"

export type { CanonicalLegionSpecialistRole, LegionFormationStrategy, LegionSpecialistRole }
export { normalizeLegionSpecialistRole }

/**
 * Normalizes file paths for reservation keys across multi-root workspaces, Windows backslashes,
 * and inline workspace hints (e.g. `@workspace:path`).
 */
export function normalizeReservationPath(
	file: string,
	cwd: string = process.cwd(),
	workspaceRoots?: Array<{ name?: string; path: string }>,
): string {
	if (!file || !file.trim()) return ""
	let clean = file.trim()
	const match = clean.match(/^@([^:/]+)[:/](.*)$/)
	if (match) {
		const hint = match[1]
		const subpath = match[2]
		if (workspaceRoots?.length) {
			const matchingRoot = workspaceRoots.find((r) => {
				const rName = r.name?.toLowerCase()
				const h = hint.toLowerCase()
				if (rName === h) return true
				const rPath = r.path.replace(/\\/g, "/").toLowerCase()
				return rPath.endsWith(`/${h}`) || path.basename(rPath) === h
			})
			if (matchingRoot) {
				clean = path.resolve(matchingRoot.path, subpath)
			} else {
				clean = subpath
			}
		} else {
			clean = subpath
		}
	}
	clean = clean.replace(/\\/g, "/")
	const resolved = path.isAbsolute(clean) ? path.normalize(clean) : path.resolve(cwd, clean)
	let posix = resolved.replace(/\\/g, "/")
	if (posix.length > 1 && posix.endsWith("/")) {
		posix = posix.slice(0, -1)
	}
	return process.platform === "win32" ? posix.toLowerCase() : posix
}

export type SubagentCategoryType = "worker" | "verifier" | "researcher"
export type LegionExecutionStageName = "leadAndRecon" | "parallelExecution" | "verificationAndHardening"
export type LegionMemberStatus = "pending" | "running" | "deferred" | "completed" | "failed" | "rerouted"

export interface LegionSpecialistDescriptor {
	role: LegionSpecialistRole
	title: string
	codename: string
	subagentType: SubagentCategoryType
	description: string
	capabilities: string[]
	preferredLayers: Array<"domain" | "core" | "infrastructure" | "ui" | "plumbing">
	defaultExecutionBoundary: "before_turn" | "safe_boundary" | "immediate"
	keywords: Array<{ terms: string[]; weight: number }>
	filePatterns: RegExp[]
}

export interface LegionSpecialistAssignment {
	assignmentId: string
	role: LegionSpecialistRole
	title: string
	codename: string
	subagentType: SubagentCategoryType
	confidence: number
	score: number
	rationale: string
	focusObjective: string
	assignedFiles: string[]
	executionOrder: "parallel" | "sequential_after_workers" | "lead"
	recommendedDeferBoundary: "before_turn" | "safe_boundary" | "immediate"
}

export interface LegionClassificationInput {
	taskDescription: string
	parentFocus?: string
	targetFiles?: string[]
	strategy?: LegionFormationStrategy
	maxSpecialists?: number
	preferredRoles?: LegionSpecialistRole[]
	excludeRoles?: LegionSpecialistRole[]
}

export interface LegionClassificationResult {
	classificationId: string
	primaryIntent: IntentClassification
	complexityScore: number
	recommendedStrategy: LegionFormationStrategy
	appliedStrategy: LegionFormationStrategy
	primarySpecialist: LegionSpecialistAssignment
	formationRoster: LegionSpecialistAssignment[]
	executionStages: {
		leadAndRecon: LegionSpecialistAssignment[]
		parallelExecution: LegionSpecialistAssignment[]
		verificationAndHardening: LegionSpecialistAssignment[]
	}
	classificationSummary: string
	timestamp: number
}

export interface SpawnedLegionMember {
	assignment: LegionSpecialistAssignment
	streamId: string
	taskId: string
	reservedFiles: string[]
	reservationWarning?: string
	status?: LegionMemberStatus
	stage?: LegionExecutionStageName
	resultSummary?: string
	failureReason?: string
	reroutedToStreamId?: string
	completedAt?: number
	/** 1-based attempt counter for this specialist slot; failover replacements increment it. */
	attempt?: number
}

/** Maximum attempts per specialist slot (initial attempt + one bounded failover) — prevents unbounded reroute loops. */
export const LEGION_MAX_ATTEMPTS_PER_SLOT = 2

export interface LegionStageBarrierStatus {
	stage: LegionExecutionStageName
	status: "empty" | "blocked_by_prior_stage" | "ready" | "in_progress" | "completed" | "failed"
	memberStreamIds: string[]
	readyStreamIds: string[]
	completedStreamIds: string[]
	failedStreamIds: string[]
}

export interface LegionStageProgressionStatus {
	formationId: string
	currentActiveStage: LegionExecutionStageName | "completed"
	stages: {
		leadAndRecon: LegionStageBarrierStatus
		parallelExecution: LegionStageBarrierStatus
		verificationAndHardening: LegionStageBarrierStatus
	}
	readyToExecuteMembers: SpawnedLegionMember[]
	leadAndReconHandOffContext: string[]
	/** Completed work from prior stages, for the next eligible specialist. */
	priorStageHandoffContext: string[]
	allStagesCompleted: boolean
	hasFailures: boolean
}

export interface LegionSynthesisReport {
	formationId: string
	parentStreamId: string
	objective: string
	overallStatus: LegionFormationManifest["status"]
	stageProgression: LegionStageProgressionStatus
	completedMembers: Array<{
		codename: string
		role: LegionSpecialistRole
		streamId: string
		stage: LegionExecutionStageName
		summary: string
		reservedFiles: string[]
	}>
	failedOrReroutedMembers: Array<{
		codename: string
		role: LegionSpecialistRole
		streamId: string
		failureReason: string
		reroutedToStreamId?: string
	}>
	pendingMembers: Array<{
		codename: string
		role: LegionSpecialistRole
		streamId: string
		stage: LegionExecutionStageName
	}>
	synthesizedMarkdown: string
	timestamp: number
}

export interface LegionFormationManifest {
	formationId: string
	parentStreamId: string
	objective: string
	classification: LegionClassificationResult
	members: SpawnedLegionMember[]
	status: "active" | "deferred" | "completed" | "partial_failure"
	stageProgression?: LegionStageProgressionStatus
	createdAt: number
	updatedAt: number
}

export interface FormLegionOptions extends LegionClassificationInput {
	/** Automatically reserve assigned target files on each specialist's stream when non-overlapping. */
	reserveAssignedFiles?: boolean
	/** Allow manual/explicit invocation even when global Legion toggle is off. */
	forceEnable?: boolean
	/** Optional pre-resolved feature state. */
	resolvedFeatureState?: EffectiveAgentSwarmFeatureState
}

const UX_SPECIALIST_DESCRIPTOR_BASE: Omit<LegionSpecialistDescriptor, "role"> = {
	title: "World-Class UX & Ergonomics Specialist",
	codename: "AESTHETE-UX",
	subagentType: "worker",
	description:
		"Crafts approachable, responsive UI components, settings navigation, progressive disclosure, accessibility, and human-centered interaction flows.",
	capabilities: [
		"webview_react_components",
		"ergonomic_navigation",
		"progressive_disclosure",
		"accessibility_a11y",
		"interactive_presets",
	],
	preferredLayers: ["ui"],
	defaultExecutionBoundary: "safe_boundary",
	keywords: [
		{
			terms: [
				"ux",
				"ui",
				"webview",
				"ergonomic",
				"ergonomics",
				"navigation",
				"component",
				"react",
				"view",
				"section",
				"button",
				"switch",
				"slider",
				"modal",
				"accessibility",
			],
			weight: 3.2,
		},
		{
			terms: ["frontend", "css", "tailwind", "layout", "preset", "search", "filter", "approachab", "worldclass"],
			weight: 2.2,
		},
	],
	filePatterns: [/webview-ui\//i, /\.tsx$/i, /\.css$/i, /components\//i, /context\//i],
}

/**
 * Canonical Registry of Legion Specialist Archetypes.
 * Mirrors industry-standard multi-agent specialist taxonomies (Architecture, Implementation,
 * Security/Hardening, Verification/QA, Deep Recon, UI/Ergonomics, and Data/State Persistence).
 */
export const LEGION_SPECIALIST_REGISTRY: Record<LegionSpecialistRole, LegionSpecialistDescriptor> = {
	legion_architect: {
		role: "legion_architect",
		title: "Systems & Protocol Architect",
		codename: "CENTURION-ARCH",
		subagentType: "researcher",
		description:
			"Designs cross-layer contracts, protobuf/schema definitions, module boundaries, and structural refactoring plans.",
		capabilities: [
			"contract_design",
			"schema_evolution",
			"layer_boundary_enforcement",
			"dependency_decomposition",
			"roadmap_synthesis",
		],
		preferredLayers: ["domain", "core", "infrastructure"],
		defaultExecutionBoundary: "before_turn",
		keywords: [
			{
				terms: [
					"architect",
					"architecture",
					"design",
					"proto",
					"protobuf",
					"schema",
					"contract",
					"interface",
					"boundary",
					"hierarchy",
					"decompose",
					"orchestrat",
					"coordinator",
					"topology",
				],
				weight: 3.0,
			},
			{
				terms: ["refactor", "restructure", "modular", "layer", "joy-zoning", "decouple", "system", "spec"],
				weight: 2.0,
			},
		],
		filePatterns: [/\.proto$/i, /types\.ts$/i, /schema/i, /orchestrat/i, /coordinator/i, /config\.ts$/i],
	},
	legion_implementer: {
		role: "legion_implementer",
		title: "Core Feature & Runtime Implementer",
		codename: "VANGUARD-IMPL",
		subagentType: "worker",
		description:
			"Executes production code changes, feature implementation, service wiring, and algorithmic logic across core and infrastructure modules.",
		capabilities: [
			"feature_implementation",
			"service_integration",
			"handler_wiring",
			"runtime_execution",
			"refactoring_execution",
		],
		preferredLayers: ["core", "infrastructure", "domain"],
		defaultExecutionBoundary: "safe_boundary",
		keywords: [
			{
				terms: [
					"implement",
					"create",
					"build",
					"add",
					"introduce",
					"feature",
					"handler",
					"service",
					"executor",
					"controller",
					"wire",
					"integrate",
				],
				weight: 2.8,
			},
			{
				terms: ["update", "modify", "support", "extend", "function", "method", "class", "module", "pipeline"],
				weight: 1.8,
			},
		],
		filePatterns: [/src\/core\//i, /src\/infrastructure\//i, /src\/services\//i, /Handler\.ts$/i, /Executor\.ts$/i],
	},
	legion_Trends_ux: {
		role: "legion_Trends_ux",
		...UX_SPECIALIST_DESCRIPTOR_BASE,
	},
	legion_ux_ergonomics: {
		role: "legion_ux_ergonomics",
		...UX_SPECIALIST_DESCRIPTOR_BASE,
	},
	legion_hardener: {
		role: "legion_hardener",
		title: "Resilience, Security & Failure-Mode Hardener",
		codename: "AEGIS-HARDEN",
		subagentType: "worker",
		description:
			"Identifies critical weakpoints, concurrency races, unbounded memory growth, and security leaks, remediating them with structural root-cause fixes.",
		capabilities: [
			"concurrency_locking",
			"failure_mode_remediation",
			"input_clamping_validation",
			"security_sanitization",
			"circuit_breaker_isolation",
		],
		preferredLayers: ["infrastructure", "core", "plumbing"],
		defaultExecutionBoundary: "safe_boundary",
		keywords: [
			{
				terms: [
					"harden",
					"hardening",
					"resilient",
					"resilience",
					"robust",
					"security",
					"failure mode",
					"weakpoint",
					"vulnerability",
					"race condition",
					"deadlock",
					"mutex",
					"barrier",
				],
				weight: 3.2,
			},
			{
				terms: [
					"fix",
					"bug",
					"patch",
					"remediate",
					"clamp",
					"sanitize",
					"guard",
					"idempotent",
					"timeout",
					"recovery",
					"leak",
				],
				weight: 2.2,
			},
		],
		filePatterns: [/Mutex/i, /Guard/i, /Security/i, /Defer/i, /Pool/i, /Orchestrator/i],
	},
	legion_verifier: {
		role: "legion_verifier",
		title: "Adversarial QA & Verification Specialist",
		codename: "SENTINEL-QA",
		subagentType: "verifier",
		description:
			"Executes unit/integration test suites, designs edge-case regression tests, and performs evidence-backed post-completion verification.",
		capabilities: [
			"unit_test_authoring",
			"edge_case_verification",
			"adversarial_completion_review",
			"regression_validation",
			"coverage_auditing",
		],
		preferredLayers: ["core", "infrastructure", "ui"],
		defaultExecutionBoundary: "before_turn",
		keywords: [
			{
				terms: [
					"test",
					"tests",
					"testing",
					"verify",
					"verification",
					"validate",
					"validation",
					"spec",
					"suite",
					"assert",
					"mocha",
					"vitest",
					"chai",
					"review",
				],
				weight: 3.2,
			},
			{
				terms: ["regression", "edge case", "coverage", "audit", "check", "lint", "typecheck", "smoke", "prove"],
				weight: 2.2,
			},
		],
		filePatterns: [/\.test\.ts$/i, /\.test\.tsx$/i, /\.spec\.ts$/i, /__tests__\//i, /Review\.ts$/i],
	},
	legion_researcher: {
		role: "legion_researcher",
		title: "Deep Codebase Recon & Forensics Specialist",
		codename: "ORACLE-RECON",
		subagentType: "researcher",
		description:
			"Performs deep static analysis, call-graph tracing, root-cause forensics, and impact discovery across large workspaces before mutation.",
		capabilities: [
			"call_graph_tracing",
			"root_cause_forensics",
			"blast_radius_mapping",
			"pattern_discovery",
			"dependency_auditing",
		],
		preferredLayers: ["domain", "core", "infrastructure", "ui"],
		defaultExecutionBoundary: "immediate",
		keywords: [
			{
				terms: [
					"investigate",
					"investigation",
					"analyze",
					"analysis",
					"explore",
					"search",
					"find",
					"trace",
					"understand",
					"explain",
					"forensic",
					"diagnose",
				],
				weight: 3.0,
			},
			{
				terms: ["dig deeper", "deeply investigate", "audit", "inspect", "locate", "discover", "map", "survey"],
				weight: 2.2,
			},
		],
		filePatterns: [],
	},
	legion_data_steward: {
		role: "legion_data_steward",
		title: "Persistence, State & Database Specialist",
		codename: "KEEPER-STATE",
		subagentType: "worker",
		description:
			"Manages SQLite buffered pools, durable checkpoints, state-keys synchronization, migrations, and cross-session storage integrity.",
		capabilities: [
			"sqlite_buffered_persistence",
			"state_manager_sync",
			"checkpoint_serialization",
			"query_optimization",
			"conflict_upsert_safety",
		],
		preferredLayers: ["infrastructure", "core"],
		defaultExecutionBoundary: "safe_boundary",
		keywords: [
			{
				terms: [
					"database",
					"db",
					"sqlite",
					"sql",
					"dbpool",
					"buffereddbpool",
					"state-keys",
					"statemanager",
					"storage",
					"persist",
					"persistence",
					"checkpoint",
					"memory",
				],
				weight: 3.2,
			},
			{
				terms: ["upsert", "table", "query", "cache", "flush", "transaction", "migration", "state"],
				weight: 2.0,
			},
		],
		filePatterns: [/db\//i, /storage\//i, /state-keys\.ts$/i, /StateManager\.ts$/i, /Pool\.ts$/i],
	},
}

const REFERENCED_FILE_REGEX = /\b(?:src|webview-ui|proto|scripts|cli|packages)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g

/**
 * LegionCoordinator implements the "Legion" — a deterministic, multi-signal specialist
 * agent classification, formation, and delegation engine integrated into the Agent Swarm
 * auxiliary capability suite.
 *
 * Key Capabilities:
 * 1. Multi-Signal Task & Delegation Classification:
 *    Evaluates task prompts, parent stream focus, referenced file paths, architectural layers,
 *    and structural complexity to score and rank specialist archetypes with transparent rationales.
 * 2. Adaptive Formation Strategies (`adaptive`, `tactical_strike`, `balanced_squad`, `full_legion`, `verification_heavy`):
 *    Automatically scales from a single high-precision specialist for focused tasks up to a
 *    coordinated multi-specialist formation (Recon/Architect -> Parallel Implementation/UX/Hardening -> QA Verifier).
 * 3. Safe Hierarchical Delegation & File Partitioning:
 *    Respects `HierarchicalDeferCoordinator` parent suspension barriers (`acceptingNewWork`),
 *    spawns independent child streams for each specialist, partitions target files to prevent
 *    write collisions, and synchronizes the parent stream's `RollingRoadmapSnapshot`.
 * 4. Remedial Specialist Routing:
 *    Maps `CriticalCompletionReview` confirmed defects (`demonstrable_defect`, `reproducible_failure`,
 *    `unsatisfied_requirement`) directly to the appropriate remediation specialist.
 */
export class LegionCoordinator {
	private async storeRecord(streamId: string, key: string, value: unknown): Promise<void> {
		await dbPool.push({
			type: "upsert",
			table: "agent_memory",
			conflictTarget: ["streamId", "key"],
			where: [
				{ column: "streamId", value: streamId },
				{ column: "key", value: key },
			],
			values: {
				streamId,
				key,
				value: JSON.stringify(value),
				updatedAt: Date.now(),
			},
			layer: "infrastructure",
		})
	}

	private async recallRecord<T>(streamId: string, key: string): Promise<T | null> {
		const found = await dbPool.selectOne(
			"agent_memory",
			[
				{ column: "streamId", value: streamId },
				{ column: "key", value: key },
			],
			streamId,
		)
		if (!found?.value) return null
		try {
			return JSON.parse(found.value) as T
		} catch {
			return null
		}
	}

	private formationLocks = new Map<string, Promise<void>>()

	/** Serializes read-modify-write cycles on a formation manifest so concurrent sibling events never lose updates. */
	private async withFormationLock<T>(formationId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.formationLocks.get(formationId) ?? Promise.resolve()
		let release!: () => void
		const current = new Promise<void>((resolve) => {
			release = resolve
		})
		const chained = previous.then(() => current)
		this.formationLocks.set(formationId, chained)
		await previous
		try {
			return await fn()
		} finally {
			release()
			if (this.formationLocks.get(formationId) === chained) {
				this.formationLocks.delete(formationId)
			}
		}
	}

	/** Reads a raw agent_memory string (stream summaries/failure reasons are stored unencoded). */
	private async recallRawText(streamId: string, key: string): Promise<string | undefined> {
		const found = await dbPool.selectOne(
			"agent_memory",
			[
				{ column: "streamId", value: streamId },
				{ column: "key", value: key },
			],
			streamId,
		)
		if (!found?.value) return undefined
		try {
			const parsed = JSON.parse(found.value)
			return typeof parsed === "string" ? parsed : String(found.value)
		} catch {
			return String(found.value)
		}
	}

	public getSpecialistDescriptor(role: LegionSpecialistRole): LegionSpecialistDescriptor {
		return LEGION_SPECIALIST_REGISTRY[role] ?? LEGION_SPECIALIST_REGISTRY[normalizeLegionSpecialistRole(role)]
	}

	public listSpecialistDescriptors(): LegionSpecialistDescriptor[] {
		return (Object.values(LEGION_SPECIALIST_REGISTRY) as LegionSpecialistDescriptor[]).filter(
			(d) => d.role !== "legion_ux_ergonomics",
		)
	}

	public getStageForExecutionOrder(order: LegionSpecialistAssignment["executionOrder"]): LegionExecutionStageName {
		if (order === "lead") return "leadAndRecon"
		if (order === "sequential_after_workers") return "verificationAndHardening"
		return "parallelExecution"
	}

	public extractTargetFiles(text: string, explicitFiles?: string[]): string[] {
		const found = new Set<string>()
		if (explicitFiles) {
			for (const file of explicitFiles) {
				if (file && file.trim()) {
					found.add(file.trim().replace(/\\/g, "/"))
				}
			}
		}
		for (const match of text.matchAll(REFERENCED_FILE_REGEX)) {
			const cleaned = match[0].replace(/[),.;:]+$/, "").replace(/\\/g, "/")
			found.add(cleaned)
		}
		return [...found]
	}

	private inferPrimaryIntent(text: string): IntentClassification {
		const lower = text.toLowerCase()
		const intentScores: Array<{ intent: IntentClassification; score: number }> = [
			{
				intent: "CREATE",
				score: this.countMatches(lower, ["create", "implement", "introduce", "build", "add", "new", "spawn", "form"]),
			},
			{
				intent: "FIX",
				score: this.countMatches(lower, ["fix", "bug", "repair", "patch", "remediate", "harden", "resolve", "weakpoint"]),
			},
			{
				intent: "REFACTOR",
				score: this.countMatches(lower, ["refactor", "restructure", "decompose", "clean", "tidy", "consolidate"]),
			},
			{
				intent: "INVESTIGATE",
				score: this.countMatches(lower, ["investigate", "audit", "analyze", "review", "inspect", "dig deeper"]),
			},
			{
				intent: "TEST",
				score: this.countMatches(lower, ["test", "verify", "validate", "coverage", "spec", "suite"]),
			},
			{
				intent: "CONFIGURE",
				score: this.countMatches(lower, ["configure", "config", "setting", "toggle", "option", "preset"]),
			},
			{
				intent: "DELETE",
				score: this.countMatches(lower, ["delete", "remove", "prune", "deprecate"]),
			},
		]
		intentScores.sort((a, b) => b.score - a.score)
		return intentScores[0] && intentScores[0].score > 0 ? intentScores[0].intent : "GENERAL"
	}

	private countMatches(normalizedText: string, terms: string[]): number {
		let count = 0
		for (const term of terms) {
			const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")
			const regex = new RegExp(`\\b${escaped}`, "gi")
			const matches = normalizedText.match(regex)
			if (matches) {
				count += matches.length
			}
		}
		return count
	}

	private matchesRoleSet(role: LegionSpecialistRole, roleSet: Set<LegionSpecialistRole>): boolean {
		if (roleSet.has(role)) return true
		const canonical = normalizeLegionSpecialistRole(role)
		if (roleSet.has(canonical)) return true
		if (canonical === "legion_ux_ergonomics" && roleSet.has("legion_Trends_ux")) return true
		return false
	}

	/**
	 * Deterministic multi-signal classification engine that evaluates a task description,
	 * parent focus, target files, and formation strategy to select and rank the optimal
	 * Legion specialist agents.
	 */
	public classifyTaskForLegion(input: LegionClassificationInput): LegionClassificationResult {
		const combinedText = `${input.parentFocus ?? ""}\n${input.taskDescription ?? ""}`.trim()
		const normalized = combinedText.toLowerCase()
		const targetFiles = this.extractTargetFiles(combinedText, input.targetFiles)
		const primaryIntent = this.inferPrimaryIntent(combinedText)

		const excludeSet = new Set<LegionSpecialistRole>(input.excludeRoles ?? [])
		const preferredSet = new Set<LegionSpecialistRole>(input.preferredRoles ?? [])

		const rawScores: Array<{
			descriptor: LegionSpecialistDescriptor
			score: number
			matchedSignals: string[]
			matchedFiles: string[]
		}> = []

		for (const baseDescriptor of this.listSpecialistDescriptors()) {
			if (this.matchesRoleSet(baseDescriptor.role, excludeSet)) continue

			// If caller explicitly requested canonical "legion_ux_ergonomics", honor that role identifier
			const descriptor =
				baseDescriptor.role === "legion_Trends_ux" &&
				preferredSet.has("legion_ux_ergonomics") &&
				!preferredSet.has("legion_Trends_ux")
					? LEGION_SPECIALIST_REGISTRY.legion_ux_ergonomics
					: baseDescriptor

			let score = 0
			const matchedSignals: string[] = []
			const matchedFiles: string[] = []

			// 1. Keyword signal scoring
			for (const group of descriptor.keywords) {
				for (const term of group.terms) {
					const hits = this.countMatches(normalized, [term])
					if (hits > 0) {
						// Diminishing returns for repeated mentions of the same keyword
						const contribution = group.weight * (1 + Math.min(3, hits - 1) * 0.35)
						score += contribution
						if (matchedSignals.length < 5) {
							matchedSignals.push(term)
						}
					}
				}
			}

			// 2. Target file pattern scoring
			for (const file of targetFiles) {
				if (descriptor.filePatterns.some((pattern) => pattern.test(file))) {
					score += 3.5
					matchedFiles.push(file)
				}
			}

			// 3. Intent alignment bonus
			if (primaryIntent === "CREATE" && descriptor.role === "legion_implementer") score += 2.0
			if (primaryIntent === "FIX" && descriptor.role === "legion_hardener") score += 2.0
			if (primaryIntent === "TEST" && descriptor.role === "legion_verifier") score += 2.5
			if (primaryIntent === "INVESTIGATE" && descriptor.role === "legion_researcher") score += 2.0
			if (primaryIntent === "REFACTOR" && descriptor.role === "legion_architect") score += 2.0

			// 4. Explicit caller preference bonus
			if (this.matchesRoleSet(descriptor.role, preferredSet)) {
				score += 6.0
				matchedSignals.push("explicit_preference")
			}

			rawScores.push({
				descriptor,
				score: Number(score.toFixed(2)),
				matchedSignals,
				matchedFiles,
			})
		}

		rawScores.sort((a, b) => b.score - a.score)

		// Fallback if prompt had zero specific keywords: default to implementer
		if (rawScores.length > 0 && rawScores[0].score === 0) {
			const implIdx = rawScores.findIndex((r) => r.descriptor.role === "legion_implementer")
			if (implIdx >= 0) {
				rawScores[implIdx].score = 2.0
				rawScores[implIdx].matchedSignals.push("default_implementation_fallback")
				rawScores.sort((a, b) => b.score - a.score)
			}
		}

		// Calculate structural complexity score (1.0 - 10.0)
		const activeDomainCount = rawScores.filter((r) => r.score >= 3.0).length
		const lengthFactor = Math.min(3.0, combinedText.length / 250)
		const fileFactor = Math.min(3.0, targetFiles.length * 0.6)
		const complexityScore = Number(
			Math.max(1.0, Math.min(10.0, 1.0 + activeDomainCount * 1.3 + lengthFactor + fileFactor)).toFixed(1),
		)

		// Determine recommended strategy vs applied strategy
		const hasTestKeywords = /\b(?:test(?:\s+project)?|verify|verification|validate)\b/i.test(combinedText)
		const recommendedStrategy: LegionFormationStrategy =
			primaryIntent === "TEST" || primaryIntent === "FIX" || hasTestKeywords
				? "verification_heavy"
				: complexityScore < 3.2
					? "tactical_strike"
					: complexityScore >= 7.2
						? "full_legion"
						: "balanced_squad"

		const requestedStrategy = input.strategy ?? "adaptive"
		const appliedStrategy: LegionFormationStrategy =
			requestedStrategy === "adaptive" ? recommendedStrategy : requestedStrategy

		const configuredMax = Math.max(1, Math.min(8, input.maxSpecialists ?? 4))
		let targetRosterSize = configuredMax
		if (appliedStrategy === "tactical_strike") {
			targetRosterSize = 1
		} else if (appliedStrategy === "balanced_squad") {
			targetRosterSize = Math.min(configuredMax, Math.max(2, Math.min(3, activeDomainCount || 2)))
		} else if (appliedStrategy === "verification_heavy") {
			targetRosterSize = Math.min(configuredMax, Math.max(2, Math.min(4, (activeDomainCount || 1) + 1)))
		} else if (appliedStrategy === "full_legion") {
			targetRosterSize = Math.min(configuredMax, Math.max(3, activeDomainCount || 4))
		}

		// Select specialists for the formation roster
		const selectedEntries = rawScores.filter((r) => r.score > 0).slice(0, targetRosterSize)
		if (selectedEntries.length === 0 && rawScores.length > 0) {
			selectedEntries.push(rawScores[0])
		}

		// Ensure verification_heavy or multi-specialist formations include a verifier when appropriate
		if (
			(appliedStrategy === "verification_heavy" || (appliedStrategy === "full_legion" && targetRosterSize >= 3)) &&
			!this.matchesRoleSet("legion_verifier", excludeSet) &&
			!selectedEntries.some((e) => e.descriptor.role === "legion_verifier")
		) {
			const verifierEntry = rawScores.find((r) => r.descriptor.role === "legion_verifier")
			if (verifierEntry) {
				if (selectedEntries.length >= targetRosterSize && selectedEntries.length > 1) {
					selectedEntries[selectedEntries.length - 1] = {
						...verifierEntry,
						score: Math.max(verifierEntry.score, 2.5),
						matchedSignals: [...verifierEntry.matchedSignals, "formation_verification_gate"],
					}
				} else if (selectedEntries.length < configuredMax) {
					selectedEntries.push({
						...verifierEntry,
						score: Math.max(verifierEntry.score, 2.5),
						matchedSignals: [...verifierEntry.matchedSignals, "formation_verification_gate"],
					})
				}
			}
		}

		// Partition target files cleanly across selected specialists so no two parallel workers collide on the same file
		const assignedFileBuckets = this.partitionFilesAcrossSpecialists(
			targetFiles,
			selectedEntries.map((e) => e.descriptor),
		)

		const maxObservedScore = Math.max(1, selectedEntries[0]?.score ?? 1)
		const classificationHash = createHash("sha256")
			.update(`${combinedText}::${appliedStrategy}::${targetRosterSize}`)
			.digest("hex")
			.slice(0, 10)

		const formationRoster: LegionSpecialistAssignment[] = selectedEntries.map((entry, idx) => {
			const d = entry.descriptor
			const confidence = Number(Math.min(0.99, Math.max(0.45, entry.score / (maxObservedScore + 2.0) + 0.32)).toFixed(2))
			const assignedFiles = assignedFileBuckets.get(d.role) ?? []
			const signalSummary =
				entry.matchedSignals.length > 0
					? `signals=[${entry.matchedSignals.slice(0, 4).join(", ")}]`
					: "baseline role alignment"
			const fileSummary =
				assignedFiles.length > 0 ? `, files=[${assignedFiles.map((f) => path.basename(f)).join(", ")}]` : ""

			const executionOrder: LegionSpecialistAssignment["executionOrder"] =
				d.role === "legion_architect" || d.role === "legion_researcher"
					? "lead"
					: d.role === "legion_verifier"
						? "sequential_after_workers"
						: "parallel"

			return {
				assignmentId: `legion-${classificationHash}-${idx + 1}-${d.role}`,
				role: d.role,
				title: d.title,
				codename: d.codename,
				subagentType: d.subagentType,
				confidence,
				score: entry.score,
				rationale: `Selected ${d.title} (${d.codename}) based on ${signalSummary}${fileSummary}.`,
				focusObjective: this.buildSpecialistFocusObjective(d, input.taskDescription, assignedFiles),
				assignedFiles,
				executionOrder,
				recommendedDeferBoundary: d.defaultExecutionBoundary,
			}
		})

		const primarySpecialist = formationRoster[0]
		const executionStages = {
			leadAndRecon: formationRoster.filter((a) => a.executionOrder === "lead"),
			parallelExecution: formationRoster.filter((a) => a.executionOrder === "parallel"),
			verificationAndHardening: formationRoster.filter((a) => a.executionOrder === "sequential_after_workers"),
		}

		const classificationSummary = `Legion Classification [${primaryIntent} | complexity=${complexityScore}/10 | strategy=${appliedStrategy}]: Primary=${primarySpecialist.codename} (${primarySpecialist.role}), Roster=[${formationRoster.map((r) => r.codename).join(" -> ")}]`

		return {
			classificationId: `cls-${classificationHash}`,
			primaryIntent,
			complexityScore,
			recommendedStrategy,
			appliedStrategy,
			primarySpecialist,
			formationRoster,
			executionStages,
			classificationSummary,
			timestamp: Date.now(),
		}
	}

	/**
	 * Partitions target files across specialists without overlap so parallel workers
	 * never contend on the same file reservation.
	 */
	private partitionFilesAcrossSpecialists(
		files: string[],
		specialists: LegionSpecialistDescriptor[],
	): Map<LegionSpecialistRole, string[]> {
		const buckets = new Map<LegionSpecialistRole, string[]>()
		for (const s of specialists) {
			buckets.set(s.role, [])
		}
		if (files.length === 0 || specialists.length === 0) {
			return buckets
		}

		const workerSpecialists = specialists.filter((s) => s.subagentType === "worker")
		const fallbackPool = workerSpecialists.length > 0 ? workerSpecialists : specialists

		files.forEach((file, index) => {
			// Find highest-affinity specialist in the selected roster for this file path
			const matched = specialists.find((s) => s.filePatterns.some((p) => p.test(file)))
			const owner = matched ?? fallbackPool[index % fallbackPool.length]
			buckets.get(owner.role)?.push(file)
		})

		return buckets
	}

	private buildSpecialistFocusObjective(
		descriptor: LegionSpecialistDescriptor,
		taskDescription: string,
		assignedFiles: string[],
	): string {
		const trimmedTask = taskDescription.trim()
		const scopeClause = assignedFiles.length > 0 ? ` Focus Files: ${assignedFiles.join(", ")}.` : ""
		return (
			`[${descriptor.codename} · ${descriptor.title}] Your specialty: ${descriptor.capabilities.join("; ")}. ` +
			`Apply this specialty to the following parent objective; coordinate through your handoff and avoid unrelated changes. ` +
			`Parent objective: ${trimmedTask}.${scopeClause} Report concrete evidence, changed paths, checks, and remaining work.`
		)
	}

	/**
	 * Maps a confirmed defect from `CriticalCompletionReview` to the appropriate
	 * remedial Legion specialist role.
	 */
	public recommendRemediationSpecialist(defect: {
		category: string
		affectedComponent: string
		actualBehavior: string
		recommendedCorrectiveAction: string
	}): LegionSpecialistAssignment {
		const combined = `${defect.affectedComponent} ${defect.actualBehavior} ${defect.recommendedCorrectiveAction}`
		const result = this.classifyTaskForLegion({
			taskDescription: combined,
			targetFiles: this.extractTargetFiles(combined, [defect.affectedComponent]),
			strategy: "tactical_strike",
			maxSpecialists: 1,
		})
		return result.primarySpecialist
	}

	/**
	 * Evaluates the multi-stage DAG barrier status (`leadAndRecon -> parallelExecution -> verificationAndHardening`)
	 * for a Legion formation manifest, determining which stage is currently active, which specialist streams
	 * are ready to execute, and what context from completed lead/recon specialists can be handed off.
	 */
	public evaluateStageProgression(manifest: LegionFormationManifest): LegionStageProgressionStatus {
		const stageNames: LegionExecutionStageName[] = ["leadAndRecon", "parallelExecution", "verificationAndHardening"]

		const membersByStage: Record<LegionExecutionStageName, SpawnedLegionMember[]> = {
			leadAndRecon: [],
			parallelExecution: [],
			verificationAndHardening: [],
		}

		for (const member of manifest.members) {
			const stage = member.stage ?? this.getStageForExecutionOrder(member.assignment.executionOrder)
			membersByStage[stage].push(member)
		}

		const isTerminalResolved = (m: SpawnedLegionMember) => m.status === "completed" || m.status === "rerouted"
		const isFailedUnrerouted = (m: SpawnedLegionMember) => m.status === "failed" && !m.reroutedToStreamId

		const stageStatuses = {} as Record<LegionExecutionStageName, LegionStageBarrierStatus>
		let priorStagesSatisfied = true
		let currentActiveStage: LegionExecutionStageName | "completed" = "completed"

		for (const stage of stageNames) {
			const stageMembers = membersByStage[stage]
			if (stageMembers.length === 0) {
				stageStatuses[stage] = {
					stage,
					status: "empty",
					memberStreamIds: [],
					readyStreamIds: [],
					completedStreamIds: [],
					failedStreamIds: [],
				}
				continue
			}

			const completedStreamIds = stageMembers.filter(isTerminalResolved).map((m) => m.streamId)
			const failedStreamIds = stageMembers.filter(isFailedUnrerouted).map((m) => m.streamId)
			const pendingOrRunning = stageMembers.filter((m) => !isTerminalResolved(m) && !isFailedUnrerouted(m))

			let status: LegionStageBarrierStatus["status"]
			let readyStreamIds: string[] = []

			if (completedStreamIds.length === stageMembers.length) {
				status = "completed"
			} else if (!priorStagesSatisfied) {
				status = "blocked_by_prior_stage"
			} else if (failedStreamIds.length > 0 && pendingOrRunning.length === 0) {
				status = "failed"
			} else {
				const anyRunning = pendingOrRunning.some((m) => m.status === "running")
				status = anyRunning || completedStreamIds.length > 0 ? "in_progress" : "ready"
				// Running and deferred members already have an owner. Exposing them as
				// dispatchable can launch the same assignment twice on a scheduler tick.
				readyStreamIds = pendingOrRunning.filter((m) => !m.status || m.status === "pending").map((m) => m.streamId)
			}

			stageStatuses[stage] = {
				stage,
				status,
				memberStreamIds: stageMembers.map((m) => m.streamId),
				readyStreamIds,
				completedStreamIds,
				failedStreamIds,
			}

			if (status !== "completed") {
				if (currentActiveStage === "completed") {
					currentActiveStage = stage
				}
				priorStagesSatisfied = false
			}
		}

		const readyIds = new Set<string>([
			...stageStatuses.leadAndRecon.readyStreamIds,
			...stageStatuses.parallelExecution.readyStreamIds,
			...stageStatuses.verificationAndHardening.readyStreamIds,
		])
		const readyToExecuteMembers = manifest.members.filter((m) => readyIds.has(m.streamId))

		const leadAndReconHandOffContext = membersByStage.leadAndRecon
			.filter((m) => m.status === "completed" && m.resultSummary)
			.map((m) => `[${m.assignment.codename} (${m.assignment.role})]: ${m.resultSummary}`)
		const activeStageIndex = stageNames.indexOf(currentActiveStage as LegionExecutionStageName)
		const priorStageHandoffContext = stageNames
			.slice(0, activeStageIndex < 0 ? stageNames.length : activeStageIndex)
			.flatMap((stage) => membersByStage[stage])
			.filter((m) => m.status === "completed" && m.resultSummary)
			.map((m) => `[${m.assignment.codename} (${m.assignment.role})]: ${m.resultSummary}`)

		const allStagesCompleted = manifest.members.length > 0 && manifest.members.every((m) => isTerminalResolved(m))
		const hasFailures = manifest.members.some((m) => isFailedUnrerouted(m))

		return {
			formationId: manifest.formationId,
			currentActiveStage,
			stages: stageStatuses,
			readyToExecuteMembers,
			leadAndReconHandOffContext,
			priorStageHandoffContext,
			allStagesCompleted,
			hasFailures,
		}
	}

	/**
	 * Forms and spawns a Legion of specialist child streams and tasks under `parentStreamId`.
	 * Enforces:
	 * 1. Parent suspension barrier (`acceptingNewWork` must be true).
	 * 2. Independent child stream creation (`agent_streams` with `parentId = parentStreamId`) and
	 *    typed task creation (`agent_tasks` with `subagent_type` and `legion_specialist_role`).
	 * 3. Non-overlapping file reservations per specialist stream when `reserveAssignedFiles` is enabled
	 *    (ignoring stale reservations from inactive/completed streams).
	 * 4. Automatic update of the parent stream's `RollingRoadmapSnapshot` and `SwarmSignal` log.
	 */
	public async formAndSpawnLegion(
		parentStreamId: string,
		options: FormLegionOptions,
	): Promise<{
		formed: boolean
		manifest?: LegionFormationManifest
		classification: LegionClassificationResult
		reason?: string
	}> {
		const featureState =
			options.resolvedFeatureState ??
			resolveEffectiveAgentSwarmState({
				streamId: parentStreamId,
				manualInvocation: options.forceEnable,
			})

		const classification = this.classifyTaskForLegion({
			taskDescription: options.taskDescription,
			parentFocus: options.parentFocus,
			targetFiles: options.targetFiles,
			strategy: options.strategy ?? featureState.legionStrategy,
			maxSpecialists: options.maxSpecialists ?? featureState.legionMaxSpecialists,
			preferredRoles: options.preferredRoles,
			excludeRoles: options.excludeRoles,
		})

		if (!featureState.legionEnabled && !options.forceEnable) {
			return {
				formed: false,
				classification,
				reason: "Legion specialist delegation auxiliary feature is disabled.",
			}
		}

		const parentStream = await dbPool.selectOne("agent_streams", { column: "id", value: parentStreamId })
		if (!parentStream) {
			throw new Error(`Parent stream ${parentStreamId} not found`)
		}

		const parentDeferStatus = await hierarchicalDeferCoordinator.getAgentDeferStatus(parentStreamId)
		if (!parentDeferStatus.acceptingNewWork) {
			throw new Error(
				`Parent stream ${parentStreamId} is currently ${parentDeferStatus.state} and not accepting new Legion specialist delegations until resumed.`,
			)
		}

		const allStreams = await dbPool.selectAllFrom("agent_streams")
		const activeStreamIds = new Set(
			allStreams.filter((s: { status: string }) => s.status === "active").map((s: { id: string }) => s.id),
		)

		const formationId = `legion-form-${parentStreamId.slice(0, 8)}-${Date.now()}`
		const members: SpawnedLegionMember[] = []
		const shouldReserve = options.reserveAssignedFiles ?? true

		for (const assignment of classification.formationRoster) {
			const childStreamId = uuidv4()
			const now = Date.now()
			const stage = this.getStageForExecutionOrder(assignment.executionOrder)

			// Direct (non-shadow) insert so the stream row flushes before dependent agent_tasks/agent_memory rows (FK order).
			await dbPool.push({
				type: "insert",
				table: "agent_streams",
				values: {
					id: childStreamId,
					externalId: `${assignment.codename}:${assignment.role}`,
					parentId: parentStreamId,
					focus: assignment.focusObjective,
					status: "active",
					sharedMemoryLayer: parentStream.sharedMemoryLayer ?? null,
					createdAt: now,
				},
				layer: "infrastructure",
			})
			activeStreamIds.add(childStreamId)

			// Persist specialist profile metadata on the child stream
			await this.storeRecord(childStreamId, "legion_specialist_profile", {
				formationId,
				parentStreamId,
				assignment,
				stage,
				spawnedAt: now,
			})

			const taskId = uuidv4()
			await dbPool.push({
				type: "insert",
				table: "agent_tasks",
				values: {
					id: taskId,
					streamId: childStreamId,
					description: assignment.focusObjective,
					status: "pending",
					result: null,
					complexity: classification.complexityScore,
					linkedKnowledgeIds: null,
					metadata: JSON.stringify({
						subagent_type: assignment.subagentType,
						legion_formation_id: formationId,
						legion_specialist_role: assignment.role,
						legion_codename: assignment.codename,
						legion_confidence: assignment.confidence,
						legion_execution_order: assignment.executionOrder,
						legion_stage: stage,
						assigned_files: assignment.assignedFiles,
					}),
					createdAt: now,
				},
				layer: "infrastructure",
			})

			const reservedFiles: string[] = []
			let reservationWarning: string | undefined
			if (shouldReserve && assignment.assignedFiles.length > 0) {
				for (const file of assignment.assignedFiles) {
					const normalizedPath = normalizeReservationPath(file)
					if (!normalizedPath) continue
					// Check ALL holders (not just the first row) and only count reservations owned by currently-active streams.
					const existingReservations = await dbPool.selectWhere("agent_memory", {
						column: "key",
						value: `file_res:${normalizedPath}`,
					})
					const existingRes = existingReservations.find(
						(res: { streamId: string }) =>
							res.streamId !== childStreamId &&
							res.streamId !== parentStreamId &&
							activeStreamIds.has(String(res.streamId)),
					)
					if (existingRes) {
						const warn = `File '${path.basename(file)}' already reserved by active stream ${String(existingRes.streamId).slice(0, 8)}`
						reservationWarning = reservationWarning ? `${reservationWarning}; ${warn}` : warn
					} else {
						await this.storeRecord(childStreamId, `file_res:${normalizedPath}`, String(now))
						reservedFiles.push(file)
					}
				}
			}

			members.push({
				assignment,
				streamId: childStreamId,
				taskId,
				reservedFiles,
				reservationWarning,
				status: "pending",
				stage,
			})
		}

		const manifest: LegionFormationManifest = {
			formationId,
			parentStreamId,
			objective: options.taskDescription,
			classification,
			members,
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}
		manifest.stageProgression = this.evaluateStageProgression(manifest)

		await this.storeRecord(parentStreamId, "last_legion_formation", manifest)
		await this.storeRecord(parentStreamId, `legion_formation:${formationId}`, manifest)

		// Synchronize parent stream's RollingRoadmapSnapshot so HierarchicalDeferCoordinator and CriticalCompletionReview have full visibility
		const existingRoadmap = await this.recallRecord<import("./HierarchicalDeferCoordinator").RollingRoadmapSnapshot>(
			parentStreamId,
			"rolling_roadmap_snapshot",
		)
		const readyActions = manifest.stageProgression.readyToExecuteMembers.map(
			(m) => `Execute [${m.stage}] ${m.assignment.codename} on stream ${m.streamId.slice(0, 8)}`,
		)
		const updatedRoadmap: import("./HierarchicalDeferCoordinator").RollingRoadmapSnapshot = {
			objective: existingRoadmap?.objective ?? parentStream.focus ?? options.taskDescription.slice(0, 120),
			activeChildAssignments: [
				...(existingRoadmap?.activeChildAssignments ?? []),
				...members.map((m) => ({
					childStreamId: m.streamId,
					taskId: m.taskId,
					description: `[${m.assignment.codename}] ${m.assignment.title}: ${m.assignment.focusObjective}`,
					status: "pending" as const,
				})),
			],
			completedWork: existingRoadmap?.completedWork ?? [],
			outstandingWork: [
				...(existingRoadmap?.outstandingWork ?? []),
				...members.map((m) => `${m.assignment.codename} (${m.assignment.role}) -> ${m.assignment.focusObjective}`),
			],
			dependenciesAndBlockers: existingRoadmap?.dependenciesAndBlockers ?? [],
			decisionsMade: [
				...(existingRoadmap?.decisionsMade ?? []),
				`Formed Legion (${formationId}): ${classification.classificationSummary}`,
			],
			nextActions:
				readyActions.length > 0
					? readyActions
					: members.map((m) => `Execute ${m.assignment.codename} on stream ${m.streamId.slice(0, 8)}`),
			synchronizationStatus: "aligned",
			updatedAt: Date.now(),
		}
		await this.storeRecord(parentStreamId, "rolling_roadmap_snapshot", updatedRoadmap)

		Logger.info(
			`[LegionCoordinator] Formed Legion ${formationId} under parent ${parentStreamId.slice(0, 8)} with ${members.length} specialist(s): ${members.map((m) => m.assignment.codename).join(", ")}`,
		)

		return {
			formed: true,
			manifest,
			classification,
		}
	}

	/**
	 * Claim a ready slot under the same lock used for lifecycle transitions.
	 * This protects competing dispatchers in this extension process; it is not a
	 * durable cross-process lease and does not prove the host execution started.
	 */
	public async claimReadySpecialist(streamId: string): Promise<boolean> {
		const profile = await this.getSpecialistProfileForStream(streamId)
		if (!profile) return false
		return this.withFormationLock(profile.formationId, async () => {
			const manifest = await this.recallRecord<LegionFormationManifest>(
				profile.parentStreamId,
				`legion_formation:${profile.formationId}`,
			)
			if (
				!manifest ||
				!this.evaluateStageProgression(manifest).readyToExecuteMembers.some((m) => m.streamId === streamId)
			) {
				return false
			}
			const updated = await this.reconcileSpecialistStreamLifecycleUnlocked(streamId, { status: "running" })
			return (
				updated?.updatedManifest.members.some((member) => member.streamId === streamId && member.status === "running") ??
				false
			)
		})
	}

	/** Read the persisted manifest directly; buffered overlays are not a durability guarantee. */
	public async isClaimDurable(parentStreamId: string, formationId: string, streamId: string): Promise<boolean> {
		await dbPool.flush()
		const db = await getPersistentDb()
		const row = await db
			.selectFrom("agent_memory")
			.select("value")
			.where("streamId", "=", parentStreamId)
			.where("key", "=", `legion_formation:${formationId}`)
			.executeTakeFirst()
		if (!row?.value) return false
		try {
			const manifest = JSON.parse(row.value) as LegionFormationManifest
			return manifest.members.some((member) => member.streamId === streamId && member.status === "running")
		} catch {
			return false
		}
	}

	/** A permanent per-attempt dispatch token, acquired atomically across processes. */
	public async acquireDispatchToken(streamId: string): Promise<boolean> {
		await dbPool.flush()
		const db = await getPersistentDb()
		const result = await db
			.insertInto("agent_memory")
			.values({ streamId, key: "legion_dispatch_token", value: uuidv4(), updatedAt: Date.now() })
			.onConflict((conflict) => conflict.columns(["streamId", "key"]).doNothing())
			.executeTakeFirst()
		return result.numInsertedOrUpdatedRows === 1n
	}

	/** One durable driver per formation; abandoned ownership requires reconciliation. */
	public async acquireFormationDispatchToken(parentStreamId: string, formationId: string): Promise<boolean> {
		await dbPool.flush()
		const db = await getPersistentDb()
		const result = await db
			.insertInto("agent_memory")
			.values({ streamId: parentStreamId, key: `legion_driver:${formationId}`, value: uuidv4(), updatedAt: Date.now() })
			.onConflict((conflict) => conflict.columns(["streamId", "key"]).doNothing())
			.executeTakeFirst()
		return result.numInsertedOrUpdatedRows === 1n
	}

	/** Prevent concurrent processes from forming the same objective twice while allowing settled objectives to re-form. */
	public async acquireAutomaticFormationToken(parentStreamId: string, objective: string): Promise<boolean> {
		await dbPool.flush()
		const db = await getPersistentDb()
		const digest = createHash("sha256").update(objective).digest("hex")
		const key = `legion_auto_formation:${digest}`
		const now = Date.now()
		const token = uuidv4()

		// 1. Check if there is an active in-flight formation
		const lastFormation = await this.recallLastLegionFormation(parentStreamId)
		if (lastFormation && lastFormation.status === "active") {
			const progression = lastFormation.stageProgression ?? this.evaluateStageProgression(lastFormation)
			if (!progression.allStagesCompleted && progression.readyToExecuteMembers.length > 0) {
				return false
			}
		}

		// 2. Try inserting a fresh token. If unowned, this atomically succeeds.
		const result = await db
			.insertInto("agent_memory")
			.values({ streamId: parentStreamId, key, value: token, updatedAt: now })
			.onConflict((conflict) => conflict.columns(["streamId", "key"]).doNothing())
			.executeTakeFirst()
		if (result.numInsertedOrUpdatedRows === 1n) {
			return true
		}

		// 3. If row exists, check if it was just acquired concurrently (within 5 seconds)
		const existing = await db
			.selectFrom("agent_memory")
			.selectAll()
			.where("streamId", "=", parentStreamId)
			.where("key", "=", key)
			.executeTakeFirst()

		if (existing && typeof existing.updatedAt === "number" && now - existing.updatedAt < 5000) {
			// Concurrently acquired by another process/worker in this window
			return false
		}

		// 4. Token belongs to an earlier settled run; atomically renew it
		const updateRes = await db
			.updateTable("agent_memory")
			.set({ value: token, updatedAt: now })
			.where("streamId", "=", parentStreamId)
			.where("key", "=", key)
			.executeTakeFirst()
		return updateRes.numUpdatedRows === 1n
	}

	/**
	 * Reconciles a specialist child stream's completion, failure, or running state with its parent's
	 * `LegionFormationManifest`, DAG stage progression barrier, and `RollingRoadmapSnapshot`.
	 */
	public async reconcileSpecialistStreamLifecycle(
		streamId: string,
		outcome: {
			status: "running" | "completed" | "failed"
			summary?: string
			failureReason?: string
		},
	): Promise<{
		updatedManifest: LegionFormationManifest
		stageProgression: LegionStageProgressionStatus
		newlyUnblockedMembers: SpawnedLegionMember[]
	} | null> {
		const profile = await this.getSpecialistProfileForStream(streamId)
		if (!profile) return null
		return this.withFormationLock(profile.formationId, () =>
			this.reconcileSpecialistStreamLifecycleUnlocked(streamId, outcome),
		)
	}

	private async reconcileSpecialistStreamLifecycleUnlocked(
		streamId: string,
		outcome: {
			status: "running" | "completed" | "failed"
			summary?: string
			failureReason?: string
		},
	): Promise<{
		updatedManifest: LegionFormationManifest
		stageProgression: LegionStageProgressionStatus
		newlyUnblockedMembers: SpawnedLegionMember[]
	} | null> {
		const profile = await this.getSpecialistProfileForStream(streamId)
		if (!profile) return null

		const manifest =
			(await this.recallRecord<LegionFormationManifest>(
				profile.parentStreamId,
				`legion_formation:${profile.formationId}`,
			)) ?? (await this.recallLastLegionFormation(profile.parentStreamId))

		if (!manifest) return null

		const priorProgression = manifest.stageProgression ?? this.evaluateStageProgression(manifest)
		const priorReadyIds = new Set(priorProgression.readyToExecuteMembers.map((m) => m.streamId))

		const memberIdx = manifest.members.findIndex((m) => m.streamId === streamId)
		if (memberIdx < 0) return null

		const member = manifest.members[memberIdx]

		// Idempotency: a repeated terminal event (or any event after a terminal state) must not duplicate roadmap entries.
		// Terminal member states are final: a settled stream can never be resurrected or flipped (e.g. rerouted -> failed).
		if (member.status === "completed" || member.status === "failed" || member.status === "rerouted") {
			return {
				updatedManifest: manifest,
				stageProgression: manifest.stageProgression ?? this.evaluateStageProgression(manifest),
				newlyUnblockedMembers: [],
			}
		}

		const now = Date.now()
		const updatedMember: SpawnedLegionMember = {
			...member,
			status: outcome.status,
			stage: member.stage ?? this.getStageForExecutionOrder(member.assignment.executionOrder),
			...(outcome.summary !== undefined ? { resultSummary: outcome.summary } : {}),
			...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
			...(outcome.status === "completed" || outcome.status === "failed" ? { completedAt: now } : {}),
		}
		manifest.members[memberIdx] = updatedMember

		// Also update the specialist's task in `agent_tasks` if transitioning to completed/failed
		if (outcome.status === "completed" || outcome.status === "failed") {
			await dbPool.push({
				type: "update",
				table: "agent_tasks",
				values: {
					status: outcome.status,
					result: outcome.summary ?? outcome.failureReason ?? null,
				},
				where: { column: "id", value: member.taskId },
				layer: "infrastructure",
			})
		}

		const nextProgression = this.evaluateStageProgression(manifest)
		manifest.stageProgression = nextProgression
		manifest.updatedAt = now

		if (nextProgression.allStagesCompleted) {
			manifest.status = "completed"
		} else if (nextProgression.hasFailures) {
			manifest.status = "partial_failure"
		} else {
			manifest.status = "active"
		}

		// If leadAndRecon just completed and unblocked parallelExecution, enrich downstream task descriptions with lead hand-off context
		const newlyUnblockedMembers = nextProgression.readyToExecuteMembers.filter((m) => !priorReadyIds.has(m.streamId))
		if (newlyUnblockedMembers.length > 0 && nextProgression.leadAndReconHandOffContext.length > 0) {
			const handoffSummary = nextProgression.leadAndReconHandOffContext.join(" | ")
			for (const unblocked of newlyUnblockedMembers) {
				await this.storeRecord(unblocked.streamId, "legion_stage_handoff_context", {
					fromStage: "leadAndRecon",
					handoffSummary,
					receivedAt: now,
				})
			}
		}

		await this.storeRecord(profile.parentStreamId, `legion_formation:${manifest.formationId}`, manifest)
		const lastFormation = await this.recallLastLegionFormation(profile.parentStreamId)
		if (!lastFormation || lastFormation.formationId === manifest.formationId) {
			await this.storeRecord(profile.parentStreamId, "last_legion_formation", manifest)
		}

		// Synchronize parent stream's RollingRoadmapSnapshot
		const existingRoadmap = await this.recallRecord<import("./HierarchicalDeferCoordinator").RollingRoadmapSnapshot>(
			profile.parentStreamId,
			"rolling_roadmap_snapshot",
		)
		if (existingRoadmap) {
			const updatedAssignments = existingRoadmap.activeChildAssignments.map((a) =>
				a.childStreamId === streamId
					? {
							...a,
							status: outcome.status,
						}
					: a,
			)
			const memberTag = `${member.assignment.codename} (${member.assignment.role})`
			const completedEntry =
				outcome.status === "completed"
					? `${memberTag} completed: ${(outcome.summary ?? "Success").slice(0, 160)}`
					: undefined
			const blockerEntry =
				outcome.status === "failed"
					? `${memberTag} failed on stream ${streamId.slice(0, 8)}: ${outcome.failureReason ?? "Unknown failure"}`
					: undefined

			const filteredOutstanding =
				outcome.status === "completed"
					? existingRoadmap.outstandingWork.filter(
							(w) => !w.startsWith(`${member.assignment.codename} (${member.assignment.role}) -> `),
						)
					: existingRoadmap.outstandingWork

			const nextActions = nextProgression.allStagesCompleted
				? ["All Legion specialists completed — synthesize results and run completion verification"]
				: nextProgression.readyToExecuteMembers.map(
						(m) => `Execute [${m.stage}] ${m.assignment.codename} on stream ${m.streamId.slice(0, 8)}`,
					)

			const updatedRoadmap: import("./HierarchicalDeferCoordinator").RollingRoadmapSnapshot = {
				...existingRoadmap,
				activeChildAssignments: updatedAssignments,
				completedWork: completedEntry
					? [...existingRoadmap.completedWork, completedEntry]
					: existingRoadmap.completedWork,
				outstandingWork: filteredOutstanding,
				dependenciesAndBlockers: blockerEntry
					? [...existingRoadmap.dependenciesAndBlockers, blockerEntry]
					: existingRoadmap.dependenciesAndBlockers,
				decisionsMade: [
					...existingRoadmap.decisionsMade,
					`Legion specialist ${member.assignment.codename} (${streamId.slice(0, 8)}) -> ${outcome.status}`,
				],
				nextActions,
				updatedAt: now,
			}
			await this.storeRecord(profile.parentStreamId, "rolling_roadmap_snapshot", updatedRoadmap)
		}

		return {
			updatedManifest: manifest,
			stageProgression: nextProgression,
			newlyUnblockedMembers,
		}
	}

	/**
	 * Adaptive failover & re-routing when a Legion specialist stream fails or encounters a blocker.
	 * Transfers the failed specialist's assigned files and objective to a newly spawned replacement
	 * or peer specialist stream, marks the failed member as `rerouted`, and restores formation progress.
	 */
	public async rerouteFailedSpecialist(
		parentStreamId: string,
		failedStreamId: string,
		options?: {
			replacementRole?: LegionSpecialistRole
			additionalContext?: string
			forceEnable?: boolean
		},
	): Promise<{
		rerouted: boolean
		replacementMember?: SpawnedLegionMember
		updatedManifest?: LegionFormationManifest
		reason?: string
	}> {
		const profile = await this.getSpecialistProfileForStream(failedStreamId)
		if (!profile || profile.parentStreamId !== parentStreamId) {
			return {
				rerouted: false,
				reason: `Stream ${failedStreamId} is not a registered Legion specialist under parent ${parentStreamId}.`,
			}
		}
		return this.withFormationLock(profile.formationId, () =>
			this.rerouteFailedSpecialistUnlocked(parentStreamId, failedStreamId, profile.formationId, options),
		)
	}

	private async rerouteFailedSpecialistUnlocked(
		parentStreamId: string,
		failedStreamId: string,
		formationId: string,
		options?: {
			replacementRole?: LegionSpecialistRole
			additionalContext?: string
			forceEnable?: boolean
		},
	): Promise<{
		rerouted: boolean
		replacementMember?: SpawnedLegionMember
		updatedManifest?: LegionFormationManifest
		reason?: string
	}> {
		const profile = { formationId }

		const manifest =
			(await this.recallRecord<LegionFormationManifest>(parentStreamId, `legion_formation:${profile.formationId}`)) ??
			(await this.recallLastLegionFormation(parentStreamId))
		if (!manifest) {
			return {
				rerouted: false,
				reason: `Legion formation ${profile.formationId} not found for parent ${parentStreamId}.`,
			}
		}

		const parentDeferStatus = await hierarchicalDeferCoordinator.getAgentDeferStatus(parentStreamId)
		if (!parentDeferStatus.acceptingNewWork) {
			throw new Error(
				`Parent stream ${parentStreamId} is currently ${parentDeferStatus.state} and cannot spawn a failover specialist until resumed.`,
			)
		}

		const failedIdx = manifest.members.findIndex((m) => m.streamId === failedStreamId)
		if (failedIdx < 0) {
			return {
				rerouted: false,
				reason: `Failed stream ${failedStreamId} not found in formation ${manifest.formationId}.`,
			}
		}

		const failedMember = manifest.members[failedIdx]

		// Only a failed specialist may be re-routed; re-routing a live one would duplicate in-flight work.
		if (failedMember.status !== "failed") {
			return {
				rerouted: false,
				updatedManifest: manifest,
				reason: `Stream ${failedStreamId} is '${failedMember.status ?? "pending"}', not 'failed'; only failed specialists can be re-routed.`,
			}
		}

		// Idempotency: an already re-routed slot must never spawn a second replacement.
		if (failedMember.reroutedToStreamId) {
			return {
				rerouted: false,
				updatedManifest: manifest,
				reason: `Stream ${failedStreamId} was already re-routed to ${failedMember.reroutedToStreamId}.`,
			}
		}

		// Bounded failover: a slot gets at most LEGION_MAX_ATTEMPTS_PER_SLOT attempts to prevent infinite reroute loops.
		const nextAttempt = (failedMember.attempt ?? 1) + 1
		if (nextAttempt > LEGION_MAX_ATTEMPTS_PER_SLOT) {
			return {
				rerouted: false,
				updatedManifest: manifest,
				reason: `Failover budget exhausted for ${failedMember.assignment.codename} (max ${LEGION_MAX_ATTEMPTS_PER_SLOT} attempts); escalate to the coordinator.`,
			}
		}

		const targetRole = options?.replacementRole ?? failedMember.assignment.role
		const descriptor = this.getSpecialistDescriptor(targetRole)
		const now = Date.now()
		const replacementStreamId = uuidv4()
		const replacementTaskId = uuidv4()
		const stage =
			failedMember.stage ??
			this.getStageForExecutionOrder(
				descriptor.role === "legion_architect" || descriptor.role === "legion_researcher"
					? "lead"
					: descriptor.role === "legion_verifier"
						? "sequential_after_workers"
						: "parallel",
			)

		const failureContext = failedMember.failureReason
			? ` [Failover Recovery from ${failedMember.assignment.codename} (${failedStreamId.slice(0, 8)}): ${failedMember.failureReason}]`
			: ` [Failover Recovery from ${failedMember.assignment.codename} (${failedStreamId.slice(0, 8)})]`
		const extraNotes = options?.additionalContext ? ` ${options.additionalContext}` : ""
		const failoverObjective = `${this.buildSpecialistFocusObjective(descriptor, manifest.objective, failedMember.assignment.assignedFiles)}${failureContext}${extraNotes}`

		const replacementAssignment: LegionSpecialistAssignment = {
			...failedMember.assignment,
			assignmentId: `${failedMember.assignment.assignmentId}-failover-${now.toString(36)}`,
			role: descriptor.role,
			title: descriptor.title,
			codename: descriptor.codename,
			subagentType: descriptor.subagentType,
			focusObjective: failoverObjective,
			rationale: `Adaptive failover specialist replacing failed stream ${failedStreamId.slice(0, 8)} (${failedMember.assignment.codename}).`,
		}

		const parentStream = await dbPool.selectOne("agent_streams", { column: "id", value: parentStreamId })

		// Direct (non-shadow) insert so the stream row flushes before dependent agent_tasks/agent_memory rows (FK order).
		await dbPool.push({
			type: "insert",
			table: "agent_streams",
			values: {
				id: replacementStreamId,
				externalId: `${replacementAssignment.codename}:${replacementAssignment.role}:failover`,
				parentId: parentStreamId,
				focus: failoverObjective,
				status: "active",
				sharedMemoryLayer: parentStream?.sharedMemoryLayer ?? null,
				createdAt: now,
			},
			layer: "infrastructure",
		})

		await this.storeRecord(replacementStreamId, "legion_specialist_profile", {
			formationId: manifest.formationId,
			parentStreamId,
			assignment: replacementAssignment,
			stage,
			reroutedFromStreamId: failedStreamId,
			spawnedAt: now,
		})

		await dbPool.push({
			type: "insert",
			table: "agent_tasks",
			values: {
				id: replacementTaskId,
				streamId: replacementStreamId,
				description: failoverObjective,
				status: "pending",
				result: null,
				complexity: manifest.classification.complexityScore,
				linkedKnowledgeIds: null,
				metadata: JSON.stringify({
					subagent_type: replacementAssignment.subagentType,
					legion_formation_id: manifest.formationId,
					legion_specialist_role: replacementAssignment.role,
					legion_codename: replacementAssignment.codename,
					legion_stage: stage,
					rerouted_from_stream_id: failedStreamId,
					assigned_files: replacementAssignment.assignedFiles,
				}),
				createdAt: now,
			},
			layer: "infrastructure",
		})

		const allStreams = await dbPool.selectAllFrom("agent_streams")
		const activeStreamIds = new Set(
			allStreams.filter((s: { status: string }) => s.status === "active").map((s: { id: string }) => s.id),
		)
		const reservedFiles: string[] = []
		let reservationWarning: string | undefined
		for (const file of replacementAssignment.assignedFiles) {
			const normalizedPath = normalizeReservationPath(file)
			if (!normalizedPath) continue
			const existingReservations = await dbPool.selectWhere("agent_memory", {
				column: "key",
				value: `file_res:${normalizedPath}`,
			})
			const existingRes = existingReservations.find(
				(res: { streamId: string }) =>
					res.streamId !== replacementStreamId &&
					res.streamId !== parentStreamId &&
					activeStreamIds.has(String(res.streamId)),
			)
			if (existingRes) {
				const warn = `File '${path.basename(file)}' already reserved by active stream ${String(existingRes.streamId).slice(0, 8)}`
				reservationWarning = reservationWarning ? `${reservationWarning}; ${warn}` : warn
			} else {
				await this.storeRecord(replacementStreamId, `file_res:${normalizedPath}`, String(now))
				reservedFiles.push(file)
			}
		}

		const replacementMember: SpawnedLegionMember = {
			assignment: replacementAssignment,
			streamId: replacementStreamId,
			taskId: replacementTaskId,
			reservedFiles,
			reservationWarning,
			status: "pending",
			stage,
			attempt: nextAttempt,
		}

		manifest.members[failedIdx] = {
			...failedMember,
			status: "rerouted",
			reroutedToStreamId: replacementStreamId,
			completedAt: failedMember.completedAt ?? now,
		}
		manifest.members.push(replacementMember)
		manifest.stageProgression = this.evaluateStageProgression(manifest)
		manifest.status = manifest.stageProgression.hasFailures ? "partial_failure" : "active"
		manifest.updatedAt = now

		await this.storeRecord(parentStreamId, `legion_formation:${manifest.formationId}`, manifest)
		await this.storeRecord(parentStreamId, "last_legion_formation", manifest)

		// Update parent RollingRoadmapSnapshot
		const existingRoadmap = await this.recallRecord<import("./HierarchicalDeferCoordinator").RollingRoadmapSnapshot>(
			parentStreamId,
			"rolling_roadmap_snapshot",
		)
		if (existingRoadmap) {
			const updatedRoadmap: import("./HierarchicalDeferCoordinator").RollingRoadmapSnapshot = {
				...existingRoadmap,
				activeChildAssignments: [
					...existingRoadmap.activeChildAssignments.map((a) =>
						a.childStreamId === failedStreamId ? { ...a, status: "failed" as const } : a,
					),
					{
						childStreamId: replacementStreamId,
						taskId: replacementTaskId,
						description: `[${replacementAssignment.codename} · Failover] ${failoverObjective}`,
						status: "pending",
					},
				],
				dependenciesAndBlockers: existingRoadmap.dependenciesAndBlockers.filter(
					(b) => !b.includes(failedStreamId.slice(0, 8)),
				),
				decisionsMade: [
					...existingRoadmap.decisionsMade,
					`Adaptive failover: Rerouted ${failedMember.assignment.codename} (${failedStreamId.slice(0, 8)}) -> ${replacementAssignment.codename} (${replacementStreamId.slice(0, 8)})`,
				],
				nextActions: manifest.stageProgression.readyToExecuteMembers.map(
					(m) => `Execute [${m.stage}] ${m.assignment.codename} on stream ${m.streamId.slice(0, 8)}`,
				),
				updatedAt: now,
			}
			await this.storeRecord(parentStreamId, "rolling_roadmap_snapshot", updatedRoadmap)
		}

		Logger.info(
			`[LegionCoordinator] Rerouted failed specialist ${failedStreamId.slice(0, 8)} to replacement ${replacementAssignment.codename} (${replacementStreamId.slice(0, 8)})`,
		)

		return {
			rerouted: true,
			replacementMember,
			updatedManifest: manifest,
		}
	}

	/**
	 * Single lifecycle entry point invoked when a specialist stream settles (completed/failed).
	 * Zero-cost no-op for streams that are not Legion specialists. Performs, in order:
	 * 1. Manifest/DAG-barrier/roadmap reconciliation (idempotent, serialized per formation).
	 * 2. Bounded adaptive failover (only when Legion is enabled for the parent and the slot has budget left).
	 * 3. Synthesis report generation once the formation is finished or stuck on an unrecoverable failure.
	 */
	public async settleSpecialistStream(
		streamId: string,
		outcome: { status: "completed" | "failed"; summary?: string; failureReason?: string },
		options?: { skipFailover?: boolean },
	): Promise<{
		manifest: LegionFormationManifest
		newlyUnblockedMembers: SpawnedLegionMember[]
		failover?: { rerouted: boolean; replacementMember?: SpawnedLegionMember; reason?: string }
		report?: LegionSynthesisReport
	} | null> {
		const profile = await this.getSpecialistProfileForStream(streamId)
		if (!profile) return null

		const reconciled = await this.reconcileSpecialistStreamLifecycle(streamId, outcome)
		if (!reconciled) return null

		let manifest = reconciled.updatedManifest
		let failover: { rerouted: boolean; replacementMember?: SpawnedLegionMember; reason?: string } | undefined

		if (outcome.status === "failed" && !options?.skipFailover) {
			const state = resolveEffectiveAgentSwarmState({ streamId: profile.parentStreamId })
			if (state.legionEnabled) {
				try {
					const res = await this.rerouteFailedSpecialist(profile.parentStreamId, streamId)
					failover = { rerouted: res.rerouted, replacementMember: res.replacementMember, reason: res.reason }
					if (res.updatedManifest) manifest = res.updatedManifest
				} catch (err) {
					// e.g. parent is deferred: leave the failure recorded so a later explicit reroute can recover it.
					failover = { rerouted: false, reason: err instanceof Error ? err.message : String(err) }
				}
			} else {
				failover = { rerouted: false, reason: "Legion is disabled for the parent stream; automatic failover skipped." }
			}
		}

		const progression = manifest.stageProgression ?? this.evaluateStageProgression(manifest)
		const finished =
			progression.allStagesCompleted || (progression.hasFailures && progression.readyToExecuteMembers.length === 0)
		const report = finished
			? ((await this.synthesizeLegionExecutionReport(profile.parentStreamId, manifest.formationId)) ?? undefined)
			: undefined

		return { manifest, newlyUnblockedMembers: reconciled.newlyUnblockedMembers, failover, report }
	}

	/**
	 * Synthesizes an aggregated multi-specialist execution report for the parent coordinator
	 * and `CriticalCompletionReview`, combining stage progression, completed specialist deliverables,
	 * failover/reroute events, and pending work.
	 */
	public async synthesizeLegionExecutionReport(
		parentStreamId: string,
		formationId?: string,
	): Promise<LegionSynthesisReport | null> {
		const manifest = formationId
			? await this.recallRecord<LegionFormationManifest>(parentStreamId, `legion_formation:${formationId}`)
			: await this.recallLastLegionFormation(parentStreamId)
		if (!manifest) return null

		const stageProgression = manifest.stageProgression ?? this.evaluateStageProgression(manifest)
		const completedMembers: LegionSynthesisReport["completedMembers"] = []
		const failedOrReroutedMembers: LegionSynthesisReport["failedOrReroutedMembers"] = []
		const pendingMembers: LegionSynthesisReport["pendingMembers"] = []

		for (const member of manifest.members) {
			const stage = member.stage ?? this.getStageForExecutionOrder(member.assignment.executionOrder)
			const streamSummary = member.resultSummary ?? (await this.recallRawText(member.streamId, "stream_summary"))
			const streamFailure = member.failureReason ?? (await this.recallRawText(member.streamId, "failure_reason"))

			if (member.status === "completed") {
				completedMembers.push({
					codename: member.assignment.codename,
					role: member.assignment.role,
					streamId: member.streamId,
					stage,
					summary: streamSummary ?? "Completed specialist objective.",
					reservedFiles: member.reservedFiles,
				})
			} else if (member.status === "failed" || member.status === "rerouted") {
				failedOrReroutedMembers.push({
					codename: member.assignment.codename,
					role: member.assignment.role,
					streamId: member.streamId,
					failureReason: streamFailure ?? "Specialist stream failed.",
					reroutedToStreamId: member.reroutedToStreamId,
				})
			} else {
				pendingMembers.push({
					codename: member.assignment.codename,
					role: member.assignment.role,
					streamId: member.streamId,
					stage,
				})
			}
		}

		const lines: string[] = [
			`### Legion Synthesis Report (\`${manifest.formationId}\`)`,
			`- **Objective**: ${manifest.objective}`,
			`- **Formation Status**: \`${manifest.status}\` · **Active Stage**: \`${stageProgression.currentActiveStage}\``,
			`- **Strategy**: \`${manifest.classification.appliedStrategy}\` (Complexity: ${manifest.classification.complexityScore}/10)`,
			"",
			"#### 1. Stage Barrier Progression",
			`- **Lead & Recon**: \`${stageProgression.stages.leadAndRecon.status}\` (${stageProgression.stages.leadAndRecon.completedStreamIds.length}/${stageProgression.stages.leadAndRecon.memberStreamIds.length})`,
			`- **Parallel Execution**: \`${stageProgression.stages.parallelExecution.status}\` (${stageProgression.stages.parallelExecution.completedStreamIds.length}/${stageProgression.stages.parallelExecution.memberStreamIds.length})`,
			`- **Verification & Hardening**: \`${stageProgression.stages.verificationAndHardening.status}\` (${stageProgression.stages.verificationAndHardening.completedStreamIds.length}/${stageProgression.stages.verificationAndHardening.memberStreamIds.length})`,
		]

		if (completedMembers.length > 0) {
			lines.push("", "#### 2. Completed Specialist Deliverables")
			for (const c of completedMembers) {
				const filesNote = c.reservedFiles.length > 0 ? ` [Files: ${c.reservedFiles.join(", ")}]` : ""
				lines.push(`- **${c.codename}** (\`${c.role}\` · \`${c.stage}\`)${filesNote}: ${c.summary}`)
			}
		}

		if (failedOrReroutedMembers.length > 0) {
			lines.push("", "#### 3. Failover & Exception Log")
			for (const f of failedOrReroutedMembers) {
				const rerouteNote = f.reroutedToStreamId
					? ` → *Rerouted to stream* \`${f.reroutedToStreamId.slice(0, 8)}\``
					: " → *Unresolved failure*"
				lines.push(`- **${f.codename}** (\`${f.role}\`): ${f.failureReason}${rerouteNote}`)
			}
		}

		if (pendingMembers.length > 0) {
			lines.push("", "#### 4. Outstanding Specialist Streams")
			for (const p of pendingMembers) {
				lines.push(`- **${p.codename}** (\`${p.role}\` · \`${p.stage}\`) — Stream \`${p.streamId.slice(0, 8)}\``)
			}
		}

		const report: LegionSynthesisReport = {
			formationId: manifest.formationId,
			parentStreamId,
			objective: manifest.objective,
			overallStatus: manifest.status,
			stageProgression,
			completedMembers,
			failedOrReroutedMembers,
			pendingMembers,
			synthesizedMarkdown: lines.join("\n"),
			timestamp: Date.now(),
		}

		await this.storeRecord(parentStreamId, "last_legion_synthesis_report", report)
		return report
	}

	public async recallLastLegionFormation(parentStreamId: string): Promise<LegionFormationManifest | null> {
		return this.recallRecord<LegionFormationManifest>(parentStreamId, "last_legion_formation")
	}

	public async getSpecialistProfileForStream(streamId: string): Promise<{
		formationId: string
		parentStreamId: string
		assignment: LegionSpecialistAssignment
		stage?: LegionExecutionStageName
		reroutedFromStreamId?: string
		spawnedAt: number
	} | null> {
		return this.recallRecord(streamId, "legion_specialist_profile")
	}
}

export const legionCoordinator = new LegionCoordinator()
