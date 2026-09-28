import { buildApiHandler } from "@core/api"
import { PromptRegistry } from "@core/prompts/system-prompt"
import { HEAV3NS_MANDATE } from "@core/prompts/system-prompt/components/heav3ns_mandate"
import { DietCodeToolSet } from "@core/prompts/system-prompt/registry/DietCodeToolSet"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { DietCodeDefaultTool, withExecutionObservation } from "@shared/tools"
import { ApiConfiguration, ApiProvider } from "@/shared/api"
import { getProviderModelIdKey } from "@/shared/storage/provider-keys"
import type { TaskConfig } from "../types/TaskConfig"
import type { AgentBaseConfig } from "./AgentConfigLoader"
import { AgentConfigLoader } from "./AgentConfigLoader"

export type AgentConfig = Partial<AgentBaseConfig>

export const SUBAGENT_DEFAULT_ALLOWED_TOOLS: DietCodeDefaultTool[] = [
	DietCodeDefaultTool.FILE_READ,
	DietCodeDefaultTool.FILE_EDIT,
	DietCodeDefaultTool.FILE_NEW,
	DietCodeDefaultTool.APPLY_PATCH,
	DietCodeDefaultTool.LIST_FILES,
	DietCodeDefaultTool.SEARCH,
	DietCodeDefaultTool.LIST_CODE_DEF,
	DietCodeDefaultTool.PROJECT_MAP,
	DietCodeDefaultTool.BASH,
	DietCodeDefaultTool.READ_COMMAND_OUTPUT,
	DietCodeDefaultTool.GET_EXECUTION_STATE,
	DietCodeDefaultTool.WEB_FETCH,
	DietCodeDefaultTool.WEB_SEARCH,
	DietCodeDefaultTool.USE_SKILL,
	DietCodeDefaultTool.ATTEMPT,
	DietCodeDefaultTool.MCP_USE,
	DietCodeDefaultTool.MCP_ACCESS,
	DietCodeDefaultTool.MEM_REFRESH,
	DietCodeDefaultTool.STABILITY_DIAGNOSE,
	DietCodeDefaultTool.STABILITY_SWEEP,
]

/** A helper has a bounded assignment; workspace release checks belong to its parent. */
export const SUBAGENT_SYSTEM_SUFFIX = `
# Scoped helper workflow

- Complete the assigned scope and return findings or changes with relevant file paths. The approved assignment delegates its available tools within the workspace; do not ask the parent to reconfirm routine steps.
- Give brief public progress updates before substantial work and when switching from implementation to verification or encountering a blocker. Name the files, operation, or finding; these updates are shown live to the user. Keep internal reasoning private.
- Use only the tools exposed to you. Do not request nested helpers or wait for peer consensus; request additional review in your handoff when needed.
- Parent roadmap, checklist, and audit signals are context, not prerequisites for your handoff. Do not repair unrelated parent work or rewrite ROADMAP.md to finish your assignment.
- Follow the workspace's existing architecture and documentation conventions. Update documentation only when your assignment changes documented behavior; do not create a new wiki or audit every file by default.
- Run the smallest meaningful checks for your changes. Reuse passing evidence for unchanged code. Run broader checks only when required by the assignment, workspace policy, or a concrete failure.
- After a failed check, fix its cause before rerunning it. If the same failure remains and no new evidence or repair is available, stop retrying and report the blocker to the parent. Never claim an unavailable check passed.
- If a command continues after its foreground wait, use read_command_output with its execution_id to inspect that same run. Do independent work between unchanged reads. Do not execute the command again just to check completion.
- Finish once the assigned deliverable and relevant verification are complete. A research-only assignment can finish with findings and limitations without code changes or tests.
- Finish with attempt_completion exactly once after relevant checks. Handoff: outcome, evidence or changed paths, checks and results, active command execution IDs, and remaining blockers. A background command is pending work, not a passed check. The parent should reconcile this evidence before repeating work.
- If another writer changes a file, read its current contents and reconcile your intended edit. Never restore an earlier snapshot over another helper's work. Use a fresh tool call ID for a new action; a replayed ID returns its existing result.
- Report uncertainty explicitly. Use [SIGNAL: ARCHITECTURE_VIOLATION] or [SIGNAL: SECURITY_RISK] only for supported findings.
`

