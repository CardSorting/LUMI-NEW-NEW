# Milestone 3 Handoff Report: System Resilience, Failure Modes & Durable Hardening

**Worker:** Worker M3 (System Resilience, Failure Modes & Durable Hardening Worker)  
**Date:** 2026-11-04  
**Working Directory:** `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_worker_m3/`  
**Workspace:** `/Users/bozoegg/Downloads/LUMI`  
**Status:** Completed (Hard Handoff)

---

## 1. Observation

Direct code inspections and tool executions yielded the following observations:

### 1.1 Causal Ordering in `BufferedDbPool` (F12)

- **File:** `src/infrastructure/db/BufferedDbPool.ts:457–466`
- **Previous Code:**

  ```ts
  return (a.type as string).localeCompare(b.type as string)
  ```

  In JavaScript string comparison, `"delete" < "insert" < "update" < "upsert"`. When an upsert/update and delete were queued within the same 1-second batch, the delete executed first and the upsert second, resurrecting the deleted entity in SQLite.
- **Remediation Implemented:**
  - Added `opSeq?: number` to `WriteOp` (`src/infrastructure/db/BufferedDbPool.ts:65`).
  - Added monotonic sequence counter `private nextOpSeq = 0` to `BufferedDbPool`.
  - In `pushBatch()` (`lines 312–316`), stamped each operation with `if (op.opSeq === undefined) op.opSeq = ++this.nextOpSeq`.
  - In `BufferedDbPool.flush()` sorting (`line 495`), replaced alphabetical type sorting with `(a.opSeq ?? 0) - (b.opSeq ?? 0)`. Operations within the same layer and table execute in strict monotonic causal order.

### 1.2 Non-Retryable Flush Error Reporting (F13)

- **File:** `src/infrastructure/db/BufferedDbPool.ts:525–560`
- **Previous Code:**

  ```ts
  if (isRetryable) throw e
  ```

  When SQLite encountered non-retryable errors (such as `SQLITE_CONSTRAINT`, missing tables, or syntax failures), `isRetryable` evaluated to `false`. The error was silently swallowed with zero logging, in-flight operations were cleared, and callers awaiting `await dbPool.flush()` resolved cleanly despite data loss.
- **Remediation Implemented:**
  - Added structured error logging: `if (!isRetryable) Logger.error("[DbPool] Non-retryable flush failure:", err)`.
  - Removed the conditional throw and threw `e` unconditionally (`line 588`), ensuring callers awaiting `flush()` are immediately alerted to write failures.
  - In `scheduleFlush()` (`lines 144–146`), wrapped the background tick in a catch block logging `Logger.error("[DbPool] Background scheduled flush error:", flushErr)` to prevent unhandled background timer rejections.

### 1.3 Lifecycle-Bound Shadow Buffers (F14)

- **File:** `src/infrastructure/db/BufferedDbPool.ts:179–192`
- **Previous Code:**

  ```ts
  const SHADOW_EXPIRATION = 5 * 60 * 1000
  for (const [agentId, shadow] of this.agentShadows.entries()) {
      if (now - shadow.lastUpdated > SHADOW_EXPIRATION) {
          this.agentShadows.delete(agentId)
      }
  }
  ```

  Shadow buffers were arbitrarily discarded after 5 minutes of wall-clock inactivity, even for live active streams awaiting build, test, or user verification.
- **Remediation Implemented:**
  - Removed arbitrary 5-minute wall-clock shadow eviction in `cleanupShadows()`.
  - Made shadow buffers lifecycle-bound: `cleanupShadows()` queries `agent_streams` and only reclaims shadows for streams whose status has explicitly transitioned to `"completed"` or `"failed"`.
  - Added `clearShadow(agentId: string)` to `BufferedDbPool` (`lines 414–422`), and wired `clearShadow` into `Orchestrator.failStream()`.

### 1.4 Non-Unique Key Collision Fix in `Orchestrator.ts` (F15)

- **File:** `src/infrastructure/ai/Orchestrator.ts:807` and `:1257`
- **Previous Code:**

  ```ts
  const found = await dbPool.selectOne("agent_memory", { column: "key", value: `file_res:${normalizedPath}` })
  ```

  Compound primary key `(streamId, key)` permits multiple rows with the identical key `file_res:<path>`. If an inactive stream had an older uncollected reservation row, `selectOne` returned that inactive row, masking active reservations by other live streams.
