# Paper 3 — Technical White Paper

**Title:** Cooperative Hierarchical Suspension, Bounded Adversarial Review, and Deterministic Specialist Delegation over a Buffered Key/Value Store
**Scope:** `agentswarm` (Critical Completion Review, Hierarchical Defer, The Legion)

## Abstract

We describe an optional orchestration layer for tree-structured LLM agents that adds (1) _safe, resumable suspension_ of an agent hierarchy, (2) _bounded, evidence-categorized completion review_, and (3) _deterministic specialist classification, staged execution and bounded failover_. All state is stored in an existing buffered SQLite key/value table; no new runtime, queue or schema is introduced. We state the invariants, give the algorithms, relate each invariant to the test that enforces it, and report the defects discovered when the design met the real store.

## 1. Problem and requirements

Derived from `agentswarm.md`–`agentswarm4.md`:

- **R1** Parent/child streams stay independent; the coordinator maintains a rolling roadmap.
- **R2** Review is optional, per-agent/per-task overridable, manually invokable, **bounded**, and decision-terminating.
- **R3** Defer must not be implemented as cancellation; support `before_turn`, `safe_boundary` (default), `immediate` (only when provably safe).
- **R4** A parent must not claim suspension while descendants run; a deferred child is never reported completed/failed.
- **R5** Reuse existing queue/store/mailbox; no blind replay of side effects; survive restarts.
- **R6 (extension)** Route tasks to appropriate specialists, order them, tolerate failure, summarize.

## 2. System model

- **Streams** form a tree via `agent_streams.parentId`. Each stream has tasks (`agent_tasks`) and a key/value memory (`agent_memory`, PK `(streamId,key)`).
- **Store:** `BufferedDbPool` batches writes; supports per-agent _shadow overlays_ (private until `commitWork`); flush order = table FK order, then layer priority.
- **Execution:** agents are cooperative: they reach turn and tool boundaries where a controller may intervene.
- **Failure model:** crash-stop of any stream; duplicate/reordered notifications within a process; single-process locking.

## 3. Design

### 3.1 Feature gating

`resolveEffectiveAgentSwarmState(ctx)` computes `(review, defer, legion, boundary, bounds, strategy)` from: defaults < VS Code < explicit StateManager < env < runtime override, then per-agent, per-task, manual invocation. The master switch is OR-ed into each sub-capability.

### 3.2 Defer protocol

Messages (durable, per-stream inbox, ≤200, deduped by id): `DEFER_REQUEST`, `DEFER_ACK`, `RESUME_REQUEST`, `RESUME_ACK`. Per-stream state: `running → (suspending) → deferred → running` and `waiting_for_children` for parents. Checkpoint = `{turnIndex, pendingToolQueue, completedToolReceipts, continuationMetadata, heldReservations, roadmap}`.

**Barrier algorithm** (`reconcilePipelineBarrier(parent, pid)`), under mutex keyed by `pid`:

1. Walk `parentId` upward from `parent`; let `root` be the stream whose stored `deferred_pipeline_status.pipelineId = pid`.
2. `H ← active descendants of root`, evaluated in reverse BFS order.
3. For each node `n` with state `waiting_for_children`: if no child of `n` is pending, `deferAgent(n)`.
4. `pending ← {n : state(n) ≠ deferred}`.
5. If `pending = ∅`: defer root with roadmap, phase `suspended`; else phase `waiting_for_children`.

Triggers: `completeInFlightAndYield`, `completeStream`, `failStream`.

### 3.3 Bounded review

State `(initialUsed, correctiveUsed, remediationAuthorized)` per `completionEventId`. Findings are normalized into three buckets; unverified/hypothetical "defects" are demoted. Decision table is in [how-it-works §4](../architecture/how-it-works.md). Corrective tasks are _merged_ into the roadmap and annotated with a recommended specialist.

### 3.4 Legion

**Classification.** For archetype _a_ with keyword groups _G_ (weight _w_), file patterns _P_:

