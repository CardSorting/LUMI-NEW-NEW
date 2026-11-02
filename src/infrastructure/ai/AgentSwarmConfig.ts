/**
 * [LAYER: INFRASTRUCTURE]
 */
export type AgentSwarmFeatureId = "agentSwarmAuxiliary" | "criticalCompletionReview" | "hierarchicalDefer" | "legionDelegation"

export type DeferExecutionBoundary = "before_turn" | "safe_boundary" | "immediate"

export type LegionFormationStrategy = "adaptive" | "tactical_strike" | "balanced_squad" | "full_legion" | "verification_heavy"

export type LegionSpecialistRole =
	| "legion_architect"
	| "legion_implementer"
	| "legion_ux_ergonomics"
	| "legion_Trends_ux"
	| "legion_hardener"
	| "legion_verifier"
	| "legion_researcher"
	| "legion_data_steward"

export type CanonicalLegionSpecialistRole = Exclude<LegionSpecialistRole, "legion_Trends_ux">

export function normalizeLegionSpecialistRole(role: LegionSpecialistRole | string): CanonicalLegionSpecialistRole {
	if (role === "legion_Trends_ux" || role === "legion_ux_ergonomics") {
		return "legion_ux_ergonomics"
	}
	if (
		role === "legion_architect" ||
		role === "legion_implementer" ||
		role === "legion_hardener" ||
		role === "legion_verifier" ||
		role === "legion_researcher" ||
		role === "legion_data_steward"
	) {
		return role
	}
	return "legion_implementer"
}

export interface AgentSwarmOverrideFields {
	enabled: boolean
	criticalCompletionReviewEnabled: boolean
	hierarchicalDeferEnabled: boolean
	defaultDeferBoundary: DeferExecutionBoundary
	legionEnabled: boolean
	legionStrategy: LegionFormationStrategy
	legionMaxSpecialists: number
}

export interface AgentSwarmConfig {
	/** Master auxiliary feature toggle (default: false). */
	enabled: boolean
	/** Critical Completion Review toggle (default: false). */
	criticalCompletionReviewEnabled: boolean
	/** Hierarchical Agent Defer & Resume toggle (default: false). */
	hierarchicalDeferEnabled: boolean
	/** Default execution boundary for defer requests (default: "safe_boundary"). */
	defaultDeferBoundary: DeferExecutionBoundary
	/** Maximum initial adversarial reviews per completion event (default: 1). */
	maxInitialCompletionReviews: number
	/** Maximum corrective verification passes after remediation (default: 1). */
	maxCorrectiveVerificationPasses: number
	/** Automatically defer pipeline during Critical Completion Review when enabled (default: true). */
	autoDeferOnCompletionReview: boolean
	/** Legion Specialist Classification, Formation & Delegation toggle (default: false). */
	legionEnabled: boolean
	/** Default formation strategy for the Legion (default: "adaptive"). */
	legionStrategy: LegionFormationStrategy
	/** Maximum number of specialist agents spawned per Legion formation (default: 4, clamped 1..8). */
	legionMaxSpecialists: number
	/** Per-agent feature configuration overrides keyed by agentId or streamId. */
	agentOverrides: Record<string, Partial<AgentSwarmOverrideFields>>
	/** Per-task feature configuration overrides keyed by taskId or streamId. */
	taskOverrides: Record<string, Partial<AgentSwarmOverrideFields>>
}

export const DEFAULT_AGENT_SWARM_CONFIG: AgentSwarmConfig = {
	enabled: false,
	criticalCompletionReviewEnabled: false,
	hierarchicalDeferEnabled: false,
	defaultDeferBoundary: "safe_boundary",
	maxInitialCompletionReviews: 1,
	maxCorrectiveVerificationPasses: 1,
	autoDeferOnCompletionReview: true,
	legionEnabled: false,
	legionStrategy: "adaptive",
	legionMaxSpecialists: 4,
	agentOverrides: {},
	taskOverrides: {},
}

const CONFIG_TTL_MS = 30_000
let configCache: AgentSwarmConfig | null = null
let configCacheAt = 0
let runtimeOverride: Partial<AgentSwarmConfig> | null = null
const dynamicAgentOverrides = new Map<string, Partial<AgentSwarmOverrideFields>>()
const dynamicTaskOverrides = new Map<string, Partial<AgentSwarmOverrideFields>>()

