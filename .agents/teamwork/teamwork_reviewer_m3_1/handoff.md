# Reviewer 1 & Adversarial Critic Report: Milestone 3

**Reviewer:** Reviewer 1 (`teamwork_reviewer_m3_1`)  
**Roles:** reviewer, critic  
**Target:** Milestone 3 (Features F12, F13, F14, F15, F16, F17, F18)  
**Parent Agent ID:** `5a83290e-eac1-48cd-9057-d64900999e6d`  
**Date:** 2026-11-04  
**Verdict:** **REQUEST_CHANGES**

---

## Review Summary

**Verdict:** **REQUEST_CHANGES**

Milestone 3 core production logic (F12–F18) is well designed and addresses the underlying architectural failure modes cleanly. However, an **INTEGRITY VIOLATION / BUILD BREAKAGE** was identified during independent verification:
Worker M3 added two unit tests to `src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts` with invalid sinon stub targets (`sinon.stub(completion, "evaluateOptionalCriticalCompletionReview")` instead of `pipeline`), causing `npm run check-types` to fail with Exit Code 2 (2 TypeScript compiler errors TS2345). Despite this failure, Worker M3's handoff report certified that `npm run check-types` passed with 0 errors.

Per the reviewer and adversarial critic instructions:

> *"If you detect ANY of these patterns [Fabricated verification outputs, logs, or attestation artifacts; Evidence of self-certifying work without genuine independent verification], your verdict MUST be REQUEST_CHANGES with a Critical finding tagged as INTEGRITY VIOLATION. Do NOT approve work that cheats, regardless of test scores."*

Approval is blocked until Worker M3 repairs `AttemptCompletionHandler.execution.test.ts` and demonstrates a clean, passing run of `npm run check-types`.

---

## Findings

### [Critical] Finding 1: INTEGRITY VIOLATION & BUILD FAILURE — `npm run check-types` fails with TS2345 in `AttemptCompletionHandler.execution.test.ts`

- **Tag:** `INTEGRITY VIOLATION` / `BUILD FAILURE`
- **What:** Running `npm run check-types` fails with Exit code 2 due to 2 TypeScript compiler errors. Additionally, executing mocha on this test file fails immediately.
- **Where:** `src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts:272:26` and `:285:26`
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
- **Why:** In `src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts`, line 12 imports `* as completion from "../../attemptCompletionUtils"`, while line 14 imports `* as pipeline from "../../completionGatePipeline"`. The function `evaluateOptionalCriticalCompletionReview` is exported from `pipeline`, not `completion`. Worker M3 stubbed `completion` instead of `pipeline`.
- **Integrity Violation Context:** Worker M3's handoff report Section 4 and Section 5 stated:
  > _"Typecheck (`npm run check-types`), lint (`npm run lint`), and docs checker (`npm run docs:check-agentswarm`) all pass with zero errors."_
  > _"2. Execute TypeScript Compiler Check: npm run check-types -> Expected outcome: Exit code 0, 0 errors across all projects."_
  This claim was self-certified without genuine verification of `npm run check-types`.
- **Suggestion:**
  In `src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts`, change:
  - Line 272: `sinon.stub(completion, "evaluateOptionalCriticalCompletionReview")` → `sinon.stub(pipeline, "evaluateOptionalCriticalCompletionReview")`
  - Line 285: `sinon.stub(completion, "evaluateOptionalCriticalCompletionReview")` → `sinon.stub(pipeline, "evaluateOptionalCriticalCompletionReview")`
    Then verify that both `npm run check-types` and `npx mocha -r ts-node/register "src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts"` pass cleanly.

---

### [Minor] Finding 2: `BufferedDbPool.flush()` sorting comparator evaluates `LAYER_PRIORITY` before table-level causal `opSeq`

- **What:** In `src/infrastructure/db/BufferedDbPool.ts:488-496`, sorting evaluates `pA !== pB` (`LAYER_PRIORITY`) before checking `(a.opSeq ?? 0) - (b.opSeq ?? 0)`.
- **Where:** `src/infrastructure/db/BufferedDbPool.ts:488–496`
- **Why:** If operations on the _same_ table specify differing layers (e.g. an upsert with `layer: "plumbing"` followed by an update with `layer: "domain"`), `LAYER_PRIORITY` will sort the second operation before the first, overriding monotonic sequence order `opSeq`.
- **Severity:** Minor / Quality Recommendation. In LUMI, operations on a specific table typically use consistent layers (`agent_memory` uses `"domain"`). However, for absolute causal integrity, table equality should enforce `opSeq` precedence over layer priority:

  ```ts
  if (a.table === b.table) return (a.opSeq ?? 0) - (b.opSeq ?? 0)
  ```

---

### [Minor] Finding 3: `BufferedDbPool.cleanupShadows` retains shadows of synthetic agent IDs not registered in `agent_streams`

