# ADR-0002 — Defer is cooperative suspension, never cancellation

**Status:** Accepted

## Context
`agentswarm3.md` §2 and `agentswarm4.md` §4/§9 warn explicitly: the UI "Pause" only freezes the feed; `AbortSignal` is cancellation; aborting a tool mid-flight can leave uncertain external side effects (DB write, shell, file mutation) and must never be replayed.

## Decision
Defer is a control-plane protocol. A stream yields at `before_turn`, `safe_boundary` (default) or `immediate` (only if the operation is idempotent **and** `canSafeInterruptImmediately`). If an operation is in flight, the stream enters `suspending` and waits; it is never aborted. Finished operations are recorded as `completedToolReceipts` in the checkpoint and are never replayed on resume. Tasks are annotated (`metadata.deferred_state`) but **never** moved to `failed`/`completed`.

## Consequences
+ No lost or duplicated side effects. A deferred child is distinguishable from completed/failed (spec §3 last line).
− Suspension latency = length of the longest in-flight atomic operation.
− True mid-turn restoration is out of scope (needs provider-round state persistence; see findings).

## Alternatives
- Abort + restart — rejected (side-effect uncertainty).
- UI pause — rejected (not runtime suspension).

## Evidence
Tests in section 3 (`before_turn`/`safe_boundary`, in-flight wait, immediate-only-when-safe).