function envBool(key: string): boolean | undefined {
	const raw = process.env[key]
	if (raw === undefined || raw === "") return undefined
	const normalized = raw.trim().toLowerCase()
	if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true
	if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false
	return undefined
}

function envBoundary(key: string): DeferExecutionBoundary | undefined {
	const raw = process.env[key]?.trim().toLowerCase()
	if (raw === "before_turn" || raw === "safe_boundary" || raw === "immediate") {
		return raw
	}
	return undefined
}

export function isValidLegionStrategy(value: unknown): value is LegionFormationStrategy {
	return (
		value === "adaptive" ||
		value === "tactical_strike" ||
		value === "balanced_squad" ||
		value === "full_legion" ||
		value === "verification_heavy"
	)
}

function envLegionStrategy(key: string): LegionFormationStrategy | undefined {
	const raw = process.env[key]?.trim().toLowerCase()
	if (isValidLegionStrategy(raw)) {
		return raw
	}
	return undefined
}

function loadFromEnv(): Partial<AgentSwarmConfig> {
	const patch: Partial<AgentSwarmConfig> = {}
	const enabled = envBool("LUMI_AGENT_SWARM_ENABLED") ?? envBool("DIETCODE_AGENT_SWARM_ENABLED")
	if (enabled !== undefined) {
		patch.enabled = enabled
	}

	const reviewEnabled =
		envBool("LUMI_CRITICAL_COMPLETION_REVIEW_ENABLED") ?? envBool("DIETCODE_CRITICAL_COMPLETION_REVIEW_ENABLED")
	if (reviewEnabled !== undefined) {
		patch.criticalCompletionReviewEnabled = reviewEnabled
	}

	const deferEnabled = envBool("LUMI_HIERARCHICAL_DEFER_ENABLED") ?? envBool("DIETCODE_HIERARCHICAL_DEFER_ENABLED")
	if (deferEnabled !== undefined) {
		patch.hierarchicalDeferEnabled = deferEnabled
	}

	const boundary = envBoundary("LUMI_AGENT_SWARM_DEFER_BOUNDARY")
	if (boundary) {
		patch.defaultDeferBoundary = boundary
	}

	const autoDefer = envBool("LUMI_AGENT_SWARM_AUTO_DEFER_ON_REVIEW")
	if (autoDefer !== undefined) {
		patch.autoDeferOnCompletionReview = autoDefer
	}

	const maxInitialRaw = process.env.LUMI_AGENT_SWARM_MAX_INITIAL_REVIEWS
	if (maxInitialRaw !== undefined && maxInitialRaw.trim() !== "") {
		const parsed = Number.parseInt(maxInitialRaw.trim(), 10)
		if (Number.isFinite(parsed) && parsed >= 1) {
			patch.maxInitialCompletionReviews = Math.max(1, Math.min(5, parsed))
		}
	}

	const maxCorrectiveRaw = process.env.LUMI_AGENT_SWARM_MAX_CORRECTIVE_PASSES
	if (maxCorrectiveRaw !== undefined && maxCorrectiveRaw.trim() !== "") {
		const parsed = Number.parseInt(maxCorrectiveRaw.trim(), 10)
		if (Number.isFinite(parsed) && parsed >= 1) {
			patch.maxCorrectiveVerificationPasses = Math.max(1, Math.min(5, parsed))
		}
	}

	const legionEnabled = envBool("LUMI_AGENT_SWARM_LEGION_ENABLED") ?? envBool("DIETCODE_AGENT_SWARM_LEGION_ENABLED")
	if (legionEnabled !== undefined) {
		patch.legionEnabled = legionEnabled
	}

	const legionStrategy = envLegionStrategy("LUMI_AGENT_SWARM_LEGION_STRATEGY")
	if (legionStrategy) {
		patch.legionStrategy = legionStrategy
	}

	const legionMaxRaw = process.env.LUMI_AGENT_SWARM_LEGION_MAX_SPECIALISTS
	if (legionMaxRaw !== undefined && legionMaxRaw.trim() !== "") {
		const parsed = Number.parseInt(legionMaxRaw.trim(), 10)
		if (Number.isFinite(parsed) && parsed >= 1) {
			patch.legionMaxSpecialists = Math.max(1, Math.min(8, parsed))
		}
	}

	return patch
}