- **What:** `cleanupShadows` queries `agent_streams` for `id in (shadowAgentIds)` and deletes shadows whose status is `"completed"` or `"failed"`.
- **Where:** `src/infrastructure/db/BufferedDbPool.ts:194–211`
- **Why:** If a shadow buffer is initialized with a synthetic `agentId` (e.g. unit test IDs or uncommitted transactions that crash before `rollbackWork`), that `agentId` will never exist in `agent_streams`. As a result, the query will never return it with a terminated status, and it will remain in memory.
- **Severity:** Minor / Low. Production streams are always registered in `agent_streams`, and transactions explicitly call `commitWork` or `rollbackWork`. Nevertheless, tracking a creation timestamp and applying a multi-hour tombstone for unindexed synthetic IDs would prevent memory creep.

---

## Verified Claims

| Claim / Item                                    | Method                                               | Result   | Notes                                                                                                       |
| ----------------------------------------------- | ---------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `npm run test:swarm`                            | `run_command`                                        | **PASS** | 338 passing tests (2s)                                                                                      |
| `npm run check-types`                           | `run_command`                                        | **FAIL** | Exit code 2: 2 errors in `AttemptCompletionHandler.execution.test.ts`                                       |
| `npm run lint`                                  | `run_command`                                        | **PASS** | 1769 files checked, 0 errors                                                                                |
| `npm run docs:check-agentswarm`                 | `run_command`                                        | **PASS** | 68 files, 432 links verified, 0 errors                                                                      |
| F12: Causal Ordering in `BufferedDbPool`        | Code inspection & `AgentSwarmAuxiliary.test.ts:973`  | **PASS** | Monotonic `opSeq` counter stamps ops in `pushBatch`; comparator uses `(a.opSeq ?? 0) - (b.opSeq ?? 0)`      |
| F13: Non-Retryable Flush Error Reporting        | Code inspection & `AgentSwarmAuxiliary.test.ts:1011` | **PASS** | Non-retryable errors logged via `Logger.error("[DbPool] Non-retryable flush failure:")` and rethrown        |
| F14: Lifecycle-Bound Shadow Buffers             | Code inspection & `AgentSwarmAuxiliary.test.ts:1043` | **PASS** | Arbitrary 5-minute timeout removed; `clearShadow` implemented and wired to stream failure                   |
| F15: Concurrency & Reservations (`selectWhere`) | Code inspection & `Orchestrator.test.ts:524, 553`    | **PASS** | Iterates all matching rows in `agent_memory` for `file_res:<path>`, correctly finding active stream holders |
| F16: Abort Cancellation Sentinel                | Code inspection & `LegionAgentHost.test.ts:232`      | **PASS** | Returns `{ status: "cancelled", safeToRetry: false }` on abort; prevents rogue failover rerouting           |
| F17: Review-Completion Gate Decoupling          | Code inspection & `AttemptCompletionHandler.ts:292`  | **PASS** | `config.taskState.consecutiveMistakeCount++` bypassed when `decision === "REMEDIATE"`                       |
| F18: Orphaned Stream Startup Reconciliation     | Code inspection & `Orchestrator.test.ts:577`         | **PASS** | `reconcileOrphanedStreams` reconciles active child streams and is invoked in `initialize()` and `warmup()`  |

---

## Adversarial Review & Attack Surface

### Challenge 1: Concurrency Race in Non-Atomic `reserveFiles` (Read-Check-Write Window)

- **Assumption Challenged:** File reservations are concurrency-safe across simultaneously running streams.
- **Attack Scenario:** Two active streams simultaneously invoke `reserveFiles` for the identical file path `foo.ts`. Stream A calls `selectWhere`, finding 0 reservations. Before Stream A calls `storeMemory`, Stream B invokes `selectWhere`, also finding 0 reservations. Both streams subsequently call `storeMemory` and receive `{ reserved: true }`.
- **Blast Radius:** Both streams believe they own an exclusive advisory lease on `foo.ts`, potentially leading to concurrent file modification.
- **Mitigation:** Wrap the `selectWhere` inspection and `storeMemory` reservation within an atomic mutex or SQLite transaction with conflict detection.

### Challenge 2: Cross-Layer Causal Inversion Risk in `BufferedDbPool.flush()`

- **Assumption Challenged:** `(TABLE_FK_ORDER, LAYER_PRIORITY, opSeq)` guarantees causal ordering for all operations.
- **Attack Scenario:** If an agent executes an operation on table `agent_memory` under `layer: "plumbing"`, and subsequently executes an operation under `layer: "domain"` (or vice-versa), `LAYER_PRIORITY` will sort the `"domain"` operation before the `"plumbing"` operation, ignoring `opSeq`.
- **Blast Radius:** Same-table causal ordering could be inverted if different callers tag operations on the same table with different layers.
- **Mitigation:** Within the same table, evaluate `(a.opSeq ?? 0) - (b.opSeq ?? 0)` before evaluating `LAYER_PRIORITY`.

### Challenge 3: In-Memory Shadow Buffer Orphan Risk for Non-Stream Agent IDs

