/**
 * [LAYER: INFRASTRUCTURE]
 */
import type { TaskAuditMetadata } from "@shared/audit/types"
import { v4 as uuidv4 } from "uuid"
import { Logger } from "@/shared/services/Logger"
import { dbPool } from "../db/BufferedDbPool"
import { type EffectiveAgentSwarmFeatureState, resolveEffectiveAgentSwarmState } from "./AgentSwarmConfig"
import { type DeferredPipelineStatus, hierarchicalDeferCoordinator } from "./HierarchicalDeferCoordinator"

/**
 * Strict Evidence & Defect Classification Categories (`agentswarm2.md` §3).
 * Never conflates confirmed defects, unverified risks, and optional improvements.
 */
export type CriticalReviewFindingCategory =
	| "demonstrable_defect"
	| "reproducible_failure"
	| "unsatisfied_requirement"
	| "material_risk"
	| "unverified_assumption"
	| "optional_improvement"
	| "subjective_preference"

/**
 * Structured Defect Evidence Schema (`agentswarm2.md` §4).
 */
export interface CriticalReviewFinding {
	id: string
	category: CriticalReviewFindingCategory
	affectedComponent: string
	triggeringCondition: string
	expectedBehavior: string
	actualBehavior: string
	rootCause: string
	recommendedCorrectiveAction: string
	isHypothetical: boolean
	isVerified: boolean
}

/**
 * Explicit Review Decisions (`agentswarm2.md` §5).
 */
export type CriticalCompletionDecision = "ACCEPT" | "REMEDIATE" | "ESCALATE" | "ACCEPT_WITH_DISCLOSED_LIMITATIONS"

export interface CorrectiveTaskItem {
	id: string
	findingId: string
	priority: 1 | 2 | 3
	affectedComponent: string
	description: string
	recommendedAction: string
	recommendedSpecialistRole?: import("./AgentSwarmConfig").LegionSpecialistRole
	recommendedSpecialistCodename?: string
	status: "pending" | "assigned" | "completed"
}

export interface CriticalReviewCycleState {
	completionEventId: string
	streamId: string
	taskId?: string
	initialReviewsUsed: number
	maxInitialReviews: number
	correctivePassesUsed: number
	maxCorrectivePasses: number
	remediationAuthorized: boolean
	lastDecision?: CriticalCompletionDecision
	updatedAt: number
}

export interface CriticalCompletionReviewInput {
	streamId: string
	taskId?: string
	agentId?: string
	completionEventId?: string
	taskDescription: string
	taskResult: string
	auditMetadata?: TaskAuditMetadata
	/** Explicit findings supplied by a reviewing subagent or caller. */
	findings?: Array<Partial<CriticalReviewFinding> & { category: CriticalReviewFindingCategory }>
	/** Indicates whether a required verification environment/capability was unavailable so blocking risk cannot be resolved internally. */
	blockingCapabilityUnavailable?: boolean
	/** Indicates whether this pass is verifying a prior remediation pass. */
	isCorrectiveVerificationPass?: boolean
	/** Manual invocation overrides disabled global/agent config for this review. */
	manualInvocation?: boolean
	/** Optional override for whether to defer the pipeline while reviewing. */
	deferPipelineDuringReview?: boolean
	/** Pre-resolved effective state from TaskConfig / caller if available. */
	resolvedFeatureState?: EffectiveAgentSwarmFeatureState
}

export interface CriticalCompletionReviewReport {
	reviewId: string
	completionEventId: string
	streamId: string
	taskId?: string
	executed: boolean
	skippedReason?: string
	featureState: EffectiveAgentSwarmFeatureState
	passType: "skipped" | "initial_adversarial_review" | "corrective_verification_pass" | "bounded_limit_reached"
	decision: CriticalCompletionDecision
	decisionJustification: string
	confirmedDefects: CriticalReviewFinding[]
	unverifiedRisksAndAssumptions: CriticalReviewFinding[]
	optionalAndSubjectiveItems: CriticalReviewFinding[]
	prioritizedCorrectiveTasks: CorrectiveTaskItem[]
	cycleState: CriticalReviewCycleState
	deferredPipelineStatus?: DeferredPipelineStatus
	coordinatorFinalReportMarkdown: string
	timestamp: number
}