function loadFromVSCodeSettings(): Partial<AgentSwarmConfig> {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const vscode = require("vscode") as typeof import("vscode")
		const cfg = vscode.workspace.getConfiguration("lumi.agentSwarm")
		const patch: Partial<AgentSwarmConfig> = {}

		if (cfg.has("enabled")) {
			patch.enabled = Boolean(cfg.get("enabled"))
		}
		if (cfg.has("criticalCompletionReview.enabled")) {
			patch.criticalCompletionReviewEnabled = Boolean(cfg.get("criticalCompletionReview.enabled"))
		}
		if (cfg.has("hierarchicalDefer.enabled")) {
			patch.hierarchicalDeferEnabled = Boolean(cfg.get("hierarchicalDefer.enabled"))
		}
		if (cfg.has("hierarchicalDefer.defaultBoundary")) {
			const boundary = cfg.get<string>("hierarchicalDefer.defaultBoundary")
			if (boundary === "before_turn" || boundary === "safe_boundary" || boundary === "immediate") {
				patch.defaultDeferBoundary = boundary
			}
		}
		if (cfg.has("autoDeferOnCompletionReview")) {
			patch.autoDeferOnCompletionReview = Boolean(cfg.get("autoDeferOnCompletionReview"))
		}
		if (cfg.has("criticalCompletionReview.maxInitialReviews")) {
			const maxInitial = Number(cfg.get("criticalCompletionReview.maxInitialReviews"))
			if (Number.isFinite(maxInitial) && maxInitial >= 1) {
				patch.maxInitialCompletionReviews = Math.max(1, Math.min(5, Math.round(maxInitial)))
			}
		}
		if (cfg.has("criticalCompletionReview.maxCorrectivePasses")) {
			const maxCorrective = Number(cfg.get("criticalCompletionReview.maxCorrectivePasses"))
			if (Number.isFinite(maxCorrective) && maxCorrective >= 1) {
				patch.maxCorrectiveVerificationPasses = Math.max(1, Math.min(5, Math.round(maxCorrective)))
			}
		}
		if (cfg.has("legion.enabled")) {
			patch.legionEnabled = Boolean(cfg.get("legion.enabled"))
		}
		if (cfg.has("legion.strategy")) {
			const strategy = cfg.get<string>("legion.strategy")
			if (isValidLegionStrategy(strategy)) {
				patch.legionStrategy = strategy
			}
		}
		if (cfg.has("legion.maxSpecialists")) {
			const maxSpecialists = Number(cfg.get("legion.maxSpecialists"))
			if (Number.isFinite(maxSpecialists) && maxSpecialists >= 1) {
				patch.legionMaxSpecialists = Math.max(1, Math.min(8, Math.round(maxSpecialists)))
			}
		}
		return patch
	} catch {
		return {}
	}
}

export function getExplicitStateManagerSetting<K extends keyof import("@shared/storage/state-keys").Settings>(
	stateManager: import("@/core/storage/StateManager").StateManager,
	key: K,
	defaultValue: import("@shared/storage/state-keys").Settings[K],
): import("@shared/storage/state-keys").Settings[K] | undefined {
	const smAny = stateManager as unknown as {
		remoteConfigCache?: Record<string, unknown>
		sessionOverrideCache?: Record<string, unknown>
		taskStateCache?: Record<string, unknown>
		pendingGlobalState?: Set<string>
		storage?: { globalState?: { get?: (k: string) => unknown } }
	}

	// 1. Check explicit in-memory overrides (remoteConfig, sessionOverride, taskState, or pending write)
	if (smAny.remoteConfigCache && smAny.remoteConfigCache[key] !== undefined) {
		return smAny.remoteConfigCache[key] as import("@shared/storage/state-keys").Settings[K]
	}
	if (smAny.sessionOverrideCache && smAny.sessionOverrideCache[key] !== undefined) {
		return smAny.sessionOverrideCache[key] as import("@shared/storage/state-keys").Settings[K]
	}
	if (smAny.taskStateCache && smAny.taskStateCache[key] !== undefined) {
		return smAny.taskStateCache[key] as import("@shared/storage/state-keys").Settings[K]
	}
	if (smAny.pendingGlobalState?.has?.(key)) {
		return stateManager.getGlobalSettingsKey(key)
	}

	// 2. If backed by a storage context, check if the key was explicitly persisted in globalState.json
	const rawBackingStore = smAny.storage?.globalState
	if (rawBackingStore && typeof rawBackingStore.get === "function") {
		const persisted = rawBackingStore.get(key)
		if (persisted !== undefined) {
			return persisted as import("@shared/storage/state-keys").Settings[K]
		}
		// Even if not yet flushed to disk, if the in-memory value differs from default, it was explicitly set
		const currentVal = stateManager.getGlobalSettingsKey(key)
		if (currentVal !== undefined && currentVal !== defaultValue) {
			return currentVal
		}
		return undefined
	}

	// 3. Fallback for lightweight test mocks of StateManager without a backing store
	return stateManager.getGlobalSettingsKey(key)
}