```
score(a) = Σ_{g∈G} Σ_{t∈g} w · (1 + 0.35·min(3, hits(t) − 1))      // hits(t) ≥ 1
         + 3.5 · |{f ∈ files : ∃p∈P, p(f)}|
         + intentBonus(a, intent)           // 2.0 / 2.5
         + 6.0 · [a ∈ preferred]
complexity = clamp(1 + 1.3·#{a : score ≥ 3} + min(3, |text|/250) + min(3, 0.6·|files|), 1, 10)
strategy   = complexity < 3.2 ? tactical_strike
           : complexity ≥ 7.2 ? full_legion
           : intent ∈ {TEST, FIX} ? verification_heavy : balanced_squad
```
Roster = top-_k_ positive scores (k by strategy, ≤ `maxSpecialists` ≤ 8), with a verifier inserted for verification-heavy/full formations; files are partitioned so no two roster members own the same file.

**Formation.** Insert child stream, profile, `pending` task (with Legion metadata), reserve files if no _other active_ stream holds them, persist manifest, update roadmap.

**Lifecycle.** Stages `S0=leadAndRecon, S1=parallelExecution, S2=verificationAndHardening`. Let `resolved(m) ⇔ m.status ∈ {completed, rerouted}`. Stage `Sk` is _runnable_ iff all non-empty `Sj, j<k` have every member `resolved`. `settleSpecialistStream(m, outcome)` = reconcile → (failed ∧ legionEnabled ⇒ failover) → (finished ∨ stuck ⇒ synthesize), all under a per-formation mutex; terminal states are absorbing.

## 4. Invariants and enforcing tests

| #   | Invariant                                                                                                             | Enforced by                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| I1  | Features off ⇒ behaviour unchanged                                                                                    | "is disabled by default…"                                                                              |
| I2  | `suspended` ⇒ every active descendant `deferred`                                                                      | barrier test (Child C mid-tool); 4-level test                                                          |
| I3  | A completed tool receipt is never replayed on resume                                                                  | defer/safe_boundary tests                                                                              |
| I4  | Deferred tasks are never marked `failed`/`completed`                                                                  | "never marks tasks failed or completed"                                                                |
| I5  | ≤ 1 initial + ≤ 1 corrective review per completion event                                                              | "bounded 1+1 termination"                                                                              |
| I6  | Only verified, non-hypothetical defects ⇒ `REMEDIATE`                                                                 | category-separation tests                                                                              |
| I7  | ≤ 2 attempts per Legion slot                                                                                          | "fails over … exactly once"                                                                            |
| I8  | Terminal member states are absorbing                                                                                  | idempotency + failover tests                                                                           |
| I9  | Stage _k_ never runs before stages < *k* are resolved                                                                 | DAG gating test                                                                                        |
| I10 | A file isn't reserved by Legion for a stream if another _active_ stream holds it                                      | formation test (**concurrent-form race untested**, see §7)                                             |
| I11 | Flush never violates FK order                                                                                         | real-SQLite tests (section 5 + Legion lifecycle)                                                       |
| I12 | No lost update under concurrent sibling completion                                                                    | concurrency test; 4-level concurrent test                                                              |
| I13 | Conductor `engage_swarm` auto-approves and formats structured handoffs                                                | `EngageSwarmHandler.test.ts`                                                                           |
| I14 | Specialist runs respect token/cost budgets and categorize `safeToRetry` failover                                      | `LegionAgentHost.test.ts`, `LegionPipelineRunner`                                                      |
| I15 | Streaming progress cards deliver real-time markdown notifications                                                     | `formatLegionProgressMessage`, `TaskLegion.test.ts`                                                    |
| I16 | Provider tool argument snapshot slicing & interleaved tool identity tracking                                          | `openai-codex.streaming.test.ts`                                                                       |
| I17 | State-machine JSON root parser self-heals duplicate roots; transport errors circuit-break with `safeToRetry: false`   | `StreamResponseHandler.test.ts`, `LegionAgentHost.test.ts`                                             |
| I18 | Specialist prompt parity with conductor rules (`LEGION_CORE_RULES`)                                                   | `LegionAgentHost.test.ts`                                                                              |
| I19 | Multi-tier terminal heredoc defense, pre-execution interception & shell integration circuit-breaking                  | `heredocPolicy.test.ts`, `ExecuteCommandToolHandler.approval.test.ts`, `VscodeTerminalProcess.test.ts` |
| I20 | Dynamic project knowledge scrubbed of credentials, TTL pruned, and shared across formation stages via blackboard      | `LegionKnowledge.test.ts`, `BufferedDbPool.test.ts`                                                    |
| I21 | Environment integrity manifest fingerprinting and WeakRef cached audits invalidated reactively on workspace mutations | `EnvironmentIntegrity.test.ts`                                                                         |
| I22 | Terminal supervision post-spawn process group termination and action execution fencing with replay protection         | `SupervisedShell.test.ts`, `CommandExecutor.test.ts`                                                   |
| I23 | Legion handoff byte-capped XML sanitization and two-phase file reservation under formation mutex                      | `LegionHandoff.test.ts`, `BufferedDbPool.test.ts`                                                      |
| I24 | Specialist settlement strictly persisted with `needs_reconciliation` recovery guard before formation transition       | `LegionPipelineRunner.test.ts`, `LegionHandoff.test.ts`                                                |

