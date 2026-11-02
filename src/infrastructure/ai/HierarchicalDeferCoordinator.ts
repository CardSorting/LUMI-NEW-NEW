/**
 * [LAYER: INFRASTRUCTURE]
 */
import { v4 as uuidv4 } from "uuid"
import { Logger } from "@/shared/services/Logger"
import { dbPool } from "../db/BufferedDbPool"
import { type DeferExecutionBoundary, resolveEffectiveAgentSwarmState } from "./AgentSwarmConfig"

export type { DeferExecutionBoundary }

export type AgentDeferState = "running" | "defer_requested" | "suspending" | "waiting_for_children" | "deferred" | "resuming"

export type PipelineSuspensionPhase = "active" | "suspending" | "waiting_for_children" | "suspended" | "resuming" | "resumed"

export type SwarmControlMessageType = "DEFER_REQUEST" | "DEFER_ACK" | "RESUME_REQUEST" | "RESUME_ACK"

export interface SwarmControlMessage {
	messageId: string
	pipelineId: string
	sequenceNumber: number
	type: SwarmControlMessageType
	senderId: string
	recipientId: string
	boundary: DeferExecutionBoundary
	reason: string
	checkpointId?: string
	timestamp: number
	acknowledgedAt?: number
}

export interface InFlightOperationDescriptor {
	operationId: string
	toolName: string
	isIdempotent: boolean
	canSafeInterruptImmediately: boolean
	startedAt: number
	status: "running" | "completed" | "deferred_before_start"
	resultSummary?: string
}

export interface RollingRoadmapSnapshot {
	objective: string
	activeChildAssignments: Array<{
		childStreamId: string
		taskId?: string
		description: string
		status: "pending" | "running" | "deferred" | "completed" | "failed"
		checkpointId?: string
	}>
	completedWork: string[]
	outstandingWork: string[]
	dependenciesAndBlockers: string[]
	decisionsMade: string[]
	nextActions: string[]
	synchronizationStatus: "aligned" | "suspending_children" | "barrier_satisfied" | "resumed"
	updatedAt: number
}

export interface AgentDeferCheckpoint {
	checkpointId: string
	streamId: string
	parentStreamId: string | null
	pipelineId: string
	sequenceNumber: number
	boundary: DeferExecutionBoundary
	yieldPoint: "before_turn" | "after_tool_round" | "immediate_safe_point"
	turnIndex: number
	pendingToolQueue: string[]
	completedToolReceipts: Array<{
		operationId: string
		toolName: string
		resultSummary: string
	}>
	continuationMetadata: Record<string, unknown>
	heldReservations: string[]
	heldMutexLocks: string[]
	rollingRoadmap?: RollingRoadmapSnapshot
	reason: string
	createdAt: number
}

export interface DeferredAgentStatus {
	streamId: string
	parentStreamId: string | null
	state: AgentDeferState
	boundary?: DeferExecutionBoundary
	pipelineId?: string
	sequenceNumber: number
	checkpointId?: string
	inFlightOperation?: InFlightOperationDescriptor
	pendingChildAckIds: string[]
	acknowledgedChildIds: string[]
	acceptingNewWork: boolean
	updatedAt: number
}

export interface DeferredPipelineStatus {
	pipelineId: string
	rootStreamId: string
	phase: PipelineSuspensionPhase
	boundary: DeferExecutionBoundary
	reason: string
	rootCheckpointId?: string
	rollingRoadmap?: RollingRoadmapSnapshot
	agentStatuses: Record<string, DeferredAgentStatus>
	pendingChildStreamIds: string[]
	suspendedStreamIds: string[]
	controlMessages: SwarmControlMessage[]
	initiatedAt: number
	suspendedAt?: number
	resumedAt?: number
}

export interface DeferAgentOptions {
	boundary?: DeferExecutionBoundary
	reason?: string
	pipelineId?: string
	sequenceNumber?: number
	turnIndex?: number
	pendingToolQueue?: string[]
	completedToolReceipts?: Array<{
		operationId: string
		toolName: string
		resultSummary: string
	}>
	continuationMetadata?: Record<string, unknown>
	inFlightOperation?: InFlightOperationDescriptor
	rollingRoadmap?: Partial<RollingRoadmapSnapshot>
	/** Allow manual/explicit invocation even when global toggle is off. */
	forceEnable?: boolean
}

export interface DeferPipelineOptions {
	boundary?: DeferExecutionBoundary
	reason?: string
	rollingRoadmap?: Partial<RollingRoadmapSnapshot>
	/** Map of streamId -> runtime execution state for in-flight boundary evaluation. */
	agentRuntimeStates?: Record<
		string,
		{
			turnIndex?: number
			pendingToolQueue?: string[]
			completedToolReceipts?: Array<{
				operationId: string
				toolName: string
				resultSummary: string
			}>
			continuationMetadata?: Record<string, unknown>
			inFlightOperation?: InFlightOperationDescriptor
		}
	>
	/** If true, children with in-flight non-interruptible operations remain in `suspending` until `completeInFlightAndYield` is called. */
	waitForInFlightBarriers?: boolean
	/** Allow manual/explicit invocation even when global toggle is off. */
	forceEnable?: boolean
}

export interface ResumeAgentResult {
	streamId: string
	resumed: boolean
	state: AgentDeferState
	restoredCheckpoint?: AgentDeferCheckpoint
	skippedCompletedOperationIds: string[]
	controlAck: SwarmControlMessage
}

export interface ResumePipelineResult {
	pipelineId: string
	rootStreamId: string
	resumed: boolean
	phase: PipelineSuspensionPhase
	resumedAgentResults: Record<string, ResumeAgentResult>
	restoredRoadmap?: RollingRoadmapSnapshot
}

