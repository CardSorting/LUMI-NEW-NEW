# PM-002 — `agent_memory` upserts without `conflictTarget` failed or duplicated rows

**Date:** 2026-11-02 · **Severity:** High · **Detected by:** Real-SQLite test or code audit · **Blameless format**

## Summary
Swarm records were upserted with no `conflictTarget`/`where`. `BufferedDbPool` then defaulted to `ON CONFLICT (id)`; `agent_memory` has no `id` (its key is `(streamId, key)`), so SQLite errored, and the in-memory matcher appended duplicate buffered rows.

## Reproduction
- **Input:** Call `deferPipeline`, `resumePipeline`, `runCriticalCompletionReview`, then `dbPool.flush()` on real SQLite.
- **Expected:** Idempotent upserts keyed by `(streamId, key)`.
- **Actual:** SQLite error on flush; duplicate in-memory rows for the same key.

## Root cause
Missing `conflictTarget: ["streamId","key"]` and `where`; `selectWhere`'s `pkMatch` only matched on `id` when `where` was absent.

## Fix
All `storeStreamRecord`/`storeRecord` writers specify the composite conflict target and a `where`; `BufferedDbPool`'s `pkMatch` now matches on `conflictTarget` columns when `where` is empty. Also fixed `createTask` inserting a non-column (`subagent_type`) into `agent_tasks`.

## Why it wasn't caught earlier
Same mock limitation as PM-001: the mock keyed `agent_memory` rows itself.

## Prevention (now in place)
Data-model rules ([data-model.md](../architecture/data-model.md#write-path-rules)); real-SQLite test (section 5).

## Lessons
Defaults that assume an `id` column are a trap for key/value tables — always spell out the key.
