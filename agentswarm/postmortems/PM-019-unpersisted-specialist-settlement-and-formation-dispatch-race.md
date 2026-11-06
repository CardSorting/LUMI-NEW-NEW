# Post-Mortem PM-019 — Unpersisted Specialist Settlement & Formation Dispatch Race

**Incident Date:** 2026-11-05  
**Severity:** High (Lost Specialist Work & Parallel Pipeline Duplication)  
**Affected Subsystems:** `src/infrastructure/ai/LegionCoordinator.ts`, `src/infrastructure/ai/LegionPipelineRunner.ts`, `src/infrastructure/ai/LegionExecutionReceipt.ts`, `src/infrastructure/ai/Orchestrator.ts`  
**Related ADRs:** [ADR-0009](../adr/ADR-0009-legion-lifecycle-dag-failover-terminal-states.md), [ADR-0020](../adr/ADR-0020-legion-handoff-sanitization-two-phase-reservation-and-unsettled-reconciliation.md)

---

## 1. Summary

In multi-specialist pipelines running under load, two concurrency defects emerged:

1. When multiple automatic triggers evaluated a parent task concurrently, both triggers acquired formation readiness, creating duplicate parallel formations with competing specialists reserving the same file paths.
2. When a specialist completed its native-tool execution loop, `LegionPipelineRunner` called `orchestrator.completeStream()`. If SQLite storage was temporarily unavailable or threw a constraint error during flush, the error was caught and logged, but the runner advanced to the next DAG stage anyway. Downstream specialists then operated on absent or corrupt upstream handoffs.

---

## 2. Root Cause Analysis

### A. Missing Formation Reservation Intent

`formLegion` previously checked only existing active streams in SQLite. Because `formLegion` involves several asynchronous operations (token classification, toolset resolution, database insertion), two concurrent dispatches launched before either had flushed its stream row to disk. Both successfully spawned separate teams.

### B. Blind Stage Progression on Settlement Failure

In `LegionPipelineRunner.ts`:

```ts
// Flawed logic:
if (result.status === "completed" && result.summary.trim()) {
    await orchestrator.completeStream(member.streamId, result.summary)
    await options?.onProgress?.({ ... })
}
```
If `completeStream` threw an unhandled storage exception (e.g. database busy, lock timeout, or uncommitted shadow collision), the error either crashed the entire pipeline ungracefully or was caught by an outer block that reported the member as failed or rerouted, triggering an unnecessary failover specialist that repeated completed work.

---

## 3. The Fix

1. **Two-Phase Formation Reservation (`LegionCoordinator.ts`, `LegionExecutionReceipt.ts`):**
   - Added `acquireFormationReservation`: establishes an atomic in-memory reservation before formation starts.
   - Added `acquireAutomaticFormationToken`: persistent SQLite token preventing duplicate formations for the same parent objective.
   - Added `acquireFormationDispatchToken`: guarantees a single driver loop drives a formation.
   - Verified via `hasOutstandingFormationReservation` and `hasLegionFormationIntent`.
2. **`needs_reconciliation` State Machine Transition (`LegionPipelineRunner.ts`):**
   - Wrapped `completeStream` and `failStream` settlement calls in explicit error boundaries.
   - If a completed or failed specialist result cannot be confirmed in durable storage, the runner stops immediately and returns:

     ```ts
     {
         status: "needs_reconciliation",
         detail: "The specialist reported completion, but its settlement could not be confirmed. Inspect persisted state and existing work before repeating it."
     }
     ```
   - The specialist member remains in `status: "running"`, preventing downstream stages from executing on missing context and preventing duplicate failover spawning.

---

## 4. Why It Escaped Earlier Testing

- **In-Memory Mocks:** Test suites mocked `dbPool.completeStream` and `dbPool.push` with immediate resolved promises, never exercising disk write errors, SQLite transaction locks, or worker claim races across separate processes.

---

## 5. Prevention & Regression Proofs

- **Multi-Process Concurrency Proof:** `src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts` Section 8:
  - Spawns two concurrent real Node child processes (`fixtures/legion-claim-worker.cjs`) against a real SQLite database; asserts exactly one process acquires the claim, driver, and reservation tokens.
  - Asserts that failing `completeStream` persistence halts the pipeline in `needs_reconciliation` and keeps the specialist status in `running`.
  - Asserts that pre-start cancellation failure halts the pipeline in `needs_reconciliation`.
