import { UpdateSettingsRequest } from "@shared/proto/dietcode/state"
import { memo, type ReactNode, useCallback, useId } from "react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { VscIcon } from "@/components/ui/vsc-icon"
import { useExtensionState } from "@/context/ExtensionStateContext"
import Section from "../Section"
import SettingsSlider from "../SettingsSlider"
import { updateSetting } from "../utils/settingsHandlers"

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
}

// Interface for feature toggle configuration
interface FeatureToggle {
	id: string
	label: string
	description: ReactNode
	settingKey: keyof UpdateSettingsRequest
	stateKey: string
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
	},
	{
		id: "native-tool-call",
		label: "Direct tool calls",
		description: "Use built-in tool calling when your model supports it.",
		stateKey: "nativeToolCallSetting",
		settingKey: "nativeToolCallEnabled",
	},
	{
		id: "parallel-tool-calling",
		label: "Parallel tool execution",
		description: "Run independent tools together; wait for results when one step depends on another.",
		stateKey: "enableParallelToolCalling",
		settingKey: "enableParallelToolCalling",
	},
	{
		id: "strict-plan-mode",
		label: "Planning stays read-only",
		description: "During the automatic planning phase, LUMI won't edit files until it begins implementation.",
		stateKey: "strictPlanModeEnabled",
		settingKey: "strictPlanModeEnabled",
	},
	{
		id: "auto-compact",
		label: "Shorten long chats",
		description: "Automatically tidy up when the conversation gets very long.",
		stateKey: "useAutoCondense",
		settingKey: "useAutoCondense",
	},
]

const editorFeatures: FeatureToggle[] = [
	{
		id: "background-edit",
		label: "Background Edit",
		description: "Allow edits without stealing editor focus",
		stateKey: "backgroundEditEnabled",
		settingKey: "backgroundEditEnabled",
	},
	{
		id: "checkpoints",
		label: "Checkpoints",
		description: "Save progress at key points for easy rollback",
		stateKey: "enableCheckpointsSetting",
		settingKey: "enableCheckpointsSetting",
	},
	{
		id: "dietcode-web-tools",
		label: "Browse the web",
		description: "Let LUMI search the web and open pages when you need outside info.",
		stateKey: "dietcodeWebToolsEnabled",
		settingKey: "dietcodeWebToolsEnabled",
	},
	{
		id: "worktrees",
		label: "Worktrees",
		description: "Run a few LUMI tasks side by side with git worktrees.",
		stateKey: "worktreesEnabled",
		settingKey: "worktreesEnabled",
	},
]

const experimentalFeatures: FeatureToggle[] = [
	{
		id: "double-check-completion",
		label: "Double-check my work",
		description: "Before saying we're done, LUMI takes a second look at what you originally asked for.",
		stateKey: "doubleCheckCompletionEnabled",
		settingKey: "doubleCheckCompletionEnabled",
	},
	{
		id: "audit-completion-gate",
		label: "Require a completion audit",
		description: "Block completion when the audit fails. Off by default; enable for tasks that need a formal review.",
		stateKey: "auditCompletionGateEnabled",
		settingKey: "auditCompletionGateEnabled",
	},
	{
		id: "audit-gate-critical-only",
		label: "Block only on critical audit findings",
		description: "Smaller warnings stay as gentle notes — only big problems block finishing.",
		stateKey: "auditCompletionGateCriticalOnly",
		settingKey: "auditCompletionGateCriticalOnly",
	},
	{
		id: "audit-advisory-escalation",
		label: "Escalate unresolved audit findings",
		description: "When completion audits are enabled, treat unresolved findings as blockers.",
		stateKey: "auditAdvisoryEscalationEnabled",
		settingKey: "auditAdvisoryEscalationEnabled",
	},
	{
		id: "audit-plan-regression-gate",
		label: "Require the planning audit score",
		description: "When completion audits are enabled, block if the score falls below the planning baseline.",
		stateKey: "auditPlanRegressionGateEnabled",
		settingKey: "auditPlanRegressionGateEnabled",
	},
	{
		id: "audit-tool-output-advisory",
		label: "Review command output",
		description: "Glance at test or build output and suggest fixes when something looks wrong.",
		stateKey: "auditToolOutputAdvisoryEnabled",
		settingKey: "auditToolOutputAdvisoryEnabled",
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
	}: FeatureCheckboxProps) => {
		const id = useId()
		if (!isVisible) {
			return null
		}

		const checkbox = (
			<div className="flex items-center justify-between gap-3 w-full">
				<Label htmlFor={id}>{label}</Label>
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
			<div className="flex flex-col items-start justify-between gap-4 py-3 w-full">
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
	} = useExtensionState()

	const isYoloRemoteLocked = remoteConfigSettings?.yoloModeToggled !== undefined

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

	// Handler for feature toggle changes
	const handleFeatureChange = useCallback((feature: FeatureToggle, checked: boolean) => {
		updateSetting(feature.settingKey, checked)
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

	return (
		<div className="mb-2">
			{renderSectionHeader("features")}
			<Section>
				<div className="mb-5 flex flex-col gap-3">
					{/* Core features */}
					<div>
						<div className="text-xs font-medium text-foreground/70 mb-3">Agent execution</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-lg border border-editor-widget-border/40"
							id="agent-features">
							{agentFeatures.map(renderFeature)}
						</div>
					</div>

					{/* Editor features */}
					<div>
						<div className="text-xs font-medium text-foreground/70 mb-3">In your editor</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
							id="optional-features">
							{editorFeatures.map(renderFeature)}
						</div>
					</div>

					{/* Experimental features */}
					<div>
						<div className="text-xs font-medium mb-3 text-description/80">Optional reviews</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50 w-full"
							id="experimental-features">
							{experimentalFeatures.map(renderFeature)}
						</div>
					</div>
				</div>

				{/* Advanced */}
				<div>
					<div className="text-xs font-medium text-foreground/70 mb-3">More options</div>
					<div className="relative p-3 my-3 rounded-lg border border-editor-widget-border/40" id="advanced-features">
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
			</Section>
		</div>
	)
}
export default memo(FeatureSettingsSection)