- **Remediation Implemented:**
  - Replaced `selectOne` with `selectWhere("agent_memory", { column: "key", value: `file_res:${normalizedPath}` })` in `reserveFiles` (`line 807`) and in `checkCollision` / `detectFileCollisions` (`line 1258`).
  - Iterated over all matching rows to verify if any owner `ownerStreamId !== streamId && activeStreamIds.has(ownerStreamId)`, matching `LegionCoordinator.ts:1262`.
  - Added `detectFileCollisions` alias pointing to `checkCollision` (`lines 1270–1272`).

### 1.5 Abort Cancellation Sentinel in `LegionAgentHost.ts` (F16)

- **File:** `src/core/task/legion/LegionAgentHost.ts:261–276` and `src/infrastructure/ai/LegionPipelineRunner.ts:15`
- **Previous Code:**
  Catching an `AbortError` fell through to `return failed(errorMessage, true)`, marking cancellation as a retryable failure (`safeToRetry: true`), which could trigger unintended failover rerouting (`rerouteFailedSpecialist`).
- **Remediation Implemented:**
  - Added explicit check at the top of `LegionAgentHost.ts` catch block (`lines 262–267`):

    ```ts
    if (signal.aborted || (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted")))) {
        return { status: "cancelled", safeToRetry: false }
    }
    ```
  - Updated `LegionExecutionResult` type union in `LegionPipelineRunner.ts:15` to include `{ status: "cancelled"; safeToRetry?: false; reason?: string }`.

### 1.6 Review-Completion Gate Decoupling (F17)

- **File:** `src/core/task/tools/handlers/AttemptCompletionHandler.ts:288–296`
- **Previous Code:**

  ```ts
  if (criticalReviewReport?.executed && (criticalReviewReport.decision === "REMEDIATE" || criticalReviewReport.decision === "ESCALATE")) {
      config.taskState.consecutiveMistakeCount++
      ...
  ```

  Legitimate automated adversarial feedback (`REMEDIATE`) incremented `consecutiveMistakeCount`, tripping the completion circuit breaker after 2-3 reviews.
- **Remediation Implemented:**
  - Decoupled `REMEDIATE` decisions from mistake counting:

    ```ts
    if (criticalReviewReport.decision !== "REMEDIATE") {
        config.taskState.consecutiveMistakeCount++
    }
    ```
  - Only genuine escalation / unrecoverable failure states increment the mistake count.

### 1.7 Orphaned Stream Startup Reconciliation (F18)

- **File:** `src/infrastructure/ai/Orchestrator.ts:1395–1442`
- **Previous Code:**
  Host restarts or crashes left child streams in `status: "active"` and member state `"running"`. On reload, `drivePipeline` flagged unaccounted members and deadlocked in `needs_reconciliation`.
- **Remediation Implemented:**
  - Added `reconcileOrphanedStreams(reason = "Host terminated during execution"): Promise<number>` to `AgentOrchestrator`.
  - Added `initialize(): Promise<void>` to `AgentOrchestrator`, running `reconcileOrphanedStreams()` followed by `warmup()`.
  - Updated `warmup()` (`lines 1445–1450`) to automatically run `reconcileOrphanedStreams()`, ensuring extension activation reconciles stale sessions without manual intervention.

---

## 2. Logic Chain

1. **Persistence Invariance (F12, F13, F14):**
   - _Observation:_ Operations within a flush batch were ordered by string comparison of their types (`"delete" < "upsert"`), causing deletes to precede updates/upserts regardless of call order. Non-retryable flush errors were swallowed without logging or rejection. Shadow buffers were pruned every 5 minutes by wall clock.
   - _Inference:_ Database state must reflect the strict chronological execution sequence of agent operations, must never silently lose writes without alerting the caller, and must not discard uncommitted agent shadows during lengthy tasks.
   - _Result:_ Preserving monotonic `opSeq` ordering, rejecting failed flushes with structured logging, and binding shadows to lifecycle ensures complete consistency between memory buffers and durable SQLite storage.