const CONFIRMED_DEFECT_CATEGORIES = new Set<CriticalReviewFindingCategory>([
	"demonstrable_defect",
	"reproducible_failure",
	"unsatisfied_requirement",
])

const RISK_OR_UNVERIFIED_CATEGORIES = new Set<CriticalReviewFindingCategory>(["material_risk", "unverified_assumption"])

const NON_BLOCKING_ADVISORY_CATEGORIES = new Set<CriticalReviewFindingCategory>(["optional_improvement", "subjective_preference"])

/**
 * CriticalCompletionReviewService implements the optional, configurable post-completion
 * review capability specified in `agentswarm2.md` and integrated with hierarchical defer
 * in `agentswarm3.md` / `agentswarm4.md`.
 *
 * Key Guarantees:
 * - Toggleable Auxiliary Feature: Disabled by default (`enabled: false`). When disabled,
 *   returns immediately with `executed: false` and `decision: "ACCEPT"` without altering normal task flow.
 * - Strict Category Separation: Confirmed defects (`demonstrable_defect`, `reproducible_failure`,
 *   `unsatisfied_requirement`) are strictly separated from unverified risks (`material_risk`,
 *   `unverified_assumption`) and advisory suggestions (`optional_improvement`, `subjective_preference`).
 *   Optional/subjective items NEVER trigger `REMEDIATE`.
 * - Bounded Termination: Enforces at most 1 initial adversarial review per completion event and
 *   at most 1 corrective verification pass after remediation.
 * - Coordinator Orchestration: Preserves separate agent streams, optionally suspends the pipeline
 *   via `HierarchicalDeferCoordinator` while reviewing, and generates a transparent final report.
 */
export class CriticalCompletionReviewService {
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

	public async getCycleState(
		streamId: string,
		completionEventId: string,
		featureState?: EffectiveAgentSwarmFeatureState,
		taskId?: string,
	): Promise<CriticalReviewCycleState> {
		const existing = await this.recallRecord<CriticalReviewCycleState>(streamId, `critical_review_cycle:${completionEventId}`)
		if (existing) {
			return existing
		}
		const resolved = featureState ?? resolveEffectiveAgentSwarmState({ streamId, taskId })
		return {
			completionEventId,
			streamId,
			taskId,
			initialReviewsUsed: 0,
			maxInitialReviews: resolved.maxInitialCompletionReviews,
			correctivePassesUsed: 0,
			maxCorrectivePasses: resolved.maxCorrectiveVerificationPasses,
			remediationAuthorized: false,
			updatedAt: Date.now(),
		}
	}