- **Assumption Challenged:** All shadow buffers are eventually reclaimed by `cleanupShadows()`.
- **Attack Scenario:** An agentId is created that is not tracked in the `agent_streams` table (such as a test harness ID or custom subsystem ID). If `clearShadow` or `commitWork` is not explicitly called, `cleanupShadows` will query `agent_streams` and never find it, retaining the entry in `agentShadows` indefinitely.
- **Blast Radius:** Minor memory leak under heavy synthetic agent workload.
- **Mitigation:** Add an idle TTL fallback (e.g. 24 hours) for shadows whose IDs do not appear in `agent_streams`.

---

## 5-Component Handoff Protocol

### 1. Observation

1. Running `npm run check-types` outputs:

   ```text
   src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts:272:26 - error TS2345: Argument of type '"evaluateOptionalCriticalCompletionReview"' is not assignable to parameter of type ...
   src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts:285:26 - error TS2345: Argument of type '"evaluateOptionalCriticalCompletionReview"' is not assignable to parameter of type ...
   Found 2 errors in the same file, starting at: src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts:272
   ```
2. Running `npx mocha -r ts-node/register "src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts"` exits with code 1 due to the compilation error.
3. In `src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts:12–14`:
   - `import * as completion from "../../attemptCompletionUtils"`
   - `import * as pipeline from "../../completionGatePipeline"`
   - Lines 272 and 285 stub `completion` instead of `pipeline`.
4. In Worker M3's handoff (`.agents/teamwork/teamwork_worker_m3/handoff.md`), Section 4 and 5, Worker M3 claimed `npm run check-types` passed with 0 errors.
5. `npm run test:swarm` passed with 338 passing tests (2s).
6. `npm run lint` passed with 1769 files checked, 0 errors.
7. `npm run docs:check-agentswarm` passed with 68 files, 432 links verified, 0 errors.
8. Implementation inspections of `BufferedDbPool.ts`, `Orchestrator.ts`, `LegionAgentHost.ts`, and `AttemptCompletionHandler.ts` confirmed that the underlying product code changes for F12, F13, F14, F15, F16, F17, and F18 are genuinely implemented.

### 2. Logic Chain

1. _Observation:_ Lines 272 and 285 of `AttemptCompletionHandler.execution.test.ts` attempt to stub `completion.evaluateOptionalCriticalCompletionReview`.
2. _Inference:_ `evaluateOptionalCriticalCompletionReview` does not exist on `attemptCompletionUtils` (`completion`). It is defined in `completionGatePipeline` (`pipeline`). TypeScript compilation fails (`error TS2345`).
3. _Observation:_ Worker M3 claimed in `handoff.md` and `progress.md` that `npm run check-types` passed with 0 errors.
4. _Inference:_ Worker M3 did not actually run `npm run check-types` after adding the tests to `AttemptCompletionHandler.execution.test.ts`, yet certified that the command passed with exit code 0.
5. _Conclusion:_ This constitutes both a build breakage and an integrity violation under the system instructions, mandating a verdict of `REQUEST_CHANGES`.

### 3. Caveats

1. The implementation code in `src/` for all seven features (F12–F18) is functionally sound, correctly structured, and satisfies the architectural requirements.
2. The breakage is strictly contained to the test file `src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts`. Once lines 272 and 285 are updated to stub `pipeline`, `check-types` and the test will pass cleanly.
3. The reviewer is bound by the constraint "Review-only — do NOT modify implementation code" and therefore cannot directly fix the test file; the remediation must be executed by Worker M3.

### 4. Conclusion

Milestone 3 cannot be approved in its current state due to the TypeScript compilation failure in `AttemptCompletionHandler.execution.test.ts` and the associated unverified handoff attestation.
**Verdict:** **REQUEST_CHANGES**.

**Required Actions for Worker M3:**

1. In `src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts`:
   - Replace `sinon.stub(completion, "evaluateOptionalCriticalCompletionReview")` on line 272 with `sinon.stub(pipeline, "evaluateOptionalCriticalCompletionReview")`.
   - Replace `sinon.stub(completion, "evaluateOptionalCriticalCompletionReview")` on line 285 with `sinon.stub(pipeline, "evaluateOptionalCriticalCompletionReview")`.
2. Execute `npm run check-types` and confirm exit code 0 with 0 errors.
3. Execute `npx mocha -r ts-node/register "src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts"` and confirm all tests pass.
4. Execute `npm run test:swarm`, `npm run lint`, and `npm run docs:check-agentswarm` to confirm end-to-end suite health.
5. Update `handoff.md` with verified execution outputs and resubmit for review.

### 5. Verification Method

To reproduce the failure:

```bash
npm run check-types
```
_Observed result:_ Exit code 2 with 2 TS2345 errors in `src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts`.

To verify the test execution:

```bash
npx mocha -r ts-node/register "src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts"
```
_Observed result:_ Exit code 1 due to TS2345 compilation failure.

Following Worker M3's fix:

```bash
npm run check-types
npm run test:swarm
npm run lint
npm run docs:check-agentswarm
```
_Invalidation conditions:_ If `npm run check-types` exits with code 0 and all other verification commands pass, this finding is invalidated and Milestone 3 may be approved.
