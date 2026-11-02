# ADR-0010 — Direct (non-shadow) writes for rows others must read; FK-ordered flush

**Status:** Accepted

## Context
`BufferedDbPool.push(op, agentId)` stores the op in that agent's **shadow overlay**, visible only to reads that pass the same `agentId`, until `commitWork`. Two consequences bit us repeatedly: (a) an `agent_streams` insert pushed with the child id sat in a shadow while its `agent_tasks`/`agent_memory` children went straight to the active buffer and flushed first → `FOREIGN KEY constraint failed` (PM-001); (b) cross-stream reads (parent reading a child) never saw shadowed writes.

## Decision
- Insert `agent_streams` rows and write any parent-readable state with `dbPool.push(op)` (no agent id).
- `BufferedDbPool.flush()` sorts by `TABLE_FK_ORDER` first, layer priority second.
- Reads of another stream's overlay-sensitive records pass that stream's id (`selectOne(…, requestingAgentId)`).
- Verify new write paths against the **real** SQLite pool.

## Consequences
+ Correct flush order; parents can read children.
− Any write issued **after** `commitWork(x)` must not pass `x` as agent id (it would never commit — PM-011). `completeStream`, `releaseFiles` and `releaseAllReservations` were corrected accordingly. Idle overlays are discarded after 5 minutes (`cleanupShadows`), so a stranded overlay write is eventually lost, not merely delayed.

## Alternatives
- Remove shadow buffers — rejected (used by other subsystems for isolation).

## Evidence
Real-SQLite tests; `TABLE_FK_ORDER` in `BufferedDbPool.ts`; PM-001, PM-003, PM-011.
