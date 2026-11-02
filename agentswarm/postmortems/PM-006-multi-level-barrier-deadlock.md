# PM-006 — Suspension barrier stuck in multi-level hierarchies and on child failure

**Date:** 2026-11-02 · **Severity:** High · **Detected by:** Real-SQLite test or code audit · **Blameless format**

## Summary
With `Root → Mid → Sub → Leaf`, the barrier walk stopped at the first parent that didn't itself hold `deferred_pipeline_status` (only the root does) and returned `null`, leaving the tree in `waiting_for_children` forever. Separately, a crashing child never notified the coordinator, deadlocking its parent. Concurrent siblings also raced.

## Reproduction
- **Input:** `completeInFlightAndYield(leaf)` in a 4-level tree; or `failStream(leaf3)` while the pipeline waits on it; or two leaves yielding at once.
- **Expected:** Barrier reaches the root, marks the pipeline `suspended`; failure and completion reconcile; no lost updates.
- **Actual:** Permanent `waiting_for_children`; lost sibling updates.

## Root cause
Ancestor walk terminated early; no hook in `completeStream`/`failStream`; no mutual exclusion.

## Fix
Walk the whole `parentId` chain; `reconcileAfterStreamFailure` called from `completeStream`/`failStream`; per-pipeline lock; bottom-up re-evaluation.

## Why it wasn't caught earlier
Early tests covered one level and sequential completion only.

## Prevention (now in place)
ADR-0004; 4-level + concurrent + crash test.

## Lessons
Test the *shape* (depth, concurrency, failure), not just the happy path.
