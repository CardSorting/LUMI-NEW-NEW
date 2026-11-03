/**
 * Drives an existing Legion formation through a host-supplied specialist executor.
 * The host is responsible for providing an isolated, permission-scoped agent execution.
 */

import { dbPool } from "../db/BufferedDbPool"
import type { EffectiveAgentSwarmFeatureState } from "./AgentSwarmConfig"
import { type LegionSynthesisReport, legionCoordinator, type SpawnedLegionMember } from "./LegionCoordinator"
import { orchestrator } from "./Orchestrator"

export type LegionExecutionResult =
	| { status: "completed"; summary: string }
	| { status: "failed"; reason: string; safeToRetry?: boolean }
	| { status: "unresolved"; reason: string }

export interface LegionExecutionHost {
	/** Must settle only after its execution has stopped, including on cancellation. */
	execute(member: SpawnedLegionMember, context: { handoff: string[]; signal: AbortSignal }): Promise<LegionExecutionResult>
}

export interface LegionPipelineResult {
	status: "completed" | "failed" | "cancelled" | "needs_reconciliation" | "not_found"
	report?: LegionSynthesisReport
	detail?: string
}

// Prevent two callers in this extension process from dispatching the same formation.
// This is not a cross-process lease; a running member after restart is ambiguous.
const activeFormations = new Map<string, Promise<LegionPipelineResult>>()

export function runLegionPipeline(
	parentStreamId: string,
	formationId: string,
	host: LegionExecutionHost,
	signal: AbortSignal,
): Promise<LegionPipelineResult> {
	const key = `${parentStreamId}:${formationId}`
	const active = activeFormations.get(key)
	if (active) return active
	const run = drivePipeline(parentStreamId, formationId, host, signal).finally(() => {
		if (activeFormations.get(key) === run) activeFormations.delete(key)
	})
	activeFormations.set(key, run)
	return run
}

async function drivePipeline(
	parentStreamId: string,
	formationId: string,
	host: LegionExecutionHost,
	signal: AbortSignal,
): Promise<LegionPipelineResult> {
	let ownsFormation = false
	for (;;) {
		if (signal.aborted) return { status: "cancelled" }
		const progress = await orchestrator.getLegionStageProgression(parentStreamId, formationId)
		if (!progress) return { status: "not_found" }
		// A nonterminal member that is not ready may still be executing elsewhere.
		// Do not start siblings or declare the formation settled until it is reconciled.
		const ambiguous = Object.values(progress.stages).some((stage) => {
			if (stage.status === "blocked_by_prior_stage") return false
			const accounted = new Set([...stage.readyStreamIds, ...stage.completedStreamIds, ...stage.failedStreamIds])
			return stage.memberStreamIds.some((id) => !accounted.has(id))
		})
		if (ambiguous) return { status: "needs_reconciliation" }
		if (progress.allStagesCompleted || (progress.hasFailures && progress.readyToExecuteMembers.length === 0)) {
			const report = (await orchestrator.synthesizeLegionExecutionReport(parentStreamId, formationId)) ?? undefined
			return { status: progress.allStagesCompleted ? "completed" : "failed", report }
		}
		// Never replay a possibly live execution after restart. An external host must
		// reconcile it with its own execution handle before the pipeline can resume.
		const member = progress.readyToExecuteMembers[0]
		if (!member) return { status: "needs_reconciliation" }
		if (!ownsFormation) {
			try {
				// Ensure the parent stream exists on disk before creating the token.
				await dbPool.flush()
				ownsFormation = await legionCoordinator.acquireFormationDispatchToken(parentStreamId, formationId)
			} catch {
				return { status: "needs_reconciliation" }
			}
			if (!ownsFormation) return { status: "needs_reconciliation" }
		}

		// Serialize writes until the host provides enforceable file ownership. Legion's
		// current reservations are advisory and cannot safely arbitrate parallel edits.
		const claimed = await legionCoordinator.claimReadySpecialist(member.streamId)
		if (!claimed) {
			return { status: "needs_reconciliation" }
		}
		// Formation and the running claim must be durable before a host can mutate
		// anything. If flush fails, leave the outcome unresolved and do not launch.
		let durable = false
		try {
			await dbPool.flush()
			durable = await legionCoordinator.isClaimDurable(parentStreamId, formationId, member.streamId)
			if (durable) durable = await legionCoordinator.acquireDispatchToken(member.streamId)
		} catch {
			// A failed barrier leaves the claim ambiguous; never launch or replay it.
		}
		if (!durable) {
			return { status: "needs_reconciliation" }
		}
		if (signal.aborted) {
			// No execution was started; record a failure rather than leaving a false running owner.
			await orchestrator.failStream(member.streamId, "Cancelled before specialist execution started", {
				skipFailover: true,
			})
			return { status: "cancelled" }
		}
		let result: LegionExecutionResult
		try {
			result = await host.execute(member, { handoff: progress.priorStageHandoffContext, signal })
		} catch (error) {
			result = { status: "failed", reason: error instanceof Error ? error.message : String(error) }
		}
		if (result.status === "unresolved") return { status: "needs_reconciliation", detail: result.reason }
		if (result.status === "completed" && result.summary.trim()) {
			await orchestrator.completeStream(member.streamId, result.summary)
		} else {
			await orchestrator.failStream(
				member.streamId,
				result.status === "failed" ? result.reason : "Specialist returned an empty result",
				{ skipFailover: signal.aborted || result.status !== "failed" || result.safeToRetry !== true },
			)
		}
		if (signal.aborted) return { status: "cancelled" }
	}
}