function loadFromStateManager(): Partial<AgentSwarmConfig> {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { StateManager } = require("@/core/storage/StateManager") as typeof import("@/core/storage/StateManager")
		const stateManager = StateManager.get()
		const patch: Partial<AgentSwarmConfig> = {}

		const enabled = getExplicitStateManagerSetting(stateManager, "agentSwarmEnabled", DEFAULT_AGENT_SWARM_CONFIG.enabled)
		if (typeof enabled === "boolean") {
			patch.enabled = enabled
		}

		const reviewEnabled = getExplicitStateManagerSetting(
			stateManager,
			"agentSwarmCriticalCompletionReviewEnabled",
			DEFAULT_AGENT_SWARM_CONFIG.criticalCompletionReviewEnabled,
		)
		if (typeof reviewEnabled === "boolean") {
			patch.criticalCompletionReviewEnabled = reviewEnabled
		}

		const deferEnabled = getExplicitStateManagerSetting(
			stateManager,
			"agentSwarmHierarchicalDeferEnabled",
			DEFAULT_AGENT_SWARM_CONFIG.hierarchicalDeferEnabled,
		)
		if (typeof deferEnabled === "boolean") {
			patch.hierarchicalDeferEnabled = deferEnabled
		}

		const boundary = getExplicitStateManagerSetting(
			stateManager,
			"agentSwarmDefaultDeferBoundary",
			DEFAULT_AGENT_SWARM_CONFIG.defaultDeferBoundary,
		)
		if (boundary === "before_turn" || boundary === "safe_boundary" || boundary === "immediate") {
			patch.defaultDeferBoundary = boundary
		}

		const autoDefer = getExplicitStateManagerSetting(
			stateManager,
			"agentSwarmAutoDeferOnCompletionReview",
			DEFAULT_AGENT_SWARM_CONFIG.autoDeferOnCompletionReview,
		)
		if (typeof autoDefer === "boolean") {
			patch.autoDeferOnCompletionReview = autoDefer
		}

		const maxInitial = getExplicitStateManagerSetting(
			stateManager,
			"agentSwarmMaxInitialCompletionReviews",
			DEFAULT_AGENT_SWARM_CONFIG.maxInitialCompletionReviews,
		)
		if (typeof maxInitial === "number" && Number.isFinite(maxInitial) && maxInitial >= 1) {
			patch.maxInitialCompletionReviews = Math.max(1, Math.min(5, Math.round(maxInitial)))
		}

		const maxCorrective = getExplicitStateManagerSetting(
			stateManager,
			"agentSwarmMaxCorrectiveVerificationPasses",
			DEFAULT_AGENT_SWARM_CONFIG.maxCorrectiveVerificationPasses,
		)
		if (typeof maxCorrective === "number" && Number.isFinite(maxCorrective) && maxCorrective >= 1) {
			patch.maxCorrectiveVerificationPasses = Math.max(1, Math.min(5, Math.round(maxCorrective)))
		}

		const legionEnabled = getExplicitStateManagerSetting(
			stateManager,
			"agentSwarmLegionEnabled",
			DEFAULT_AGENT_SWARM_CONFIG.legionEnabled,
		)
		if (typeof legionEnabled === "boolean") {
			patch.legionEnabled = legionEnabled
		}

		const legionStrategy = getExplicitStateManagerSetting(
			stateManager,
			"agentSwarmLegionStrategy",
			DEFAULT_AGENT_SWARM_CONFIG.legionStrategy,
		)
		if (isValidLegionStrategy(legionStrategy)) {
			patch.legionStrategy = legionStrategy
		}

		const legionMaxSpecialists = getExplicitStateManagerSetting(
			stateManager,
			"agentSwarmLegionMaxSpecialists",
			DEFAULT_AGENT_SWARM_CONFIG.legionMaxSpecialists,
		)
		if (typeof legionMaxSpecialists === "number" && Number.isFinite(legionMaxSpecialists) && legionMaxSpecialists >= 1) {
			patch.legionMaxSpecialists = Math.max(1, Math.min(8, Math.round(legionMaxSpecialists)))
		}

		return patch
	} catch {
		return {}
	}
}