	/**
	 * Synthesizes structured findings from explicit reviewer input and/or deterministic
	 * task completion & audit signals, strictly separating confirmed defects, unverified
	 * assumptions, and optional improvements.
	 */
	public classifyFindings(input: CriticalCompletionReviewInput): {
		confirmedDefects: CriticalReviewFinding[]
		unverifiedRisksAndAssumptions: CriticalReviewFinding[]
		optionalAndSubjectiveItems: CriticalReviewFinding[]
	} {
		const normalizedFindings: CriticalReviewFinding[] = []

		// 1. Normalize any explicitly provided findings
		if (input.findings && input.findings.length > 0) {
			for (const raw of input.findings) {
				const isHypothetical =
					raw.isHypothetical ??
					(RISK_OR_UNVERIFIED_CATEGORIES.has(raw.category) || NON_BLOCKING_ADVISORY_CATEGORIES.has(raw.category))
				const isVerified = raw.isVerified ?? (CONFIRMED_DEFECT_CATEGORIES.has(raw.category) && !isHypothetical)

				// Spec §4: Hypothetical or unverified issues must be labeled as such and must not be treated as confirmed defects
				let effectiveCategory = raw.category
				if (CONFIRMED_DEFECT_CATEGORIES.has(effectiveCategory) && (isHypothetical || !isVerified)) {
					effectiveCategory = "unverified_assumption"
				}

				normalizedFindings.push({
					id: raw.id ?? uuidv4(),
					category: effectiveCategory,
					affectedComponent: raw.affectedComponent ?? "task_output",
					triggeringCondition: raw.triggeringCondition ?? "During completion verification",
					expectedBehavior: raw.expectedBehavior ?? "All task requirements satisfied without defect",
					actualBehavior: raw.actualBehavior ?? "Observed discrepancy during completion review",
					rootCause: raw.rootCause ?? "Unresolved defect or unverified assumption in implementation",
					recommendedCorrectiveAction:
						raw.recommendedCorrectiveAction ?? "Remediate the affected component and re-verify",
					isHypothetical,
					isVerified,
				})
			}
		} else {
			// 2. Derive structured findings from audit metadata and result text when no explicit findings array was passed
			const violations = input.auditMetadata?.violations ?? []
			for (const v of violations) {
				if (v === "security_leak" || v.startsWith("unresolved_work_marker:") || v === "reported_blocker") {
					normalizedFindings.push({
						id: uuidv4(),
						category: "demonstrable_defect",
						affectedComponent: "completion_result",
						triggeringCondition: `Completion audit violation '${v}' triggered on submitted output`,
						expectedBehavior: "Production-ready completion without unresolved stubs, blockers, or credential leaks",
						actualBehavior: `Audit detected '${v}' in submitted task result`,
						rootCause: `Incomplete implementation or unremoved marker (${v})`,
						recommendedCorrectiveAction: `Resolve '${v}' in the affected code and verify with tests`,
						isHypothetical: false,
						isVerified: true,
					})
				} else if (v.startsWith("low_intent_coverage:")) {
					normalizedFindings.push({
						id: uuidv4(),
						category: "unsatisfied_requirement",
						affectedComponent: "task_scope",
						triggeringCondition: `Intent coverage check (${v})`,
						expectedBehavior: `Address primary requirements in: ${input.taskDescription.slice(0, 120)}`,
						actualBehavior: `Submitted result has low alignment with requested task objectives (${v})`,
						rootCause: "Task result omits key requirements from the original task prompt",
						recommendedCorrectiveAction: "Implement and document all required deliverables from the task prompt",
						isHypothetical: false,
						isVerified: true,
					})
				} else if (v === "missing_validation_evidence") {
					normalizedFindings.push({
						id: uuidv4(),
						category: "unverified_assumption",
						affectedComponent: "verification_evidence",
						triggeringCondition: "Task requested verification/testing but no test execution evidence was recorded",
						expectedBehavior: "Explicit verification evidence confirming tests ran and passed",
						actualBehavior: "Completion result lacks verification evidence",
						rootCause: "Verification was not executed or not disclosed in the completion summary",
						recommendedCorrectiveAction: "Run the relevant test suite or disclose what remained unverified",
						isHypothetical: true,
						isVerified: false,
					})
				}
			}
		}

		const confirmedDefects = normalizedFindings.filter(
			(f) => CONFIRMED_DEFECT_CATEGORIES.has(f.category) && f.isVerified && !f.isHypothetical,
		)
		const unverifiedRisksAndAssumptions = normalizedFindings.filter(
			(f) =>
				RISK_OR_UNVERIFIED_CATEGORIES.has(f.category) ||
				(CONFIRMED_DEFECT_CATEGORIES.has(f.category) && (!f.isVerified || f.isHypothetical)),
		)
		const optionalAndSubjectiveItems = normalizedFindings.filter((f) => NON_BLOCKING_ADVISORY_CATEGORIES.has(f.category))

		return {
			confirmedDefects,
			unverifiedRisksAndAssumptions,
			optionalAndSubjectiveItems,
		}
	}