/**
 * HierarchicalDeferCoordinator implements cooperative, checkpointed, boundary-safe
 * suspension and resumption across single agents and parent-child agent hierarchies
 * as specified in `agentswarm3.md` and `agentswarm4.md`.
 *
 * Key Guarantees:
 * 1. Defer != Cancel: Never aborts active work as failed or completed.
 * 2. Safe Boundaries: Supports `before_turn`, `safe_boundary` (default), and `immediate` (only when safe).
 *    Never replays completed side-effecting tool operations upon resume.
 * 3. Independent Streams: Parent and child streams checkpoint and resume their own histories
 *    and mailboxes independently without merging transcripts.
 * 4. Parent Suspension Barrier: A parent pipeline remains in `waiting_for_children` until all
 *    descendant streams reach a safe boundary and emit `DEFER_ACK`.
 * 5. Durable & Idempotent: Control messages, checkpoints, and rolling roadmaps are persisted
 *    to `agent_memory` in `dbPool`, surviving restarts and deduplicating repeated requests.
 */
export class HierarchicalDeferCoordinator {
	private sequenceCounters = new Map<string, number>()
	private barrierLocks = new Map<string, Promise<void>>()

	private async withBarrierLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.barrierLocks.get(key) ?? Promise.resolve()
		let release!: () => void
		const current = new Promise<void>((resolve) => {
			release = resolve
		})
		this.barrierLocks.set(
			key,
			previous.then(() => current),
		)
		await previous
		try {
			return await fn()
		} finally {
			if (this.barrierLocks.get(key) === current) {
				this.barrierLocks.delete(key)
			}
			release()
		}
	}

	private nextSequenceNumber(streamId: string, provided?: number): number {
		const current = this.sequenceCounters.get(streamId) ?? 0
		if (provided !== undefined && provided > current) {
			this.sequenceCounters.set(streamId, provided)
			return provided
		}
		const next = current + 1
		this.sequenceCounters.set(streamId, next)
		return next
	}

	private async storeStreamRecord(streamId: string, key: string, value: unknown): Promise<void> {
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

	private async recallStreamRecord<T>(streamId: string, key: string): Promise<T | null> {
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

	private static readonly MAX_CONTROL_INBOX_MESSAGES = 200

	private async appendControlMessage(streamId: string, message: SwarmControlMessage): Promise<void> {
		const inboxKey = "defer_control_inbox"
		const existing = (await this.recallStreamRecord<SwarmControlMessage[]>(streamId, inboxKey)) ?? []
		const deduplicated = existing.filter((m) => m.messageId !== message.messageId)
		deduplicated.push(message)
		const bounded =
			deduplicated.length > HierarchicalDeferCoordinator.MAX_CONTROL_INBOX_MESSAGES
				? deduplicated.slice(-HierarchicalDeferCoordinator.MAX_CONTROL_INBOX_MESSAGES)
				: deduplicated
		await this.storeStreamRecord(streamId, inboxKey, bounded)
	}

	public async getControlInbox(streamId: string): Promise<SwarmControlMessage[]> {
		return (await this.recallStreamRecord<SwarmControlMessage[]>(streamId, "defer_control_inbox")) ?? []
	}

	public async getAgentDeferStatus(streamId: string): Promise<DeferredAgentStatus> {
		const persisted = await this.recallStreamRecord<DeferredAgentStatus>(streamId, "defer_agent_status")
		if (persisted) {
			return persisted
		}
		const stream = await dbPool.selectOne("agent_streams", { column: "id", value: streamId })
		return {
			streamId,
			parentStreamId: stream?.parentId ?? null,
			state: "running",
			sequenceNumber: this.sequenceCounters.get(streamId) ?? 0,
			pendingChildAckIds: [],
			acknowledgedChildIds: [],
			acceptingNewWork: true,
			updatedAt: Date.now(),
		}
	}

	public async getCheckpoint(streamId: string, checkpointId?: string): Promise<AgentDeferCheckpoint | null> {
		if (checkpointId) {
			const specific = await this.recallStreamRecord<AgentDeferCheckpoint>(streamId, `defer_checkpoint:${checkpointId}`)
			if (specific) return specific
		}
		return this.recallStreamRecord<AgentDeferCheckpoint>(streamId, "defer_latest_checkpoint")
	}

	private async collectHeldReservations(streamId: string): Promise<string[]> {
		const items = await dbPool.selectWhere("agent_memory", { column: "streamId", value: streamId })
		return items
			.filter((item: { key: string }) => item.key.startsWith("file_res:"))
			.map((item: { key: string }) => item.key.replace(/^file_res:/, ""))
	}

	/**
	 * Register an in-flight tool or operation on a stream so boundary checks know whether
	 * the agent can yield immediately or must wait for a safe boundary.
	 */
	public async registerInFlightOperation(
		streamId: string,
		operation: InFlightOperationDescriptor,
	): Promise<DeferredAgentStatus> {
		const status = await this.getAgentDeferStatus(streamId)
		const updated: DeferredAgentStatus = {
			...status,
			inFlightOperation: operation,
			updatedAt: Date.now(),
		}
		await this.storeStreamRecord(streamId, "defer_agent_status", updated)
		return updated
	}

	/**
	 * Defer a single agent stream at a well-defined execution boundary (`before_turn`, `safe_boundary`, `immediate`).
	 * Idempotent: if the agent is already deferred for the same or newer sequence/pipeline, returns the existing status.
	 */
	public async deferAgent(
		streamId: string,
		options?: DeferAgentOptions,
	): Promise<{
		deferred: boolean
		status: DeferredAgentStatus
		checkpoint?: AgentDeferCheckpoint
		ackMessage?: SwarmControlMessage
		reason?: string
	}> {
		const effectiveState = resolveEffectiveAgentSwarmState({
			streamId,
			manualInvocation: options?.forceEnable,
		})
		if (!effectiveState.hierarchicalDeferEnabled && !options?.forceEnable) {
			const currentStatus = await this.getAgentDeferStatus(streamId)
			return {
				deferred: false,
				status: currentStatus,
				reason: "Hierarchical defer auxiliary feature is disabled.",
			}
		}

		const stream = await dbPool.selectOne("agent_streams", { column: "id", value: streamId })
		if (!stream) {
			throw new Error(`Stream ${streamId} not found`)
		}

		const existingStatus = await this.getAgentDeferStatus(streamId)
		const boundary = options?.boundary ?? effectiveState.defaultDeferBoundary
		const pipelineId = options?.pipelineId ?? existingStatus.pipelineId ?? `pipeline-${streamId.slice(0, 8)}`
		const reason = options?.reason ?? "Cooperative agent defer requested"

		// Idempotency guard: if already deferred under this pipeline or higher sequence number, return existing checkpoint
		if (
			existingStatus.state === "deferred" &&
			existingStatus.checkpointId &&
			(options?.sequenceNumber === undefined || options.sequenceNumber <= existingStatus.sequenceNumber)
		) {
			const existingCheckpoint = await this.getCheckpoint(streamId, existingStatus.checkpointId)
			const existingInbox = await this.getControlInbox(streamId)
			const lastAck = [...existingInbox].reverse().find((m) => m.type === "DEFER_ACK")
			return {
				deferred: true,
				status: existingStatus,
				checkpoint: existingCheckpoint ?? undefined,
				ackMessage: lastAck,
			}
		}

		const seq = this.nextSequenceNumber(streamId, options?.sequenceNumber)
		const requestMsg: SwarmControlMessage = {
			messageId: uuidv4(),
			pipelineId,
			sequenceNumber: seq,
			type: "DEFER_REQUEST",
			senderId: stream.parentId ?? "coordinator",
			recipientId: streamId,
			boundary,
			reason,
			timestamp: Date.now(),
		}
		await this.appendControlMessage(streamId, requestMsg)

		const inFlight = options?.inFlightOperation ?? existingStatus.inFlightOperation

		// Check if an in-flight operation blocks immediate yielding at this boundary
		if (inFlight && inFlight.status === "running") {
			const canInterruptNow = boundary === "immediate" && inFlight.canSafeInterruptImmediately && inFlight.isIdempotent

			if (!canInterruptNow) {
				// Must wait for current atomic operation or turn to finish before yielding
				const suspendingStatus: DeferredAgentStatus = {
					streamId,
					parentStreamId: stream.parentId ?? null,
					state: "suspending",
					boundary,
					pipelineId,
					sequenceNumber: seq,
					inFlightOperation: inFlight,
					pendingChildAckIds: existingStatus.pendingChildAckIds,
					acknowledgedChildIds: existingStatus.acknowledgedChildIds,
					acceptingNewWork: false,
					updatedAt: Date.now(),
				}
				await this.storeStreamRecord(streamId, "defer_agent_status", suspendingStatus)
				return {
					deferred: false,
					status: suspendingStatus,
					reason: `Waiting for in-flight operation '${inFlight.toolName}' (${inFlight.operationId}) to reach ${boundary} boundary.`,
				}
			}
		}

		return this.finalizeAgentDeferAtBoundary(streamId, {
			parentStreamId: stream.parentId ?? null,
			pipelineId,
			sequenceNumber: seq,
			boundary,
			reason,
			turnIndex: options?.turnIndex ?? 0,
			pendingToolQueue: options?.pendingToolQueue ?? [],
			completedToolReceipts: options?.completedToolReceipts ?? [],
			continuationMetadata: options?.continuationMetadata ?? {},
			inFlightOperation: inFlight,
			rollingRoadmap: options?.rollingRoadmap,
		})
	}

	/**
	 * Completes an in-flight operation on a `suspending` stream and immediately transitions
	 * it to `deferred` at the safe boundary, recording the completed operation receipt so it
	 * will never be replayed on resume. Also notifies any waiting parent pipeline barrier.
	 */
	public async completeInFlightAndYield(
		streamId: string,
		completedReceipt: {
			operationId: string
			toolName: string
			resultSummary: string
		},
		continuationMetadata?: Record<string, unknown>,
	): Promise<{
		deferred: boolean
		status: DeferredAgentStatus
		checkpoint: AgentDeferCheckpoint
		ackMessage: SwarmControlMessage
		parentPipelineStatus?: DeferredPipelineStatus
	}> {
		const status = await this.getAgentDeferStatus(streamId)
		const existingCheckpoint = status.checkpointId ? await this.getCheckpoint(streamId, status.checkpointId) : null
		const priorReceipts = existingCheckpoint?.completedToolReceipts ?? []
		const mergedReceipts = [...priorReceipts.filter((r) => r.operationId !== completedReceipt.operationId), completedReceipt]

		const finalized = await this.finalizeAgentDeferAtBoundary(streamId, {
			parentStreamId: status.parentStreamId,
			pipelineId: status.pipelineId ?? `pipeline-${streamId.slice(0, 8)}`,
			sequenceNumber: status.sequenceNumber || this.nextSequenceNumber(streamId),
			boundary: status.boundary ?? "safe_boundary",
			reason: "Reached safe boundary after completing in-flight operation",
			turnIndex: existingCheckpoint?.turnIndex ?? 0,
			pendingToolQueue: existingCheckpoint?.pendingToolQueue ?? [],
			completedToolReceipts: mergedReceipts,
			continuationMetadata: {
				...(existingCheckpoint?.continuationMetadata ?? {}),
				...(continuationMetadata ?? {}),
			},
			inFlightOperation: status.inFlightOperation
				? {
						...status.inFlightOperation,
						status: "completed",
						resultSummary: completedReceipt.resultSummary,
					}
				: undefined,
		})

		let parentPipelineStatus: DeferredPipelineStatus | undefined
		if (status.parentStreamId && status.pipelineId) {
			parentPipelineStatus = (await this.reconcilePipelineBarrier(status.parentStreamId, status.pipelineId)) ?? undefined
		}

		return {
			...finalized,
			parentPipelineStatus,
		}
	}

	private async finalizeAgentDeferAtBoundary(
		streamId: string,
		params: {
			parentStreamId: string | null
			pipelineId: string
			sequenceNumber: number
			boundary: DeferExecutionBoundary
			reason: string
			turnIndex: number
			pendingToolQueue: string[]
			completedToolReceipts: Array<{
				operationId: string
				toolName: string
				resultSummary: string
			}>
			continuationMetadata: Record<string, unknown>
			inFlightOperation?: InFlightOperationDescriptor
			rollingRoadmap?: Partial<RollingRoadmapSnapshot>
		},
	): Promise<{
		deferred: true
		status: DeferredAgentStatus
		checkpoint: AgentDeferCheckpoint
		ackMessage: SwarmControlMessage
	}> {
		const heldReservations = await this.collectHeldReservations(streamId)
		const checkpointId = `chk-${streamId.slice(0, 8)}-${params.sequenceNumber}-${Date.now()}`
		const yieldPoint: AgentDeferCheckpoint["yieldPoint"] =
			params.boundary === "before_turn"
				? "before_turn"
				: params.boundary === "immediate"
					? "immediate_safe_point"
					: "after_tool_round"

		// Pause running/pending tasks on this stream as "deferred" (stored in task metadata & memory)
		// without marking them failed or completed!
		const tasks = await dbPool.selectWhere("agent_tasks", { column: "streamId", value: streamId })
		const activeTaskIds: string[] = []
		for (const task of tasks) {
			if (task.status === "running" || task.status === "pending") {
				activeTaskIds.push(task.id)
				let parsedMeta: Record<string, unknown> = {}
				if (task.metadata) {
					try {
						parsedMeta = typeof task.metadata === "string" ? JSON.parse(task.metadata) : task.metadata
					} catch {
						parsedMeta = {}
					}
				}
				const deferredMeta = {
					...parsedMeta,
					deferred_state: "deferred",
					deferred_checkpoint_id: checkpointId,
					deferred_at: Date.now(),
					prior_task_status: task.status,
				}
				await dbPool.push({
					type: "update",
					table: "agent_tasks",
					values: {
						metadata: JSON.stringify(deferredMeta),
					},
					where: { column: "id", value: task.id },
					layer: "infrastructure",
				})
				// Freeze heartbeat lease so stalled-task detector knows this task is intentionally deferred
				await this.storeStreamRecord(streamId, `task_deferred_lease:${task.id}`, {
					taskId: task.id,
					checkpointId,
					deferredAt: Date.now(),
					priorStatus: task.status,
				})
			}
		}

		const roadmapSnapshot: RollingRoadmapSnapshot | undefined = params.rollingRoadmap
			? {
					objective: params.rollingRoadmap.objective ?? "Suspended pipeline objective",
					activeChildAssignments: params.rollingRoadmap.activeChildAssignments ?? [],
					completedWork: params.rollingRoadmap.completedWork ?? [],
					outstandingWork: params.rollingRoadmap.outstandingWork ?? [],
					dependenciesAndBlockers: params.rollingRoadmap.dependenciesAndBlockers ?? [],
					decisionsMade: params.rollingRoadmap.decisionsMade ?? [],
					nextActions: params.rollingRoadmap.nextActions ?? [],
					synchronizationStatus: params.rollingRoadmap.synchronizationStatus ?? "barrier_satisfied",
					updatedAt: Date.now(),
				}
			: undefined

		const checkpoint: AgentDeferCheckpoint = {
			checkpointId,
			streamId,
			parentStreamId: params.parentStreamId,
			pipelineId: params.pipelineId,
			sequenceNumber: params.sequenceNumber,
			boundary: params.boundary,
			yieldPoint,
			turnIndex: params.turnIndex,
			pendingToolQueue: [...params.pendingToolQueue],
			completedToolReceipts: [...params.completedToolReceipts],
			continuationMetadata: {
				...params.continuationMetadata,
				deferredTaskIds: activeTaskIds,
			},
			heldReservations,
			heldMutexLocks: [],
			rollingRoadmap: roadmapSnapshot,
			reason: params.reason,
			createdAt: Date.now(),
		}

		await this.storeStreamRecord(streamId, `defer_checkpoint:${checkpointId}`, checkpoint)
		await this.storeStreamRecord(streamId, "defer_latest_checkpoint", checkpoint)
		if (roadmapSnapshot) {
			await this.storeStreamRecord(streamId, "rolling_roadmap_snapshot", roadmapSnapshot)
		}

		const ackMessage: SwarmControlMessage = {
			messageId: uuidv4(),
			pipelineId: params.pipelineId,
			sequenceNumber: params.sequenceNumber,
			type: "DEFER_ACK",
			senderId: streamId,
			recipientId: params.parentStreamId ?? "coordinator",
			boundary: params.boundary,
			reason: params.reason,
			checkpointId,
			timestamp: Date.now(),
			acknowledgedAt: Date.now(),
		}
		await this.appendControlMessage(streamId, ackMessage)
		if (params.parentStreamId) {
			await this.appendControlMessage(params.parentStreamId, ackMessage)
		}

		const existingStatus = await this.getAgentDeferStatus(streamId)
		const deferredStatus: DeferredAgentStatus = {
			streamId,
			parentStreamId: params.parentStreamId,
			state: "deferred",
			boundary: params.boundary,
			pipelineId: params.pipelineId,
			sequenceNumber: params.sequenceNumber,
			checkpointId,
			inFlightOperation: params.inFlightOperation ? { ...params.inFlightOperation, status: "completed" } : undefined,
			pendingChildAckIds: [],
			acknowledgedChildIds: existingStatus.acknowledgedChildIds,
			acceptingNewWork: false,
			updatedAt: Date.now(),
		}
		await this.storeStreamRecord(streamId, "defer_agent_status", deferredStatus)

		Logger.info(
			`[HierarchicalDefer] Stream ${streamId.slice(0, 8)} deferred at ${params.boundary} (checkpoint=${checkpointId})`,
		)

		return {
			deferred: true,
			status: deferredStatus,
			checkpoint,
			ackMessage,
		}
	}

	/**
	 * Recursively collects all descendant streams in topological order (root first, leaves last).
	 */
	private async collectHierarchyStreams(rootStreamId: string): Promise<
		Array<{
			id: string
			parentId: string | null
			focus: string
			status: "active" | "completed" | "failed"
		}>
	> {
		const root = await dbPool.selectOne("agent_streams", { column: "id", value: rootStreamId })
		if (!root) {
			throw new Error(`Root stream ${rootStreamId} not found`)
		}
		const allStreams = await dbPool.selectAllFrom("agent_streams")
		const result: Array<{
			id: string
			parentId: string | null
			focus: string
			status: "active" | "completed" | "failed"
		}> = []
		const queue = [root]
		const visited = new Set<string>()

		while (queue.length > 0) {
			const current = queue.shift()
			if (!current || visited.has(current.id)) continue
			visited.add(current.id)
			result.push(current)
			const children = allStreams.filter((s: { parentId: string | null }) => s.parentId === current.id)
			queue.push(...children)
		}
		return result
	}

	/**
	 * Hierarchically defers a parent stream and all of its active child/descendant streams.
	 * Enforces the Parent Suspension Barrier:
	 * 1. Parent immediately stops accepting new delegations (`acceptingNewWork = false`).
	 * 2. Propagates `DEFER_REQUEST` down to all active descendants.
	 * 3. Leaves/children defer at their safe execution boundaries.
	 * 4. If any child has an in-flight non-interruptible operation, the parent transitions to
	 *    `waiting_for_children` and the pipeline remains in `waiting_for_children` until that child yields.
	 * 5. Once all descendants emit `DEFER_ACK`, the parent checkpoints its Rolling Roadmap and transitions
	 *    the pipeline to `suspended`.
	 */
	public async deferPipeline(rootStreamId: string, options?: DeferPipelineOptions): Promise<DeferredPipelineStatus> {
		const effectiveState = resolveEffectiveAgentSwarmState({
			streamId: rootStreamId,
			manualInvocation: options?.forceEnable,
		})
		const boundary = options?.boundary ?? effectiveState.defaultDeferBoundary
		const reason = options?.reason ?? "Hierarchical pipeline defer requested"

		if (!effectiveState.hierarchicalDeferEnabled && !options?.forceEnable) {
			return {
				pipelineId: `disabled-${rootStreamId.slice(0, 8)}`,
				rootStreamId,
				phase: "active",
				boundary,
				reason: "Hierarchical defer auxiliary feature is disabled.",
				agentStatuses: {},
				pendingChildStreamIds: [],
				suspendedStreamIds: [],
				controlMessages: [],
				initiatedAt: Date.now(),
			}
		}

		// Check if already suspended for idempotency
		const existingPipeline = await this.recallStreamRecord<DeferredPipelineStatus>(rootStreamId, "deferred_pipeline_status")
		if (existingPipeline && existingPipeline.phase === "suspended") {
			return existingPipeline
		}

		const pipelineId = existingPipeline?.pipelineId ?? `pipeline-${rootStreamId.slice(0, 8)}-${Date.now()}`
		const hierarchy = await this.collectHierarchyStreams(rootStreamId)
		const activeDescendants = hierarchy.slice(1).filter((s) => s.status === "active")

		// Step 1: Put root into `suspending` / `waiting_for_children` and stop accepting new work
		const rootSeq = this.nextSequenceNumber(rootStreamId)
		const rootInitialStatus: DeferredAgentStatus = {
			streamId: rootStreamId,
			parentStreamId: hierarchy[0]?.parentId ?? null,
			state: activeDescendants.length > 0 ? "waiting_for_children" : "suspending",
			boundary,
			pipelineId,
			sequenceNumber: rootSeq,
			pendingChildAckIds: activeDescendants.map((c) => c.id),
			acknowledgedChildIds: [],
			acceptingNewWork: false,
			updatedAt: Date.now(),
		}
		await this.storeStreamRecord(rootStreamId, "defer_agent_status", rootInitialStatus)

		const agentStatuses: Record<string, DeferredAgentStatus> = {
			[rootStreamId]: rootInitialStatus,
		}
		const pendingChildStreamIds: string[] = []
		const suspendedStreamIds: string[] = []

		// Step 2: Defer descendants bottom-up (leaves first) so each parent in a multi-level tree waits for its children
		const descendantsBottomUp = [...activeDescendants].reverse()
		for (const child of descendantsBottomUp) {
			const childRuntime = options?.agentRuntimeStates?.[child.id]
			const childChildren = activeDescendants.filter((s) => s.parentId === child.id)
			const childHasPendingGrandchildren = childChildren.some((gc) => pendingChildStreamIds.includes(gc.id))

			if (childHasPendingGrandchildren) {
				const waitingChildStatus: DeferredAgentStatus = {
					streamId: child.id,
					parentStreamId: child.parentId,
					state: "waiting_for_children",
					boundary,
					pipelineId,
					sequenceNumber: this.nextSequenceNumber(child.id),
					pendingChildAckIds: childChildren.filter((gc) => pendingChildStreamIds.includes(gc.id)).map((gc) => gc.id),
					acknowledgedChildIds: childChildren.filter((gc) => suspendedStreamIds.includes(gc.id)).map((gc) => gc.id),
					acceptingNewWork: false,
					updatedAt: Date.now(),
				}
				await this.storeStreamRecord(child.id, "defer_agent_status", waitingChildStatus)
				agentStatuses[child.id] = waitingChildStatus
				pendingChildStreamIds.push(child.id)
				continue
			}

			const deferResult = await this.deferAgent(child.id, {
				boundary,
				reason: `Cascaded from parent pipeline ${pipelineId}: ${reason}`,
				pipelineId,
				turnIndex: childRuntime?.turnIndex,
				pendingToolQueue: childRuntime?.pendingToolQueue,
				completedToolReceipts: childRuntime?.completedToolReceipts,
				continuationMetadata: childRuntime?.continuationMetadata,
				inFlightOperation: childRuntime?.inFlightOperation,
				forceEnable: true,
			})

			agentStatuses[child.id] = deferResult.status
			if (deferResult.deferred) {
				suspendedStreamIds.push(child.id)
			} else {
				pendingChildStreamIds.push(child.id)
			}
		}

		// Step 3: Evaluate Parent Suspension Barrier
		return this.evaluateAndPersistPipelineState(rootStreamId, {
			pipelineId,
			boundary,
			reason,
			hierarchy,
			agentStatuses,
			pendingChildStreamIds,
			suspendedStreamIds,
			rollingRoadmapInput: options?.rollingRoadmap,
			rootRuntimeState: options?.agentRuntimeStates?.[rootStreamId],
			initiatedAt: existingPipeline?.initiatedAt ?? Date.now(),
		})
	}

	public async reconcileAfterStreamFailure(streamId: string): Promise<DeferredPipelineStatus | null> {
		const status = await this.getAgentDeferStatus(streamId)
		if (!status.parentStreamId || !status.pipelineId) {
			return null
		}
		return this.reconcilePipelineBarrier(status.parentStreamId, status.pipelineId)
	}

	private async reconcilePipelineBarrier(parentStreamId: string, pipelineId: string): Promise<DeferredPipelineStatus | null> {
		return this.withBarrierLock(pipelineId, async () => {
			// Walk up the stream ancestor chain to find the root stream that owns `deferred_pipeline_status` for this pipelineId
			let rootId = parentStreamId
			let currentId: string | null = parentStreamId
			const visited = new Set<string>()
			while (currentId && !visited.has(currentId)) {
				visited.add(currentId)
				const candidatePipeline = await this.recallStreamRecord<DeferredPipelineStatus>(
					currentId,
					"deferred_pipeline_status",
				)
				if (candidatePipeline?.pipelineId === pipelineId) {
					rootId = currentId
				}
				const stream: { parentId: string | null } | null = await dbPool.selectOne("agent_streams", {
					column: "id",
					value: currentId,
				})
				currentId = stream?.parentId ?? null
			}

			const pipeline = await this.recallStreamRecord<DeferredPipelineStatus>(rootId, "deferred_pipeline_status")
			if (!pipeline || pipeline.pipelineId !== pipelineId) return null

			// Only a pipeline that is still *draining* has a barrier to reconcile. After resume (`resumed`/`resuming`)
			// or once it is already `suspended`, a late child completion/failure must not re-suspend the parent or
			// flip `acceptingNewWork` back to false.
			if (pipeline.phase !== "waiting_for_children" && pipeline.phase !== "suspending") return null

			const hierarchy = await this.collectHierarchyStreams(rootId)
			const activeDescendants = hierarchy.slice(1).filter((s) => s.status === "active")
			const agentStatuses: Record<string, DeferredAgentStatus> = {}
			const pendingChildStreamIds: string[] = []
			const suspendedStreamIds: string[] = []

			// Re-evaluate bottom-up so intermediate nodes waiting for grandchildren can now defer
			for (const child of [...activeDescendants].reverse()) {
				let status = await this.getAgentDeferStatus(child.id)
				if (status.state === "waiting_for_children") {
					const childChildren = activeDescendants.filter((s) => s.parentId === child.id)
					const stillPending = childChildren.filter((gc) => pendingChildStreamIds.includes(gc.id))
					if (stillPending.length === 0) {
						const finalized = await this.deferAgent(child.id, {
							boundary: pipeline.boundary,
							reason: `Barrier satisfied for intermediate stream ${child.id.slice(0, 8)}`,
							pipelineId: pipeline.pipelineId,
							forceEnable: true,
						})
						status = finalized.status
					}
				}
				agentStatuses[child.id] = status
				if (status.state === "deferred") {
					suspendedStreamIds.push(child.id)
				} else {
					pendingChildStreamIds.push(child.id)
				}
			}

			return this.evaluateAndPersistPipelineState(rootId, {
				pipelineId: pipeline.pipelineId,
				boundary: pipeline.boundary,
				reason: pipeline.reason,
				hierarchy,
				agentStatuses,
				pendingChildStreamIds,
				suspendedStreamIds,
				rollingRoadmapInput: pipeline.rollingRoadmap,
				initiatedAt: pipeline.initiatedAt,
			})
		})
	}

	private async evaluateAndPersistPipelineState(
		rootStreamId: string,
		params: {
			pipelineId: string
			boundary: DeferExecutionBoundary
			reason: string
			hierarchy: Array<{
				id: string
				parentId: string | null
				focus: string
				status: "active" | "completed" | "failed"
			}>
			agentStatuses: Record<string, DeferredAgentStatus>
			pendingChildStreamIds: string[]
			suspendedStreamIds: string[]
			rollingRoadmapInput?: Partial<RollingRoadmapSnapshot>
			rootRuntimeState?: {
				turnIndex?: number
				pendingToolQueue?: string[]
				completedToolReceipts?: Array<{
					operationId: string
					toolName: string
					resultSummary: string
				}>
				continuationMetadata?: Record<string, unknown>
				inFlightOperation?: InFlightOperationDescriptor
			}
			initiatedAt: number
		},
	): Promise<DeferredPipelineStatus> {
		const activeDescendants = params.hierarchy.slice(1).filter((s) => s.status === "active")
		const childAssignments: RollingRoadmapSnapshot["activeChildAssignments"] = activeDescendants.map((child) => {
			const st = params.agentStatuses[child.id]
			return {
				childStreamId: child.id,
				description: child.focus,
				status: st?.state === "deferred" ? "deferred" : "running",
				checkpointId: st?.checkpointId,
			}
		})

		const allChildrenDeferred = params.pendingChildStreamIds.length === 0
		const roadmap: RollingRoadmapSnapshot = {
			objective: params.rollingRoadmapInput?.objective ?? params.hierarchy[0]?.focus ?? "Root pipeline objective",
			activeChildAssignments: params.rollingRoadmapInput?.activeChildAssignments ?? childAssignments,
			completedWork: params.rollingRoadmapInput?.completedWork ?? [],
			outstandingWork:
				params.rollingRoadmapInput?.outstandingWork ??
				activeDescendants.map((c) => `Resume child stream ${c.id.slice(0, 8)} (${c.focus})`),
			dependenciesAndBlockers:
				params.rollingRoadmapInput?.dependenciesAndBlockers ??
				(allChildrenDeferred
					? []
					: params.pendingChildStreamIds.map(
							(id) => `Waiting for child stream ${id.slice(0, 8)} to reach safe boundary`,
						)),
			decisionsMade: params.rollingRoadmapInput?.decisionsMade ?? [
				`Initiated cooperative pipeline defer (${params.boundary}): ${params.reason}`,
			],
			nextActions: params.rollingRoadmapInput?.nextActions ?? [
				allChildrenDeferred
					? "Resume pipeline from coordinated parent/child checkpoints"
					: "Wait for remaining in-flight child operations to reach safe boundary",
			],
			synchronizationStatus: allChildrenDeferred ? "barrier_satisfied" : "suspending_children",
			updatedAt: Date.now(),
		}

		let rootStatus: DeferredAgentStatus
		let rootCheckpointId: string | undefined

		if (allChildrenDeferred) {
			const rootDefer = await this.deferAgent(rootStreamId, {
				boundary: params.boundary,
				reason: params.reason,
				pipelineId: params.pipelineId,
				turnIndex: params.rootRuntimeState?.turnIndex,
				pendingToolQueue: params.rootRuntimeState?.pendingToolQueue,
				completedToolReceipts: params.rootRuntimeState?.completedToolReceipts,
				continuationMetadata: params.rootRuntimeState?.continuationMetadata,
				inFlightOperation: params.rootRuntimeState?.inFlightOperation,
				rollingRoadmap: roadmap,
				forceEnable: true,
			})
			rootStatus = {
				...rootDefer.status,
				pendingChildAckIds: [],
				acknowledgedChildIds: [...params.suspendedStreamIds],
			}
			await this.storeStreamRecord(rootStreamId, "defer_agent_status", rootStatus)
			rootCheckpointId = rootDefer.checkpoint?.checkpointId
			if (rootDefer.deferred && !params.suspendedStreamIds.includes(rootStreamId)) {
				params.suspendedStreamIds.push(rootStreamId)
			}
		} else {
			const currentRootStatus = await this.getAgentDeferStatus(rootStreamId)
			rootStatus = {
				...currentRootStatus,
				state: "waiting_for_children",
				boundary: params.boundary,
				pipelineId: params.pipelineId,
				pendingChildAckIds: [...params.pendingChildStreamIds],
				acknowledgedChildIds: [...params.suspendedStreamIds],
				acceptingNewWork: false,
				updatedAt: Date.now(),
			}
			await this.storeStreamRecord(rootStreamId, "defer_agent_status", rootStatus)
			await this.storeStreamRecord(rootStreamId, "rolling_roadmap_snapshot", roadmap)
		}

		params.agentStatuses[rootStreamId] = rootStatus

		const allControlMessages: SwarmControlMessage[] = []
		for (const stream of params.hierarchy) {
			const inbox = await this.getControlInbox(stream.id)
			for (const msg of inbox) {
				if (msg.pipelineId === params.pipelineId && !allControlMessages.some((m) => m.messageId === msg.messageId)) {
					allControlMessages.push(msg)
				}
			}
		}

		const phase: PipelineSuspensionPhase =
			allChildrenDeferred && rootStatus.state === "deferred" ? "suspended" : "waiting_for_children"

		const pipelineStatus: DeferredPipelineStatus = {
			pipelineId: params.pipelineId,
			rootStreamId,
			phase,
			boundary: params.boundary,
			reason: params.reason,
			rootCheckpointId,
			rollingRoadmap: roadmap,
			agentStatuses: params.agentStatuses,
			pendingChildStreamIds: params.pendingChildStreamIds,
			suspendedStreamIds: params.suspendedStreamIds,
			controlMessages: allControlMessages.sort((a, b) => a.timestamp - b.timestamp),
			initiatedAt: params.initiatedAt,
			suspendedAt: phase === "suspended" ? Date.now() : undefined,
		}

		await this.storeStreamRecord(rootStreamId, "deferred_pipeline_status", pipelineStatus)
		return pipelineStatus
	}

	/**
	 * Inspects the durable status of a deferred or suspending pipeline.
	 */
	public async getDeferredPipelineStatus(rootStreamId: string): Promise<DeferredPipelineStatus | null> {
		return this.recallStreamRecord<DeferredPipelineStatus>(rootStreamId, "deferred_pipeline_status")
	}

	/**
	 * Resumes a single deferred agent stream from its durable checkpoint without replaying
	 * already-completed tool calls or merging parent/child histories.
	 * Idempotent: if the stream is already running, returns the current running state safely.
	 */
	public async resumeAgent(
		streamId: string,
		options?: {
			pipelineId?: string
			reason?: string
			checkpointId?: string
			forceEnable?: boolean
		},
	): Promise<ResumeAgentResult> {
		const status = await this.getAgentDeferStatus(streamId)
		const checkpoint = await this.getCheckpoint(streamId, options?.checkpointId ?? status.checkpointId)
		const pipelineId =
			options?.pipelineId ?? status.pipelineId ?? checkpoint?.pipelineId ?? `pipeline-${streamId.slice(0, 8)}`
		const reason = options?.reason ?? "Cooperative agent resume requested"

		// Idempotency guard: if already running, emit RESUME_ACK and return without duplicating work
		if (status.state === "running") {
			const ack: SwarmControlMessage = {
				messageId: uuidv4(),
				pipelineId,
				sequenceNumber: status.sequenceNumber,
				type: "RESUME_ACK",
				senderId: streamId,
				recipientId: status.parentStreamId ?? "coordinator",
				boundary: status.boundary ?? "safe_boundary",
				reason: "Already running (idempotent resume)",
				checkpointId: checkpoint?.checkpointId,
				timestamp: Date.now(),
				acknowledgedAt: Date.now(),
			}
			return {
				streamId,
				resumed: true,
				state: "running",
				restoredCheckpoint: checkpoint ?? undefined,
				skippedCompletedOperationIds: checkpoint?.completedToolReceipts.map((r) => r.operationId) ?? [],
				controlAck: ack,
			}
		}

		const seq = this.nextSequenceNumber(streamId)
		const reqMsg: SwarmControlMessage = {
			messageId: uuidv4(),
			pipelineId,
			sequenceNumber: seq,
			type: "RESUME_REQUEST",
			senderId: status.parentStreamId ?? "coordinator",
			recipientId: streamId,
			boundary: status.boundary ?? "safe_boundary",
			reason,
			checkpointId: checkpoint?.checkpointId,
			timestamp: Date.now(),
		}
		await this.appendControlMessage(streamId, reqMsg)

		// Restore deferred tasks on this stream to their prior active status and refresh heartbeats
		const tasks = await dbPool.selectWhere("agent_tasks", { column: "streamId", value: streamId })
		for (const task of tasks) {
			const lease = await this.recallStreamRecord<{
				taskId: string
				checkpointId: string
				deferredAt: number
				priorStatus: "pending" | "running"
			}>(streamId, `task_deferred_lease:${task.id}`)
			if (lease) {
				let parsedMeta: Record<string, unknown> = {}
				if (task.metadata) {
					try {
						parsedMeta = typeof task.metadata === "string" ? JSON.parse(task.metadata) : task.metadata
					} catch {
						parsedMeta = {}
					}
				}
				const resumedMeta = {
					...parsedMeta,
					deferred_state: "resumed",
					resumed_at: Date.now(),
				}
				await dbPool.push({
					type: "update",
					table: "agent_tasks",
					values: {
						status: lease.priorStatus,
						metadata: JSON.stringify(resumedMeta),
					},
					where: { column: "id", value: task.id },
					layer: "infrastructure",
				})
				// Refresh task heartbeat so stalled task detection does not penalize time spent deferred
				await dbPool.push({
					type: "upsert",
					table: "agent_memory",
					conflictTarget: ["streamId", "key"],
					where: [
						{ column: "streamId", value: streamId },
						{ column: "key", value: `task_heartbeat:${task.id}` },
					],
					values: {
						streamId,
						key: `task_heartbeat:${task.id}`,
						value: String(Date.now()),
						updatedAt: Date.now(),
					},
					layer: "infrastructure",
				})
			}
		}

		const ackMsg: SwarmControlMessage = {
			messageId: uuidv4(),
			pipelineId,
			sequenceNumber: seq,
			type: "RESUME_ACK",
			senderId: streamId,
			recipientId: status.parentStreamId ?? "coordinator",
			boundary: status.boundary ?? "safe_boundary",
			reason,
			checkpointId: checkpoint?.checkpointId,
			timestamp: Date.now(),
			acknowledgedAt: Date.now(),
		}
		await this.appendControlMessage(streamId, ackMsg)
		if (status.parentStreamId) {
			await this.appendControlMessage(status.parentStreamId, ackMsg)
		}

		const runningStatus: DeferredAgentStatus = {
			streamId,
			parentStreamId: status.parentStreamId,
			state: "running",
			boundary: status.boundary,
			pipelineId,
			sequenceNumber: seq,
			checkpointId: checkpoint?.checkpointId,
			inFlightOperation: undefined,
			pendingChildAckIds: [],
			acknowledgedChildIds: [],
			acceptingNewWork: true,
			updatedAt: Date.now(),
		}
		await this.storeStreamRecord(streamId, "defer_agent_status", runningStatus)

		Logger.info(
			`[HierarchicalDefer] Stream ${streamId.slice(0, 8)} resumed from checkpoint ${checkpoint?.checkpointId ?? "none"}`,
		)

		return {
			streamId,
			resumed: true,
			state: "running",
			restoredCheckpoint: checkpoint ?? undefined,
			skippedCompletedOperationIds: checkpoint?.completedToolReceipts.map((r) => r.operationId) ?? [],
			controlAck: ackMsg,
		}
	}

	/**
	 * Resumes a deferred parent-child pipeline hierarchy in coordinated order,
	 * restoring each stream's independent state and updating the parent's rolling roadmap.
	 */
	public async resumePipeline(
		rootStreamId: string,
		options?: {
			reason?: string
			forceEnable?: boolean
		},
	): Promise<ResumePipelineResult> {
		const pipeline = await this.getDeferredPipelineStatus(rootStreamId)
		const hierarchy = await this.collectHierarchyStreams(rootStreamId)
		const pipelineId = pipeline?.pipelineId ?? `pipeline-${rootStreamId.slice(0, 8)}`
		const reason = options?.reason ?? "Hierarchical pipeline resume requested"

		const resumedAgentResults: Record<string, ResumeAgentResult> = {}
		const agentStatuses: Record<string, DeferredAgentStatus> = {}

		// Resume root and all active descendants independently (preserving separate stream histories)
		for (const stream of hierarchy) {
			if (stream.status !== "active") continue
			const res = await this.resumeAgent(stream.id, {
				pipelineId,
				reason,
				forceEnable: options?.forceEnable ?? true,
			})
			resumedAgentResults[stream.id] = res
			agentStatuses[stream.id] = await this.getAgentDeferStatus(stream.id)
		}

		const restoredRoadmap: RollingRoadmapSnapshot | undefined = pipeline?.rollingRoadmap
			? {
					...pipeline.rollingRoadmap,
					activeChildAssignments: pipeline.rollingRoadmap.activeChildAssignments.map((a) => ({
						...a,
						status: resumedAgentResults[a.childStreamId]?.resumed ? "running" : a.status,
					})),
					dependenciesAndBlockers: [],
					decisionsMade: [...pipeline.rollingRoadmap.decisionsMade, `Resumed pipeline ${pipelineId}: ${reason}`],
					nextActions: ["Continue coordinated execution across resumed parent and child streams"],
					synchronizationStatus: "resumed",
					updatedAt: Date.now(),
				}
			: undefined

		if (restoredRoadmap) {
			await this.storeStreamRecord(rootStreamId, "rolling_roadmap_snapshot", restoredRoadmap)
		}

		if (pipeline) {
			const updatedPipeline: DeferredPipelineStatus = {
				...pipeline,
				phase: "resumed",
				rollingRoadmap: restoredRoadmap,
				agentStatuses,
				pendingChildStreamIds: [],
				suspendedStreamIds: [],
				resumedAt: Date.now(),
			}
			await this.storeStreamRecord(rootStreamId, "deferred_pipeline_status", updatedPipeline)
		}

		return {
			pipelineId,
			rootStreamId,
			resumed: true,
			phase: "resumed",
			resumedAgentResults,
			restoredRoadmap,
		}
	}
}

export const hierarchicalDeferCoordinator = new HierarchicalDeferCoordinator()
