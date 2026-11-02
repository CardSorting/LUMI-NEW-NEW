import { UpdateSettingsRequest } from "@shared/proto/dietcode/state"
import { Search, ShieldCheck, Sparkles, Workflow, X } from "lucide-react"
import { memo, type ReactNode, useCallback, useId, useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { VscIcon } from "@/components/ui/vsc-icon"
import { useExtensionState } from "@/context/ExtensionStateContext"
import Section from "../Section"
import SettingsSlider from "../SettingsSlider"
import { updateSetting, updateSettingsBatch } from "../utils/settingsHandlers"

// Reusable checkbox component for feature settings
interface FeatureCheckboxProps {
	checked: boolean | undefined
	onChange: (checked: boolean) => void
	label: string
	description: ReactNode
	disabled?: boolean
	isRemoteLocked?: boolean
	remoteTooltip?: string
	isVisible?: boolean
	badgeText?: string
}

// Interface for feature toggle configuration
interface FeatureToggle {
	id: string
	label: string
	description: ReactNode
	settingKey: keyof UpdateSettingsRequest
	stateKey: string
	/** Optional search keywords to improve discoverability */
	keywords?: string[]
	/** If set, the setting value is nested with this key (e.g., "enabled" -> { enabled: checked }) */
	nestedKey?: string
}

const agentFeatures: FeatureToggle[] = [
	{
		id: "yolo",
		label: "Autonomous execution",
		description:
			"Run tools, edit files, and execute commands without individual approval prompts. Stop at any time. Workspace and organization policies still apply.",
		stateKey: "yoloModeToggled",
		settingKey: "yoloModeToggled",
		keywords: ["yolo", "auto", "approval", "autonomous"],
	},
	{
		id: "native-tool-call",
		label: "Direct tool calls",
		description: "Use built-in tool calling when your model supports it.",
		stateKey: "nativeToolCallSetting",
		settingKey: "nativeToolCallEnabled",
		keywords: ["native", "tool", "function calling"],
	},
	{
		id: "parallel-tool-calling",
		label: "Parallel tool execution",
		description: "Run independent tools together; wait for results when one step depends on another.",
		stateKey: "enableParallelToolCalling",
		settingKey: "enableParallelToolCalling",
		keywords: ["parallel", "concurrent", "batch"],
	},
	{
		id: "strict-plan-mode",
		label: "Planning stays read-only",
		description: "During the automatic planning phase, LUMI won't edit files until it begins implementation.",
		stateKey: "strictPlanModeEnabled",
		settingKey: "strictPlanModeEnabled",
		keywords: ["plan", "read-only", "strict"],
	},
	{
		id: "auto-compact",
		label: "Shorten long chats",
		description: "Automatically tidy up when the conversation gets very long.",
		stateKey: "useAutoCondense",
		settingKey: "useAutoCondense",
		keywords: ["condense", "compact", "context", "memory"],
	},
]

const editorFeatures: FeatureToggle[] = [
	{
		id: "background-edit",
		label: "Background Edit",
		description: "Allow edits without stealing editor focus",
		stateKey: "backgroundEditEnabled",
		settingKey: "backgroundEditEnabled",
		keywords: ["background", "focus", "editor"],
	},
	{
		id: "checkpoints",
		label: "Checkpoints",
		description: "Save progress at key points for easy rollback",
		stateKey: "enableCheckpointsSetting",
		settingKey: "enableCheckpointsSetting",
		keywords: ["checkpoint", "rollback", "restore", "snapshot"],
	},
	{
		id: "dietcode-web-tools",
		label: "Browse the web",
		description: "Let LUMI search the web and open pages when you need outside info.",
		stateKey: "dietcodeWebToolsEnabled",
		settingKey: "dietcodeWebToolsEnabled",
		keywords: ["web", "search", "fetch", "browser"],
	},
	{
		id: "worktrees",
		label: "Worktrees",
		description: "Run a few LUMI tasks side by side with git worktrees.",
		stateKey: "worktreesEnabled",
		settingKey: "worktreesEnabled",
		keywords: ["git", "worktree", "parallel", "branch"],
	},
]

const experimentalFeatures: FeatureToggle[] = [
	{
		id: "double-check-completion",
		label: "Double-check my work",
		description: "Before saying we're done, LUMI takes a second look at what you originally asked for.",
		stateKey: "doubleCheckCompletionEnabled",
		settingKey: "doubleCheckCompletionEnabled",
		keywords: ["double check", "verify", "completion"],
	},
	{
		id: "audit-completion-gate",
		label: "Require a completion audit",
		description: "Block completion when the audit fails. Off by default; enable for tasks that need a formal review.",
		stateKey: "auditCompletionGateEnabled",
		settingKey: "auditCompletionGateEnabled",
		keywords: ["audit", "gate", "score", "completion"],
	},
	{
		id: "audit-gate-critical-only",
		label: "Block only on critical audit findings",
		description: "Smaller warnings stay as gentle notes — only big problems block finishing.",
		stateKey: "auditCompletionGateCriticalOnly",
		settingKey: "auditCompletionGateCriticalOnly",
		keywords: ["critical", "blocker", "warnings"],
	},
	{
		id: "audit-advisory-escalation",
		label: "Escalate unresolved audit findings",
		description: "When completion audits are enabled, treat unresolved findings as blockers.",
		stateKey: "auditAdvisoryEscalationEnabled",
		settingKey: "auditAdvisoryEscalationEnabled",
		keywords: ["escalate", "advisory", "unresolved"],
	},
	{
		id: "audit-plan-regression-gate",
		label: "Require the planning audit score",
		description: "When completion audits are enabled, block if the score falls below the planning baseline.",
		stateKey: "auditPlanRegressionGateEnabled",
		settingKey: "auditPlanRegressionGateEnabled",
		keywords: ["planning", "baseline", "regression"],
	},
	{
		id: "audit-tool-output-advisory",
		label: "Review command output",
		description: "Glance at test or build output and suggest fixes when something looks wrong.",
		stateKey: "auditToolOutputAdvisoryEnabled",
		settingKey: "auditToolOutputAdvisoryEnabled",
		keywords: ["command", "terminal", "output", "advisory"],
	},
]

const AGENT_SWARM_SEARCH_TERMS = [
	"agent swarm",
	"agentswarm",
	"auxiliary",
	"critical completion review",
	"adversarial review",
	"hierarchical defer",
	"defer",
	"resume",
	"suspension barrier",
	"safe_boundary",
	"before_turn",
	"immediate",
	"remediate",
	"coordinator",
	"legion",
	"specialist",
	"delegation",
	"formation",
	"tactical_strike",
	"balanced_squad",
	"full_legion",
	"verification_heavy",
	"centurion",
	"vanguard",
	"aegis",
	"sentinel",
]

const DEFER_BOUNDARY_OPTIONS: Array<{
	value: "safe_boundary" | "before_turn" | "immediate"
	label: string
	summary: string
}> = [
	{
		value: "safe_boundary",
		label: "Safe tool boundary (Recommended)",
		summary: "Finishes any running non-idempotent tool call and checkpoints cleanly before suspending.",
	},
	{
		value: "before_turn",
		label: "Before next reasoning turn",
		summary: "Completes the current reasoning/tool round and suspends at the start of the next turn.",
	},
	{
		value: "immediate",
		label: "Immediate safe point",
		summary: "Yields immediately when the active operation is read-only/idempotent; otherwise waits for atomic completion.",
	},
]

const LEGION_STRATEGY_OPTIONS: Array<{
	value: "adaptive" | "tactical_strike" | "balanced_squad" | "full_legion" | "verification_heavy"
	label: string
	summary: string
}> = [
	{
		value: "adaptive",
		label: "Adaptive Classification (Recommended)",
		summary:
			"Dynamically scales from a 1-agent tactical strike to a multi-specialist squad based on task intent, target files, and complexity.",
	},
	{
		value: "tactical_strike",
		label: "Tactical Strike (Single Best Specialist)",
		summary:
			"Routes the delegation to the single highest-scoring specialist agent with zero multi-stream coordination overhead.",
	},
	{
		value: "balanced_squad",
		label: "Balanced Squad (2–3 Specialists)",
		summary:
			"Pairs primary implementation/architecture specialists with domain peers and partitions target files to prevent collisions.",
	},
	{
		value: "verification_heavy",
		label: "Verification-Heavy Formation",
		summary:
			"Pairs implementation/hardening specialists with an Adversarial QA Verifier (SENTINEL-QA) for strict regression coverage.",
	},
	{
		value: "full_legion",
		label: "Full Legion Formation (Multi-Stage)",
		summary: "Deploys Lead Recon/Architect -> Parallel Implementation/UX/Hardening -> Sequential QA Verification.",
	},
]

type LegionStageId = "lead" | "parallel" | "verify"

/** Mirrors the backend execution DAG: leadAndRecon -> parallelExecution -> verificationAndHardening. */
const LEGION_STAGES: Array<{ id: LegionStageId; label: string; summary: string }> = [
	{ id: "lead", label: "1 · Lead & Recon", summary: "Architect / Forensics map the work first and hand context downstream." },
	{
		id: "parallel",
		label: "2 · Parallel Execution",
		summary: "Implementers, UX, hardeners and data stewards work side by side.",
	},
	{ id: "verify", label: "3 · Verification", summary: "QA verifies only after every earlier stage has completed." },
]

const LEGION_SPECIALIST_ARCHETYPES: Array<{
	codename: string
	title: string
	role: string
	focus: string
	stage: LegionStageId
}> = [
	{
		codename: "CENTURION-ARCH",
		title: "Architect",
		role: "legion_architect",
		focus: "Contracts, protos & layer boundaries",
		stage: "lead",
	},
	{
		codename: "ORACLE-RECON",
		title: "Forensics Recon",
		role: "legion_researcher",
		focus: "Deep codebase tracing & blast radius",
		stage: "lead",
	},
	{
		codename: "VANGUARD-IMPL",
		title: "Implementer",
		role: "legion_implementer",
		focus: "Core runtime & service execution",
		stage: "parallel",
	},
	{
		codename: "AESTHETE-UX",
		title: "UX & Ergonomics",
		role: "legion_ux_ergonomics",
		focus: "Webview React UI, presets & a11y",
		stage: "parallel",
	},
	{
		codename: "AEGIS-HARDEN",
		title: "Hardener",
		role: "legion_hardener",
		focus: "Concurrency locks, security & edge cases",
		stage: "parallel",
	},
	{
		codename: "KEEPER-STATE",
		title: "Data Steward",
		role: "legion_data_steward",
		focus: "SQLite pool, checkpoints & state-keys",
		stage: "parallel",
	},
	{
		codename: "SENTINEL-QA",
		title: "QA Verifier",
		role: "legion_verifier",
		focus: "Unit/integration suites & defect proofs",
		stage: "verify",
	},
]

const FeatureRow = memo(
	({
		checked = false,
		onChange,
		label,
		description,
		disabled,
		isRemoteLocked,
		isVisible = true,
		remoteTooltip,
		badgeText,
	}: FeatureCheckboxProps) => {
		const id = useId()
		if (!isVisible) {
			return null
		}

		const checkbox = (
			<div className="flex items-center justify-between gap-3 w-full">
				<div className="flex items-center gap-2 min-w-0">
					<Label className="cursor-pointer" htmlFor={id}>
						{label}
					</Label>
					{badgeText && (
						<Badge className="text-[10px] px-1.5 py-0 h-4 shrink-0" variant="outline">
							{badgeText}
						</Badge>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Switch
						aria-describedby={`${id}-description`}
						checked={checked}
						className="shrink-0"
						disabled={disabled || isRemoteLocked}
						id={id}
						onCheckedChange={onChange}
						size="lg"
					/>
					{isRemoteLocked && <VscIcon className="text-description text-sm" name="lock" />}
				</div>
			</div>
		)

		return (
			<div className="flex flex-col items-start justify-between gap-2 py-3 w-full">
				<div className="space-y-0.5 flex-1 w-full">
					{isRemoteLocked ? (
						<Tooltip>
							<TooltipTrigger asChild>{checkbox}</TooltipTrigger>
							<TooltipContent className="max-w-xs" side="top">
								{remoteTooltip}
							</TooltipContent>
						</Tooltip>
					) : (
						checkbox
					)}
				</div>
				<div className="text-xs text-description" id={`${id}-description`}>
					{description}
				</div>
			</div>
		)
	},
)

interface FeatureSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const FeatureSettingsSection = ({ renderSectionHeader }: FeatureSettingsSectionProps) => {
	const {
		enableCheckpointsSetting,
		mcpDisplayMode,
		strictPlanModeEnabled,
		yoloModeToggled,
		useAutoCondense,
		dietcodeWebToolsEnabled,
		worktreesEnabled,
		remoteConfigSettings,
		nativeToolCallSetting,
		enableParallelToolCalling,
		backgroundEditEnabled,
		doubleCheckCompletionEnabled,
		auditCompletionGateEnabled,
		auditCompletionGateThreshold,
		auditCompletionGateCriticalOnly,
		auditAdvisoryEscalationEnabled,
		auditPlanRegressionGateEnabled,
		auditToolOutputAdvisoryEnabled,
		agentSwarmEnabled,
		agentSwarmCriticalCompletionReviewEnabled,
		agentSwarmHierarchicalDeferEnabled,
		agentSwarmDefaultDeferBoundary,
		agentSwarmAutoDeferOnCompletionReview,
		agentSwarmMaxInitialCompletionReviews,
		agentSwarmMaxCorrectiveVerificationPasses,
		agentSwarmLegionEnabled,
		agentSwarmLegionStrategy,
		agentSwarmLegionMaxSpecialists,
	} = useExtensionState()

	const [searchQuery, setSearchQuery] = useState("")

	const isYoloRemoteLocked = remoteConfigSettings?.yoloModeToggled !== undefined

	// Effective Agent Swarm state calculation (mirrors resolveEffectiveAgentSwarmState)
	const effectiveSwarmMaster = Boolean(agentSwarmEnabled)
	const effectiveCriticalReview = Boolean(agentSwarmEnabled || agentSwarmCriticalCompletionReviewEnabled)
	const effectiveHierarchicalDefer = Boolean(agentSwarmEnabled || agentSwarmHierarchicalDeferEnabled)
	const effectiveLegion = Boolean(agentSwarmEnabled || agentSwarmLegionEnabled)
	const isAnySwarmCapabilityActive =
		effectiveSwarmMaster || effectiveCriticalReview || effectiveHierarchicalDefer || effectiveLegion
	const currentBoundary = agentSwarmDefaultDeferBoundary ?? "safe_boundary"
	const currentAutoDefer = agentSwarmAutoDeferOnCompletionReview ?? true
	const currentMaxInitialReviews = agentSwarmMaxInitialCompletionReviews ?? 1
	const currentMaxCorrectivePasses = agentSwarmMaxCorrectiveVerificationPasses ?? 1
	const currentLegionStrategy = agentSwarmLegionStrategy ?? "adaptive"
	const currentLegionMaxSpecialists = agentSwarmLegionMaxSpecialists ?? 4

	// State lookup for mapped features
	const featureState: Record<string, boolean | undefined> = {
		enableCheckpointsSetting,
		strictPlanModeEnabled,
		nativeToolCallSetting,
		useAutoCondense,
		dietcodeWebToolsEnabled: dietcodeWebToolsEnabled?.user,
		worktreesEnabled: worktreesEnabled?.user,
		enableParallelToolCalling,
		backgroundEditEnabled,
		doubleCheckCompletionEnabled,
		auditCompletionGateEnabled,
		auditCompletionGateCriticalOnly,
		auditAdvisoryEscalationEnabled,
		auditPlanRegressionGateEnabled,
		auditToolOutputAdvisoryEnabled,
		yoloModeToggled: isYoloRemoteLocked ? remoteConfigSettings?.yoloModeToggled : yoloModeToggled,
	}

	// Visibility lookup for features with feature flags
	const featureVisibility: Record<string, boolean | undefined> = {
		dietcodeWebToolsEnabled: dietcodeWebToolsEnabled?.featureFlag,
		worktreesEnabled: worktreesEnabled?.featureFlag,
	}

	const normalizedSearch = searchQuery.trim().toLowerCase()

	const matchesFeature = useCallback(
		(feature: FeatureToggle): boolean => {
			if (!normalizedSearch) return true
			const haystack = [
				feature.label,
				typeof feature.description === "string" ? feature.description : "",
				...(feature.keywords || []),
			]
				.join(" ")
				.toLowerCase()
			return haystack.includes(normalizedSearch)
		},
		[normalizedSearch],
	)

	const filteredAgentFeatures = useMemo(() => agentFeatures.filter(matchesFeature), [matchesFeature])
	const filteredEditorFeatures = useMemo(() => editorFeatures.filter(matchesFeature), [matchesFeature])
	const filteredExperimentalFeatures = useMemo(() => experimentalFeatures.filter(matchesFeature), [matchesFeature])

	const showAgentSwarmSection = useMemo(() => {
		if (!normalizedSearch) return true
		return AGENT_SWARM_SEARCH_TERMS.some((term) => term.includes(normalizedSearch) || normalizedSearch.includes(term))
	}, [normalizedSearch])

	const showAdvancedSection = useMemo(() => {
		if (!normalizedSearch) return true
		return "tool reply style mcp display plain rich markdown".includes(normalizedSearch)
	}, [normalizedSearch])

	const scrollToGroup = useCallback((elementId: string) => {
		const el = document.getElementById(elementId)
		if (el && typeof el.scrollIntoView === "function") {
			el.scrollIntoView({ behavior: "smooth", block: "start" })
		}
	}, [])

	// Handler for feature toggle changes
	const handleFeatureChange = useCallback((feature: FeatureToggle, checked: boolean) => {
		updateSetting(feature.settingKey, checked)
	}, [])

	// Master Agent Swarm toggle: atomically toggles the suite and sub-capabilities
	const handleMasterAgentSwarmToggle = useCallback((checked: boolean) => {
		updateSettingsBatch({
			agentSwarmEnabled: checked,
			agentSwarmCriticalCompletionReviewEnabled: checked,
			agentSwarmHierarchicalDeferEnabled: checked,
			agentSwarmLegionEnabled: checked,
		})
	}, [])

	// Quick preset handler for one-click workflow ergonomics
	const handleApplySwarmPreset = useCallback((preset: "off" | "review_only" | "defer_only" | "legion_only" | "full_suite") => {
		switch (preset) {
			case "off":
				updateSettingsBatch({
					agentSwarmEnabled: false,
					agentSwarmCriticalCompletionReviewEnabled: false,
					agentSwarmHierarchicalDeferEnabled: false,
					agentSwarmLegionEnabled: false,
				})
				break
			case "review_only":
				updateSettingsBatch({
					agentSwarmEnabled: false,
					agentSwarmCriticalCompletionReviewEnabled: true,
					agentSwarmHierarchicalDeferEnabled: false,
					agentSwarmLegionEnabled: false,
				})
				break
			case "defer_only":
				updateSettingsBatch({
					agentSwarmEnabled: false,
					agentSwarmCriticalCompletionReviewEnabled: false,
					agentSwarmHierarchicalDeferEnabled: true,
					agentSwarmLegionEnabled: false,
				})
				break
			case "legion_only":
				updateSettingsBatch({
					agentSwarmEnabled: false,
					agentSwarmCriticalCompletionReviewEnabled: false,
					agentSwarmHierarchicalDeferEnabled: false,
					agentSwarmLegionEnabled: true,
					agentSwarmLegionStrategy: "adaptive",
				})
				break
			case "full_suite":
				updateSettingsBatch({
					agentSwarmEnabled: true,
					agentSwarmCriticalCompletionReviewEnabled: true,
					agentSwarmHierarchicalDeferEnabled: true,
					agentSwarmLegionEnabled: true,
					agentSwarmDefaultDeferBoundary: "safe_boundary",
					agentSwarmAutoDeferOnCompletionReview: true,
					agentSwarmLegionStrategy: "adaptive",
				})
				break
		}
	}, [])

	const renderFeature = (feature: FeatureToggle) => (
		<div key={feature.id}>
			<FeatureRow
				checked={featureState[feature.stateKey]}
				description={feature.description}
				isRemoteLocked={feature.id === "yolo" && isYoloRemoteLocked}
				isVisible={featureVisibility[feature.stateKey] ?? true}
				key={feature.id}
				label={feature.label}
				onChange={(checked) =>
					feature.nestedKey === "enabled"
						? handleFeatureChange(feature, checked)
						: updateSetting(feature.settingKey, checked)
				}
				remoteTooltip="This setting is managed by your organization"
			/>
			{feature.id === "audit-completion-gate" && featureState[feature.stateKey] && (
				<SettingsSlider
					label="Minimum completion audit score (0–100)"
					max={100}
					min={0}
					onChange={(value) => updateSetting("auditCompletionGateThreshold", value)}
					step={5}
					value={auditCompletionGateThreshold ?? 50}
					valueWidth="w-8"
				/>
			)}
		</div>
	)

	const noMatchingSettings =
		filteredAgentFeatures.length === 0 &&
		filteredEditorFeatures.length === 0 &&
		filteredExperimentalFeatures.length === 0 &&
		!showAgentSwarmSection &&
		!showAdvancedSection

	return (
		<div className="mb-2">
			{renderSectionHeader("features")}
			<Section>
				{/* Ergonomic Quick Filter & Section Jump Bar (inspired by VS Code / Linear settings navigation) */}
				<div className="mb-2 space-y-2.5">
					<div className="relative flex items-center">
						<Search aria-hidden className="w-3.5 h-3.5 text-description absolute left-2.5 pointer-events-none" />
						<input
							aria-label="Filter preferences"
							className="w-full rounded-md border border-editor-widget-border/60 bg-input-background pl-8 pr-7 py-1.5 text-xs text-foreground placeholder:text-description/70 focus:outline-none focus:ring-1 focus:ring-focusBorder"
							data-testid="preferences-search-input"
							onChange={(e) => setSearchQuery(e.target.value)}
							placeholder="Filter preferences (e.g., Legion, Agent Swarm, defer, completion review, checkpoints)..."
							type="text"
							value={searchQuery}
						/>
						{searchQuery && (
							<button
								aria-label="Clear filter"
								className="absolute right-2 text-description hover:text-foreground cursor-pointer bg-transparent border-0 p-0.5"
								onClick={() => setSearchQuery("")}
								type="button">
								<X className="w-3.5 h-3.5" />
							</button>
						)}
					</div>

					<nav aria-label="Preference sections" className="flex flex-wrap items-center gap-1.5">
						<button
							className="text-[11px] px-2 py-0.5 rounded-full border border-editor-widget-border/50 bg-transparent text-description hover:text-foreground hover:bg-list-hover cursor-pointer transition-colors"
							onClick={() => scrollToGroup("agent-features")}
							type="button">
							Execution
						</button>
						<button
							className="text-[11px] px-2 py-0.5 rounded-full border border-editor-widget-border/50 bg-transparent text-description hover:text-foreground hover:bg-list-hover cursor-pointer transition-colors flex items-center gap-1"
							data-testid="jump-to-agent-swarm"
							onClick={() => scrollToGroup("agent-swarm-features")}
							type="button">
							<Workflow className="w-3 h-3" />
							<span>Swarm & Legion</span>
							<span
								className={`inline-block w-1.5 h-1.5 rounded-full ${isAnySwarmCapabilityActive ? "bg-charts-green" : "bg-description/40"}`}
							/>
						</button>
						<button
							className="text-[11px] px-2 py-0.5 rounded-full border border-editor-widget-border/50 bg-transparent text-description hover:text-foreground hover:bg-list-hover cursor-pointer transition-colors"
							onClick={() => scrollToGroup("optional-features")}
							type="button">
							Editor
						</button>
						<button
							className="text-[11px] px-2 py-0.5 rounded-full border border-editor-widget-border/50 bg-transparent text-description hover:text-foreground hover:bg-list-hover cursor-pointer transition-colors"
							onClick={() => scrollToGroup("experimental-features")}
							type="button">
							Reviews
						</button>
					</nav>
				</div>

				{noMatchingSettings && (
					<div className="p-4 text-center rounded-md border border-editor-widget-border/40 text-xs text-description">
						No preferences match "{searchQuery}".{" "}
						<button
							className="underline text-foreground cursor-pointer bg-transparent border-0 p-0"
							onClick={() => setSearchQuery("")}
							type="button">
							Reset filter
						</button>
					</div>
				)}

				<div className="mb-5 flex flex-col gap-3">
					{/* Core features */}
					{filteredAgentFeatures.length > 0 && (
						<div>
							<div className="text-xs font-medium text-foreground/70 mb-3">Agent execution</div>
							<div
								className="relative p-3 pt-0 my-3 rounded-lg border border-editor-widget-border/40"
								id="agent-features">
								{filteredAgentFeatures.map(renderFeature)}
							</div>
						</div>
					)}

					{/* Auxiliary Agent Swarm Capability Suite (Legion + Critical Completion Review + Hierarchical Defer) */}
					{showAgentSwarmSection && (
						<div>
							<div className="flex items-center justify-between mb-2">
								<div className="flex items-center gap-2">
									<span className="text-xs font-medium text-foreground/80">
										Agent Swarm & Hierarchy Orchestration
									</span>
									<Badge variant={isAnySwarmCapabilityActive ? "default" : "outline"}>
										{isAnySwarmCapabilityActive ? "Active" : "Auxiliary · Off by default"}
									</Badge>
								</div>
							</div>

							<div
								className="relative p-3 pt-1 my-2 rounded-lg border border-editor-widget-border/50 space-y-2"
								data-testid="agent-swarm-settings-card"
								id="agent-swarm-features">
								{/* Master Suite Toggle */}
								<FeatureRow
									badgeText="Master Switch"
									checked={effectiveSwarmMaster}
									description="Enable the auxiliary Agent Swarm capability suite (Legion Specialist Delegation, Critical Completion Review, and Cooperative Hierarchical Defer/Resume). When off, single-agent and subagent flows run with zero extra overhead."
									label="Agent Swarm auxiliary suite"
									onChange={handleMasterAgentSwarmToggle}
								/>

								{/* Quick Ergonomic Presets */}
								<div className="flex flex-wrap items-center justify-between gap-2 py-2 px-2.5 rounded-md bg-editor-widget-background/40 border border-editor-widget-border/30">
									<span className="text-[11px] font-medium text-description flex items-center gap-1">
										<Sparkles className="w-3 h-3" />
										Quick mode presets:
									</span>
									<div className="flex flex-wrap items-center gap-1.5">
										<button
											className={`text-[11px] px-2 py-0.5 rounded border cursor-pointer transition-colors ${
												!isAnySwarmCapabilityActive
													? "border-foreground/60 bg-selection text-foreground font-medium"
													: "border-editor-widget-border/50 bg-transparent text-description hover:text-foreground"
											}`}
											data-testid="swarm-preset-off"
											onClick={() => handleApplySwarmPreset("off")}
											type="button">
											Standard (Off)
										</button>
										<button
											className={`text-[11px] px-2 py-0.5 rounded border cursor-pointer transition-colors ${
												!effectiveSwarmMaster &&
												effectiveLegion &&
												!effectiveCriticalReview &&
												!effectiveHierarchicalDefer
													? "border-foreground/60 bg-selection text-foreground font-medium"
													: "border-editor-widget-border/50 bg-transparent text-description hover:text-foreground"
											}`}
											data-testid="swarm-preset-legion-only"
											onClick={() => handleApplySwarmPreset("legion_only")}
											type="button">
											Legion Only
										</button>
										<button
											className={`text-[11px] px-2 py-0.5 rounded border cursor-pointer transition-colors ${
												!effectiveSwarmMaster &&
												effectiveCriticalReview &&
												!effectiveHierarchicalDefer &&
												!effectiveLegion
													? "border-foreground/60 bg-selection text-foreground font-medium"
													: "border-editor-widget-border/50 bg-transparent text-description hover:text-foreground"
											}`}
											data-testid="swarm-preset-review-only"
											onClick={() => handleApplySwarmPreset("review_only")}
											type="button">
											Review Only
										</button>
										<button
											className={`text-[11px] px-2 py-0.5 rounded border cursor-pointer transition-colors ${
												!effectiveSwarmMaster &&
												!effectiveCriticalReview &&
												effectiveHierarchicalDefer &&
												!effectiveLegion
													? "border-foreground/60 bg-selection text-foreground font-medium"
													: "border-editor-widget-border/50 bg-transparent text-description hover:text-foreground"
											}`}
											data-testid="swarm-preset-defer-only"
											onClick={() => handleApplySwarmPreset("defer_only")}
											type="button">
											Defer Only
										</button>
										<button
											className={`text-[11px] px-2 py-0.5 rounded border cursor-pointer transition-colors ${
												effectiveCriticalReview && effectiveHierarchicalDefer && effectiveLegion
													? "border-foreground/60 bg-selection text-foreground font-medium"
													: "border-editor-widget-border/50 bg-transparent text-description hover:text-foreground"
											}`}
											data-testid="swarm-preset-full"
											onClick={() => handleApplySwarmPreset("full_suite")}
											type="button">
											Full Swarm + Legion
										</button>
									</div>
								</div>

								{/* Sub-Capability 1: The Legion (Specialist Agent Classification, Formation & Delegation) */}
								<div className="border-t border-editor-widget-border/30 pt-1">
									<FeatureRow
										badgeText="Specialist Squads"
										checked={effectiveLegion}
										description="Classify parent task requirements, target files, and complexity to dynamically select, form, and spawn specialist subagents (Architect, Implementer, UX/Ergonomics, Hardener, QA Verifier, Forensics Recon, Data Steward) with non-overlapping file partitioning."
										label="Legion Specialist Classification & Delegation"
										onChange={(checked) => {
											if (!checked && effectiveSwarmMaster) {
												updateSettingsBatch({
													agentSwarmEnabled: false,
													agentSwarmCriticalCompletionReviewEnabled: effectiveCriticalReview,
													agentSwarmHierarchicalDeferEnabled: effectiveHierarchicalDefer,
													agentSwarmLegionEnabled: false,
												})
											} else {
												updateSetting("agentSwarmLegionEnabled", checked)
											}
										}}
									/>

									{effectiveLegion && (
										<div
											className="ml-2 pl-3 border-l-2 border-editor-widget-border/50 space-y-3 py-2 my-1"
											data-testid="legion-delegation-details">
											<div className="space-y-1.5">
												<Label
													className="text-xs font-medium text-foreground"
													htmlFor="swarm-legion-strategy-select">
													Legion formation & classification strategy
												</Label>
												<Select
													onValueChange={(value) => updateSetting("agentSwarmLegionStrategy", value)}
													value={currentLegionStrategy}>
													<SelectTrigger
														aria-label="Legion formation & classification strategy"
														className="w-full"
														id="swarm-legion-strategy-select">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														{LEGION_STRATEGY_OPTIONS.map((opt) => (
															<SelectItem key={opt.value} value={opt.value}>
																{opt.label}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
												<p className="text-[11px] text-description m-0">
													{
														LEGION_STRATEGY_OPTIONS.find((o) => o.value === currentLegionStrategy)
															?.summary
													}
												</p>
											</div>

											<SettingsSlider
												description="Maximum number of specialist subagents the parent orchestrator can form per Legion delegation (Spec default: 4)."
												label="Max specialists per Legion formation"
												max={8}
												min={1}
												onChange={(value) => updateSetting("agentSwarmLegionMaxSpecialists", value)}
												step={1}
												value={currentLegionMaxSpecialists}
												valueWidth="w-6"
											/>

											{/* Specialist Roster Matrix Preview */}
											<div className="space-y-1.5 pt-1" data-testid="legion-stage-pipeline">
												<div className="text-[11px] font-medium text-foreground/80">
													Formation pipeline — stages run in order; each waits for the one before
												</div>
												<ol className="m-0 p-0 list-none flex flex-col sm:flex-row gap-1.5">
													{LEGION_STAGES.map((stage) => (
														<li
															className="flex-1 px-2 py-1.5 rounded border border-editor-widget-border/40 bg-editor-widget-background/30"
															key={stage.id}>
															<div className="text-[11px] font-medium text-foreground">
																{stage.label}
															</div>
															<div className="text-[10px] text-description">{stage.summary}</div>
														</li>
													))}
												</ol>
												<div className="text-[10px] text-description">
													If a specialist fails, LUMI re-routes its work once to a replacement, then
													escalates to the coordinator with an unresolved-failure report.
												</div>
											</div>
											<div className="space-y-1.5 pt-1" data-testid="legion-specialist-roster-grid">
												<div className="text-[11px] font-medium text-foreground/80">
													Available Specialist Archetypes (Auto-Classified by Task & File Signals)
												</div>
												<div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
													{LEGION_SPECIALIST_ARCHETYPES.map((spec) => (
														<div
															className="px-2 py-1.5 rounded border border-editor-widget-border/40 bg-editor-widget-background/30 flex flex-col gap-0.5"
															key={spec.role}>
															<div className="flex items-center justify-between gap-1">
																<span className="text-[11px] font-medium text-foreground">
																	{spec.title}
																</span>
																<code className="text-[10px] text-description">
																	{spec.codename}
																</code>
															</div>
															<span className="text-[10px] text-description">{spec.focus}</span>
															<Badge
																className="self-start text-[10px] px-1.5 py-0 h-4"
																variant="outline">
																{LEGION_STAGES.find((stage) => stage.id === spec.stage)?.label}
															</Badge>
														</div>
													))}
												</div>
											</div>
										</div>
									)}
								</div>

								{/* Sub-Capability 2: Critical Completion Review */}
								<div className="border-t border-editor-widget-border/30 pt-1">
									<FeatureRow
										badgeText="Post-Completion"
										checked={effectiveCriticalReview}
										description="Run a bounded post-completion verification pass that strictly separates confirmed defects from unverified assumptions and non-blocking suggestions (optional/subjective items never trigger remediation)."
										label="Critical Completion Review"
										onChange={(checked) => {
											if (!checked && effectiveSwarmMaster) {
												updateSettingsBatch({
													agentSwarmEnabled: false,
													agentSwarmCriticalCompletionReviewEnabled: false,
													agentSwarmHierarchicalDeferEnabled: effectiveHierarchicalDefer,
													agentSwarmLegionEnabled: effectiveLegion,
												})
											} else {
												updateSetting("agentSwarmCriticalCompletionReviewEnabled", checked)
											}
										}}
									/>

									{effectiveCriticalReview && (
										<div
											className="ml-2 pl-3 border-l-2 border-editor-widget-border/50 space-y-3 py-2 my-1"
											data-testid="critical-review-details">
											<SettingsSlider
												description="Maximum initial adversarial reviews per completion event before requiring explicit authorization (Spec default: 1)."
												label="Max initial adversarial reviews per completion"
												max={5}
												min={1}
												onChange={(value) =>
													updateSetting("agentSwarmMaxInitialCompletionReviews", value)
												}
												step={1}
												value={currentMaxInitialReviews}
												valueWidth="w-6"
											/>
											<SettingsSlider
												description="Maximum corrective verification passes after remediation before escalating or accepting with disclosed limitations (Spec default: 1)."
												label="Max corrective verification passes"
												max={5}
												min={1}
												onChange={(value) =>
													updateSetting("agentSwarmMaxCorrectiveVerificationPasses", value)
												}
												step={1}
												value={currentMaxCorrectivePasses}
												valueWidth="w-6"
											/>
										</div>
									)}
								</div>

								{/* Sub-Capability 3: Cooperative Hierarchical Agent Defer & Resume */}
								<div className="border-t border-editor-widget-border/30 pt-1">
									<FeatureRow
										badgeText="Multi-Stream"
										checked={effectiveHierarchicalDefer}
										description="Allow cooperative, checkpointed suspension and resumption across parent and child agent streams at safe execution boundaries without cancelling work or merging stream histories."
										label="Hierarchical Agent Defer & Resume"
										onChange={(checked) => {
											if (!checked && effectiveSwarmMaster) {
												updateSettingsBatch({
													agentSwarmEnabled: false,
													agentSwarmCriticalCompletionReviewEnabled: effectiveCriticalReview,
													agentSwarmHierarchicalDeferEnabled: false,
													agentSwarmLegionEnabled: effectiveLegion,
												})
											} else {
												updateSetting("agentSwarmHierarchicalDeferEnabled", checked)
											}
										}}
									/>

									{effectiveHierarchicalDefer && (
										<div
											className="ml-2 pl-3 border-l-2 border-editor-widget-border/50 space-y-3 py-2 my-1"
											data-testid="hierarchical-defer-details">
											<div className="space-y-1.5">
												<Label
													className="text-xs font-medium text-foreground"
													htmlFor="swarm-defer-boundary-select">
													Default execution boundary for defer requests
												</Label>
												<Select
													onValueChange={(value) =>
														updateSetting("agentSwarmDefaultDeferBoundary", value)
													}
													value={currentBoundary}>
													<SelectTrigger
														aria-label="Default execution boundary for defer requests"
														className="w-full"
														id="swarm-defer-boundary-select">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														{DEFER_BOUNDARY_OPTIONS.map((opt) => (
															<SelectItem key={opt.value} value={opt.value}>
																{opt.label}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
												<p className="text-[11px] text-description m-0">
													{DEFER_BOUNDARY_OPTIONS.find((o) => o.value === currentBoundary)?.summary}
												</p>
											</div>

											<FeatureRow
												checked={currentAutoDefer}
												description="Automatically suspend the active parent/child pipeline at the configured boundary while Critical Completion Review evaluates completed work, and resume once accepted."
												label="Auto-defer pipeline during Critical Completion Review"
												onChange={(checked) =>
													updateSetting("agentSwarmAutoDeferOnCompletionReview", checked)
												}
											/>
										</div>
									)}
								</div>

								{/* Effective Status Summary Footer */}
								<div
									className="mt-2 pt-2 border-t border-editor-widget-border/30 flex items-center justify-between text-[11px] text-description"
									data-testid="agent-swarm-status-summary">
									<span className="flex items-center gap-1.5">
										<ShieldCheck className="w-3.5 h-3.5 shrink-0" />
										<span>
											Legion: <strong>{effectiveLegion ? `On (${currentLegionStrategy})` : "Off"}</strong> ·
											Review: <strong>{effectiveCriticalReview ? "On" : "Off"}</strong> · Defer:{" "}
											<strong>{effectiveHierarchicalDefer ? "On" : "Off"}</strong> · Boundary:{" "}
											<code className="text-[10px]">{currentBoundary}</code>
										</span>
									</span>
									<span>
										Max Squad: {currentLegionMaxSpecialists} · Bounds: {currentMaxInitialReviews}+
										{currentMaxCorrectivePasses}
									</span>
								</div>
							</div>
						</div>
					)}

					{/* Editor features */}
					{filteredEditorFeatures.length > 0 && (
						<div>
							<div className="text-xs font-medium text-foreground/70 mb-3">In your editor</div>
							<div
								className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
								id="optional-features">
								{filteredEditorFeatures.map(renderFeature)}
							</div>
						</div>
					)}

					{/* Experimental features */}
					{filteredExperimentalFeatures.length > 0 && (
						<div>
							<div className="text-xs font-medium mb-3 text-description/80">Optional reviews</div>
							<div
								className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50 w-full"
								id="experimental-features">
								{filteredExperimentalFeatures.map(renderFeature)}
							</div>
						</div>
					)}
				</div>

				{/* Advanced */}
				{showAdvancedSection && (
					<div>
						<div className="text-xs font-medium text-foreground/70 mb-3">More options</div>
						<div
							className="relative p-3 my-3 rounded-lg border border-editor-widget-border/40"
							id="advanced-features">
							<div className="space-y-3">
								<div className="space-y-2">
									<Label className="text-sm font-medium text-foreground">Tool reply style</Label>
									<p className="text-xs text-muted-foreground">How responses from extra tools appear in chat</p>
									<Select onValueChange={(v) => updateSetting("mcpDisplayMode", v)} value={mcpDisplayMode}>
										<SelectTrigger className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="plain">Plain Text</SelectItem>
											<SelectItem value="rich">Rich Display</SelectItem>
											<SelectItem value="markdown">Markdown</SelectItem>
										</SelectContent>
									</Select>
								</div>
							</div>
						</div>
					</div>
				)}
			</Section>
		</div>
	)
}
export default memo(FeatureSettingsSection)