## 5. Correctness arguments (sketch)

- **I2:** phase `suspended` is assigned only in `evaluateAndPersistPipelineState` when `pending = ∅` after deferring all descendants; `pending` is recomputed from durable statuses, so a late-finishing child cannot be missed (re-triggered by its own completion/failure).
- **I8/I12:** every manifest mutation occurs inside `withFormationLock(formationId)`; the first branch of the reconcile body returns when the member is already terminal, so replays are no-ops.
- **I7:** `nextAttempt = attempt + 1 > 2` short-circuits before any insert.
- **I16/I17:** done snapshots are sliced against accumulated deltas; `extractJsonRoots` self-heals identical duplicate JSON roots without throwing, while transport errors set `safeToRetry: false` stopping runaway failovers.
- **I18/I19:** specialist prompts strictly mandate `write_to_file` and forbid heredocs; pre-execution interception prevents unexecutable heredocs from triggering UI approval stalls or reaching process dispatch; `VscodeTerminalProcess` circuit-breaks interactive shell integration deadlocks.
- **I20/I21:** project knowledge scrubbers redact sensitive tokens and credentials before persisting to `agent_knowledge`; manifest fingerprints are lazily recomputed and reactively purged when mutating disk tools fire.
- **I22/I23/I24:** terminal shell supervisors isolate post-spawn observations and kill entire process tree process groups; handoff prompts strip raw control characters and enforce strict byte caps; specialist settlement commits synchronously before stage transitions with `needs_reconciliation` state guards.
- **Progress:** each loop is bounded (I5, I7, inbox cap) ⇒ termination or explicit escalation.

## 6. Evaluation

Automated: 455 backend unit tests passing in `npm run test:swarm` across 28 test suites (including auxiliary, legion host/adapter/task, engage_swarm handler, toolset discovery, orchestrator, state keys, codex streaming, stream response handler, heredoc policy, command approval & interception, terminal process lifecycle & decoding, dynamic project knowledge, environment integrity, terminal supervision, and legion handoff sanitization); 465 passing in `npm run test:execution` (32 webview); 7 component tests; multiple tests flush to a real SQLite file with foreign keys on. Defects found by evaluation are in [post-mortems](../postmortems/README.md); nineteen were persistence/phase/stream-decoding/terminal semantic and invisible to standard mocks. **Not evaluated:** performance under extreme concurrency, live-host extension host network drops.

**Overhead when off:** one config resolution per entry point (30 s cache) and one profile lookup in `settleLegionSpecialist`.

## 7. Limitations

1. In-process locks only (single extension host). 2. No mid-turn restoration. 3. Heuristic classification. 4. Review engine consumes findings; it does not generate them with a model. 5. File reservation is check-then-act (L11 resolved via two-phase reservation in Phase 11). 6. Other modules were not audited for stranded shadow-overlay writes (L12; the in-scope instances are fixed — PM-011). 7. Specialist execution host runner (L2) is implemented via `LegionAgentHost` / `LegionToolAdapter` in Phase 6/7. Full list: [findings](../implementation/findings.md#known-limits-and-open-questions).

## 8. Related decisions and further reading

[ADR-0001 … 0020](../adr/README.md) · [Data model](../architecture/data-model.md) · [Configuration](../architecture/configuration.md) · [Philosophy](01-philosophy.md) · [Stakeholder hand-off](02-stakeholder-handoff.md)