export class SubagentBuilder {
	private readonly agentConfig: AgentConfig = {}
	private allowedTools: DietCodeDefaultTool[]
	private readonly retryAbortController = new AbortController()
	private requestRetrySignal?: AbortSignal
	private readonly apiHandler: ReturnType<typeof buildApiHandler>
	private parentStreamContext: string | null = null
	private retryObserver?: (attempt: number, maxAttempts: number, delayMs: number) => void

	constructor(
		private readonly baseConfig: TaskConfig,
		subagentName?: string,
	) {
		const subagentConfig = AgentConfigLoader.getInstance().getCachedConfig(subagentName)
		this.agentConfig = subagentConfig ?? {}
		this.allowedTools = this.resolveAllowedTools(this.agentConfig.tools)

		const mode = this.baseConfig.services.stateManager.getGlobalSettingsKey("mode")
		const apiConfiguration = this.baseConfig.services.stateManager.getApiConfiguration()
		const effectiveApiConfiguration = {
			...apiConfiguration,
			ulid: this.baseConfig.ulid,
			getRetrySignal: () => this.requestRetrySignal ?? this.retryAbortController.signal,
			onRetryAttempt: (attempt: number, maxAttempts: number, delayMs: number) =>
				this.retryObserver?.(attempt, maxAttempts, delayMs),
		}

		this.applyModelOverride(effectiveApiConfiguration as Record<string, unknown>, mode, this.agentConfig.modelId)
		this.apiHandler = buildApiHandler(effectiveApiConfiguration as typeof apiConfiguration, mode)
	}

	cancelPendingRetry(): void {
		this.retryAbortController.abort()
	}

	setRetryObserver(observer?: (attempt: number, maxAttempts: number, delayMs: number) => void): void {
		this.retryObserver = observer
	}

	setRequestRetrySignal(signal?: AbortSignal): void {
		this.requestRetrySignal = signal ? AbortSignal.any([signal, this.retryAbortController.signal]) : undefined
	}

	setAllowedTools(tools: DietCodeDefaultTool[]): void {
		this.allowedTools = Array.from(new Set([...withExecutionObservation(tools), DietCodeDefaultTool.ATTEMPT]))
	}

	getApiHandler(): ReturnType<typeof buildApiHandler> {
		return this.apiHandler
	}

	setParentStreamContext(context: string): void {
		this.parentStreamContext = context
	}

	getAllowedTools(): DietCodeDefaultTool[] {
		return this.allowedTools
	}

	getConfiguredSkills(): string[] | undefined {
		return this.agentConfig.skills
	}

	buildSystemPrompt(generatedSystemPrompt: string): string {
		const configuredSystemPrompt = this.agentConfig?.systemPrompt?.trim()
		// Generated roles already contain the shared mandate; custom profiles replace those roles.
		const systemPrompt = configuredSystemPrompt ? `${configuredSystemPrompt}\n\n${HEAV3NS_MANDATE}` : generatedSystemPrompt

		// Nesting depth awareness for the subagent
		const currentDepth = this.baseConfig.taskState?.recursionDepth || 0
		const depthBlock = `\n\n# SWARM NESTING CONTEXT\nYou are operating at nesting depth ${currentDepth}. Return the assigned deliverable to your parent; additional delegation is owned by the parent.`

		// 1. Fetch current structural health signal
		let architectureSignal = ""
		architectureSignal = `\n\n# SUBSTRATE HEALTH SIGNAL\nFollow applicable workspace instructions and existing architecture. Do not assume a guide exists or architectural health has been verified.`

		const parentContextBlock = this.parentStreamContext
			? `\n\n# Parent Agent Context\n${this.parentStreamContext}\nUse the context above to prioritize your research within the broader task goals.`
			: ""

		// Cross-Agent Intelligence (Blackboard)
		const blackboard = this.baseConfig.taskState?.swarmBlackboard || []
		const blackboardBlock =
			blackboard.length > 0
				? `\n\n# SWARM BLACKBOARD (Shared Intelligence)\n${blackboard.map((f) => `- ${f}`).join("\n")}\nCONSIDER the findings above. If your research contradicts or supports these findings, signal it explicitly.`
				: ""

		return `${this.buildAgentIdentitySystemPrefix()}${systemPrompt}${depthBlock}${architectureSignal}${parentContextBlock}${blackboardBlock}${SUBAGENT_SYSTEM_SUFFIX}`
	}

