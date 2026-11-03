import type { ApiHandler } from "@core/api"
import { expect } from "chai"
import { LegionAgentHost } from "@/core/task/legion/LegionAgentHost"
import { createLegionToolAdapter } from "@/core/task/legion/LegionToolAdapter"
import { TaskState } from "@/core/task/TaskState"
import { evaluateOptionalCriticalCompletionReview, runCompletionGateFlow } from "@/core/task/tools/completionGatePipeline"
import { ToolExecutorCoordinator } from "@/core/task/tools/ToolExecutorCoordinator"
import type { TaskConfig } from "@/core/task/tools/types/TaskConfig"
import { dbPool } from "../../db/BufferedDbPool"
import {
	getAgentSwarmConfig,
	resolveEffectiveAgentSwarmState,
	setAgentSwarmAgentOverride,
	setAgentSwarmConfigOverride,
	setAgentSwarmTaskOverride,
	toggleAgentSwarmFeature,
} from "../AgentSwarmConfig"
import { CriticalCompletionReviewService } from "../CriticalCompletionReview"
import { HierarchicalDeferCoordinator } from "../HierarchicalDeferCoordinator"
import { legionCoordinator } from "../LegionCoordinator"
import { runAutomaticLegion, runLegionPipeline } from "../LegionPipelineRunner"
import { AgentOrchestrator } from "../Orchestrator"