export function invalidateAgentSwarmConfigCache(): void {
	configCache = null
	configCacheAt = 0
}

/**
 * Set or clear a programmatic runtime override for the Agent Swarm auxiliary feature suite.
 * Pass `null` to clear all overrides and restore default disabled state.
 */
export function setAgentSwarmConfigOverride(patch: Partial<AgentSwarmConfig> | null): void {
	runtimeOverride = patch
	if (patch === null) {
		dynamicAgentOverrides.clear()
		dynamicTaskOverrides.clear()
	}
	invalidateAgentSwarmConfigCache()
}

/**
 * Convenience toggle for enabling or disabling the Agent Swarm auxiliary feature (and its sub-capabilities) at runtime.
 */
export function toggleAgentSwarmFeature(
	enabled: boolean,
	options?: {
		criticalCompletionReviewEnabled?: boolean
		hierarchicalDeferEnabled?: boolean
		defaultDeferBoundary?: DeferExecutionBoundary
		legionEnabled?: boolean
		legionStrategy?: LegionFormationStrategy
		legionMaxSpecialists?: number
	},
): AgentSwarmConfig {
	runtimeOverride = {
		...(runtimeOverride || {}),
		enabled,
		criticalCompletionReviewEnabled: options?.criticalCompletionReviewEnabled ?? enabled,
		hierarchicalDeferEnabled: options?.hierarchicalDeferEnabled ?? enabled,
		legionEnabled: options?.legionEnabled ?? enabled,
		...(options?.defaultDeferBoundary ? { defaultDeferBoundary: options.defaultDeferBoundary } : {}),
		...(options?.legionStrategy ? { legionStrategy: options.legionStrategy } : {}),
		...(options?.legionMaxSpecialists !== undefined
			? { legionMaxSpecialists: Math.max(1, Math.min(8, Math.round(options.legionMaxSpecialists))) }
			: {}),
	}
	invalidateAgentSwarmConfigCache()
	return getAgentSwarmConfig()
}

/**
 * Configure per-agent overrides for Critical Completion Review, Hierarchical Defer, and Legion.
 */
export function setAgentSwarmAgentOverride(agentId: string, override: Partial<AgentSwarmOverrideFields> | null): void {
	if (override === null) {
		dynamicAgentOverrides.delete(agentId)
	} else {
		dynamicAgentOverrides.set(agentId, {
			...(dynamicAgentOverrides.get(agentId) || {}),
			...override,
		})
	}
	invalidateAgentSwarmConfigCache()
}

/**
 * Configure per-task overrides for Critical Completion Review, Hierarchical Defer, and Legion.
 * Per-task overrides take precedence over per-agent and global settings.
 */
export function setAgentSwarmTaskOverride(taskId: string, override: Partial<AgentSwarmOverrideFields> | null): void {
	if (override === null) {
		dynamicTaskOverrides.delete(taskId)
	} else {
		dynamicTaskOverrides.set(taskId, {
			...(dynamicTaskOverrides.get(taskId) || {}),
			...override,
		})
	}
	invalidateAgentSwarmConfigCache()
}