	buildNativeTools(context: SystemPromptContext) {
		const family = PromptRegistry.getInstance().getModelFamily(context)
		const toolSets = DietCodeToolSet.getToolsForVariantWithFallback(family, this.allowedTools)
		const filteredToolSpecs = toolSets
			.map((toolSet) => toolSet.config)
			.filter(
				(toolSpec) =>
					this.allowedTools.includes(toolSpec.id) &&
					(!toolSpec.contextRequirements || toolSpec.contextRequirements(context)),
			)

		const converter = DietCodeToolSet.getNativeConverter(context.providerInfo.providerId, context.providerInfo.model.id)
		return filteredToolSpecs.map((tool) => converter(tool, context))
	}

	private resolveAllowedTools(configuredTools?: DietCodeDefaultTool[]): DietCodeDefaultTool[] {
		const sourceTools = configuredTools && configuredTools.length > 0 ? configuredTools : SUBAGENT_DEFAULT_ALLOWED_TOOLS
		return Array.from(new Set([...withExecutionObservation(sourceTools), DietCodeDefaultTool.ATTEMPT]))
	}

	private buildAgentIdentitySystemPrefix(): string {
		const name = this.agentConfig?.name?.trim()
		const description = this.agentConfig?.description?.trim()

		if (!name && !description) {
			return ""
		}

		const lines = ["# AGENT PROFILE"]
		if (name) {
			lines.push(`Identity: ${name}`)
		}
		if (description) {
			lines.push(`Objective: ${description}`)
		}

		return `${lines.join("\n")}\n\n`
	}

	private applyModelOverride(apiConfiguration: ApiConfiguration, _mode: string, modelId?: string): void {
		const trimmedModelId = modelId?.trim()
		if (!trimmedModelId) {
			// Even if no modelId is overridden, we still apply the thinking budget for subagents
			this.applyThinkingBudgetOverride(apiConfiguration)
			return
		}

		const modeKey = _mode === "plan" ? "plan" : "act"
		const providerKey = _mode === "plan" ? "planModeApiProvider" : "actModeApiProvider"
		const provider = apiConfiguration[providerKey as keyof ApiConfiguration] as ApiProvider
		if (provider) {
			const modelKey = getProviderModelIdKey(provider, modeKey)
			const config = apiConfiguration as Record<string, unknown>
			if (modelKey in config) {
				config[modelKey] = trimmedModelId
			}
		}

		// Apply thinking budget after model override
		this.applyThinkingBudgetOverride(apiConfiguration)
	}

	/**
	 * Applies a reduced thinking budget for subagents by default.
	 * Subagents often perform well with lower thinking budgets than parent agents.
	 * The budget is capped to 8k tokens unless explicitly overridden to a higher value.
	 * @param apiConfig The API configuration object.
	 */
	private applyThinkingBudgetOverride(apiConfig: ApiConfiguration): void {
		// Phase 3: Adaptive Thinking Budget Delegation
		// Subagents reach high performance with lower thinking budgets than parents.
		// We cap it to 8k by default for subagents unless explicitly overridden.
		const subagentDefaultThinkingBudget = 8192

		// If thinkingBudgetTokens is already set, we take the minimum of the current value and the subagent default.
		// This allows a parent to explicitly set a lower budget, but prevents a subagent from using a higher default.
		const config = apiConfig as Record<string, unknown>
		if (config.thinkingBudgetTokens !== undefined && config.thinkingBudgetTokens !== null) {
			config.thinkingBudgetTokens = Math.min(config.thinkingBudgetTokens as number, subagentDefaultThinkingBudget)
		} else {
			// If thinkingBudgetTokens is not set, we apply the subagent default.
			config.thinkingBudgetTokens = subagentDefaultThinkingBudget
		}
	}
}
