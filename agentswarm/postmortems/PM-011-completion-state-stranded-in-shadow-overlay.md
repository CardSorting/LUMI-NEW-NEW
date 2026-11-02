# PM-011 — Completion state and reservation releases were stranded in a shadow overlay

**Date:** 2026-11-02 · **Severity:** High (silent; affected pre-existing code and two features built on it) · **Detected by:** Empirical probe against the real SQLite pool while preparing the maintainers' handbook · **Blameless format**

## Summary
`completeStream` called `dbPool.commitWork(streamId)` (draining the stream's shadow overlay) and **then** wrote the stream's `completed` status and `stream_summary` with `pushBatch(ops, streamId)` — i.e. *back into the same overlay*. Nothing commits that overlay again, so the writes never reached SQLite and were invisible to any reader that did not pass that stream's id. `BufferedDbPool.cleanupShadows` deletes overlays idle for 5 minutes, so they were eventually discarded. `releaseFiles` and `releaseAllReservations` had the same shape for their `delete` ops. All three patterns exist unchanged in `git show HEAD`.

## Impact
- A completed stream stayed `active` in the database (and for hierarchy walks such as `collectHierarchyStreams`), so a **suspension barrier waiting on a child never released** when the child finished via `completeStream` — the PM-006 fix ("completeStream also reconciles") was ineffective on the real pool.
- `stream_summary` never persisted ⇒ the Legion synthesis fallback and any restart-time reader lost it.
- Finished streams' `file_res:*` rows were never deleted on disk (masked functionally because conflict checks only count *active* streams, but a permanent leak).
- `failStream` was **not** affected (it uses a direct push).

## Reproduction
- **Input:** real SQLite pool; `createStream` → `flush` → `completeStream(id, "the summary")` → `flush`.
- **Expected:** `agent_streams.status = 'completed'`, `agent_memory.stream_summary` present.
- **Actual:** status `active`, summary row absent. A non-overlay `selectOne` also returned `active`.

## Root cause
Shadow overlays are private write buffers released only by `commitWork`. Ordering `commitWork` *before* the final write turned the final write into a write-that-never-commits. The in-memory test double applies every op immediately, so no mock-based test could see it (same class as PM-001).

## Fix
`completeStream`'s final `pushBatch`, `releaseFiles` and `releaseAllReservations` now write **directly** (no agent id), consistent with [ADR-0010](../adr/ADR-0010-direct-writes-for-shared-rows.md). Three regression tests run against the real SQLite file; the two completion tests were proven to **fail with the fix reverted** (`expected 'active' to equal 'completed'`; `expected 'waiting_for_children' to equal 'suspended'`).

## Why it wasn't caught earlier
Every earlier "completed" assertion used the mock, or read with the stream's own overlay id, which does see overlay writes.

## Prevention
- Real-SQLite tests for completion persistence, barrier release, and reservation release.
- Rule added to [for-agents.md](../onboarding/for-agents.md): *a write issued after `commitWork(x)` must not pass `x` as its agent id.*
- Audit command in [PB-06](../playbooks/PB-06-triage-sqlite-flush-errors.md) to find agent-scoped pushes.

## Lessons
When a store has a private-buffer concept, "commit then write" is a trap. And: **the only evidence that counts for persistence is the file on disk.**

## Still open
Other modules outside `src/infrastructure/ai/` may use agent-scoped pushes the same way; they were not audited (see findings L12).
