# PM-001 — Shadow-buffer push caused `FOREIGN KEY constraint failed` on flush

**Date:** 2026-11-02 · **Severity:** High (flush failure; reappeared twice) · **Detected by:** Real-SQLite test or code audit · **Blameless format**

## Summary
Rows pushed with an `agentId` argument sit in that agent's shadow overlay. A child `agent_streams` insert was pushed with the child's id while its dependent `agent_tasks`/`agent_memory` rows were pushed without one, so dependents flushed to SQLite before the parent row existed. The same mistake **re-appeared** in `rerouteFailedSpecialist` and, later, in a regressed `formAndSpawnLegion` (see PM-010).

## Reproduction
- **Input:** `formLegion(...)` (or a failover) followed by `await dbPool.flush()` against a real SQLite file with `PRAGMA foreign_keys = ON`.
- **Expected:** Streams, tasks and memory flush in FK order with no error.
- **Actual:** `SqliteError: FOREIGN KEY constraint failed` on flush.

## Root cause
`BufferedDbPool.pushBatch/push(op, agentId)` routes the op to `agentShadows.get(agentId)` instead of the active buffer. Only an explicit `commitWork(agentId)` moves it. The in-memory test mock ignored the second argument, so the bug was invisible.

## Fix
Removed the `agentId` argument from the `agent_streams` inserts (`formAndSpawnLegion`, `rerouteFailedSpecialistUnlocked`). Added `TABLE_FK_ORDER` to `flush()` so parents always sort before dependents (see PM-003). Added a real-SQLite lifecycle test that forms a Legion, completes a lead, fails a worker (failover) and flushes after each step.

## Why it wasn't caught earlier
The unit-test `dbPool` mock reimplements `push` and ignores `agentId` and FK order — it cannot reproduce overlay or ordering bugs.

## Prevention (now in place)
- ADR-0010. - Rule in [for-agents.md §2](../onboarding/for-agents.md). - Required real-SQLite test for any new write path ([for-maintainers.md](../onboarding/for-maintainers.md)).

## Lessons
A mock that is *more permissive* than the real component is a liability. When an API has a non-obvious optional parameter (`agentId`), grep for every call site whenever you touch persistence.