describe("Agent Swarm Auxiliary Feature Suite (Critical Completion Review & Hierarchical Defer)", () => {
	const orchestrator = new AgentOrchestrator()
	const reviewService = new CriticalCompletionReviewService()

	// In-memory mock DB backing `dbPool` for fast, deterministic, durable-table simulation
	let streamsTable: Map<string, any>
	let tasksTable: Map<string, any>
	let memoryTable: Map<string, any>

	const matchesWhere = (row: any, where: any): boolean => {
		if (!where) return true
		const conds = Array.isArray(where) ? where : [where]
		return conds.every((c) => row[c.column] === c.value)
	}

	const getTableMap = (table: string): Map<string, any> => {
		if (table === "agent_streams") return streamsTable
		if (table === "agent_tasks") return tasksTable
		if (table === "agent_memory") return memoryTable
		return new Map()
	}

	let originalDbMethods: Record<string, any> = {}
	let originalIsClaimDurable: typeof legionCoordinator.isClaimDurable
	let originalAcquireDispatchToken: typeof legionCoordinator.acquireDispatchToken
	let originalAcquireFormationDispatchToken: typeof legionCoordinator.acquireFormationDispatchToken
	let originalAcquireAutomaticFormationToken: typeof legionCoordinator.acquireAutomaticFormationToken

	beforeEach(() => {
		originalIsClaimDurable = legionCoordinator.isClaimDurable
		originalAcquireDispatchToken = legionCoordinator.acquireDispatchToken
		originalAcquireFormationDispatchToken = legionCoordinator.acquireFormationDispatchToken
		originalAcquireAutomaticFormationToken = legionCoordinator.acquireAutomaticFormationToken
		legionCoordinator.isClaimDurable = async () => true
		legionCoordinator.acquireDispatchToken = async () => true
		legionCoordinator.acquireFormationDispatchToken = async () => true
		legionCoordinator.acquireAutomaticFormationToken = async () => true
		streamsTable = new Map()
		tasksTable = new Map()
		memoryTable = new Map()
		setAgentSwarmConfigOverride(null)

		const target = dbPool as any
		originalDbMethods = {
			beginWork: target.beginWork,
			commitWork: target.commitWork,
			rollbackWork: target.rollbackWork,
			selectOne: target.selectOne,
			selectWhere: target.selectWhere,
			selectAllFrom: target.selectAllFrom,
			push: target.push,
			pushBatch: target.pushBatch,
			flush: target.flush,
		}

		target.beginWork = async () => {}
		target.flush = async () => {}
		target.commitWork = async () => {}
		target.rollbackWork = async () => {}

		target.selectOne = async (table: string, where: any) => {
			const map = getTableMap(table)
			for (const row of map.values()) {
				if (matchesWhere(row, where)) return { ...row }
			}
			return null
		}

		target.selectWhere = async (table: string, where: any) => {
			const map = getTableMap(table)
			const out: any[] = []
			for (const row of map.values()) {
				if (matchesWhere(row, where)) out.push({ ...row })
			}
			return out
		}

		target.selectAllFrom = async (table: string) => {
			const map = getTableMap(table)
			return Array.from(map.values()).map((r) => ({ ...r }))
		}

		const applyOp = (op: any) => {
			const map = getTableMap(op.table)
			if (op.type === "insert" || op.type === "upsert") {
				const key = op.table === "agent_memory" ? `${op.values.streamId}::${op.values.key}` : String(op.values.id)
				map.set(key, { ...(map.get(key) || {}), ...op.values })
			} else if (op.type === "update") {
				for (const [k, row] of map.entries()) {
					if (matchesWhere(row, op.where)) {
						map.set(k, { ...row, ...op.values })
					}
				}
			} else if (op.type === "delete") {
				for (const [k, row] of map.entries()) {
					if (matchesWhere(row, op.where)) {
						map.delete(k)
					}
				}
			}
		}

		target.push = async (op: any) => {
			applyOp(op)
		}
		target.pushBatch = async (ops: any[]) => {
			for (const op of ops) applyOp(op)
		}
	})

	afterEach(() => {
		legionCoordinator.isClaimDurable = originalIsClaimDurable
		legionCoordinator.acquireDispatchToken = originalAcquireDispatchToken
		legionCoordinator.acquireFormationDispatchToken = originalAcquireFormationDispatchToken
		legionCoordinator.acquireAutomaticFormationToken = originalAcquireAutomaticFormationToken
		setAgentSwarmConfigOverride(null)
		const target = dbPool as any
		for (const [k, fn] of Object.entries(originalDbMethods)) {
			target[k] = fn
		}
	})

	describe("1. Auxiliary Feature Toggle & Precedence", () => {
		it("enables Legion by default without enabling review or defer", async () => {
			const cfg = getAgentSwarmConfig()
			expect(cfg.enabled).to.equal(false)
			expect(cfg.criticalCompletionReviewEnabled).to.equal(false)
			expect(cfg.hierarchicalDeferEnabled).to.equal(false)
			expect(cfg.legionEnabled).to.equal(true)

			const effective = orchestrator.isAuxiliaryFeatureEnabled({ streamId: "stream-1", taskId: "task-1" })
			expect(effective.enabled).to.equal(true)
			expect(effective.legionEnabled).to.equal(true)

			const root = await orchestrator.createStream("Normal Root Stream")
			const deferRes = await orchestrator.deferAgent(root.id)
			expect(deferRes.deferred).to.equal(false)
			expect(deferRes.reason).to.include("disabled")

			const reviewRes = await orchestrator.runCriticalCompletionReview({
				streamId: root.id,
				taskDescription: "Implement feature X",
				taskResult: "TODO: stub not implemented",
			})
			expect(reviewRes.executed).to.equal(false)
			expect(reviewRes.decision).to.equal("ACCEPT")
			expect(reviewRes.passType).to.equal("skipped")
		})

		it("supports global toggling, per-agent overrides, per-task overrides, and manual invocation", async () => {
			// Global toggle ON
			toggleAgentSwarmFeature(true)
			expect(resolveEffectiveAgentSwarmState().enabled).to.equal(true)
			expect(resolveEffectiveAgentSwarmState().criticalCompletionReviewEnabled).to.equal(true)
			expect(resolveEffectiveAgentSwarmState().hierarchicalDeferEnabled).to.equal(true)
			expect(resolveEffectiveAgentSwarmState().resolvedFrom).to.equal("global")

			// Per-agent override disables review for "agent-fast"
			setAgentSwarmAgentOverride("agent-fast", { criticalCompletionReviewEnabled: false })
			const agentState = resolveEffectiveAgentSwarmState({ agentId: "agent-fast" })
			expect(agentState.criticalCompletionReviewEnabled).to.equal(false)
			expect(agentState.hierarchicalDeferEnabled).to.equal(true)
			expect(agentState.resolvedFrom).to.equal("agent_override")

			// Per-task override re-enables review for a high-risk task even on "agent-fast"
			setAgentSwarmTaskOverride("task-high-risk", {
				criticalCompletionReviewEnabled: true,
				defaultDeferBoundary: "before_turn",
			})
			const taskState = resolveEffectiveAgentSwarmState({
				agentId: "agent-fast",
				taskId: "task-high-risk",
			})
			expect(taskState.criticalCompletionReviewEnabled).to.equal(true)
			expect(taskState.defaultDeferBoundary).to.equal("before_turn")
			expect(taskState.resolvedFrom).to.equal("task_override")

			// Toggle everything OFF globally, then verify manual invocation still works
			toggleAgentSwarmFeature(false)
			expect(resolveEffectiveAgentSwarmState().enabled).to.equal(false)

			const manualState = resolveEffectiveAgentSwarmState({ manualInvocation: true })
			expect(manualState.enabled).to.equal(true)
			expect(manualState.criticalCompletionReviewEnabled).to.equal(true)
			expect(manualState.resolvedFrom).to.equal("manual_invocation")
		})

		it("respects an explicit Legion opt-out with the master switch off", () => {
			setAgentSwarmConfigOverride({ enabled: false, legionEnabled: false })
			expect(resolveEffectiveAgentSwarmState().legionEnabled).to.equal(false)
			setAgentSwarmTaskOverride("task-opt-in", { legionEnabled: true })
			expect(resolveEffectiveAgentSwarmState({ taskId: "task-opt-in" }).legionEnabled).to.equal(true)
		})
	})

	describe("2. Critical Completion Review (agentswarm2.md)", () => {
		it("strictly separates confirmed defects, unverified risks, and optional/subjective items (optional items never trigger REMEDIATE)", async () => {
			toggleAgentSwarmFeature(true)
			const stream = await orchestrator.createStream("Feature implementation")

			// Only optional_improvement and subjective_preference findings -> must ACCEPT, never REMEDIATE
			const optionalOnlyReport = await reviewService.runReview({
				streamId: stream.id,
				completionEventId: "evt-optional",
				taskDescription: "Add user profile endpoint",
				taskResult: "Implemented user profile endpoint and verified with unit tests.",
				findings: [
					{
						category: "optional_improvement",
						affectedComponent: "UserController.ts",
						recommendedCorrectiveAction: "Could add GraphQL subscription in a future milestone",
					},
					{
						category: "subjective_preference",
						affectedComponent: "UserTypes.ts",
						recommendedCorrectiveAction: "Prefer interface over type alias",
					},
				],
			})

			expect(optionalOnlyReport.executed).to.equal(true)
			expect(optionalOnlyReport.decision).to.equal("ACCEPT")
			expect(optionalOnlyReport.confirmedDefects).to.have.length(0)
			expect(optionalOnlyReport.optionalAndSubjectiveItems).to.have.length(2)
			expect(optionalOnlyReport.prioritizedCorrectiveTasks).to.have.length(0)
		})

		it("downgrades hypothetical or unverified defect claims to unverified_assumption and decides ACCEPT_WITH_DISCLOSED_LIMITATIONS", async () => {
			toggleAgentSwarmFeature(true)
			const stream = await orchestrator.createStream("Edge case handling")

			const report = await reviewService.runReview({
				streamId: stream.id,
				completionEventId: "evt-hypothetical",
				taskDescription: "Handle webhook payloads",
				taskResult: "Implemented webhook handler and verified signature validation.",
				findings: [
					{
						category: "demonstrable_defect",
						affectedComponent: "WebhookHandler.ts",
						actualBehavior: "Might fail if payload exceeds 50MB under extreme load",
						isHypothetical: true,
						isVerified: false,
					},
				],
			})

			expect(report.decision).to.equal("ACCEPT_WITH_DISCLOSED_LIMITATIONS")
			expect(report.confirmedDefects).to.have.length(0)
			expect(report.unverifiedRisksAndAssumptions).to.have.length(1)
			expect(report.unverifiedRisksAndAssumptions[0].category).to.equal("unverified_assumption")
			expect(report.coordinatorFinalReportMarkdown).to.include("ACCEPT_WITH_DISCLOSED_LIMITATIONS")
		})

		it("emits REMEDIATE with prioritized corrective tasks for confirmed defects and enforces bounded 1+1 termination", async () => {
			toggleAgentSwarmFeature(true)
			const stream = await orchestrator.createStream("Auth token refresh")
			const completionEventId = "evt-bounded-remediate"

			// Pass 1: Initial adversarial review finds a confirmed reproducible failure
			const initialReport = await reviewService.runReview({
				streamId: stream.id,
				completionEventId,
				taskDescription: "Implement token refresh on 401",
				taskResult: "Implemented token refresh interceptor.",
				findings: [
					{
						category: "reproducible_failure",
						affectedComponent: "src/auth/refresh.ts",
						triggeringCondition: "Concurrent 401 responses arrive while refresh is in flight",
						expectedBehavior: "Deduplicate refresh requests onto a single promise",
						actualBehavior: "Issues duplicate refresh calls causing token revocation",
						rootCause: "Missing in-flight mutex around refreshToken()",
						recommendedCorrectiveAction: "Wrap refreshToken() in a shared in-flight promise lock",
						isHypothetical: false,
						isVerified: true,
					},
				],
			})

			expect(initialReport.executed).to.equal(true)
			expect(initialReport.passType).to.equal("initial_adversarial_review")
			expect(initialReport.decision).to.equal("REMEDIATE")
			expect(initialReport.confirmedDefects).to.have.length(1)
			expect(initialReport.prioritizedCorrectiveTasks).to.have.length(1)
			expect(initialReport.prioritizedCorrectiveTasks[0].priority).to.equal(1)

			// Pass 2: Corrective verification pass after remediation succeeds -> ACCEPT
			const correctivePass = await reviewService.runReview({
				streamId: stream.id,
				completionEventId,
				isCorrectiveVerificationPass: true,
				taskDescription: "Implement token refresh on 401",
				taskResult: "Added shared in-flight mutex around refreshToken() and verified with concurrency test.",
				findings: [],
			})

			expect(correctivePass.executed).to.equal(true)
			expect(correctivePass.passType).to.equal("corrective_verification_pass")
			expect(correctivePass.decision).to.equal("ACCEPT")
			expect(correctivePass.cycleState.initialReviewsUsed).to.equal(1)
			expect(correctivePass.cycleState.correctivePassesUsed).to.equal(1)

			// Pass 3: Attempting another corrective pass on the same completion event is blocked by bounded termination
			const thirdPass = await reviewService.runReview({
				streamId: stream.id,
				completionEventId,
				isCorrectiveVerificationPass: true,
				taskDescription: "Implement token refresh on 401",
				taskResult: "Attempting third pass",
			})

			expect(thirdPass.executed).to.equal(false)
			expect(thirdPass.passType).to.equal("bounded_limit_reached")
			expect(thirdPass.skippedReason).to.include("Bounded termination limit reached")
		})

		it("emits ESCALATE when blocking risk cannot be resolved due to unavailable capabilities", async () => {
			toggleAgentSwarmFeature(true)
			const stream = await orchestrator.createStream("Hardware enclave signing")

			const escalateReport = await reviewService.runReview({
				streamId: stream.id,
				completionEventId: "evt-escalate",
				taskDescription: "Verify HSM hardware enclave signature in production",
				taskResult: "Cannot access production HSM from local sandbox.",
				blockingCapabilityUnavailable: true,
				findings: [
					{
						category: "material_risk",
						affectedComponent: "HsmSigner.ts",
						actualBehavior: "HSM hardware enclave is unreachable from sandbox environment",
						isHypothetical: false,
						isVerified: true,
					},
				],
			})

			expect(escalateReport.decision).to.equal("ESCALATE")
		})

		it("integrates cleanly into runCompletionGateFlow only when enabled", async () => {
			const taskState = new TaskState()
			const config = {
				taskId: "task-gate-review",
				ulid: "ulid-gate-review",
				cwd: process.cwd(),
				auditCompletionGateEnabled: false,
				focusChainSettings: { enabled: false },
				taskState,
				messageState: { getDietCodeMessages: () => [] },
			} as unknown as TaskConfig

			const defectiveResult = "TODO: placeholder stub not implemented yet."

			// 1. When disabled (default), runCompletionGateFlow passes without running Critical Completion Review
			const disabledFlow = await runCompletionGateFlow(config, { result: defectiveResult }, "Test")
			expect(disabledFlow.status).to.equal("passed")
			expect(disabledFlow.criticalReviewReport).to.equal(undefined)

			// 2. When enabled, Critical Completion Review catches the unresolved stub and blocks with REMEDIATE
			toggleAgentSwarmFeature(true, { criticalCompletionReviewEnabled: true, hierarchicalDeferEnabled: false })
			taskState.workspaceRevision++
			const enabledFlow = await runCompletionGateFlow(
				config,
				{
					result: defectiveResult,
					taskDescription: "Implement production payment processor and verify with tests.",
				},
				"Test",
			)
			expect(enabledFlow.status).to.equal("blocked")
			expect(enabledFlow.criticalReviewReport?.decision).to.equal("REMEDIATE")
			if (enabledFlow.status === "blocked") {
				expect(enabledFlow.message).to.include("REMEDIATE")
			}

			// 3. Manual invocation works even when global config is disabled
			toggleAgentSwarmFeature(false)
			const manualReport = await evaluateOptionalCriticalCompletionReview(config, {
				result: "Implemented and verified with unit tests.",
				taskDescription: "Verify manual review invocation",
				manualInvocation: true,
			})
			expect(manualReport).to.not.equal(null)
			expect(manualReport?.executed).to.equal(true)
			expect(manualReport?.decision).to.equal("ACCEPT")
		})
	})

	describe("3. Individual Agent Defer & Resume Across Execution Boundaries", () => {
		it("defers at before_turn and safe_boundary, preserves file reservations, and never marks tasks failed or completed", async () => {
			toggleAgentSwarmFeature(true)
			const stream = await orchestrator.createStream("Worker Stream A")
			const task = await orchestrator.createTask(stream.id, "Implement parser module")
			await orchestrator.updateTaskStatus(task.id, "running")
			await orchestrator.reserveFiles(stream.id, ["src/parser.ts"])

			const deferRes = await orchestrator.deferAgent(stream.id, {
				boundary: "before_turn",
				reason: "Await schema approval",
				turnIndex: 3,
				pendingToolQueue: ["write_to_file:src/parser.ts"],
				completedToolReceipts: [
					{
						operationId: "op-read-1",
						toolName: "read_file",
						resultSummary: "Read src/schema.ts (120 lines)",
					},
				],
				continuationMetadata: { nextStep: "Write parser AST nodes" },
			})

			expect(deferRes.deferred).to.equal(true)
			expect(deferRes.status.state).to.equal("deferred")
			expect(deferRes.status.acceptingNewWork).to.equal(false)
			expect(deferRes.checkpoint?.yieldPoint).to.equal("before_turn")
			expect(deferRes.checkpoint?.turnIndex).to.equal(3)
			expect(deferRes.checkpoint?.heldReservations).to.have.length(1)
			expect(deferRes.ackMessage?.type).to.equal("DEFER_ACK")

			// Verify task was NOT marked completed or failed, and stalled task detector ignores deferred tasks
			const tasksDuringDefer = await orchestrator.getStreamTasks(stream.id)
			expect(tasksDuringDefer[0].status).to.equal("running")
			expect((tasksDuringDefer[0].metadata as any)?.deferred_state).to.equal("deferred")

			const stalled = await orchestrator.detectStalledTasks(0)
			expect(stalled.map((t) => t.id)).to.not.include(task.id)

			// Verify idempotency of duplicate deferAgent calls
			const duplicateDefer = await orchestrator.deferAgent(stream.id, {
				boundary: "before_turn",
				sequenceNumber: deferRes.status.sequenceNumber,
			})
			expect(duplicateDefer.deferred).to.equal(true)
			expect(duplicateDefer.checkpoint?.checkpointId).to.equal(deferRes.checkpoint?.checkpointId)

			// Resume agent and verify completed operations are recorded as skipped so they are never replayed
			const resumeRes = await orchestrator.resumeAgent(stream.id, {
				reason: "Schema approved",
			})
			expect(resumeRes.resumed).to.equal(true)
			expect(resumeRes.state).to.equal("running")
			expect(resumeRes.skippedCompletedOperationIds).to.deep.equal(["op-read-1"])
			expect(resumeRes.restoredCheckpoint?.pendingToolQueue).to.deep.equal(["write_to_file:src/parser.ts"])
			expect(resumeRes.controlAck.type).to.equal("RESUME_ACK")

			// Verify idempotency of duplicate resumeAgent calls
			const duplicateResume = await orchestrator.resumeAgent(stream.id)
			expect(duplicateResume.resumed).to.equal(true)
			expect(duplicateResume.state).to.equal("running")
		})

		it("waits for an in-flight non-idempotent tool operation to finish before yielding at safe_boundary", async () => {
			toggleAgentSwarmFeature(true)
			const stream = await orchestrator.createStream("Worker Stream with In-Flight Mutation")

			await orchestrator.registerInFlightOperation(stream.id, {
				operationId: "op-mut-99",
				toolName: "replace_in_file",
				isIdempotent: false,
				canSafeInterruptImmediately: false,
				startedAt: Date.now(),
				status: "running",
			})

			// Requesting defer while non-idempotent tool is running enters `suspending`, NOT `deferred`
			const initialDefer = await orchestrator.deferAgent(stream.id, {
				boundary: "safe_boundary",
				reason: "Pause after current file edit completes",
			})
			expect(initialDefer.deferred).to.equal(false)
			expect(initialDefer.status.state).to.equal("suspending")
			expect(initialDefer.status.acceptingNewWork).to.equal(false)

			// Once the atomic tool finishes, completeInFlightAndYield transitions the stream to `deferred`
			const yielded = await orchestrator.completeInFlightAndYield(
				stream.id,
				{
					operationId: "op-mut-99",
					toolName: "replace_in_file",
					resultSummary: "Updated 15 lines in src/service.ts",
				},
				{ cursorLine: 45 },
			)
			expect(yielded.deferred).to.equal(true)
			expect(yielded.status.state).to.equal("deferred")
			expect(yielded.checkpoint.completedToolReceipts.map((r) => r.operationId)).to.include("op-mut-99")
		})

		it("allows immediate defer only when the in-flight operation is explicitly safe and idempotent", async () => {
			toggleAgentSwarmFeature(true)
			const stream = await orchestrator.createStream("Worker Stream with Read-Only Search")

			await orchestrator.registerInFlightOperation(stream.id, {
				operationId: "op-search-1",
				toolName: "search_files",
				isIdempotent: true,
				canSafeInterruptImmediately: true,
				startedAt: Date.now(),
				status: "running",
			})

			const immediateDefer = await orchestrator.deferAgent(stream.id, {
				boundary: "immediate",
				reason: "Urgent priority shift",
			})
			expect(immediateDefer.deferred).to.equal(true)
			expect(immediateDefer.status.state).to.equal("deferred")
			expect(immediateDefer.checkpoint?.yieldPoint).to.equal("immediate_safe_point")
		})
	})

	describe("4. Hierarchical Pipeline Defer, Suspension Barrier & Independent Stream Recovery (agentswarm3.md & agentswarm4.md)", () => {
		it("enforces the Parent Suspension Barrier when Child C ismid-tool, then suspends the full hierarchy once Child C yields", async () => {
			toggleAgentSwarmFeature(true)

			// Create Parent A -> Child B and Child C
			const parentA = await orchestrator.createStream("Parent Coordinator A: Full-Stack Refactor")
			const childB = await orchestrator.spawnChildStream(parentA.id, "Child B: Update API Schema")
			const childC = await orchestrator.spawnChildStream(parentA.id, "Child C: Migrate Database Tables")

			// Record separate tasks in each stream to verify stream histories never merge
			const taskA = await orchestrator.createTask(parentA.id, "Coordinate Child B and Child C")
			await orchestrator.updateTaskStatus(taskA.id, "running", "Delegated schema and migration tasks")

			const taskB = await orchestrator.createTask(childB.id, "Edit openapi.yaml")
			await orchestrator.updateTaskStatus(taskB.id, "running", "Drafted v2 endpoints")

			const taskC = await orchestrator.createTask(childC.id, "Run migration SQL")
			await orchestrator.updateTaskStatus(taskC.id, "running", "Executing migration batch 1")

			// Child C has a non-interruptible in-flight database mutation; Child B is at a safe boundary
			const pipelineSuspending = await orchestrator.deferPipeline(parentA.id, {
				boundary: "safe_boundary",
				reason: "User requested mid-flight architectural inspection",
				agentRuntimeStates: {
					[childB.id]: {
						turnIndex: 2,
						pendingToolQueue: ["validate_openapi"],
						completedToolReceipts: [
							{ operationId: "b-op-1", toolName: "write_to_file", resultSummary: "Wrote openapi.yaml" },
						],
					},
					[childC.id]: {
						turnIndex: 1,
						inFlightOperation: {
							operationId: "c-op-migration",
							toolName: "execute_command",
							isIdempotent: false,
							canSafeInterruptImmediately: false,
							startedAt: Date.now(),
							status: "running",
						},
					},
				},
			})

			// Barrier check: Child B is `deferred`, Child C is `suspending`, so Parent A MUST be `waiting_for_children`
			expect(pipelineSuspending.phase).to.equal("waiting_for_children")
			expect(pipelineSuspending.agentStatuses[childB.id].state).to.equal("deferred")
			expect(pipelineSuspending.agentStatuses[childC.id].state).to.equal("suspending")
			expect(pipelineSuspending.agentStatuses[parentA.id].state).to.equal("waiting_for_children")
			expect(pipelineSuspending.agentStatuses[parentA.id].acceptingNewWork).to.equal(false)
			expect(pipelineSuspending.pendingChildStreamIds).to.deep.equal([childC.id])
			expect(pipelineSuspending.suspendedStreamIds).to.deep.equal([childB.id])
			expect(pipelineSuspending.rollingRoadmap?.synchronizationStatus).to.equal("suspending_children")

			// Now Child C finishes its in-flight atomic migration command and yields at the safe boundary
			const childCYield = await orchestrator.completeInFlightAndYield(
				childC.id,
				{
					operationId: "c-op-migration",
					toolName: "execute_command",
					resultSummary: "Migration batch 1 committed cleanly",
				},
				{ nextBatch: 2 },
			)

			expect(childCYield.deferred).to.equal(true)
			expect(childCYield.parentPipelineStatus).to.not.equal(undefined)
			expect(childCYield.parentPipelineStatus?.phase).to.equal("suspended")
			expect(childCYield.parentPipelineStatus?.pendingChildStreamIds).to.be.empty
			expect(childCYield.parentPipelineStatus?.suspendedStreamIds).to.include.members([childB.id, childC.id, parentA.id])
			expect(childCYield.parentPipelineStatus?.rollingRoadmap?.synchronizationStatus).to.equal("barrier_satisfied")

			// Simulate process restart by instantiating a fresh coordinator reading only from durable DB storage
			const recoveredCoordinator = new HierarchicalDeferCoordinator()
			const recoveredPipeline = await recoveredCoordinator.getDeferredPipelineStatus(parentA.id)
			expect(recoveredPipeline?.phase).to.equal("suspended")
			expect(recoveredPipeline?.rollingRoadmap?.activeChildAssignments).to.have.length(2)

			// Resume the entire pipeline from the recovered coordinator
			const resumedPipeline = await recoveredCoordinator.resumePipeline(parentA.id, {
				reason: "Architectural inspection passed; continue execution",
			})

			expect(resumedPipeline.resumed).to.equal(true)
			expect(resumedPipeline.phase).to.equal("resumed")
			expect(resumedPipeline.restoredRoadmap?.synchronizationStatus).to.equal("resumed")
			expect(resumedPipeline.resumedAgentResults[childB.id].skippedCompletedOperationIds).to.deep.equal(["b-op-1"])
			expect(resumedPipeline.resumedAgentResults[childC.id].skippedCompletedOperationIds).to.deep.equal(["c-op-migration"])

			// Verify Parent A, Child B, and Child C retained completely independent conversation histories
			const historyA = await orchestrator.getConversationHistory(parentA.id)
			const historyB = await orchestrator.getConversationHistory(childB.id)
			const historyC = await orchestrator.getConversationHistory(childC.id)

			expect(historyA).to.have.length(2)
			expect(historyB).to.have.length(2)
			expect(historyC).to.have.length(2)
			expect(JSON.stringify(historyA)).to.include("Coordinate Child B and Child C")
			expect(JSON.stringify(historyA)).to.not.include("Edit openapi.yaml")
			expect(JSON.stringify(historyB)).to.include("Edit openapi.yaml")
			expect(JSON.stringify(historyC)).to.include("Run migration SQL")
		})

		it("rejects new task or child stream delegations on a suspending/deferred parent until resumed", async () => {
			toggleAgentSwarmFeature(true)
			const parent = await orchestrator.createStream("Coordinator Parent")
			const child = await orchestrator.spawnChildStream(parent.id, "Active Child")

			await orchestrator.registerInFlightOperation(child.id, {
				operationId: "op-child-1",
				toolName: "execute_command",
				isIdempotent: false,
				canSafeInterruptImmediately: false,
				startedAt: Date.now(),
				status: "running",
			})

			const deferStatus = await orchestrator.deferPipeline(parent.id, { boundary: "safe_boundary" })
			expect(deferStatus.phase).to.equal("waiting_for_children")
			expect(deferStatus.agentStatuses[parent.id].acceptingNewWork).to.equal(false)

			// Attempting to create a new task or spawn a child while waiting_for_children / deferred must throw
			let createTaskFailed = false
			try {
				await orchestrator.createTask(parent.id, "Conflicting new task")
			} catch (err) {
				createTaskFailed = true
				expect(String(err)).to.include("not accepting new work")
			}
			expect(createTaskFailed).to.equal(true)

			let spawnChildFailed = false
			try {
				await orchestrator.spawnChildStream(parent.id, "Conflicting new child")
			} catch (err) {
				spawnChildFailed = true
				expect(String(err)).to.include("not accepting new child delegations")
			}
			expect(spawnChildFailed).to.equal(true)

			// Once child yields and pipeline resumes, parent accepts new work again
			await orchestrator.completeInFlightAndYield(child.id, {
				operationId: "op-child-1",
				toolName: "execute_command",
				resultSummary: "Finished",
			})
			await orchestrator.resumePipeline(parent.id)

			const taskAfterResume = await orchestrator.createTask(parent.id, "Allowed after resume")
			expect(taskAfterResume.description).to.equal("Allowed after resume")
		})

		it("handles 4-level deep hierarchies, concurrent sibling barrier completions, and child failure during suspension", async () => {
			toggleAgentSwarmFeature(true)

			// 4-level hierarchy: Root -> MidCoord -> SubCoord -> Leaf1, Leaf2, Leaf3
			const root = await orchestrator.createStream("Level 1: Root Coordinator")
			const mid = await orchestrator.spawnChildStream(root.id, "Level 2: Mid Coordinator")
			const sub = await orchestrator.spawnChildStream(mid.id, "Level 3: Sub Coordinator")
			const leaf1 = await orchestrator.spawnChildStream(sub.id, "Level 4: Leaf Worker 1")
			const leaf2 = await orchestrator.spawnChildStream(sub.id, "Level 4: Leaf Worker 2")
			const leaf3 = await orchestrator.spawnChildStream(sub.id, "Level 4: Leaf Worker 3 (will fail)")

			for (const leaf of [leaf1, leaf2, leaf3]) {
				await orchestrator.registerInFlightOperation(leaf.id, {
					operationId: `op-${leaf.id}`,
					toolName: "replace_in_file",
					isIdempotent: false,
					canSafeInterruptImmediately: false,
					startedAt: Date.now(),
					status: "running",
				})
			}

			const initialPipeline = await orchestrator.deferPipeline(root.id, { boundary: "safe_boundary" })
			expect(initialPipeline.phase).to.equal("waiting_for_children")
			expect(initialPipeline.agentStatuses[sub.id].state).to.equal("waiting_for_children")
			expect(initialPipeline.agentStatuses[mid.id].state).to.equal("waiting_for_children")
			expect(initialPipeline.agentStatuses[root.id].state).to.equal("waiting_for_children")

			// Concurrent sibling completions (Leaf 1 and Leaf 2 finish simultaneously)
			await Promise.all([
				orchestrator.completeInFlightAndYield(leaf1.id, {
					operationId: `op-${leaf1.id}`,
					toolName: "replace_in_file",
					resultSummary: "Leaf 1 done",
				}),
				orchestrator.completeInFlightAndYield(leaf2.id, {
					operationId: `op-${leaf2.id}`,
					toolName: "replace_in_file",
					resultSummary: "Leaf 2 done",
				}),
			])

			// Leaf 3 is still running, so pipeline is still waiting_for_children
			const midPipeline = await orchestrator.getDeferredPipelineStatus(root.id)
			expect(midPipeline?.phase).to.equal("waiting_for_children")
			expect(midPipeline?.pendingChildStreamIds).to.include(leaf3.id)

			// Now Leaf 3 crashes/fails instead of yielding; failStream must reconcile the barrier so Root/Mid/Sub don't deadlock!
			await orchestrator.failStream(leaf3.id, "Leaf 3 encountered fatal crash")

			const finalPipeline = await orchestrator.getDeferredPipelineStatus(root.id)
			expect(finalPipeline?.phase).to.equal("suspended")
			expect(finalPipeline?.pendingChildStreamIds).to.be.empty
			expect(finalPipeline?.agentStatuses[sub.id].state).to.equal("deferred")
			expect(finalPipeline?.agentStatuses[mid.id].state).to.equal("deferred")
			expect(finalPipeline?.agentStatuses[root.id].state).to.equal("deferred")
		})
	})

	describe("5. Real SQLite BufferedDbPool Flush & On-Disk Upsert Verification", () => {
		it("flushes agent_memory composite-key upserts to real SQLite without ON CONFLICT errors", async () => {
			// Restore real BufferedDbPool methods for this test and use an isolated temp SQLite file
			const target = dbPool as any
			for (const [k, fn] of Object.entries(originalDbMethods)) {
				target[k] = fn
			}
			const os = await import("node:os")
			const path = await import("node:path")
			const fs = await import("node:fs")
			const { setDbPath } = await import("../../db/Config")

			const tempDbFile = path.join(os.tmpdir(), `lumi-swarm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
			setDbPath(tempDbFile)

			try {
				toggleAgentSwarmFeature(true)
				const root = await orchestrator.createStream("Real SQLite Root Stream")
				const child = await orchestrator.spawnChildStream(root.id, "Real SQLite Child Stream")
				const task = await orchestrator.createTask(child.id, "Persist checkpoint to real SQLite")
				await orchestrator.updateTaskStatus(task.id, "running")

				// Trigger multiple upserts to the same (streamId, key) pairs in agent_memory
				const defer1 = await orchestrator.deferPipeline(root.id, {
					boundary: "safe_boundary",
					reason: "First SQLite checkpoint",
				})
				expect(defer1.phase).to.equal("suspended")

				// Flush to real SQLite disk
				await dbPool.flush()

				// Resume and defer again to force ON CONFLICT (streamId, key) DO UPDATE in SQLite
				await orchestrator.resumePipeline(root.id, { reason: "Resume before second checkpoint" })
				await dbPool.flush()

				const review = await orchestrator.runCriticalCompletionReview({
					streamId: root.id,
					taskId: task.id,
					taskDescription: "Persist checkpoint to real SQLite and verify",
					taskResult: "Persisted checkpoints and verified with real SQLite flush tests.",
				})
				await dbPool.flush()

				expect(review.executed).to.equal(true)
				expect(review.decision).to.equal("ACCEPT")
				// Verify pipeline was automatically resumed after review completed
				const postReviewStatus = await orchestrator.getAgentDeferStatus(root.id)
				expect(postReviewStatus.state).to.equal("running")
			} finally {
				await dbPool.stop()
				try {
					if (fs.existsSync(tempDbFile)) fs.unlinkSync(tempDbFile)
					if (fs.existsSync(`${tempDbFile}-wal`)) fs.unlinkSync(`${tempDbFile}-wal`)
					if (fs.existsSync(`${tempDbFile}-shm`)) fs.unlinkSync(`${tempDbFile}-shm`)
				} catch {
					// ignore cleanup errors
				}
			}
		})

		const withRealSqlite = async (fn: (file: string) => Promise<void>) => {
			const target = dbPool as any
			for (const [k, fn2] of Object.entries(originalDbMethods)) {
				target[k] = fn2
			}
			const os = await import("node:os")
			const path = await import("node:path")
			const fs = await import("node:fs")
			const { setDbPath } = await import("../../db/Config")
			const file = path.join(os.tmpdir(), `lumi-swarm-real-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
			setDbPath(file)
			try {
				await fn(file)
			} finally {
				await dbPool.stop()
				for (const f of [file, `${file}-wal`, `${file}-shm`]) {
					try {
						if (fs.existsSync(f)) fs.unlinkSync(f)
					} catch {
						// ignore cleanup errors
					}
				}
			}
		}

		it("persists completeStream's final status and summary to SQLite and exposes them to non-overlay readers", async () => {
			await withRealSqlite(async (file) => {
				const stream = await orchestrator.createStream("Persist completion state")
				await dbPool.flush()

				await orchestrator.completeStream(stream.id, "final summary")

				// A reader that does not pass the stream's own agent id (e.g. hierarchy walks) must already see it
				const visible = await dbPool.selectOne("agent_streams", { column: "id", value: stream.id })
				expect(visible?.status).to.equal("completed")

				await dbPool.flush()
				const Database = (await import("better-sqlite3")).default
				const raw = new Database(file, { readonly: true })
				try {
					const row = raw.prepare("select status from agent_streams where id = ?").get(stream.id) as { status: string }
					const summary = raw
						.prepare("select value from agent_memory where streamId = ? and key = 'stream_summary'")
						.get(stream.id) as { value: string }
					expect(row.status).to.equal("completed")
					expect(summary.value).to.equal("final summary")
				} finally {
					raw.close()
				}
			})
		})

		it("deletes a finished stream's file reservations from SQLite (release is not stranded in a shadow overlay)", async () => {
			await withRealSqlite(async (file) => {
				const stream = await orchestrator.createStream("Reservation owner")
				await dbPool.flush()
				const reserved = await orchestrator.reserveFiles(stream.id, ["src/reservation-probe.ts"])
				expect(reserved.reserved).to.equal(true)
				// Deliberately NO flush here: reserve and release land in the same buffered batch, where the pool orders
				// ops by type (delete before upsert) and would otherwise resurrect the reservation row.

				await orchestrator.completeStream(stream.id, "done")
				await dbPool.flush()

				const Database = (await import("better-sqlite3")).default
				const raw = new Database(file, { readonly: true })
				try {
					const rows = raw
						.prepare("select key from agent_memory where streamId = ? and key like 'file_res:%'")
						.all(stream.id)
					expect(rows).to.have.length(0)
				} finally {
					raw.close()
				}
			})
		})

		it("does not re-suspend or block a resumed parent when a child finishes later", async () => {
			await withRealSqlite(async () => {
				toggleAgentSwarmFeature(true)
				const root = await orchestrator.createStream("Resumed root")
				const child = await orchestrator.spawnChildStream(root.id, "Late child")

				const suspended = await orchestrator.deferPipeline(root.id, { boundary: "safe_boundary" })
				expect(suspended.phase).to.equal("suspended")
				await orchestrator.resumePipeline(root.id)

				await orchestrator.completeStream(child.id, "finished after the resume")

				const rootStatus = await orchestrator.getAgentDeferStatus(root.id)
				expect(rootStatus.state).to.equal("running")
				expect(rootStatus.acceptingNewWork).to.equal(true)
				const task = await orchestrator.createTask(root.id, "New work after resume")
				expect(task.id).to.be.a("string")
			})
		})

		it("lets a child's completeStream release a waiting parent suspension barrier on the real pool", async () => {
			await withRealSqlite(async () => {
				toggleAgentSwarmFeature(true)
				const root = await orchestrator.createStream("Barrier root")
				const child = await orchestrator.spawnChildStream(root.id, "Barrier child")
				const inFlight = {
					operationId: "op-real-1",
					toolName: "execute_command",
					isIdempotent: false,
					canSafeInterruptImmediately: false,
					startedAt: Date.now(),
					status: "running" as const,
				}

				const waiting = await orchestrator.deferPipeline(root.id, {
					boundary: "safe_boundary",
					agentRuntimeStates: { [child.id]: { inFlightOperation: inFlight } },
				})
				expect(waiting.phase).to.equal("waiting_for_children")

				await orchestrator.completeStream(child.id, "child finished its command")

				const after = await orchestrator.getDeferredPipelineStatus(root.id)
				expect(after?.phase).to.equal("suspended")
			})
		})
	})

	describe("6. Proto Settings Synchronization, updateSettings Clamping & TaskConfig Integration", () => {
		it("synchronizes UpdateSettingsRequest proto fields through updateSettings and updateTaskSettings with clamping and cache invalidation", async () => {
			const { UpdateSettingsRequest } = await import("@/shared/proto/dietcode/state")
			const { updateSettings } = await import("@/core/controller/state/updateSettings")
			const { updateTaskSettings } = await import("@/core/controller/state/updateTaskSettings")
			const { StateManager } = await import("@/core/storage/StateManager")

			const globalSettingsStore: Record<string, any> = {}
			const taskSettingsStore: Record<string, Record<string, any>> = {}
			let postedWebviewStates = 0

			const mockStateManager = {
				setGlobalState: (key: string, val: any) => {
					globalSettingsStore[key] = val
				},
				setGlobalStateBatch: (batch: Record<string, any>) => {
					Object.assign(globalSettingsStore, batch)
				},
				getGlobalSettingsKey: (key: string) => globalSettingsStore[key],
				getGlobalStateKey: (key: string) => globalSettingsStore[key],
				setTaskSettings: (taskId: string, key: string, val: any) => {
					if (!taskSettingsStore[taskId]) taskSettingsStore[taskId] = {}
					taskSettingsStore[taskId][key] = val
				},
				setTaskSettingsBatch: (taskId: string, batch: Record<string, any>) => {
					if (!taskSettingsStore[taskId]) taskSettingsStore[taskId] = {}
					Object.assign(taskSettingsStore[taskId], batch)
				},
			}

			const origGet = (StateManager as any).get
			;(StateManager as any).get = () => mockStateManager

			const mockController = {
				stateManager: mockStateManager,
				postStateToWebview: async () => {
					postedWebviewStates++
				},
				task: undefined,
			} as any

			try {
				const protoReq = UpdateSettingsRequest.create({
					agentSwarmEnabled: true,
					agentSwarmCriticalCompletionReviewEnabled: true,
					agentSwarmHierarchicalDeferEnabled: true,
					agentSwarmDefaultDeferBoundary: "before_turn",
					agentSwarmAutoDeferOnCompletionReview: false,
					agentSwarmMaxInitialCompletionReviews: 99, // Should clamp to 5
					agentSwarmMaxCorrectiveVerificationPasses: 0, // Should clamp to 1
				})

				await updateSettings(mockController, protoReq)

				expect(globalSettingsStore.agentSwarmEnabled).to.equal(true)
				expect(globalSettingsStore.agentSwarmCriticalCompletionReviewEnabled).to.equal(true)
				expect(globalSettingsStore.agentSwarmHierarchicalDeferEnabled).to.equal(true)
				expect(globalSettingsStore.agentSwarmDefaultDeferBoundary).to.equal("before_turn")
				expect(globalSettingsStore.agentSwarmAutoDeferOnCompletionReview).to.equal(false)
				expect(globalSettingsStore.agentSwarmMaxInitialCompletionReviews).to.equal(5)
				expect(globalSettingsStore.agentSwarmMaxCorrectiveVerificationPasses).to.equal(1)
				expect(postedWebviewStates).to.equal(1)

				// Verify getAgentSwarmConfig() immediately reflects StateManager settings (cache invalidated)
				const resolvedCfg = getAgentSwarmConfig()
				expect(resolvedCfg.enabled).to.equal(true)
				expect(resolvedCfg.criticalCompletionReviewEnabled).to.equal(true)
				expect(resolvedCfg.hierarchicalDeferEnabled).to.equal(true)
				expect(resolvedCfg.defaultDeferBoundary).to.equal("before_turn")
				expect(resolvedCfg.autoDeferOnCompletionReview).to.equal(false)
				expect(resolvedCfg.maxInitialCompletionReviews).to.equal(5)
				expect(resolvedCfg.maxCorrectiveVerificationPasses).to.equal(1)

				// Reject invalid defer boundary values cleanly
				const invalidBoundaryReq = UpdateSettingsRequest.create({
					agentSwarmDefaultDeferBoundary: "invalid_boundary_mode",
				})
				await updateSettings(mockController, invalidBoundaryReq)
				expect(globalSettingsStore.agentSwarmDefaultDeferBoundary).to.equal("before_turn")

				// Verify updateTaskSettings persists task-scoped settings with clamping
				await updateTaskSettings(mockController, {
					taskId: "task-swarm-123",
					settings: UpdateSettingsRequest.create({
						agentSwarmEnabled: true,
						agentSwarmCriticalCompletionReviewEnabled: true,
						agentSwarmHierarchicalDeferEnabled: false,
						agentSwarmDefaultDeferBoundary: "immediate",
						agentSwarmMaxInitialCompletionReviews: 2,
						agentSwarmMaxCorrectiveVerificationPasses: 8, // Clamps to 5
					}),
				} as any)

				expect(taskSettingsStore["task-swarm-123"].agentSwarmEnabled).to.equal(true)
				expect(taskSettingsStore["task-swarm-123"].agentSwarmCriticalCompletionReviewEnabled).to.equal(true)
				expect(taskSettingsStore["task-swarm-123"].agentSwarmHierarchicalDeferEnabled).to.equal(false)
				expect(taskSettingsStore["task-swarm-123"].agentSwarmDefaultDeferBoundary).to.equal("immediate")
				expect(taskSettingsStore["task-swarm-123"].agentSwarmMaxInitialCompletionReviews).to.equal(2)
				expect(taskSettingsStore["task-swarm-123"].agentSwarmMaxCorrectiveVerificationPasses).to.equal(5)
			} finally {
				;(StateManager as any).get = origGet
			}
		})

		it("activates Critical Completion Review directly from TaskConfig settingsPatch even when global override is unset", async () => {
			setAgentSwarmConfigOverride(null)
			const taskState = new TaskState()
			const config = {
				taskId: "task-from-settings-patch",
				ulid: "ulid-from-settings-patch",
				cwd: process.cwd(),
				auditCompletionGateEnabled: false,
				agentSwarmEnabled: true,
				agentSwarmCriticalCompletionReviewEnabled: true,
				agentSwarmHierarchicalDeferEnabled: false,
				agentSwarmDefaultDeferBoundary: "safe_boundary",
				agentSwarmAutoDeferOnCompletionReview: false,
				agentSwarmMaxInitialCompletionReviews: 1,
				agentSwarmMaxCorrectiveVerificationPasses: 1,
				focusChainSettings: { enabled: false },
				taskState,
				messageState: { getDietCodeMessages: () => [] },
			} as unknown as TaskConfig

			const flow = await runCompletionGateFlow(
				config,
				{
					result: "TODO: placeholder stub not implemented yet.",
					taskDescription: "Implement full webhook signature validator and verify with unit tests.",
				},
				"Test",
			)

			expect(flow.status).to.equal("blocked")
			expect(flow.criticalReviewReport?.executed).to.equal(true)
			expect(flow.criticalReviewReport?.decision).to.equal("REMEDIATE")
		})

		it("preserves VS Code workspace settings.json and env overrides when StateManager has only unpersisted default values", async () => {
			const { StateManager } = await import("@/core/storage/StateManager")
			const vscode = require("vscode")
			const origGetConfig = vscode.workspace.getConfiguration
			const origGet = (StateManager as any).get

			// Simulate a real initialized StateManager where globalStateCache was populated with defaults
			// (`false`, `"safe_boundary"`, `1`, `1`) but `storage.globalState` has NOT persisted any user changes yet
			const persistedBackingStore: Record<string, any> = {}
			const inMemoryGlobalCache: Record<string, any> = {
				agentSwarmEnabled: false,
				agentSwarmCriticalCompletionReviewEnabled: false,
				agentSwarmHierarchicalDeferEnabled: false,
				agentSwarmDefaultDeferBoundary: "safe_boundary",
				agentSwarmAutoDeferOnCompletionReview: true,
				agentSwarmMaxInitialCompletionReviews: 1,
				agentSwarmMaxCorrectiveVerificationPasses: 1,
			}

			const realisticStateManager = {
				storage: {
					globalState: {
						get: (k: string) => persistedBackingStore[k],
					},
				},
				remoteConfigCache: {},
				sessionOverrideCache: {},
				taskStateCache: {},
				pendingGlobalState: new Set<string>(),
				getGlobalSettingsKey: (k: string) => inMemoryGlobalCache[k],
				setGlobalState: (k: string, v: any) => {
					inMemoryGlobalCache[k] = v
					persistedBackingStore[k] = v
				},
			}

			;(StateManager as any).get = () => realisticStateManager
			vscode.workspace.getConfiguration = (section?: string) => {
				if (section === "lumi.agentSwarm") {
					const vsSettings: Record<string, any> = {
						enabled: true,
						"criticalCompletionReview.enabled": true,
						"hierarchicalDefer.enabled": true,
						"hierarchicalDefer.defaultBoundary": "immediate",
						"criticalCompletionReview.maxInitialReviews": 3,
						"criticalCompletionReview.maxCorrectivePasses": 2,
					}
					return {
						has: (k: string) => k in vsSettings,
						get: (k: string) => vsSettings[k],
					}
				}
				return origGetConfig(section)
			}

			try {
				setAgentSwarmConfigOverride(null)
				const cfgFromVsCode = getAgentSwarmConfig()
				expect(cfgFromVsCode.enabled).to.equal(true)
				expect(cfgFromVsCode.criticalCompletionReviewEnabled).to.equal(true)
				expect(cfgFromVsCode.hierarchicalDeferEnabled).to.equal(true)
				expect(cfgFromVsCode.defaultDeferBoundary).to.equal("immediate")
				expect(cfgFromVsCode.maxInitialCompletionReviews).to.equal(3)
				expect(cfgFromVsCode.maxCorrectiveVerificationPasses).to.equal(2)

				// Now if the user explicitly toggles off via Webview UI (persisted in StateManager), StateManager wins over settings.json
				realisticStateManager.setGlobalState("agentSwarmEnabled", false)
				realisticStateManager.setGlobalState("agentSwarmDefaultDeferBoundary", "before_turn")
				setAgentSwarmConfigOverride(null)

				const cfgAfterWebviewToggle = getAgentSwarmConfig()
				expect(cfgAfterWebviewToggle.enabled).to.equal(false)
				expect(cfgAfterWebviewToggle.defaultDeferBoundary).to.equal("before_turn")
			} finally {
				vscode.workspace.getConfiguration = origGetConfig
				;(StateManager as any).get = origGet
			}
		})

		it("includes all 10 agentSwarm* keys (including Legion) in TASK_CONFIG_KEYS and validates TaskConfig", async () => {
			const { TASK_CONFIG_KEYS } = await import("@/core/task/tools/utils/ToolConstants")
			expect(TASK_CONFIG_KEYS).to.include("agentSwarmEnabled")
			expect(TASK_CONFIG_KEYS).to.include("agentSwarmCriticalCompletionReviewEnabled")
			expect(TASK_CONFIG_KEYS).to.include("agentSwarmHierarchicalDeferEnabled")
			expect(TASK_CONFIG_KEYS).to.include("agentSwarmDefaultDeferBoundary")
			expect(TASK_CONFIG_KEYS).to.include("agentSwarmAutoDeferOnCompletionReview")
			expect(TASK_CONFIG_KEYS).to.include("agentSwarmMaxInitialCompletionReviews")
			expect(TASK_CONFIG_KEYS).to.include("agentSwarmMaxCorrectiveVerificationPasses")
			expect(TASK_CONFIG_KEYS).to.include("agentSwarmLegionEnabled")
			expect(TASK_CONFIG_KEYS).to.include("agentSwarmLegionStrategy")
			expect(TASK_CONFIG_KEYS).to.include("agentSwarmLegionMaxSpecialists")
		})
	})

	describe("7. The Legion — Specialist Agent Classification, Formation & Delegation", () => {
		it("classifies tasks across intents, file paths, strategies, and role constraints", async () => {
			// Multi-domain full-stack task with target files across proto, backend, webview UI, and tests
			const adaptiveClassification = orchestrator.classifyTaskForLegion({
				taskDescription:
					"Design proto contract, implement SQLite persistence, build React settings UI with accessible navigation, harden concurrency, and verify with unit tests",
				parentFocus: "End-to-end Legion feature delivery",
				targetFiles: [
					"proto/dietcode/state.proto",
					"src/infrastructure/db/BufferedDbPool.ts",
					"src/core/controller/state/updateSettings.ts",
					"webview-ui/src/components/settings/sections/FeatureSettingsSection.tsx",
					"src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts",
				],
				strategy: "adaptive",
				maxSpecialists: 5,
			})

			expect(adaptiveClassification.complexityScore).to.be.greaterThan(0.5)
			expect(adaptiveClassification.formationRoster.length).to.be.at.least(3)
			expect(adaptiveClassification.formationRoster.length).to.be.at.most(5)

			// Verify file partitioning assigns target files without overlap across worker/lead specialists
			const workerAssignedFiles = adaptiveClassification.formationRoster
				.filter((s) => s.role !== "legion_verifier")
				.flatMap((s) => s.assignedFiles)
			const uniqueWorkerAssignedFiles = new Set(workerAssignedFiles)
			expect(workerAssignedFiles.length).to.equal(uniqueWorkerAssignedFiles.size)

			// Tactical strike strategy selects exactly 1 best specialist
			const tacticalClassification = orchestrator.classifyTaskForLegion({
				taskDescription: "Polish React button hover state and keyboard focus ring in FeatureSettingsSection.tsx",
				targetFiles: ["webview-ui/src/components/settings/sections/FeatureSettingsSection.tsx"],
				strategy: "tactical_strike",
			})
			expect(tacticalClassification.formationRoster.length).to.equal(1)
			expect(tacticalClassification.primarySpecialist.role).to.equal("legion_Trends_ux")

			// Verification-heavy strategy guarantees Verifier presence
			const verificationClassification = orchestrator.classifyTaskForLegion({
				taskDescription: "Audit completion gate pipeline for race conditions and edge cases",
				strategy: "verification_heavy",
				maxSpecialists: 3,
			})
			const verificationRoles = verificationClassification.formationRoster.map((s) => s.role)
			expect(verificationRoles).to.include("legion_verifier")
			expect(verificationRoles).to.include("legion_hardener")

			// Respects excludeRoles and preferredRoles
			const constrainedClassification = orchestrator.classifyTaskForLegion({
				taskDescription: "Investigate unknown workspace crash",
				preferredRoles: ["legion_researcher"],
				excludeRoles: ["legion_Trends_ux", "legion_data_steward"],
				maxSpecialists: 2,
			})
			const constrainedRoles = constrainedClassification.formationRoster.map((s) => s.role)
			expect(constrainedRoles).to.include("legion_researcher")
			expect(constrainedRoles).to.not.include("legion_Trends_ux")
			expect(constrainedRoles).to.not.include("legion_data_steward")
		})

		it("forms and spawns a Legion hierarchy when enabled, reserves non-overlapping files, and updates the parent RollingRoadmapSnapshot", async () => {
			const parentStream = await orchestrator.createStream("Parent Coordinator: Feature Delivery")

			// 1. An explicit opt-out classifies without spawning child streams.
			toggleAgentSwarmFeature(false)
			const disabledRes = await orchestrator.formLegion(parentStream.id, {
				taskDescription: "Implement settings UI and unit tests",
				targetFiles: [
					"webview-ui/src/components/settings/sections/FeatureSettingsSection.tsx",
					"webview-ui/src/components/settings/sections/FeatureSettingsSection.test.tsx",
				],
			})
			expect(disabledRes.formed).to.equal(false)
			expect(disabledRes.reason).to.include("disabled")
			expect(disabledRes.manifest).to.equal(undefined)

			// 2. Enable Legion and form a specialist cohort
			toggleAgentSwarmFeature(true, {
				legionEnabled: true,
				legionStrategy: "adaptive",
				legionMaxSpecialists: 4,
			})

			const activeRes = await orchestrator.formLegion(parentStream.id, {
				taskDescription:
					"Update state.proto and StateManager settings, build FeatureSettingsSection UI, and add unit tests",
				parentFocus: "Deliver end-to-end Legion configuration",
				targetFiles: [
					"proto/dietcode/state.proto",
					"src/core/controller/state/updateSettings.ts",
					"webview-ui/src/components/settings/sections/FeatureSettingsSection.tsx",
					"src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts",
				],
			})

			expect(activeRes.formed).to.equal(true)
			expect(activeRes.manifest).to.not.equal(undefined)
			const manifest = activeRes.manifest!
			expect(manifest.members.length).to.be.at.least(2)
			expect(manifest.members.length).to.be.at.most(4)
			expect(manifest.classification.classificationSummary).to.include("Legion Classification")

			// Verify each spawned specialist has a child stream, a pending task with legion metadata, and a retrievable profile
			for (const member of manifest.members) {
				const childTasks = await orchestrator.getStreamTasks(member.streamId)
				expect(childTasks).to.have.length(1)
				expect(childTasks[0].description).to.include(member.assignment.codename)
				expect((childTasks[0].metadata as any)?.legion_formation_id).to.equal(manifest.formationId)
				expect((childTasks[0].metadata as any)?.legion_specialist_role).to.equal(member.assignment.role)

				const profile = await orchestrator.getStreamSpecialistProfile(member.streamId)
				expect(profile).to.not.equal(null)
				expect(profile?.assignment.role).to.equal(member.assignment.role)
				expect(profile?.assignment.codename).to.equal(member.assignment.codename)
			}

			// Verify recallLastLegionFormation retrieves the durable manifest from agent_memory
			const recalled = await orchestrator.recallLastLegionFormation(parentStream.id)
			expect(recalled?.formationId).to.equal(manifest.formationId)
			expect(recalled?.members.length).to.equal(manifest.members.length)
		})

		it("enforces the Parent Suspension Barrier by rejecting formLegion while the parent stream is deferred or waiting_for_children", async () => {
			toggleAgentSwarmFeature(true)
			const parent = await orchestrator.createStream("Deferred Parent Stream")
			await orchestrator.deferAgent(parent.id, {
				boundary: "safe_boundary",
				reason: "Paused before delegation",
			})

			let threwBarrierError = false
			try {
				await orchestrator.formLegion(parent.id, {
					taskDescription: "Attempt to spawn Legion while parent is deferred",
				})
			} catch (err) {
				threwBarrierError = true
				expect(String(err)).to.include("not accepting new Legion specialist delegations")
			}
			expect(threwBarrierError).to.equal(true)
		})

		it("recommends remediation specialists on CriticalCompletionReview REMEDIATE decisions and spawns a Remedial Legion cohort", async () => {
			toggleAgentSwarmFeature(true)
			const parent = await orchestrator.createStream("Parent Under Adversarial Review")

			const reviewReport = await orchestrator.runCriticalCompletionReview({
				streamId: parent.id,
				completionEventId: "evt-remedial-legion",
				taskDescription: "Implement database migration and React settings toggle",
				taskResult: "Implemented migration and toggle.",
				findings: [
					{
						category: "reproducible_failure",
						affectedComponent: "src/infrastructure/db/BufferedDbPool.ts",
						triggeringCondition: "Concurrent SQLite upsert on composite key",
						expectedBehavior: "Upsert succeeds without conflict error",
						actualBehavior: "Throws SQLITE_ERROR on conflict target",
						rootCause: "Missing composite conflictColumns array",
						recommendedCorrectiveAction: "Pass ['streamId', 'key'] as conflictColumns in BufferedDbPool",
						isHypothetical: false,
						isVerified: true,
					},
					{
						category: "unsatisfied_requirement",
						affectedComponent: "src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts",
						expectedBehavior: "Unit test covers real SQLite flush",
						actualBehavior: "Only in-memory mock tested without verification suite",
						recommendedCorrectiveAction: "Add real SQLite flush unit test",
						isHypothetical: false,
						isVerified: true,
					},
				],
			})

			expect(reviewReport.decision).to.equal("REMEDIATE")
			expect(reviewReport.prioritizedCorrectiveTasks).to.have.length(2)
			expect(reviewReport.prioritizedCorrectiveTasks[0].recommendedSpecialistRole).to.equal("legion_data_steward")
			expect(reviewReport.prioritizedCorrectiveTasks[0].recommendedSpecialistCodename).to.equal("KEEPER-STATE")
			expect(reviewReport.prioritizedCorrectiveTasks[1].recommendedSpecialistRole).to.equal("legion_verifier")
			expect(reviewReport.prioritizedCorrectiveTasks[1].recommendedSpecialistCodename).to.equal("SENTINEL-QA")
			expect(reviewReport.coordinatorFinalReportMarkdown).to.include("KEEPER-STATE")
			expect(reviewReport.coordinatorFinalReportMarkdown).to.include("SENTINEL-QA")

			// Spawn a Remedial Legion directly from the review report
			const remedialRes = await orchestrator.spawnRemediationLegionForReview(parent.id, reviewReport)
			expect(remedialRes.formed).to.equal(true)
			expect(remedialRes.manifest).to.not.equal(undefined)
			const spawnedRoles = remedialRes.manifest?.members.map((a) => a.assignment.role) ?? []
			expect(spawnedRoles).to.include("legion_data_steward")
			expect(spawnedRoles).to.include("legion_verifier")
		})

		it("normalizes reservation paths across multi-root hints, backslashes, and accumulates reservation warnings", async () => {
			const { normalizeReservationPath } = await import("../LegionCoordinator")
			const norm1 = normalizeReservationPath("@frontend:src/components/App.tsx")
			const norm2 = normalizeReservationPath("src/components/App.tsx")
			expect(norm1).to.equal(norm2)

			// Verify collision detection with accumulated warnings across multiple already-reserved files
			const parentStream = await orchestrator.createStream("Parent: Multi-File Reservation Collision")
			toggleAgentSwarmFeature(true, { legionEnabled: true })
			const otherStream = await orchestrator.createStream("Prior active stream")
			const path1 = normalizeReservationPath("src/a.ts")
			const path2 = normalizeReservationPath("src/b.ts")
			await dbPool.push({
				type: "insert",
				table: "agent_memory",
				values: { streamId: otherStream.id, key: `file_res:${path1}`, value: String(Date.now()), updatedAt: Date.now() },
				layer: "domain",
			})
			await dbPool.push({
				type: "insert",
				table: "agent_memory",
				values: { streamId: otherStream.id, key: `file_res:${path2}`, value: String(Date.now()), updatedAt: Date.now() },
				layer: "domain",
			})

			const formed = await orchestrator.formLegion(parentStream.id, {
				taskDescription: "Fix bugs in src/a.ts and src/b.ts and src/c.ts",
				targetFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
			})
			// Multi-root roots resolution
			const multiRoot = normalizeReservationPath("@frontend:src/components/App.tsx", process.cwd(), [
				{ name: "frontend", path: "/projects/frontend" },
			])
			expect(multiRoot).to.include("/projects/frontend/src/components/App.tsx")
			// Empty path check
			expect(normalizeReservationPath("")).to.equal("")
			expect(normalizeReservationPath("   ")).to.equal("")
			// Trailing slash normalization check
			expect(normalizeReservationPath("/workspace/project/")).to.equal(normalizeReservationPath("/workspace/project"))
			// Suffix boundary check: hint "frontend" must not match folder "myfrontend"
			const nonMatching = normalizeReservationPath("@frontend:src/index.ts", "/default/cwd", [
				{ name: "sub", path: "/projects/myfrontend" },
			])
			expect(nonMatching).to.not.include("/projects/myfrontend")

			// Verify failStream automatically triggers reroute and replacement accumulates reservation warning
			const failedMember = formed.manifest!.members[0]
			await orchestrator.failStream(failedMember.streamId, "Reroute test failure")
			const manifest = (await orchestrator.recallLastLegionFormation(parentStream.id))!
			const original = manifest.members.find((m) => m.streamId === failedMember.streamId)!
			expect(original.status).to.equal("rerouted")
			const replacement = manifest.members.find((m) => m.streamId === original.reroutedToStreamId)!
			expect(replacement).to.not.equal(undefined)
			if (replacement.reservationWarning) {
				expect(replacement.reservationWarning).to.include("already reserved by active stream")
			}
		})

		it("synchronizes Legion proto fields in updateSettings and updateTaskSettings with strategy validation and 1..8 specialist clamping", async () => {
			const { UpdateSettingsRequest } = await import("@/shared/proto/dietcode/state")
			const { updateSettings } = await import("@/core/controller/state/updateSettings")
			const { StateManager } = await import("@/core/storage/StateManager")

			const globalSettingsStore: Record<string, any> = {}
			const mockStateManager = {
				setGlobalState: (key: string, val: any) => {
					globalSettingsStore[key] = val
				},
				setGlobalStateBatch: (batch: Record<string, any>) => {
					Object.assign(globalSettingsStore, batch)
				},
				getGlobalSettingsKey: (key: string) => globalSettingsStore[key],
				getGlobalStateKey: (key: string) => globalSettingsStore[key],
			}

			const origGet = (StateManager as any).get
			;(StateManager as any).get = () => mockStateManager

			const mockController = {
				stateManager: mockStateManager,
				postStateToWebview: async () => {},
				task: undefined,
			} as any

			try {
				await updateSettings(
					mockController,
					UpdateSettingsRequest.create({
						agentSwarmLegionEnabled: true,
						agentSwarmLegionStrategy: "verification_heavy",
						agentSwarmLegionMaxSpecialists: 42, // Should clamp to 8
					}),
				)

				expect(globalSettingsStore.agentSwarmLegionEnabled).to.equal(true)
				expect(globalSettingsStore.agentSwarmLegionStrategy).to.equal("verification_heavy")
				expect(globalSettingsStore.agentSwarmLegionMaxSpecialists).to.equal(8)

				const resolved = getAgentSwarmConfig()
				expect(resolved.legionEnabled).to.equal(true)
				expect(resolved.legionStrategy).to.equal("verification_heavy")
				expect(resolved.legionMaxSpecialists).to.equal(8)

				// Invalid strategy is ignored cleanly
				await updateSettings(
					mockController,
					UpdateSettingsRequest.create({
						agentSwarmLegionStrategy: "invalid_strategy_xyz",
						agentSwarmLegionMaxSpecialists: 0, // Should clamp to 1
					}),
				)
				expect(globalSettingsStore.agentSwarmLegionStrategy).to.equal("verification_heavy")
				expect(globalSettingsStore.agentSwarmLegionMaxSpecialists).to.equal(1)
			} finally {
				;(StateManager as any).get = origGet
			}
		})
	})
	describe("8. Legion Lifecycle — Stage Barriers, Failover, Synthesis & Concurrency", () => {
		const ONLY_PIPELINE_ROLES = {
			preferredRoles: ["legion_architect", "legion_implementer", "legion_verifier"] as any[],
			excludeRoles: [
				"legion_hardener",
				"legion_ux_ergonomics",
				"legion_Trends_ux",
				"legion_researcher",
				"legion_data_steward",
			] as any[],
		}

		const formPipelineLegion = async (parentId: string, extra?: Record<string, unknown>) => {
			const res = await orchestrator.formLegion(parentId, {
				taskDescription: "Design the proto contract, implement the handler wiring, and verify with tests",
				strategy: "full_legion",
				maxSpecialists: 3,
				...ONLY_PIPELINE_ROLES,
				...(extra ?? {}),
			})
			expect(res.formed).to.equal(true)
			const manifest = res.manifest!
			const byRole = (role: string) => manifest.members.find((m) => m.assignment.role === role)!
			return {
				manifest,
				lead: byRole("legion_architect"),
				worker: byRole("legion_implementer"),
				verifier: byRole("legion_verifier"),
			}
		}

		const readJson = async (streamId: string, key: string) => {
			const raw = await orchestrator.recallMemory(streamId, key)
			return raw ? JSON.parse(raw) : null
		}

		beforeEach(() => {
			toggleAgentSwarmFeature(true, { legionEnabled: true, legionStrategy: "full_legion", legionMaxSpecialists: 3 })
		})

		it("gates stages as a DAG (lead -> parallel -> verification), hands lead context downstream, and synthesizes once finished", async () => {
			const parent = await orchestrator.createStream("Parent: staged delivery")
			const { lead, worker, verifier } = await formPipelineLegion(parent.id)

			const initial = (await orchestrator.getLegionStageProgression(parent.id))!
			expect(initial.currentActiveStage).to.equal("leadAndRecon")
			expect(initial.stages.leadAndRecon.status).to.equal("ready")
			expect(initial.stages.parallelExecution.status).to.equal("blocked_by_prior_stage")
			expect(initial.stages.verificationAndHardening.status).to.equal("blocked_by_prior_stage")
			expect(initial.readyToExecuteMembers.map((m) => m.streamId)).to.deep.equal([lead.streamId])

			await orchestrator.completeStream(lead.streamId, "Contract designed: add legion fields to state.proto")
			const afterLead = (await orchestrator.getLegionStageProgression(parent.id))!
			expect(afterLead.currentActiveStage).to.equal("parallelExecution")
			expect(afterLead.readyToExecuteMembers.map((m) => m.streamId)).to.deep.equal([worker.streamId])
			expect(afterLead.stages.verificationAndHardening.status).to.equal("blocked_by_prior_stage")

			const handoff = await readJson(worker.streamId, "legion_stage_handoff_context")
			expect(handoff.handoffSummary).to.include("Contract designed")

			await orchestrator.completeStream(worker.streamId, "Handler wired")
			const afterWorker = (await orchestrator.getLegionStageProgression(parent.id))!
			expect(afterWorker.readyToExecuteMembers.map((m) => m.streamId)).to.deep.equal([verifier.streamId])

			await orchestrator.completeStream(verifier.streamId, "All suites green")
			const finalProgress = (await orchestrator.getLegionStageProgression(parent.id))!
			expect(finalProgress.allStagesCompleted).to.equal(true)
			expect((await orchestrator.recallLastLegionFormation(parent.id))?.status).to.equal("completed")

			const report = await readJson(parent.id, "last_legion_synthesis_report")
			expect(report.overallStatus).to.equal("completed")
			expect(report.completedMembers).to.have.length(3)
			expect(report.synthesizedMarkdown).to.include("Contract designed")
			expect(report.synthesizedMarkdown).to.include("All suites green")

			const roadmap = await readJson(parent.id, "rolling_roadmap_snapshot")
			expect(roadmap.completedWork).to.have.length(3)
			expect(roadmap.nextActions[0]).to.include("synthesize")
		})

		it("does not offer running or deferred specialists for dispatch again", async () => {
			const parent = await orchestrator.createStream("Parent: dispatch ownership")
			const { manifest, lead } = await formPipelineLegion(parent.id)
			const member = manifest.members.find((m) => m.streamId === lead.streamId)!
			member.status = "running"
			let progress = legionCoordinator.evaluateStageProgression(manifest)
			expect(progress.stages.leadAndRecon.status).to.equal("in_progress")
			expect(progress.readyToExecuteMembers).to.have.length(0)
			member.status = "deferred"
			progress = legionCoordinator.evaluateStageProgression(manifest)
			expect(progress.readyToExecuteMembers).to.have.length(0)
			expect(progress.stages.parallelExecution.status).to.equal("blocked_by_prior_stage")
		})

		it("retains constraints beyond the first 280 characters in specialist assignments", async () => {
			const parent = await orchestrator.createStream("Parent: assignment context")
			const taskDescription = `${"Investigate the implementation and its dependencies. ".repeat(8)}Constraint: preserve existing user data.`
			const { manifest } = await formPipelineLegion(parent.id, { taskDescription })
			for (const member of manifest.members) {
				expect(member.assignment.focusObjective).to.include("Constraint: preserve existing user data.")
				expect(member.assignment.focusObjective).to.include("Your specialty:")
				const tasks = await orchestrator.getStreamTasks(member.streamId)
				expect(tasks[0].description).to.include("Constraint: preserve existing user data.")
			}
		})

		it("drives eligible specialists in stage order through a host and passes lead findings forward", async () => {
			const parent = await orchestrator.createStream("Parent: host execution")
			const { manifest, lead, worker, verifier } = await formPipelineLegion(parent.id)
			const seen: string[] = []
			const result = await runLegionPipeline(
				parent.id,
				manifest.formationId,
				{
					execute: async (member, context) => {
						seen.push(member.streamId)
						if (member.streamId === worker.streamId) expect(context.handoff.join(" ")).to.include("lead findings")
						if (member.streamId === verifier.streamId) expect(context.handoff.join(" ")).to.include("worker findings")
						return {
							status: "completed",
							summary: member.streamId === lead.streamId ? "lead findings" : "worker findings",
						}
					},
				},
				new AbortController().signal,
			)
			expect(seen).to.deep.equal([lead.streamId, worker.streamId, verifier.streamId])
			expect(result.status).to.equal("completed")
			expect(result.report?.completedMembers).to.have.length(3)
		})

		it("does not replay an unresolved running specialist", async () => {
			const parent = await orchestrator.createStream("Parent: recovery")
			const { manifest, lead } = await formPipelineLegion(parent.id)
			await legionCoordinator.reconcileSpecialistStreamLifecycle(lead.streamId, { status: "running" })
			let calls = 0
			const result = await runLegionPipeline(
				parent.id,
				manifest.formationId,
				{
					execute: async () => {
						calls++
						return { status: "completed", summary: "done" }
					},
				},
				new AbortController().signal,
			)
			expect(result.status).to.equal("needs_reconciliation")
			expect(calls).to.equal(0)
		})

		it("atomically claims only eligible pending members within the formation", async () => {
			const parent = await orchestrator.createStream("Parent: claim")
			const { lead, worker } = await formPipelineLegion(parent.id)
			expect(await legionCoordinator.claimReadySpecialist(worker.streamId)).to.equal(false)
			const claims = await Promise.all([
				legionCoordinator.claimReadySpecialist(lead.streamId),
				legionCoordinator.claimReadySpecialist(lead.streamId),
			])
			expect(claims.filter(Boolean)).to.have.length(1)
			expect((await orchestrator.getLegionStageProgression(parent.id))!.readyToExecuteMembers).to.have.length(0)
		})

		it("automatically forms and operates a team only when a permitted host is available", async () => {
			const parent = await orchestrator.createStream("Parent: automatic formation")
			const taskDescription =
				"Design the proto contract, implement handler wiring, harden concurrency, and verify with tests"
			let calls = 0
			const host = {
				execute: async () => {
					calls++
					return { status: "completed" as const, summary: "Specialist finished" }
				},
			}
			const base = { parentStreamId: parent.id, taskDescription, host, signal: new AbortController().signal }
			expect((await runAutomaticLegion({ ...base, delegationAllowed: false })).decision).to.equal("local")
			expect(await orchestrator.recallLastLegionFormation(parent.id)).to.equal(null)
			const result = await runAutomaticLegion({ ...base, delegationAllowed: true })
			expect(result.decision).to.equal("delegated")
			if (result.decision === "delegated") expect(result.pipeline.status).to.equal("completed")
			expect(calls).to.be.greaterThan(1)
			expect((await runAutomaticLegion({ ...base, delegationAllowed: true })).decision).to.equal("local")
		})

		it("forms a team and runs isolated provider conversations through the tool adapter", async () => {
			const parent = await orchestrator.createStream("Parent: integrated execution")
			const base = {
				cwd: process.cwd(),
				taskState: new TaskState(),
				callbacks: {},
				services: { dietcodeIgnoreController: { validateAccess: () => true } },
			} as unknown as TaskConfig
			const original = ToolExecutorCoordinator.prototype.execute
			let executed = 0
			ToolExecutorCoordinator.prototype.execute = async () => {
				executed++
				return "observed file"
			}
			try {
				const host = new LegionAgentHost({
					createApi: () => {
						let turn = 0
						return {
							createMessage: () => {
								const current = turn++
								return (async function* () {
									yield {
										type: "tool_calls",
										tool_call: {
											function:
												current === 0
													? { id: "read", name: "read_file", arguments: '{"path":"a.ts"}' }
													: {
															id: "done",
															name: "attempt_completion",
															arguments: '{"result":"Observed file"}',
														},
										},
									}
								})()
							},
						} as unknown as ApiHandler
					},
					createTools: async (_member, api) => createLegionToolAdapter(base, api, []),
				})
				const result = await runAutomaticLegion({
					parentStreamId: parent.id,
					taskDescription: "Design proto contract, implement handler and harden concurrency, then verify tests",
					delegationAllowed: true,
					host,
					signal: new AbortController().signal,
				})
				expect(result.decision).to.equal("delegated")
				if (result.decision === "delegated") expect(result.pipeline.status).to.equal("completed")
				expect(executed).to.be.greaterThan(1)
			} finally {
				ToolExecutorCoordinator.prototype.execute = original
			}
		})

		it("coalesces concurrent pipeline calls and never starts a second host execution", async () => {
			const parent = await orchestrator.createStream("Parent: concurrent schedulers")
			const { manifest } = await formPipelineLegion(parent.id)
			let release!: () => void
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			let calls = 0
			const controller = new AbortController()
			const host = {
				execute: async () => {
					calls++
					await gate
					return { status: "completed" as const, summary: "done" }
				},
			}
			const first = runLegionPipeline(parent.id, manifest.formationId, host, controller.signal)
			const second = runLegionPipeline(parent.id, manifest.formationId, host, controller.signal)
			expect(second).to.equal(first)
			// Cancel after the in-flight host call settles; no later stage should start.
			while (calls === 0) await new Promise((resolve) => setImmediate(resolve))
			controller.abort()
			release()
			expect((await first).status).to.equal("cancelled")
			expect(calls).to.equal(1)
		})

		it("does not create a replacement when a host stops due to cancellation", async () => {
			const parent = await orchestrator.createStream("Parent: cancellation")
			const { manifest } = await formPipelineLegion(parent.id)
			const controller = new AbortController()
			const result = await runLegionPipeline(
				parent.id,
				manifest.formationId,
				{
					execute: async () => {
						controller.abort()
						return { status: "failed", reason: "cancelled" }
					},
				},
				controller.signal,
			)
			expect(result.status).to.equal("cancelled")
			const after = (await orchestrator.recallLastLegionFormation(parent.id))!
			expect(after.members).to.have.length(manifest.members.length)
			expect(after.members.filter((member) => member.status === "failed")).to.have.length(1)
		})

		it("does not automatically replay a failed execution whose side effects are unknown", async () => {
			const parent = await orchestrator.createStream("Parent: uncertain effects")
			const { manifest } = await formPipelineLegion(parent.id)
			let calls = 0
			const result = await runLegionPipeline(
				parent.id,
				manifest.formationId,
				{
					execute: async () => {
						calls++
						return { status: "failed", reason: "connection lost after a write" }
					},
				},
				new AbortController().signal,
			)
			expect(result.status).to.equal("failed")
			expect(calls).to.equal(1)
			expect((await orchestrator.recallLastLegionFormation(parent.id))!.members).to.have.length(manifest.members.length)
		})

		it("leaves a specialist running when a command outcome is unresolved", async () => {
			const parent = await orchestrator.createStream("Parent: active command")
			const { manifest, lead } = await formPipelineLegion(parent.id)
			const result = await runLegionPipeline(
				parent.id,
				manifest.formationId,
				{
					execute: async () => ({ status: "unresolved", reason: "command-1 is still active" }),
				},
				new AbortController().signal,
			)
			expect(result.status).to.equal("needs_reconciliation")
			expect(result.detail).to.include("command-1")
			expect(
				(await orchestrator.recallLastLegionFormation(parent.id))!.members.find(
					(member) => member.streamId === lead.streamId,
				)?.status,
			).to.equal("running")
		})

		it("does not launch a specialist when its claim is not durable", async () => {
			const parent = await orchestrator.createStream("Parent: durability failure")
			const { manifest } = await formPipelineLegion(parent.id)
			legionCoordinator.isClaimDurable = async () => false
			let calls = 0
			const result = await runLegionPipeline(
				parent.id,
				manifest.formationId,
				{
					execute: async () => {
						calls++
						return { status: "completed", summary: "done" }
					},
				},
				new AbortController().signal,
			)
			expect(result.status).to.equal("needs_reconciliation")
			expect(calls).to.equal(0)
		})

		it("does not start a second driver for an owned formation", async () => {
			const parent = await orchestrator.createStream("Parent: owned formation")
			const { manifest } = await formPipelineLegion(parent.id)
			legionCoordinator.acquireFormationDispatchToken = async () => false
			let calls = 0
			const result = await runLegionPipeline(
				parent.id,
				manifest.formationId,
				{
					execute: async () => {
						calls++
						return { status: "completed", summary: "done" }
					},
				},
				new AbortController().signal,
			)
			expect(result.status).to.equal("needs_reconciliation")
			expect(calls).to.equal(0)
		})

		it("is idempotent: repeated terminal events never duplicate roadmap or manifest entries", async () => {
			const parent = await orchestrator.createStream("Parent: idempotency")
			const { lead } = await formPipelineLegion(parent.id)

			await orchestrator.completeStream(lead.streamId, "Done once")
			await orchestrator.completeStream(lead.streamId, "Done once")

			const roadmap = await readJson(parent.id, "rolling_roadmap_snapshot")
			expect(roadmap.completedWork.filter((w: string) => w.includes(lead.assignment.codename))).to.have.length(1)
		})

		it("fails over a crashed specialist exactly once, then escalates with an unresolved-failure report", async () => {
			const parent = await orchestrator.createStream("Parent: failover")
			const { lead, worker } = await formPipelineLegion(parent.id)
			await orchestrator.completeStream(lead.streamId, "Contract ready")

			await orchestrator.failStream(worker.streamId, "handler crashed")
			let manifest = (await orchestrator.recallLastLegionFormation(parent.id))!
			const original = manifest.members.find((m) => m.streamId === worker.streamId)!
			expect(original.status).to.equal("rerouted")
			expect(original.reroutedToStreamId).to.be.a("string")

			const replacement = manifest.members.find((m) => m.streamId === original.reroutedToStreamId)!
			expect(replacement.attempt).to.equal(2)
			expect(replacement.assignment.role).to.equal("legion_implementer")
			expect(replacement.stage).to.equal("parallelExecution")
			const replacementTasks = await orchestrator.getStreamTasks(replacement.streamId)
			expect(replacementTasks[0].description).to.include("Failover Recovery")

			// A repeated failure event must not spawn a second replacement
			const memberCountAfterFirstFailover = manifest.members.length
			await orchestrator.failStream(worker.streamId, "handler crashed")
			manifest = (await orchestrator.recallLastLegionFormation(parent.id))!
			expect(manifest.members).to.have.length(memberCountAfterFirstFailover)

			// Replacement fails too: failover budget is exhausted, so the formation reports an unresolved failure
			await orchestrator.failStream(replacement.streamId, "still crashing")
			manifest = (await orchestrator.recallLastLegionFormation(parent.id))!
			expect(manifest.members).to.have.length(memberCountAfterFirstFailover)
			expect(manifest.status).to.equal("partial_failure")

			const report = await readJson(parent.id, "last_legion_synthesis_report")
			expect(report.synthesizedMarkdown).to.include("Unresolved failure")
			const progress = (await orchestrator.getLegionStageProgression(parent.id))!
			expect(progress.hasFailures).to.equal(true)
			expect(progress.stages.verificationAndHardening.status).to.not.equal("ready")
		})

		it("never loses updates when sibling specialists settle concurrently", async () => {
			const parent = await orchestrator.createStream("Parent: concurrency")
			const res = await orchestrator.formLegion(parent.id, {
				taskDescription: "Implement handler wiring and harden the concurrency locks",
				strategy: "full_legion",
				maxSpecialists: 2,
				preferredRoles: ["legion_implementer", "legion_hardener"] as any[],
				excludeRoles: [
					"legion_architect",
					"legion_verifier",
					"legion_ux_ergonomics",
					"legion_Trends_ux",
					"legion_researcher",
					"legion_data_steward",
				] as any[],
			})
			const members = res.manifest!.members
			expect(members).to.have.length(2)

			await Promise.all(members.map((m, i) => orchestrator.completeStream(m.streamId, `Parallel result ${i}`)))

			const manifest = (await orchestrator.recallLastLegionFormation(parent.id))!
			expect(manifest.members.every((m) => m.status === "completed")).to.equal(true)
			expect(manifest.status).to.equal("completed")
			const roadmap = await readJson(parent.id, "rolling_roadmap_snapshot")
			expect(roadmap.completedWork).to.have.length(2)
		})

		it("skips automatic failover when Legion is disabled for the parent, leaving an explicit recoverable failure", async () => {
			setAgentSwarmConfigOverride(null)
			toggleAgentSwarmFeature(false)
			const parent = await orchestrator.createStream("Parent: manual-only legion")
			const res = await orchestrator.formLegion(parent.id, {
				taskDescription: "Implement handler wiring",
				forceEnable: true,
				maxSpecialists: 1,
			})
			expect(res.formed).to.equal(true)
			const member = res.manifest!.members[0]

			await orchestrator.failStream(member.streamId, "boom")
			const manifest = (await orchestrator.recallLastLegionFormation(parent.id))!
			expect(manifest.members).to.have.length(1)
			expect(manifest.members[0].status).to.equal("failed")

			// An explicit reroute still works and respects the attempt budget
			const rerouted = await orchestrator.rerouteFailedLegionSpecialist(parent.id, member.streamId)
			expect(rerouted.rerouted).to.equal(true)
			expect(rerouted.replacementMember?.attempt).to.equal(2)
		})

		it("refuses to reroute a specialist that has not failed", async () => {
			const parent = await orchestrator.createStream("Parent: reroute guard")
			const { worker } = await formPipelineLegion(parent.id)
			const res = await orchestrator.rerouteFailedLegionSpecialist(parent.id, worker.streamId)
			expect(res.rerouted).to.equal(false)
			expect(res.reason).to.include("not 'failed'")
		})

		it("flushes a full Legion lifecycle (form, stage hand-off, failover, synthesis) to real SQLite without FK errors", async () => {
			legionCoordinator.isClaimDurable = originalIsClaimDurable
			legionCoordinator.acquireDispatchToken = originalAcquireDispatchToken
			legionCoordinator.acquireFormationDispatchToken = originalAcquireFormationDispatchToken
			legionCoordinator.acquireAutomaticFormationToken = originalAcquireAutomaticFormationToken
			const target = dbPool as any
			for (const [k, fn] of Object.entries(originalDbMethods)) {
				target[k] = fn
			}
			const os = await import("node:os")
			const path = await import("node:path")
			const fs = await import("node:fs")
			const { setDbPath } = await import("../../db/Config")

			const tempDbFile = path.join(os.tmpdir(), `lumi-legion-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
			setDbPath(tempDbFile)

			try {
				const parent = await orchestrator.createStream("Real SQLite Legion Parent")
				await dbPool.flush()
				const { execFile } = await import("node:child_process")
				const { promisify } = await import("node:util")
				const workerPath = path.join(process.cwd(), "src/infrastructure/ai/__tests__/fixtures/legion-claim-worker.cjs")
				const runWorker = () =>
					promisify(execFile)(
						process.execPath,
						[
							"-r",
							"ts-node/register",
							"-r",
							"tsconfig-paths/register",
							"-r",
							"./src/test/requires.cjs",
							workerPath,
							tempDbFile,
						],
						{ env: { ...process.env, TS_NODE_PROJECT: "./tsconfig.unit-test.json" }, timeout: 20_000 },
					)
				const results = await Promise.all([runWorker(), runWorker()])
				const claims = results.map(({ stdout }) => {
					const line = stdout.split("\n").find((entry) => entry.startsWith("LEGION_RESULT:"))
					if (!line) throw new Error(`Missing worker result: ${stdout}`)
					return JSON.parse(line.slice("LEGION_RESULT:".length)) as {
						root: string
						claimed: boolean
						driver: boolean
						dispatch: boolean
					}
				})
				expect(claims[0].root).to.equal(claims[1].root)
				expect(claims.filter((claim) => claim.claimed)).to.have.length(1)
				expect(claims.filter((claim) => claim.driver)).to.have.length(1)
				expect(claims.filter((claim) => claim.dispatch)).to.have.length(1)
				const roots = await Promise.all([
					orchestrator.getOrCreateLegionTaskStream("same-task", "objective"),
					orchestrator.getOrCreateLegionTaskStream("same-task", "objective"),
				])
				expect(roots[0].id).to.equal(roots[1].id)
				const formations = await Promise.all([
					legionCoordinator.acquireAutomaticFormationToken(roots[0].id, "objective"),
					legionCoordinator.acquireAutomaticFormationToken(roots[1].id, "objective"),
				])
				expect(formations.filter(Boolean)).to.have.length(1)
				const { hasLegionFormationIntent } = await import("../LegionExecutionReceipt")
				expect(await hasLegionFormationIntent(roots[0].id)).to.equal(true)
				const { manifest: formed, lead, worker } = await formPipelineLegion(parent.id)
				await dbPool.flush()
				const { beginLegionOperation, finishLegionOperation, getLegionOperationEvidence } = await import(
					"../LegionExecutionReceipt"
				)
				const receipt = await beginLegionOperation(lead.streamId, "call-1", "write_to_file", {
					path: "src/a.ts",
					content: "sensitive content",
				})
				expect((await getLegionOperationEvidence([lead.streamId]))[0].status).to.equal("started")
				let duplicateRejected = false
				try {
					await beginLegionOperation(lead.streamId, "call-1", "write_to_file", {})
				} catch {
					duplicateRejected = true
				}
				expect(duplicateRejected).to.equal(true)
				await finishLegionOperation(lead.streamId, "call-1", receipt, "returned")
				await beginLegionOperation(lead.streamId, "call-2", "apply_patch", {
					input: "*** Update File: src/b.ts\nsecret patch contents",
				})
				const evidence = await getLegionOperationEvidence([lead.streamId])
				expect(evidence.map((entry) => entry.status)).to.have.members(["started", "returned"])
				expect(JSON.stringify(evidence)).to.include("src/b.ts").and.not.include("secret patch contents")
				const owners = await Promise.all([
					legionCoordinator.acquireFormationDispatchToken(parent.id, formed.formationId),
					legionCoordinator.acquireFormationDispatchToken(parent.id, formed.formationId),
				])
				expect(owners.filter(Boolean)).to.have.length(1)
				expect(await legionCoordinator.claimReadySpecialist(lead.streamId)).to.equal(true)
				await dbPool.flush()
				expect(await legionCoordinator.isClaimDurable(parent.id, formed.formationId, lead.streamId)).to.equal(true)
				const tokens = await Promise.all([
					legionCoordinator.acquireDispatchToken(lead.streamId),
					legionCoordinator.acquireDispatchToken(lead.streamId),
				])
				expect(tokens.filter(Boolean)).to.have.length(1)
				expect(await legionCoordinator.acquireDispatchToken(lead.streamId)).to.equal(false)

				await orchestrator.completeStream(lead.streamId, "Contract ready")
				await dbPool.flush()

				await orchestrator.failStream(worker.streamId, "handler crashed")
				await dbPool.flush()

				const manifest = (await orchestrator.recallLastLegionFormation(parent.id))!
				expect(manifest.members.some((m) => m.status === "rerouted")).to.equal(true)
				await dbPool.flush()
				setDbPath(":memory:")
				const { getPersistentDb } = await import("../../db/Config")
				let failure = ""
				try {
					await getPersistentDb()
				} catch (error) {
					failure = String(error)
				}
				expect(failure).to.include("Persistent SQLite storage is unavailable")
			} finally {
				await dbPool.stop()
				try {
					if (fs.existsSync(tempDbFile)) fs.unlinkSync(tempDbFile)
					if (fs.existsSync(`${tempDbFile}-wal`)) fs.unlinkSync(`${tempDbFile}-wal`)
					if (fs.existsSync(`${tempDbFile}-shm`)) fs.unlinkSync(`${tempDbFile}-shm`)
				} catch {
					// ignore cleanup errors
				}
			}
		})
	})
})
