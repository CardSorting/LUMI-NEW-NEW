# ADR-0004 — Parent suspension barrier with ancestor walk and per-pipeline lock

**Status:** Accepted

## Context
Spec: "The parent must not report the hierarchy as suspended while descendants are still executing." Hierarchies can be many levels deep; children finish at different times, concurrently, or crash.

## Decision
1. Phase is `waiting_for_children` until every active descendant is `deferred`.
2. Barrier re-evaluation (`reconcilePipelineBarrier`) is triggered by `completeInFlightAndYield`, and by `completeStream`/`failStream` (`reconcileAfterStreamFailure`).
3. Re-evaluation **walks the full `parentId` chain** to find the stream that owns the matching `deferred_pipeline_status` (only the root stores it).
4. Re-evaluation runs under a **per-pipeline mutex**; descendants are evaluated bottom-up so intermediate nodes can defer once their children have.

## Consequences
+ No false "suspended"; no deadlock on child failure; correct for 4+ levels; concurrent siblings serialize.
− The lock is in-process (single extension host). Multi-process deployments would need a durable lock.

## Alternatives
- Poll every inbox — rejected (spec prefers notification on ack).
- Stop at the immediate parent — rejected (that was the original bug, PM-006).

## Evidence
Tests: barrier with mid-tool Child C; 4-level hierarchy with concurrent sibling completion and child crash.