export function getAgentSwarmConfig(): AgentSwarmConfig {
	const now = Date.now()
	if (configCache && now - configCacheAt < CONFIG_TTL_MS) {
		return {
			...configCache,
			agentOverrides: { ...configCache.agentOverrides },
			taskOverrides: { ...configCache.taskOverrides },
		}
	}

	const mergedAgentOverrides: AgentSwarmConfig["agentOverrides"] = {
		...(runtimeOverride?.agentOverrides || {}),
	}
	for (const [agentId, override] of dynamicAgentOverrides.entries()) {
		mergedAgentOverrides[agentId] = { ...(mergedAgentOverrides[agentId] || {}), ...override }
	}

	const mergedTaskOverrides: AgentSwarmConfig["taskOverrides"] = {
		...(runtimeOverride?.taskOverrides || {}),
	}
	for (const [taskId, override] of dynamicTaskOverrides.entries()) {
		mergedTaskOverrides[taskId] = { ...(mergedTaskOverrides[taskId] || {}), ...override }
	}

	const base: AgentSwarmConfig = {
		...DEFAULT_AGENT_SWARM_CONFIG,
		...loadFromVSCodeSettings(),
		...loadFromStateManager(),
		...loadFromEnv(),
		...(runtimeOverride || {}),
		agentOverrides: mergedAgentOverrides,
		taskOverrides: mergedTaskOverrides,
	}

	configCache = base
	configCacheAt = now
	return {
		...base,
		agentOverrides: { ...base.agentOverrides },
		taskOverrides: { ...base.taskOverrides },
	}
}

export interface EffectiveAgentSwarmFeatureState {
	enabled: boolean
	criticalCompletionReviewEnabled: boolean
	hierarchicalDeferEnabled: boolean
	defaultDeferBoundary: DeferExecutionBoundary
	maxInitialCompletionReviews: number
	maxCorrectiveVerificationPasses: number
	autoDeferOnCompletionReview: boolean
	legionEnabled: boolean
	legionStrategy: LegionFormationStrategy
	legionMaxSpecialists: number
	resolvedFrom: "default" | "global" | "agent_override" | "task_override" | "manual_invocation"
}

