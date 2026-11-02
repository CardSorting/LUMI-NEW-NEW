# ADR-0003 — Persist all swarm state in `agent_memory` via `BufferedDbPool`

**Status:** Accepted

## Context
`agentswarm3.md` §7 says: reuse BroccoliDB/queue/mailbox; "I would not create another parallel queue, another agent engine, or another independent mailbox." The host already has a buffered SQLite pool and a per-stream key/value table.

## Decision
Control messages, checkpoints, status, roadmaps, review cycles, Legion manifests and reservations are all JSON values under well-known keys in `agent_memory` (PK `(streamId, key)`). No new tables or migrations. See [data-model.md](../architecture/data-model.md).

## Consequences
+ Survives restarts; reuses flush batching and ordering; no schema migration.
− Value size is bounded only by convention (the control inbox is capped at 200 messages).
− Correctness depends on the write rules in ADR-0010 and on composite-key upserts.

## Alternatives
- New `agent_swarm_*` tables — rejected (migration cost, parallel infra).
- In-memory maps — rejected (not durable, violates spec §7).

## Evidence
Real-SQLite tests (section 5 and the Legion lifecycle test) flush this state to disk.
