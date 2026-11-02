# PM-003 — Flush ordered by layer priority, not by FK dependency

**Date:** 2026-11-02 · **Severity:** Medium · **Detected by:** Real-SQLite test or code audit · **Blameless format**

## Summary
`agent_memory` was written at `layer: "domain"` (priority 0) while `agent_streams` inserts used `infrastructure` (priority 1), so memory flushed first and violated the FK to `agent_streams`.

## Reproduction
- **Input:** Create a stream, store memory for it, flush.
- **Expected:** Parent rows land first.
- **Actual:** `SQLITE_CONSTRAINT_FOREIGNKEY`.

## Root cause
`flush()` sorted solely by `LAYER_PRIORITY`.

## Fix
Introduced `TABLE_FK_ORDER` (`agent_streams` < `agent_tasks` < `agent_memory` < …) consulted before layer priority; swarm writers use `layer: "infrastructure"`.

## Why it wasn't caught earlier
No test flushed to a real database with foreign keys on.

## Prevention (now in place)
Real-SQLite tests; ADR-0010.

## Lessons
Ordering is a correctness property of the store, not of each caller — put it in the store.