export function resolveEffectiveAgentSwarmState(context?: {
	agentId?: string
	streamId?: string
	taskId?: string
	manualInvocation?: boolean
	settingsPatch?: Partial<
		Pick<
			AgentSwarmConfig,
			| "enabled"
			| "criticalCompletionReviewEnabled"
			| "hierarchicalDeferEnabled"
			| "defaultDeferBoundary"
			| "autoDeferOnCompletionReview"
			| "maxInitialCompletionReviews"
			| "maxCorrectiveVerificationPasses"
			| "legionEnabled"
			| "legionStrategy"
			| "legionMaxSpecialists"
		>
	>
}): EffectiveAgentSwarmFeatureState {
	const cfg = getAgentSwarmConfig()
	const patch = context?.settingsPatch

	// Programmatic runtimeOverride takes precedence over settingsPatch when explicitly set
	const baseEnabled = runtimeOverride?.enabled ?? patch?.enabled ?? cfg.enabled
	const baseReview =
		runtimeOverride?.criticalCompletionReviewEnabled ??
		patch?.criticalCompletionReviewEnabled ??
		cfg.criticalCompletionReviewEnabled
	const baseDefer = runtimeOverride?.hierarchicalDeferEnabled ?? patch?.hierarchicalDeferEnabled ?? cfg.hierarchicalDeferEnabled
	const baseBoundary = runtimeOverride?.defaultDeferBoundary ?? patch?.defaultDeferBoundary ?? cfg.defaultDeferBoundary
	const baseAutoDefer =
		runtimeOverride?.autoDeferOnCompletionReview ?? patch?.autoDeferOnCompletionReview ?? cfg.autoDeferOnCompletionReview
	const baseMaxInitial =
		runtimeOverride?.maxInitialCompletionReviews ?? patch?.maxInitialCompletionReviews ?? cfg.maxInitialCompletionReviews
	const baseMaxCorrective =
		runtimeOverride?.maxCorrectiveVerificationPasses ??
		patch?.maxCorrectiveVerificationPasses ??
		cfg.maxCorrectiveVerificationPasses
	const baseLegionEnabled = runtimeOverride?.legionEnabled ?? patch?.legionEnabled ?? cfg.legionEnabled
	const baseLegionStrategy = runtimeOverride?.legionStrategy ?? patch?.legionStrategy ?? cfg.legionStrategy
	const baseLegionMaxSpecialists =
		runtimeOverride?.legionMaxSpecialists ?? patch?.legionMaxSpecialists ?? cfg.legionMaxSpecialists

	let enabled = baseEnabled
	let reviewEnabled = baseEnabled || baseReview
	let deferEnabled = baseEnabled || baseDefer
	let legionEnabled = baseEnabled || baseLegionEnabled
	let defaultDeferBoundary = baseBoundary
	let legionStrategy = baseLegionStrategy
	let legionMaxSpecialists = baseLegionMaxSpecialists
	let resolvedFrom: EffectiveAgentSwarmFeatureState["resolvedFrom"] =
		enabled || reviewEnabled || deferEnabled || legionEnabled ? "global" : "default"

	const agentKey = context?.agentId || context?.streamId
	if (agentKey && cfg.agentOverrides[agentKey]) {
		const agentPatch = cfg.agentOverrides[agentKey]
		if (agentPatch.enabled !== undefined) {
			enabled = agentPatch.enabled
			if (agentPatch.criticalCompletionReviewEnabled === undefined) {
				reviewEnabled = agentPatch.enabled
			}
			if (agentPatch.hierarchicalDeferEnabled === undefined) {
				deferEnabled = agentPatch.enabled
			}
			if (agentPatch.legionEnabled === undefined) {
				legionEnabled = agentPatch.enabled
			}
		}
		if (agentPatch.criticalCompletionReviewEnabled !== undefined) {
			reviewEnabled = agentPatch.criticalCompletionReviewEnabled
		}
		if (agentPatch.hierarchicalDeferEnabled !== undefined) {
			deferEnabled = agentPatch.hierarchicalDeferEnabled
		}
		if (agentPatch.legionEnabled !== undefined) {
			legionEnabled = agentPatch.legionEnabled
		}
		if (agentPatch.defaultDeferBoundary !== undefined) {
			defaultDeferBoundary = agentPatch.defaultDeferBoundary
		}
		if (agentPatch.legionStrategy !== undefined) {
			legionStrategy = agentPatch.legionStrategy
		}
		if (agentPatch.legionMaxSpecialists !== undefined) {
			legionMaxSpecialists = Math.max(1, Math.min(8, Math.round(agentPatch.legionMaxSpecialists)))
		}
		resolvedFrom = "agent_override"
	}

	const taskKey = context?.taskId || context?.streamId
	if (taskKey && cfg.taskOverrides[taskKey]) {
		const taskPatch = cfg.taskOverrides[taskKey]
		if (taskPatch.enabled !== undefined) {
			enabled = taskPatch.enabled
			if (taskPatch.criticalCompletionReviewEnabled === undefined) {
				reviewEnabled = taskPatch.enabled
			}
			if (taskPatch.hierarchicalDeferEnabled === undefined) {
				deferEnabled = taskPatch.enabled
			}
			if (taskPatch.legionEnabled === undefined) {
				legionEnabled = taskPatch.enabled
			}
		}
		if (taskPatch.criticalCompletionReviewEnabled !== undefined) {
			reviewEnabled = taskPatch.criticalCompletionReviewEnabled
		}
		if (taskPatch.hierarchicalDeferEnabled !== undefined) {
			deferEnabled = taskPatch.hierarchicalDeferEnabled
		}
		if (taskPatch.legionEnabled !== undefined) {
			legionEnabled = taskPatch.legionEnabled
		}
		if (taskPatch.defaultDeferBoundary !== undefined) {
			defaultDeferBoundary = taskPatch.defaultDeferBoundary
		}
		if (taskPatch.legionStrategy !== undefined) {
			legionStrategy = taskPatch.legionStrategy
		}
		if (taskPatch.legionMaxSpecialists !== undefined) {
			legionMaxSpecialists = Math.max(1, Math.min(8, Math.round(taskPatch.legionMaxSpecialists)))
		}
		resolvedFrom = "task_override"
	}

	if (context?.manualInvocation) {
		enabled = true
		reviewEnabled = true
		legionEnabled = true
		resolvedFrom = "manual_invocation"
	}

	const anyActive = enabled || reviewEnabled || deferEnabled || legionEnabled
	return {
		enabled: anyActive,
		criticalCompletionReviewEnabled: reviewEnabled,
		hierarchicalDeferEnabled: deferEnabled,
		defaultDeferBoundary,
		maxInitialCompletionReviews: baseMaxInitial,
		maxCorrectiveVerificationPasses: baseMaxCorrective,
		autoDeferOnCompletionReview: baseAutoDefer,
		legionEnabled,
		legionStrategy,
		legionMaxSpecialists,
		resolvedFrom,
	}
}
