# Data Model

All Agent Swarm state is stored in four existing tables via `BufferedDbPool` (`agent_streams`, `agent_tasks`, `agent_memory`, `agent_knowledge`). **No new tables, no migrations.**

## Tables used

| Table             | Columns used                                                                                                                                                                                             | Notes                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `agent_streams`   | `id`, `externalId`, `parentId`, `focus`, `status` (`active`/`completed`/`failed`), `sharedMemoryLayer`, `createdAt`                                                                                      | Parent of both other tables (FK) — must flush first                                  |
| `agent_tasks`     | `id`, `streamId`, `description`, `status`, `result`, `complexity`, `linkedKnowledgeIds`, `metadata` (JSON string), `createdAt`                                                                           | `subagent_type` is **not** a column — it lives in `metadata` (PM-002/PM-001 era bug) |
| `agent_memory`    | `streamId`, `key`, `value` (string/JSON), `updatedAt` — **PK `(streamId, key)`**                                                                                                                         | Upserts need `conflictTarget:["streamId","key"]`                                     |
| `agent_knowledge` | `id` (SHA-256), `userId`, `streamId`, `type` (`legion_workspace_heuristic`), `content`, `tags`, `embedding`, `confidence`, `hubScore`, `expiresAt`, `metadata` (JSON with `workspaceScope`), `createdAt` | Workspace-scoped heuristics with 30-day TTL; pruned via `pruneExpiredAgentKnowledge` |

## `agent_memory` keys

| Key                                                                         | Written on        | Shape                                                                                                                                                                              | Writer                          |
| --------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `defer_agent_status`                                                        | any stream        | `DeferredAgentStatus` (`state`, `boundary`, `pipelineId`, `sequenceNumber`, `checkpointId`, `inFlightOperation`, `pendingChildAckIds`, `acknowledgedChildIds`, `acceptingNewWork`) | Defer                           |
| `defer_control_inbox`                                                       | any stream        | `SwarmControlMessage[]` (≤200, de-duplicated by `messageId`)                                                                                                                       | Defer                           |
| `defer_checkpoint:<checkpointId>` / `defer_latest_checkpoint`               | stream            | `AgentDeferCheckpoint`                                                                                                                                                             | Defer                           |
| `task_deferred_lease:<taskId>`                                              | stream            | `{taskId, checkpointId, deferredAt, priorStatus}`                                                                                                                                  | Defer                           |
| `task_heartbeat:<taskId>`                                                   | stream            | epoch ms string                                                                                                                                                                    | Resume                          |
| `deferred_pipeline_status`                                                  | **root** stream   | `DeferredPipelineStatus`                                                                                                                                                           | Defer                           |
| `rolling_roadmap_snapshot`                                                  | parent/root       | `RollingRoadmapSnapshot`                                                                                                                                                           | Defer, Review, Legion           |
| `critical_review_cycle:<completionEventId>`                                 | reviewed stream   | `CriticalReviewCycleState`                                                                                                                                                         | Review                          |
| `last_critical_completion_review` / `critical_completion_review:<reviewId>` | reviewed stream   | `CriticalCompletionReviewReport`                                                                                                                                                   | Review                          |
| `legion_specialist_profile`                                                 | specialist stream | `{formationId, parentStreamId, assignment, stage, spawnedAt, reroutedFromStreamId?}`                                                                                               | Legion                          |
| `legion_stage_handoff_context`                                              | specialist stream | `{fromStage, handoffSummary, receivedAt}`                                                                                                                                          | Legion                          |
| `last_legion_formation` / `legion_formation:<formationId>`                  | **parent** stream | `LegionFormationManifest`                                                                                                                                                          | Legion                          |
| `last_legion_synthesis_report`                                              | parent stream     | `LegionSynthesisReport`                                                                                                                                                            | Legion                          |
| `legion_op_receipt:<callId>`                                                | specialist stream | `LegionOperationReceipt` (`callId`, `toolName`, `inputHash`, `startedAt`)                                                                                                          | LegionToolAdapter               |
| `legion_op_outcome:<callId>`                                                | specialist stream | `{receipt, outcome: "returned" \| "uncertain", settledAt}`                                                                                                                         | LegionToolAdapter               |
| `legion_dispatch_token:<formationId>:<memberStreamId>`                      | parent stream     | `{formationId, streamId, acquiredAt}`                                                                                                                                              | LegionCoordinator               |
| `legion_formation_intent:<parentStreamId>`                                  | parent stream     | `{parentStreamId, intendedAt}`                                                                                                                                                     | LegionExecutionReceipt          |
| `legion_formation_reservation:<parentStreamId>`                             | parent stream     | reservation token string                                                                                                                                                           | LegionCoordinator               |
| `file_res:<absolutePath>`                                                   | stream            | epoch ms string                                                                                                                                                                    | Orchestrator / Legion           |
| `stream_summary` / `failure_reason`                                         | stream            | **raw text** (not JSON-encoded)                                                                                                                                                    | `completeStream` / `failStream` |

> `stream_summary`/`failure_reason` are raw strings; everything else is `JSON.stringify`'d. Read raw ones with a tolerant reader (see `LegionCoordinator.recallRawText`) — treating them as JSON silently drops them.

