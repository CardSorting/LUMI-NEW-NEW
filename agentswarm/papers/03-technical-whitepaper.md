# Paper 3 — Technical White Paper

**Title:** Cooperative Hierarchical Suspension, Bounded Adversarial Review, and Deterministic Specialist Delegation over a Buffered Key/Value Store
**Scope:** `agentswarm` (Critical Completion Review, Hierarchical Defer, The Legion)

## Abstract
We describe an optional orchestration layer for tree-structured LLM agents that adds (1) *safe, resumable suspension* of an agent hierarchy, (2) *bounded, evidence-categorized completion review*, and (3) *deterministic specialist classification, staged execution and bounded failover*. All state is stored in an existing buffered SQLite key/value table; no new runtime, queue or schema is introduced. We state the invariants, give the algorithms, relate each invariant to the test that enforces it, and report the defects discovered when the design met the real store.

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
- **Store:** `BufferedDbPool` batches writes; supports per-agent *shadow overlays* (private until `commitWork`); flush order = table FK order, then layer priority.
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
State `(initialUsed, correctiveUsed, remediationAuthorized)` per `completionEventId`. Findings are normalized into three buckets; unverified/hypothetical "defects" are demoted. Decision table is in [how-it-works §4](../architecture/how-it-works.md). Corrective tasks are *merged* into the roadmap and annotated with a recommended specialist.

### 3.4 Legion
**Classification.** For archetype *a* with keyword groups *G* (weight *w*), file patterns *P*:

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
Roster = top-*k* positive scores (k by strategy, ≤ `maxSpecialists` ≤ 8), with a verifier inserted for verification-heavy/full formations; files are partitioned so no two roster members own the same file.

**Formation.** Insert child stream, profile, `pending` task (with Legion metadata), reserve files if no *other active* stream holds them, persist manifest, update roadmap.

**Lifecycle.** Stages `S0=leadAndRecon, S1=parallelExecution, S2=verificationAndHardening`. Let `resolved(m) ⇔ m.status ∈ {completed, rerouted}`. Stage `Sk` is *runnable* iff all non-empty `Sj, j<k` have every member `resolved`. `settleSpecialistStream(m, outcome)` = reconcile → (failed ∧ legionEnabled ⇒ failover) → (finished ∨ stuck ⇒ synthesize), all under a per-formation mutex; terminal states are absorbing.

## 4. Invariants and enforcing tests

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Features off ⇒ behaviour unchanged | "is disabled by default…" |
| I2 | `suspended` ⇒ every active descendant `deferred` | barrier test (Child C mid-tool); 4-level test |
| I3 | A completed tool receipt is never replayed on resume | defer/safe_boundary tests |
| I4 | Deferred tasks are never marked `failed`/`completed` | "never marks tasks failed or completed" |
| I5 | ≤ 1 initial + ≤ 1 corrective review per completion event | "bounded 1+1 termination" |
| I6 | Only verified, non-hypothetical defects ⇒ `REMEDIATE` | category-separation tests |
| I7 | ≤ 2 attempts per Legion slot | "fails over … exactly once" |
| I8 | Terminal member states are absorbing | idempotency + failover tests |
| I9 | Stage *k* never runs before stages < *k* are resolved | DAG gating test |
| I10 | A file isn't reserved by Legion for a stream if another *active* stream holds it | formation test (**concurrent-form race untested**, see §7) |
| I11 | Flush never violates FK order | real-SQLite tests (section 5 + Legion lifecycle) |
| I12 | No lost update under concurrent sibling completion | concurrency test; 4-level concurrent test |

## 5. Correctness arguments (sketch)
- **I2:** phase `suspended` is assigned only in `evaluateAndPersistPipelineState` when `pending = ∅` after deferring all descendants; `pending` is recomputed from durable statuses, so a late-finishing child cannot be missed (re-triggered by its own completion/failure).
- **I8/I12:** every manifest mutation occurs inside `withFormationLock(formationId)`; the first branch of the reconcile body returns when the member is already terminal, so replays are no-ops.
- **I7:** `nextAttempt = attempt + 1 > 2` short-circuits before any insert.
- **Progress:** each loop is bounded (I5, I7, inbox cap) ⇒ termination or explicit escalation.

## 6. Evaluation
Automated: 34 swarm tests (8 sections), 14 orchestrator tests, state-key tests (80 total backend assertions), 7 component tests; four tests flush to a real SQLite file with foreign keys on. Defects found by evaluation are in [post-mortems](../postmortems/README.md); six were persistence/phase-semantic and invisible to the in-memory test double. **Not evaluated:** performance under load, live-host behaviour, real model-driven execution of specialists.

**Overhead when off:** one config resolution per entry point (30 s cache) and one profile lookup in `settleLegionSpecialist`.

## 7. Limitations
1. In-process locks only (single extension host). 2. No mid-turn restoration. 3. Heuristic classification. 4. Review engine consumes findings; it does not generate them with a model. 5. File reservation is check-then-act (L11). 6. Other modules were not audited for stranded shadow-overlay writes (L12; the in-scope instances are fixed — PM-011). 7. Specialist execution depends on a host runner (L2). Full list: [findings](../implementation/findings.md#known-limits-and-open-questions).

## 8. Related decisions and further reading
[ADR-0001 … 0011](../adr/README.md) · [Data model](../architecture/data-model.md) · [Configuration](../architecture/configuration.md) · [Philosophy](01-philosophy.md) · [Stakeholder hand-off](02-stakeholder-handoff.md)
