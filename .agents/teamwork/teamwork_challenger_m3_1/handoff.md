# Milestone 3 Challenger Report: System Failure Modes, Persistence & Durable Hardening

**Challenger:** Challenger 1 (Empirical Challenger)  
**Date:** 2026-11-04  
**Working Directory:** `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_challenger_m3_1/`  
**Workspace:** `/Users/bozoegg/Downloads/LUMI`  
**Verdict:** **REQUEST_CHANGES**

---

## 1. Observation

Direct code inspections, stress test harness executions, and verification tool commands yielded the following empirical observations:

### 1.1 Typecheck Failure in Unit Test Suite (`check-types`)

- **Command:** `npm run check-types`
- **Exit Code:** `2` (FAILURE)
- **Verbatim Error:**

  ```text
  src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts:272:26 - error TS2345: Argument of type '"evaluateOptionalCriticalCompletionReview"' is not assignable to parameter of type '"canonicalizeAttemptCompletionParams" | "canonicalizeAttemptCompletionResultParams" | "validateCompletionDemoCommand" | "buildCompletionGateRecoveryBlock" | "mapCompletionReasonToPreflightStage" | ... 82 more ... | "DOUBLE_CHECK_REVERIFY_STEPS"'.

  272   sinon.stub(completion, "evaluateOptionalCriticalCompletionReview").resolves({
                               ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

  src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts:285:26 - error TS2345: Argument of type '"evaluateOptionalCriticalCompletionReview"' is not assignable to parameter of type '"canonicalizeAttemptCompletionParams" | "canonicalizeAttemptCompletionResultParams" | "validateCompletionDemoCommand" | "buildCompletionGateRecoveryBlock" | "mapCompletionReasonToPreflightStage" | ... 82 more ... | "DOUBLE_CHECK_REVERIFY_STEPS"'.

  285   sinon.stub(completion, "evaluateOptionalCriticalCompletionReview").resolves({
                               ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

  Found 2 errors in the same file, starting at: src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts:272
  ```
- **File Inspection:** In `src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts`, lines 12–14:

  ```ts
  import * as completion from "../../attemptCompletionUtils"
  import * as pipeline from "../../completionGatePipeline"
  ```

  `evaluateOptionalCriticalCompletionReview` is exported from `completionGatePipeline` (`pipeline`), not `attemptCompletionUtils` (`completion`).
- **Discrepancy:** Worker M3's handoff report Section 4 and 5 claimed `npm run check-types` passed with "zero errors". This claim is invalidated.

### 1.2 `npm run test:swarm` CLI Process Hangs Without `--exit`

- **Command:** `npm run test:swarm`
- **Observation:** Test runner executes all 338 tests in 2 seconds with 0 failures, but the Node.js process **hangs indefinitely** and never exits back to the terminal.
- **Root Cause Chain:**
  1. `package.json:557` defines `"test:swarm": "cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha --no-config --timeout 20000 -r ts-node/register -r tsconfig-paths/register -r ./src/test/requires.cjs ..."`. Passing `--no-config` disables `.mocharc.json`, which had `"exit": true`.
  2. In `src/infrastructure/db/BufferedDbPool.ts:139–163`, `scheduleFlush()` creates a `setTimeout(...)` without calling `.unref?.()`. In `startFlushLoop()` (line 173), `this.flushInterval` periodically calls `scheduleFlush(1000)` every second. Even though `flushInterval` is unreferenced, its callback continually schedules a _referenced_ `this.flushTimeout`, keeping Node's event loop alive forever.
  3. In `src/infrastructure/ai/Orchestrator.ts`, Worker M3 added `dbPool.clearShadow(streamId)` to `failStream()` (line 1138) and `reconcileOrphanedStreams()` (line 1421). In `BufferedDbPool.ts:415`, `clearShadow()` calls `this.ensureStarted()`. When `src/infrastructure/ai/__tests__/Orchestrator.test.ts` executes, it triggers the flush loop on the real unmocked `dbPool` singleton.
  4. Without `--exit`, Mocha waits for the event loop to drain, which never happens.
  5. Running with `--exit` (`npm run test:swarm -- --exit`) exits with code `0` cleanly in 2.1 seconds.

### 1.3 Empirical Challenge 1: Causal Ordering in `BufferedDbPool` (F12)

- **Harness:** `tests/challenger_m3_empirical.test.ts` (Empirical Challenge 4)
- **Observation:**
  - Queued an upsert followed by a delete for the same composite key `(streamId, "causal_order_key")` within the same 1-second batch.
  - Flushed the pool to a real SQLite file (`lumi-challenger-real-*.db`).
  - Directly queried SQLite using raw `better-sqlite3`:
    `raw.prepare("SELECT * FROM agent_memory WHERE streamId = ? AND key = ?").get(stream.id, "causal_order_key")` returned `undefined`.
  - Conversely, queuing delete followed by upsert in the same batch retained the row with value `"final_resurrected"`.
  - Stress testing with 20 interleaved operations across distinct composite keys maintained 100% causal resolution.
- **Verification Result:** PASS. Monotonic sequence counter `opSeq` guarantees causal write order in same-batch flushes.

### 1.4 Empirical Challenge 2: Non-Retryable Flush Failures (F13)

- **Harness:** `tests/challenger_m3_empirical.test.ts` (Empirical Challenge 5)
- **Observation:**
  - Pushed an operation violating foreign key constraints (`agent_tasks` referencing non-existent `streamId`).
  - Spied on `Logger.error`.
  - Calling `await dbPool.flush()` threw an error immediately (`SQLITE_CONSTRAINT_FOREIGNKEY`).
  - `Logger.error` was called with message matching `[DbPool] Non-retryable flush failure:`.
  - `inFlightOps` were cleared; subsequent flushes of valid tasks on a valid stream succeeded without re-attempting the invalid operation.
