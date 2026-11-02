# PM-012 — Post-resume barrier reconciliation re-suspended a resumed parent; same-batch reservation `delete` sorted before `upsert`

**Date:** 2026-11-02 · **Severity:** High (affected post-resume pipeline state and on-disk reservation cleanup) · **Detected by:** Running the 8 diagnostic SQL queries (`Q1`–`Q8`) against a real SQLite database while verifying the Maintainers' Operating Handbook · **Blameless format**

## Summary
While empirically executing the SQLite inspection queries (`Q1`–`Q8`) for the Maintainers' Operating Handbook against a real SQLite database (`joyzoning.sqlite` schema), two subtle persistence/state-machine bugs surfaced that had been invisible in single-phase unit tests:

1. **PM-012a (Post-resume barrier reconciliation re-suspends a resumed pipeline):**
   When a hierarchy was deferred (`phase: "suspended"`) and then resumed (`resumePipeline` → `phase: "resumed"`), and a child stream subsequently finished (`completeStream` → `reconcileAfterStreamFailure` → `reconcilePipelineBarrier`), `reconcilePipelineBarrier` did not check whether the pipeline had already exited the suspension phase. Because all children were now terminal (`completed`), `reconcilePipelineBarrier` set `pipeline.phase = "suspended"` and re-wrote the root stream's suspension state back to `state: "waiting_for_children"`, `acceptingNewWork: false`!
2. **PM-012b (Same-batch `delete` sorted before `upsert` in `BufferedDbPool.flush()`):**
   `BufferedDbPool.flush()` sorts buffered operations by `(1) TABLE_FK_ORDER`, `(2) LAYER_PRIORITY`, `(3) table`, and `(4) op.type.localeCompare(b.type)`. Because `"delete"` sorts alphabetically before `"upsert"`, if a stream called `reserveFiles` (`upsert` on `agent_memory`) and then `completeStream` → `releaseAllReservations` (`delete` on `agent_memory`) within the same 1-second flush window without an intermediate `flush()`, `BufferedDbPool.flush()` executed the `DELETE` **first** (affecting 0 rows) and the `INSERT ... ON CONFLICT DO UPDATE` **second** — leaving the released file reservation row permanently on disk.

## Impact
- **PM-012a:** Any parent pipeline that deferred, resumed, and then had its children finish normal execution was silently re-locked (`acceptingNewWork: false`, `state: "waiting_for_children"`) as soon as the first child called `completeStream` or `failStream`.
- **PM-012b:** Short-lived specialist streams that reserved and released files within a single 1s flush interval left stale `file_res:<path>` rows in `agent_memory` on disk. (Active-stream checks in `LegionCoordinator` prevented false-positive lock conflicts for finished streams, but on-disk state and `Q5` diagnostic queries showed lingering reservation rows.)

## Reproduction
- **PM-012a:**
  1. Create `root` and `child` streams on a real SQLite pool.
  2. `deferHierarchy({ rootStreamId: root })` → `acknowledgeChildSuspension({ streamId: child })` → barrier reaches `suspended`.
  3. `resumeHierarchy({ rootStreamId: root })` → `root` is `resumed` (`acceptingNewWork: true`).
  4. `completeStream(child, "done")` → triggers `reconcileAfterStreamFailure(child)`.
  5. Inspect `stream_suspension_state` for `root`: expected `state: "resumed"`, `acceptingNewWork: true`; actual before fix was `state: "waiting_for_children"`, `acceptingNewWork: false`.
- **PM-012b:**
  1. On a real SQLite pool, call `reserveFiles(streamId, ["src/foo.ts"])` and then `completeStream(streamId, "done")` without calling `dbPool.flush()` in between.
  2. Call `await dbPool.flush()`.
  3. Query `SELECT * FROM agent_memory WHERE key = 'file_res:src/foo.ts'`: expected 0 rows; actual before fix was 1 row (`streamId`).

## Root cause
1. **PM-012a:** `reconcilePipelineBarrier` checked `if (!pipeline || pipeline.phase === "suspended")` to short-circuit, assuming a pipeline could only be in `suspending`, `waiting_for_children`, or `suspended`. It forgot that a pipeline record remains stored under `pipeline_defer_state:<pipelineId>` after `resumePipeline` transitions `pipeline.phase` to `"resumed"`.
2. **PM-012b:** `BufferedDbPool.push()` coalesces `update`/`upsert` against prior in-buffer ops, but `delete` ops are appended without removing matching prior `upsert` ops in `this.activeBuffer`, and `flush()` sorts by `a.type.localeCompare(b.type)` (`"delete"` < `"upsert"`).

## Fix
1. **PM-012a (`src/infrastructure/ai/HierarchicalDeferCoordinator.ts`):**
   Changed the guard at the top of `reconcilePipelineBarrier` to only reconcile when the pipeline is actively waiting on its suspension barrier:
   ```ts
   if (
     !pipeline ||
     (pipeline.phase !== "waiting_for_children" && pipeline.phase !== "suspending")
   ) {
     return null;
   }
   ```
2. **PM-012b (`src/infrastructure/ai/Orchestrator.ts`):**
   In `releaseFiles` and `releaseAllReservations`, when reservations exist to be deleted, `await dbPool.flush()` is called before pushing the `delete` batch so any pending `upsert` for those `file_res:*` keys is committed before the `DELETE` runs.
3. **Regression test (`src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts`):**
   Added *"does not re-suspend an already resumed pipeline when a child completes later, and deletes same-batch file reservations on disk"* against a real SQLite file.

## Why it wasn't caught earlier
- Earlier barrier tests ended at `resumeHierarchy` and did not call `completeStream` on the children *after* resume.
- Earlier reservation release tests flushed after `reserveFiles` (to inspect the reservation row) before calling `releaseAllReservations`.

## Prevention
- Every diagnostic SQL query in the Maintainers' Operating Handbook (`Q1`–`Q8`) was executed against a multi-phase lifecycle script (`defer` → `resume` → `completeStream` → `formLegion`) on a real SQLite file.
- Documented the `BufferedDbPool.flush()` alphabetical `op.type` sort (`delete` < `insert` < `update` < `upsert`) in [maintainers/03-operating-handbook.md](../maintainers/03-operating-handbook.md) so maintainers know never to queue an un-flushed `upsert` and `delete` for the same key in the same batch.

