# Implementation Details & Findings

## What was built (short)
Three independently toggleable capabilities over existing infrastructure — see [how-it-works](../architecture/how-it-works.md). Counts at Phase 8: 190 tests passing (49 auxiliary, 54 legion host/adapter/task, 8 engage_swarm handler, 3 toolset discovery, 14 orchestrator, 32 state keys, 15 codex streaming, 15 stream response handler); core engines and handlers total ~6,500 lines.

## Key findings

1. **Suspension is mostly bookkeeping.** Because the host already had durable per-stream memory and cooperative boundaries, "freeze a hierarchy" reduced to a *protocol* (requests, acks, checkpoints, a barrier). The hard parts were concurrency and persistence ordering, not the idea.
2. **The store's rules matter more than the feature's logic.** 4 of 10 incidents were persistence semantics (shadow overlays, conflict targets, FK ordering, non-unique reads). See [post-mortems](../postmortems/README.md).
3. **A permissive test double is the most dangerous test asset.** The in-memory `dbPool` mock ignored `agentId`, FK order and key semantics; real-SQLite tests caught defects the mock-based tests could not.
4. **Idempotency must be total.** "Ignore an event equal to the current state" is not idempotency; repeated *different* events must also be ignored once a state is terminal (PM-009).
5. **Unbounded loops hide in "helpful" automation.** Review, failover and remediation all needed explicit numeric bounds and an escalation exit.
6. **Config has more sources than UIs assume.** settings.json, env, UI, per-task, per-agent, manual invocation; plus a store that pre-fills defaults. Make precedence explicit and visible (UI posts *effective* values).
7. **Deterministic classification is good enough to start.** Explainable, free and testable; heuristics can be steered with `preferredRoles`/`excludeRoles`.
8. **Interrupted delegation is a first-class failure mode.** See PM-010 / PB-08.
9. **"Commit, then write" strands writes in a private buffer — and same-batch `delete` sorts before `upsert`.** Found late, by probing the real SQLite file with diagnostic queries (`Q1`–`Q8`) rather than reading code; they silently broke barrier release, post-resume child completion, and same-batch reservation deletion ([PM-011](../postmortems/PM-011-completion-state-stranded-in-shadow-overlay.md), [PM-012](../postmortems/PM-012-post-resume-reconcile-and-delete-upsert-ordering.md)). *If you take one lesson: look at the file on disk.*
10. **Conductor autonomy requires auto-approval.** Prompting users interactively to approve delegator tools destroys autonomous agent flow. Auto-approving `engage_swarm` preserves sprint velocity while specialist tool sandboxing protects the workspace.
11. **Streaming progress cards make multi-agent systems observable.** Opaque multi-stage execution feels hung. Emitting badge-annotated markdown progress cards (`formatLegionProgressMessage`) keeps users informed across stage transitions and specialist runs.
12. **Snapshot test isolation requires conditional tool suppression.** Dynamically registering new tools alters system prompt token streams and snapshot assertions. Gating tool variants on `!context.isTesting` protects regression test baselines while enabling full capabilities in production.
13. **Failover must distinguish retryable errors from toxic errors.** Indiscriminately retrying exhausted budgets or disallowed tools creates infinite loops. Categorizing `safeToRetry` ensures failover only reroutes recoverable failures.
14. **Streaming transport hygiene & circuit breaking.** Model endpoints yield divergent delta/snapshot contracts (deltas followed by full argument snapshots, or interleaved call IDs). Deduplicating snapshots at the provider level, self-healing duplicate complete JSON roots in `StreamResponseHandler`, and circuit-breaking transport decoding errors with `safeToRetry: false` in `LegionAgentHost` prevents futile specialist failover loops and token waste ([ADR-0014](../adr/ADR-0014-tool-argument-stream-deduplication-and-self-healing-parser.md), [PM-015](../postmortems/PM-015-tool-argument-snapshot-concatenation-and-stream-decoding-loop.md)).

## Known limits and open questions

| # | Item | Status |
|---|---|---|
| L1 | **No live-host verification.** Nothing was exercised inside a running VS Code extension host with real model calls; UI behaviour was verified with jsdom component tests only. | Unverified |
| L2 | ~~Who runs the specialist tasks?~~ — **Resolved in Phase 6 & 7**: `LegionAgentHost`, `LegionToolAdapter`, and `LegionPipelineRunner` directly execute specialist tasks via native tool loops; `Task.ts` and `EngageSwarmHandler.ts` orchestrate them. | **Resolved** |
| L3 | ~~Cross-agent visibility of `completeStream`'s writes~~ — **was a real defect** (completion state and reservation deletes were stranded in a shadow overlay, never reaching SQLite). Fixed and covered by real-SQLite tests; see [PM-011](../postmortems/PM-011-completion-state-stranded-in-shadow-overlay.md). | **Resolved** |
| L4 | **Locks are in-process.** Barrier and formation locks assume a single extension host. | By design |
| L5 | **No mid-turn restoration.** Resume is at turn/tool boundaries; provider-round state is not persisted (spec: separate capability). | By design |
| L6 | **Env beats UI.** Operators may be surprised. | Documented |
| L7 | **`manualInvocation` does not force Defer.** It forces review and Legion; pass `forceEnable` to defer methods. | Documented |
| L8 | **Review engine classifies, it doesn't reason.** Findings come from the caller or audit violations; no embedded LLM reviewer. | By design |
| L9 | **Classification is heuristic.** Unusual phrasing can mis-rank specialists. | Mitigated by overrides |
| L10 | **Work was uncommitted** at authoring time. | Check `git log` |
| L12 | **Other modules not audited for PM-011.** Only `src/infrastructure/ai/*.ts` was searched for agent-scoped pushes issued after `commitWork`. Anything else using `BufferedDbPool` shadows the same way may be affected. Also: overlays idle for 5 minutes are discarded by `cleanupShadows`. | Open |
| L11 | **File reservation is check-then-act, not atomic.** Two `formLegion` calls interleaving in one process could both pass the active-holder check for the same file. Conflicts are *warnings* (the file is simply not reserved for the loser), not enforced locks, and there is no test for concurrent forms. | Open |

## Suggested next steps
1. Live smoke test (PB-07 manual section) and record it.
2. Confirm L2/L3 with a real runner and a real-SQLite test that completes members and reads from another agent id.
3. Consider a durable lock if multi-process execution is planned.
4. Optional: LLM re-ranker behind the same manifest contract; telemetry on specialist outcomes to tune keyword weights.