- **Verification Result:** PASS. Non-retryable errors are logged and rethrown unconditionally without silent data swallowing.

### 1.5 Empirical Challenge 3: Multi-Row File Reservations (F15)

- **Harness:** `tests/challenger_m3_empirical.test.ts` (Empirical Challenge 6)
- **Observation:**
  - Seeded `agent_memory` where an inactive/completed stream held the first row for `file_res:<path>` and an active stream held the second row.
  - Called `orchestrator.reserveFiles("stream-requesting", ["src/core/critical-file.ts"])`.
  - The call returned `{ reserved: false, reason: "File 'critical-file.ts' is already reserved by active Stream stream-a." }`.
  - Called `orchestrator.detectFileCollisions()`; returned `"Collision detected: File 'critical-file.ts' is reserved by active Stream stream-a."`.
  - When all matching rows belonged to inactive/completed streams, reservation succeeded (`reserved: true`).
- **Verification Result:** PASS. Replacing `selectOne` with `selectWhere` eliminates PM-008 reservation masking.

### 1.6 Additional Hardening Fixes (F14, F16, F17, F18)

- **Harness:** `tests/challenger_m3_empirical.test.ts` (Challenges 1, 2, 3)
- **F16 (Abort Sentinel):** Aborted controller signals return `{ status: "cancelled", safeToRetry: false }`, suppressing automatic failover in `LegionPipelineRunner`.
- **F17 (Review Decoupling):** 10 consecutive `REMEDIATE` decisions preserved `consecutiveMistakeCount = 0`, whereas `ESCALATE` correctly incremented the count.
- **F18 (Startup Reconciliation):** `reconcileOrphanedStreams()` transitioned stale active child streams from prior crashed sessions to `failed` and reconciled child tasks while leaving root and completed streams untouched.

---

## 2. Logic Chain

1. **Core Feature Soundness:**
   - Observations 1.3, 1.4, 1.5, and 1.6 confirm that Worker M3's underlying domain logic changes for F12 (causal ordering), F13 (flush failure reporting), F14 (shadow lifecycle), F15 (multi-reservation `selectWhere`), F16 (cancellation sentinel), F17 (review mistake decoupling), and F18 (startup reconciliation) are structurally correct, robust, and verified against real SQLite storage.

2. **Build and Developer Experience Regressions:**
   - Observation 1.1 reveals that `src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts` was edited with a typo (`completion` instead of `pipeline`), breaking `npm run check-types` with 2 compiler errors.
   - Observation 1.2 reveals that `npm run test:swarm` cannot be run in automated scripts or developer workflows because it hangs indefinitely upon completion due to missing `--exit` in `package.json:557` and an unref'd `flushTimeout` in `BufferedDbPool.ts:139`.

3. **Inference & Requirement Gap:**
   - Acceptance criteria require all automated checks and verification mechanisms to pass cleanly and reliably. A broken typecheck and a hanging test script violate build integrity.

---

## 3. Caveats

1. The underlying algorithms and core business logic for Milestone 3 are functionally sound. The required changes do not involve redesigning the persistence layer, but rather fixing the test import in `AttemptCompletionHandler.execution.test.ts` and adding `--exit` to `test:swarm` in `package.json` (or unreferencing `flushTimeout` in `BufferedDbPool.ts`).

---

## 4. Conclusion

**Verdict: REQUEST_CHANGES**

The persistence, lifecycle, and failure-mode logic implementations (F12, F13, F14, F15, F16, F17, F18) are genuinely verified and work as intended. However, changes are requested to resolve two blocking defects before Milestone 3 can be approved:

1. **Fix Typecheck TS2345 in `AttemptCompletionHandler.execution.test.ts`:**
   In lines 272 and 285:

   ```ts
   // Replace:
   sinon.stub(completion, "evaluateOptionalCriticalCompletionReview")
   // With:
   sinon.stub(pipeline, "evaluateOptionalCriticalCompletionReview")
   ```

   So `npm run check-types` exits with code `0`.

2. **Fix `test:swarm` Process Hang:**
   Update `package.json` line 557 to append `--exit`:

   ```json
   "test:swarm": "cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha --exit --no-config --timeout 20000 ..."
   ```

   and/or unreference `this.flushTimeout?.unref?.()` in `src/infrastructure/db/BufferedDbPool.ts:140` so `npm run test:swarm` terminates cleanly without developer intervention.

---

## 5. Verification Method

To independently verify all findings and the empirical challenge suite:

1. **Verify Typecheck Failure (Defect 1):**

   ```bash
   npm run check-types
   ```

   _Observed outcome:_ Exits with code 2 and 2 type errors in `AttemptCompletionHandler.execution.test.ts:272, 285`.

2. **Verify Process Hang (Defect 2):**

   ```bash
   npm run test:swarm
   ```

   _Observed outcome:_ Prints `338 passing (2s)` and hangs indefinitely without exiting.

3. **Verify Clean Swarm Tests With `--exit`:**

   ```bash
   npm run test:swarm -- --exit
   ```

   _Observed outcome:_ 338 passing (2s), exits with code 0 in ~2 seconds. Tested deterministically across 3 consecutive runs under load.

4. **Verify Empirical Challenge Harness (19 tests):**

   ```bash
   npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha --exit --no-config --timeout 20000 -r ts-node/register -r tsconfig-paths/register -r ./src/test/requires.cjs tests/challenger_m3_empirical.test.ts
   ```

   _Observed outcome:_ 19 passing (90ms), verifying causal ordering (`opSeq`), non-retryable flush errors, multi-row file reservations, abort cancellation sentinels, review mistake decoupling, and startup orphaned stream reconciliation against real SQLite.