## Key shapes (abridged)

```ts
type AgentDeferState = "running" | "defer_requested" | "suspending" | "waiting_for_children" | "deferred" | "resuming"
type PipelineSuspensionPhase = "active" | "suspending" | "waiting_for_children" | "suspended" | "resuming" | "resumed"

interface LegionFormationManifest {
	formationId: string
	parentStreamId: string
	objective: string
	classification: LegionClassificationResult
	members: SpawnedLegionMember[] // status: pending|running|deferred|completed|failed|rerouted
	status: "active" | "deferred" | "completed" | "partial_failure"
	stageProgression?: LegionStageProgressionStatus
}

// Conductor Tool (`engage_swarm`) Inputs & Outputs
interface EngageSwarmParams {
	objective: string // Required
	strategy?: LegionFormationStrategy // "adaptive" | "tactical_strike" | "balanced_squad" | "full_legion" | "verification_heavy"
	preferred_roles?: string | string[] // Comma-separated or array of LegionSpecialistRole
	max_specialists?: number // Clamped 1..8
}

// Streaming Progress Event (`formatLegionProgressMessage`)
interface LegionProgressEvent {
	stage: string
	member?: SpawnedLegionMember
	status:
		| "stage_started"
		| "member_started"
		| "member_completed"
		| "member_failed"
		| "member_rerouted"
		| "formation_completed"
		| "formation_failed"
	detail?: string
}

// Specialist Execution Outcome with Categorized Failover
type LegionExecutionResult =
	| { status: "completed"; summary: string }
	| { status: "failed"; reason: string; safeToRetry?: boolean }
	| { status: "unresolved"; reason: string }

// Fallback Specialist Completion Spec (`attempt_completion`)
interface FallbackAttemptCompletionParams {
	result: string // Required specialist result and handoff summary
}

// Streaming Parser & Tool Argument Error Models (ADR-0014, StreamResponseHandler.ts)
type ToolArgumentErrorKind = "incomplete" | "concatenation" | "syntax" | "invalid_format"

interface ExtractedJsonRoot {
	value: unknown
	startIndex: number
	endIndex: number
	raw: string
}

interface ExtractedJsonResult {
	roots: ExtractedJsonRoot[]
	remainder: string
}

// Terminal Heredoc Policy & Prompt Parity Models (ADR-0015, heredocPolicy.ts & LegionAgentHost.ts)
interface HeredocRedirectionDetection {
	isHeredocFileWrite: boolean
	targetFiles: string[]
	reason?: string
}

interface TopLevelHeredoc {
	delimiter: string
	index: number
	statementStart: number
}

// LEGION_CORE_RULES: Core instruction prompt injected into LegionAgentHost system prompts
// establishing 1:1 parity with conductor rules (mandating write_to_file, forbidding multiline heredocs)
```

`SpawnedLegionMember` carries `stage`, `attempt` (1-based), `reroutedToStreamId`, `resultSummary`, `failureReason`, `completedAt`.

## Where the database lives

`<storageUri or globalStorageUri>/joyzoning.sqlite` — set in `Controller` (`src/core/controller/index.ts`, `setDbPath`), WAL mode, `PRAGMA foreign_keys = ON`. If `setDbPath` was never called the fallback is `<process cwd>/dietcode.db` (tests/dev only). A database that opens as corrupt is **renamed** to `<path>.corrupt.<timestamp>` (+ `-wal`/`-shm`) and a fresh one is created, so swarm state is lost in that event (the old file is kept for forensics).

## Buffering facts maintainers must know

| Fact               | Detail                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flush cadence      | `BufferedDbPool` flushes on a 1 s timer; `await dbPool.flush()` forces it                                                                          |
| Flush order        | `TABLE_FK_ORDER` first, then layer priority                                                                                                        |
| Shadow overlays    | `push(op, agentId)` → private to that id until `commitWork(agentId)`; idle overlays are **deleted after 5 minutes** (`cleanupShadows`, every 30 s) |
| Overlay visibility | Only reads that pass the same `agentId` (e.g. `selectOne(table, where, agentId)`) see overlay writes                                               |

## Write-path rules

1. `agent_memory` upsert ⇒ `conflictTarget: ["streamId","key"]` **and** `where` on both columns **and** `layer: "infrastructure"`.
2. Rows other streams must read ⇒ `push(op)` **without** an agent id.
3. **Never write with agent id `x` after `commitWork(x)`** — the write can never commit (PM-011).
4. Flush order is enforced by `TABLE_FK_ORDER` in `BufferedDbPool.flush()` (`agent_streams` → `agent_tasks` → `agent_memory` → `agent_knowledge`).
5. In-memory `selectWhere` for upserts matches on `conflictTarget` columns when `where` is absent (prevents duplicate buffered rows).
6. **Flush before direct persistent SQLite queries**: Any query bypassing `dbPool` via `getPersistentDb()` to inspect foreign keys or durable manifests must call `await dbPool.flush()` first.

See [ADR-0003](../adr/ADR-0003-durable-state-in-agent-memory.md), [ADR-0010](../adr/ADR-0010-direct-writes-for-shared-rows.md), [PB-06](../playbooks/PB-06-triage-sqlite-flush-errors.md).