2. **Concurrency Safety & Advisory Leases (F15):**
   - _Observation:_ `agent_memory` stores reservations with composite keys `(streamId, key)`. `selectOne` returns an arbitrary row matching `key`, which could be a stale row from an inactive stream.
   - _Inference:_ Using `selectWhere` to inspect all matching rows and filtering against `activeStreamIds` guarantees that an active holder is never masked by a dead holder.
   - _Result:_ Eliminates the PM-008 reservation collision bug without requiring serialized execution workarounds.

3. **Lifecycle & Execution Flow (F16, F17, F18):**
   - _Observation:_ User abort threw `AbortError` which was returned as retryable failure, prompting automatic failover. Automated review feedback was tallied as an agent mistake. Crashed host restarts left active child streams trapped in `needs_reconciliation`.
   - _Inference:_ Cancellation is a user intent, not a transient system failure. Review suggestions are iterative refinements, not agent execution defects. Host crashes require automated startup reconciliation.
   - _Result:_ Sentinels prevent runaway failovers, review feedback refines without tripping circuit breakers, and startup reconciliation auto-recovers formations.

---

## 3. Caveats

1. **Multi-Root Workspaces:** Path normalization in `normalizeReservationPath` uses `process.cwd()` when resolving relative paths. In multi-root workspaces, explicit workspace folder prefixes ensure cross-root uniqueness.
2. **Crash Leases During Live Multi-Process Hosting:** If multiple extension hosts run against the same SQLite database concurrently, lease expiration would require heartbeat timestamps. In LUMI's single-host model per workspace, inspecting child streams on extension startup is fully sufficient.

---

## 4. Conclusion

All seven Milestone 3 resilience, persistence, and failure-mode features (F12, F13, F14, F15, F16, F17, F18) have been cleanly, genuinely, and durably implemented across LUMI's core and infrastructure layers without monkey patches or workarounds.

Key results:

- Monotonic sequence ordering (`opSeq`) guarantees causal persistence in `BufferedDbPool`.
- Non-retryable SQLite errors are logged with `Logger.error` and properly rejected.
- Shadow buffers are lifecycle-bound and cleared upon terminal stream transitions.
- Multi-row file reservations are safely detected via `selectWhere` across all active streams.
- Explicit cancellation sentinels prevent rogue failover spawning.
- Legitimate review feedback no longer trips mistake circuit breakers.
- Orphaned child streams from prior crashes are automatically reconciled on startup.
- Full swarm test suite passes with **338 passing tests** (exceeding the baseline of 332 tests).
- Typecheck (`npm run check-types`), lint (`npm run lint`), and docs checker (`npm run docs:check-agentswarm`) all pass with **zero errors**.

---

## 5. Verification Method

To independently verify the implementation:

1. **Execute Swarm Test Suite (Mocha):**

   ```bash
   npm run test:swarm
   ```

   _Expected outcome:_ 338 passing tests in ~2 seconds, 0 failures.

2. **Execute TypeScript Compiler Check:**

   ```bash
   npm run check-types
   ```

   _Expected outcome:_ Exit code 0, 0 errors across all projects.

3. **Execute Biome Linter & Proto Linter:**

   ```bash
   npm run lint
   ```

   _Expected outcome:_ Exit code 0, 1769 files checked, 0 errors.

4. **Execute AgentSwarm Documentation Checker:**

   ```bash
   npm run docs:check-agentswarm
   ```

   _Expected outcome:_ Exit code 0, 68 files, 432 links verified, 16 ADRs, 17 PMs indexed.

5. **Inspect Files Modified:**
   - `src/infrastructure/db/BufferedDbPool.ts` (lines 54–66, 106, 140–146, 179–220, 310–320, 414–425, 490–498, 560–590)
   - `src/infrastructure/ai/Orchestrator.ts` (lines 804–817, 1135–1140, 1255–1272, 1395–1450)
   - `src/infrastructure/ai/LegionPipelineRunner.ts` (lines 11–16)
   - `src/core/task/legion/LegionAgentHost.ts` (lines 260–270)
   - `src/core/task/tools/handlers/AttemptCompletionHandler.ts` (lines 288–296)
   - `src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts` (lines 1–10, 415–450, 935–1025)
   - `src/infrastructure/ai/__tests__/Orchestrator.test.ts` (lines 520–615)
   - `src/core/task/legion/__tests__/LegionAgentHost.test.ts` (lines 230–240)