export interface AutomaticLegionInput {
	parentStreamId: string
	taskDescription: string
	targetFiles?: string[]
	/** Host policy must explicitly allow delegation before any formation is created. */
	delegationAllowed: boolean
	host?: LegionExecutionHost
	signal: AbortSignal
	resolvedFeatureState?: EffectiveAgentSwarmFeatureState
}

export type AutomaticLegionResult =
	| { decision: "local"; reason: string }
	| { decision: "delegated"; formationId: string; pipeline: LegionPipelineResult }
	| { decision: "needs_reconciliation"; formationId?: string }

const activeDecisions = new Map<string, Promise<AutomaticLegionResult>>()

/** Decide, form and operate a team when configured and supported by the host. */
export function runAutomaticLegion(input: AutomaticLegionInput): Promise<AutomaticLegionResult> {
	const existing = activeDecisions.get(input.parentStreamId)
	if (existing) return existing
	const decision = decideAndRunLegion(input).finally(() => {
		if (activeDecisions.get(input.parentStreamId) === decision) activeDecisions.delete(input.parentStreamId)
	})
	activeDecisions.set(input.parentStreamId, decision)
	return decision
}

async function decideAndRunLegion(input: AutomaticLegionInput): Promise<AutomaticLegionResult> {
	if (input.signal.aborted) return { decision: "local", reason: "Task cancelled" }
	if (!input.delegationAllowed || !input.host) return { decision: "local", reason: "Delegation unavailable or prohibited" }
	const { resolveEffectiveAgentSwarmState } = await import("./AgentSwarmConfig")
	const state = input.resolvedFeatureState ?? resolveEffectiveAgentSwarmState({ streamId: input.parentStreamId })
	if (!state.legionEnabled) return { decision: "local", reason: "Legion disabled" }
	if (!input.taskDescription.trim()) return { decision: "local", reason: "No task objective" }
	const previous = await orchestrator.recallLastLegionFormation(input.parentStreamId)
	if (previous && previous.status !== "completed")
		return { decision: "needs_reconciliation", formationId: previous.formationId }
	if (previous?.objective === input.taskDescription) return { decision: "local", reason: "Objective already formed" }
	const classification = orchestrator.classifyTaskForLegion({
		taskDescription: input.taskDescription,
		targetFiles: input.targetFiles,
		strategy: state.legionStrategy,
		maxSpecialists: state.legionMaxSpecialists,
	})
	if (classification.formationRoster.length < 2 || classification.complexityScore < 3.2) {
		return { decision: "local", reason: "Task does not warrant a specialist team" }
	}
	if (input.signal.aborted) return { decision: "local", reason: "Task cancelled" }
	try {
		await dbPool.flush()
		if (!(await legionCoordinator.acquireAutomaticFormationToken(input.parentStreamId, input.taskDescription))) {
			return { decision: "needs_reconciliation" }
		}
	} catch {
		return { decision: "needs_reconciliation" }
	}
	const formed = await orchestrator.formLegion(input.parentStreamId, {
		taskDescription: input.taskDescription,
		targetFiles: input.targetFiles,
		resolvedFeatureState: state,
	})
	if (!formed.formed || !formed.manifest) return { decision: "local", reason: formed.reason ?? "Formation unavailable" }
	return {
		decision: "delegated",
		formationId: formed.manifest.formationId,
		pipeline: await runLegionPipeline(input.parentStreamId, formed.manifest.formationId, input.host, input.signal),
	}
}
