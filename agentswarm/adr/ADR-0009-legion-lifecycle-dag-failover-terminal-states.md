# ADR-0009 — Legion lifecycle: stage DAG, bounded failover, final terminal states, per-formation lock

**Status:** Accepted

## Context
After spawning, a formation needs ordering (recon before work before verification), a plan for failures, and result aggregation. Sibling streams settle concurrently; events can repeat.

## Decision
1. **Stage DAG** `leadAndRecon → parallelExecution → verificationAndHardening`; a stage runs only when all earlier non-empty stages are resolved; lead summaries are handed to the next stage (`legion_stage_handoff_context`).
2. **Bounded failover:** a slot gets at most `LEGION_MAX_ATTEMPTS_PER_SLOT = 2` attempts; only a `failed` member may be re-routed; already-re-routed slots never spawn a second replacement; automatic failover only when Legion is enabled for the parent.
3. **Terminal states are final:** `completed`, `failed`, `rerouted` are never changed by later events (PM-009).
4. **Per-formation lock** around every manifest read-modify-write.
5. **Single entry point** `settleSpecialistStream`, invoked from `completeStream`/`failStream`; failures of Legion bookkeeping are logged and never fail the underlying stream transition.
6. A **synthesis report** is produced when the formation completes or is stuck on an unrecoverable failure.

## Consequences
+ No lost updates, no loops, idempotent under repeated events; clear escalation signal.
− Failed-and-exhausted slots block downstream stages until the coordinator intervenes (intentional: don't verify broken work).
− Lock is in-process (as ADR-0004).

## Alternatives
- Unbounded retry — rejected (loops). Skip failed slot and continue — rejected (verifies incomplete work).

## Evidence
Section 8 tests (gating, idempotency, failover-once, concurrency, disabled-parent, reroute guard, real SQLite).