	/**
	 * Executes a Critical Completion Review pass if enabled (or manually invoked).
	 */
	public async runReview(input: CriticalCompletionReviewInput): Promise<CriticalCompletionReviewReport> {
		const featureState =
			input.resolvedFeatureState ??
			resolveEffectiveAgentSwarmState({
				agentId: input.agentId,
				streamId: input.streamId,
				taskId: input.taskId,
				manualInvocation: input.manualInvocation,
			})

		const completionEventId = input.completionEventId ?? `comp-${input.streamId.slice(0, 8)}-${input.taskId ?? "default"}`
		const cycleState = await this.getCycleState(input.streamId, completionEventId, featureState, input.taskId)

		// 1. Auxiliary Feature Disabled -> Immediate no-op pass-through (`agentswarm2.md` §1)
		if (!featureState.criticalCompletionReviewEnabled) {
			const report: CriticalCompletionReviewReport = {
				reviewId: uuidv4(),
				completionEventId,
				streamId: input.streamId,
				taskId: input.taskId,
				executed: false,
				skippedReason: "Critical Completion Review auxiliary feature is disabled.",
				featureState,
				passType: "skipped",
				decision: "ACCEPT",
				decisionJustification: "Critical Completion Review is disabled (default); task follows standard completion flow.",
				confirmedDefects: [],
				unverifiedRisksAndAssumptions: [],
				optionalAndSubjectiveItems: [],
				prioritizedCorrectiveTasks: [],
				cycleState,
				coordinatorFinalReportMarkdown: "Critical Completion Review: Disabled (standard completion flow).",
				timestamp: Date.now(),
			}
			return report
		}

		// 2. Bounded Termination Enforcement (`agentswarm2.md` §7)
		// Max 1 initial adversarial review per completion event + max 1 corrective verification pass after remediation.
		const isCorrective =
			input.isCorrectiveVerificationPass ?? (cycleState.initialReviewsUsed >= 1 && cycleState.remediationAuthorized)

		if (!isCorrective && cycleState.initialReviewsUsed >= cycleState.maxInitialReviews) {
			// Cannot run another initial review on the same completion event without authorized remediation
			const boundedReport: CriticalCompletionReviewReport = {
				reviewId: uuidv4(),
				completionEventId,
				streamId: input.streamId,
				taskId: input.taskId,
				executed: false,
				skippedReason:
					"Bounded termination limit reached: maximum initial adversarial reviews (1) already executed for this completion event.",
				featureState,
				passType: "bounded_limit_reached",
				decision:
					cycleState.lastDecision === "REMEDIATE"
						? "ACCEPT_WITH_DISCLOSED_LIMITATIONS"
						: (cycleState.lastDecision ?? "ACCEPT"),
				decisionJustification:
					"Bounded review limit reached; preventing additional review cycles without explicit user/coordinator authorization.",
				confirmedDefects: [],
				unverifiedRisksAndAssumptions: [],
				optionalAndSubjectiveItems: [],
				prioritizedCorrectiveTasks: [],
				cycleState,
				coordinatorFinalReportMarkdown: this.formatCoordinatorFinalReport({
					decision:
						cycleState.lastDecision === "REMEDIATE"
							? "ACCEPT_WITH_DISCLOSED_LIMITATIONS"
							: (cycleState.lastDecision ?? "ACCEPT"),
					justification: "Bounded termination guard prevented an unauthorized repeat review cycle.",
					confirmedDefects: [],
					unverifiedRisksAndAssumptions: [],
					optionalAndSubjectiveItems: [],
					prioritizedCorrectiveTasks: [],
					passType: "bounded_limit_reached",
				}),
				timestamp: Date.now(),
			}
			return boundedReport
		}

		if (isCorrective && cycleState.correctivePassesUsed >= cycleState.maxCorrectivePasses) {
			const boundedCorrectiveReport: CriticalCompletionReviewReport = {
				reviewId: uuidv4(),
				completionEventId,
				streamId: input.streamId,
				taskId: input.taskId,
				executed: false,
				skippedReason:
					"Bounded termination limit reached: maximum corrective verification passes (1) already executed after remediation.",
				featureState,
				passType: "bounded_limit_reached",
				decision: "ACCEPT_WITH_DISCLOSED_LIMITATIONS",
				decisionJustification:
					"Maximum corrective verification passes (1) reached; terminating review loop with disclosed limitations rather than entering an infinite remediation loop.",
				confirmedDefects: [],
				unverifiedRisksAndAssumptions: [],
				optionalAndSubjectiveItems: [],
				prioritizedCorrectiveTasks: [],
				cycleState,
				coordinatorFinalReportMarkdown: this.formatCoordinatorFinalReport({
					decision: "ACCEPT_WITH_DISCLOSED_LIMITATIONS",
					justification:
						"Maximum corrective verification passes (1) reached; terminating review loop per bounded termination policy.",
					confirmedDefects: [],
					unverifiedRisksAndAssumptions: [],
					optionalAndSubjectiveItems: [],
					prioritizedCorrectiveTasks: [],
					passType: "bounded_limit_reached",
				}),
				timestamp: Date.now(),
			}
			return boundedCorrectiveReport
		}

		// 3. Optional Integration with Hierarchical Defer (`agentswarm3.md` §1)
		let deferredPipelineStatus: DeferredPipelineStatus | undefined
		const shouldDeferPipeline =
			(input.deferPipelineDuringReview ?? featureState.autoDeferOnCompletionReview) && featureState.hierarchicalDeferEnabled
		if (shouldDeferPipeline) {
			try {
				const streamExists = await dbPool.selectOne("agent_streams", { column: "id", value: input.streamId })
				if (streamExists) {
					deferredPipelineStatus = await hierarchicalDeferCoordinator.deferPipeline(input.streamId, {
						boundary: featureState.defaultDeferBoundary,
						reason: `Critical Completion Review in progress for ${completionEventId}`,
						forceEnable: true,
					})
				}
			} catch (err) {
				Logger.warn(
					`[CriticalCompletionReview] Optional pipeline defer skipped for ${input.streamId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}

		// 4. Classify Evidence & Determine Explicit Decision (`agentswarm2.md` §3, §4, §5)
		const { confirmedDefects, unverifiedRisksAndAssumptions, optionalAndSubjectiveItems } = this.classifyFindings(input)

		let decision: CriticalCompletionDecision
		let decisionJustification: string
		const prioritizedCorrectiveTasks: CorrectiveTaskItem[] = []

		if (
			input.blockingCapabilityUnavailable &&
			(confirmedDefects.length > 0 || unverifiedRisksAndAssumptions.some((r) => r.category === "material_risk"))
		) {
			decision = "ESCALATE"
			decisionJustification =
				"Blocking risk or defect cannot be resolved within current agent capabilities or permissions; escalating to user/coordinator."
		} else if (confirmedDefects.length > 0) {
			if (isCorrective) {
				// Already ran remediation + 1 corrective pass; do not loop infinitely (`agentswarm2.md` §7)
				decision = "ESCALATE"
				decisionJustification = `${confirmedDefects.length} confirmed defect(s) remain unresolved after the bounded corrective verification pass; escalating to prevent an unbounded remediation loop.`
			} else {
				decision = "REMEDIATE"
				decisionJustification = `${confirmedDefects.length} confirmed defect(s) or unsatisfied requirement(s) identified with concrete evidence. Optional/subjective suggestions (${optionalAndSubjectiveItems.length}) were excluded from triggering remediation.`
				const { legionCoordinator } = await import("./LegionCoordinator")
				for (let i = 0; i < confirmedDefects.length; i++) {
					const defect = confirmedDefects[i]
					const recommendedSpecialist = legionCoordinator.recommendRemediationSpecialist(defect)
					prioritizedCorrectiveTasks.push({
						id: `remediate-${completionEventId}-${i + 1}`,
						findingId: defect.id,
						priority: defect.category === "demonstrable_defect" || defect.category === "reproducible_failure" ? 1 : 2,
						affectedComponent: defect.affectedComponent,
						description: `[${defect.category}] ${defect.actualBehavior} (Expected: ${defect.expectedBehavior})`,
						recommendedAction: defect.recommendedCorrectiveAction,
						recommendedSpecialistRole: recommendedSpecialist.role,
						recommendedSpecialistCodename: recommendedSpecialist.codename,
						status: "pending",
					})
				}
			}
		} else if (unverifiedRisksAndAssumptions.length > 0) {
			decision = "ACCEPT_WITH_DISCLOSED_LIMITATIONS"
			decisionJustification = `Core requirements are satisfied with zero confirmed defects, but ${unverifiedRisksAndAssumptions.length} unverified assumption(s) or residual risk(s) must be disclosed.`
		} else {
			decision = "ACCEPT"
			decisionJustification =
				optionalAndSubjectiveItems.length > 0
					? `Requirements are satisfied and verified with zero confirmed defects (${optionalAndSubjectiveItems.length} non-blocking optional/subjective observation(s) noted without blocking acceptance).`
					: "All requirements are satisfied and verified with zero confirmed defects or unverified assumptions."
		}

		// 5. Incorporate confirmed findings into the existing rolling roadmap (`agentswarm2.md` §6)
		// and resume the coordinator pipeline if it was deferred for this review (`agentswarm3.md` §8)
		const existingRoadmap = await this.recallRecord<import("./HierarchicalDeferCoordinator").RollingRoadmapSnapshot>(
			input.streamId,
			"rolling_roadmap_snapshot",
		)
		if (existingRoadmap || prioritizedCorrectiveTasks.length > 0) {
			const updatedRoadmap: import("./HierarchicalDeferCoordinator").RollingRoadmapSnapshot = {
				objective: existingRoadmap?.objective ?? input.taskDescription.slice(0, 120),
				activeChildAssignments: existingRoadmap?.activeChildAssignments ?? [],
				completedWork: existingRoadmap?.completedWork ?? [],
				outstandingWork: [
					...(existingRoadmap?.outstandingWork ?? []),
					...prioritizedCorrectiveTasks.map((t) => `[P${t.priority}] ${t.affectedComponent}: ${t.recommendedAction}`),
				],
				dependenciesAndBlockers: existingRoadmap?.dependenciesAndBlockers ?? [],
				decisionsMade: [
					...(existingRoadmap?.decisionsMade ?? []),
					`Critical Completion Review (${completionEventId}): ${decision}`,
				],
				nextActions:
					decision === "REMEDIATE"
						? prioritizedCorrectiveTasks.map((t) => t.recommendedAction)
						: (existingRoadmap?.nextActions ?? ["Complete task"]),
				synchronizationStatus: "aligned",
				updatedAt: Date.now(),
			}
			await this.storeRecord(input.streamId, "rolling_roadmap_snapshot", updatedRoadmap)
		}

		if (deferredPipelineStatus && deferredPipelineStatus.phase === "suspended" && decision !== "ESCALATE") {
			try {
				await hierarchicalDeferCoordinator.resumePipeline(input.streamId, {
					reason: `Critical Completion Review concluded with decision=${decision}`,
					forceEnable: true,
				})
				deferredPipelineStatus =
					(await hierarchicalDeferCoordinator.getDeferredPipelineStatus(input.streamId)) ?? deferredPipelineStatus
			} catch (err) {
				Logger.warn(
					`[CriticalCompletionReview] Auto-resume after review skipped for ${input.streamId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}

		const passType: CriticalCompletionReviewReport["passType"] = isCorrective
			? "corrective_verification_pass"
			: "initial_adversarial_review"

		const updatedCycle: CriticalReviewCycleState = {
			...cycleState,
			initialReviewsUsed: isCorrective ? cycleState.initialReviewsUsed : cycleState.initialReviewsUsed + 1,
			correctivePassesUsed: isCorrective ? cycleState.correctivePassesUsed + 1 : cycleState.correctivePassesUsed,
			remediationAuthorized: decision === "REMEDIATE",
			lastDecision: decision,
			updatedAt: Date.now(),
		}

		await this.storeRecord(input.streamId, `critical_review_cycle:${completionEventId}`, updatedCycle)

		const coordinatorFinalReportMarkdown = this.formatCoordinatorFinalReport({
			decision,
			justification: decisionJustification,
			confirmedDefects,
			unverifiedRisksAndAssumptions,
			optionalAndSubjectiveItems,
			prioritizedCorrectiveTasks,
			passType,
		})

		const report: CriticalCompletionReviewReport = {
			reviewId: uuidv4(),
			completionEventId,
			streamId: input.streamId,
			taskId: input.taskId,
			executed: true,
			featureState,
			passType,
			decision,
			decisionJustification,
			confirmedDefects,
			unverifiedRisksAndAssumptions,
			optionalAndSubjectiveItems,
			prioritizedCorrectiveTasks,
			cycleState: updatedCycle,
			deferredPipelineStatus,
			coordinatorFinalReportMarkdown,
			timestamp: Date.now(),
		}

		await this.storeRecord(input.streamId, "last_critical_completion_review", report)
		await this.storeRecord(input.streamId, `critical_completion_review:${report.reviewId}`, report)

		Logger.info(
			`[CriticalCompletionReview] Stream ${input.streamId.slice(0, 8)} pass=${passType} decision=${decision} (defects=${confirmedDefects.length}, unverified=${unverifiedRisksAndAssumptions.length}, optional=${optionalAndSubjectiveItems.length})`,
		)

		return report
	}

	public async recallLastReview(streamId: string): Promise<CriticalCompletionReviewReport | null> {
		return this.recallRecord<CriticalCompletionReviewReport>(streamId, "last_critical_completion_review")
	}

	private formatCoordinatorFinalReport(params: {
		decision: CriticalCompletionDecision
		justification: string
		confirmedDefects: CriticalReviewFinding[]
		unverifiedRisksAndAssumptions: CriticalReviewFinding[]
		optionalAndSubjectiveItems: CriticalReviewFinding[]
		prioritizedCorrectiveTasks: CorrectiveTaskItem[]
		passType: CriticalCompletionReviewReport["passType"]
	}): string {
		const lines: string[] = [
			`### Critical Completion Review (${params.passType})`,
			`- **Decision**: \`${params.decision}\``,
			`- **Justification**: ${params.justification}`,
			"",
			"#### 1. Verified Results & Confirmed Defects",
		]

		if (params.confirmedDefects.length === 0) {
			lines.push(
				"- **Confirmed Defects**: None (0 demonstrable defects, reproducible failures, or unsatisfied requirements).",
			)
		} else {
			for (const d of params.confirmedDefects) {
				lines.push(
					`- **[${d.category}]** \`${d.affectedComponent}\` — Trigger: ${d.triggeringCondition} | Expected: ${d.expectedBehavior} | Actual: ${d.actualBehavior} | Root Cause: ${d.rootCause} | Fix: ${d.recommendedCorrectiveAction}`,
				)
			}
		}

		lines.push("")
		lines.push("#### 2. Unverified Assumptions & Material Risks")
		if (params.unverifiedRisksAndAssumptions.length === 0) {
			lines.push("- None identified.")
		} else {
			for (const u of params.unverifiedRisksAndAssumptions) {
				lines.push(
					`- **[${u.category}]** \`${u.affectedComponent}\` (hypothetical=${u.isHypothetical}, verified=${u.isVerified}): ${u.actualBehavior} — Recommended: ${u.recommendedCorrectiveAction}`,
				)
			}
		}

		if (params.prioritizedCorrectiveTasks.length > 0) {
			lines.push("")
			lines.push("#### 3. Prioritized Corrective Tasks")
			for (const task of params.prioritizedCorrectiveTasks) {
				const specialistBadge =
					task.recommendedSpecialistCodename && task.recommendedSpecialistRole
						? ` · *Specialist*: \`${task.recommendedSpecialistCodename}\` (\`${task.recommendedSpecialistRole}\`)`
						: ""
				lines.push(
					`- **[P${task.priority}]** \`${task.affectedComponent}\`: ${task.description} → *Action*: ${task.recommendedAction}${specialistBadge}`,
				)
			}
		}

		if (params.optionalAndSubjectiveItems.length > 0) {
			lines.push("")
			lines.push("#### 4. Non-Blocking Optional / Subjective Notes")
			for (const opt of params.optionalAndSubjectiveItems) {
				lines.push(`- **[${opt.category}]** \`${opt.affectedComponent}\`: ${opt.recommendedCorrectiveAction}`)
			}
		}

		return lines.join("\n")
	}
}

export const criticalCompletionReviewService = new CriticalCompletionReviewService()
