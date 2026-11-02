# Onboarding — Maintainers (Ownership, Operations & Zero-to-Hero Index)

Welcome! If you have **never seen LUMI or `agentswarm` before** and are taking over ownership, operation, code review, or release management of this subsystem, start here.

---

## 0. Complete Maintainers' Zero-to-Hero Handbook (`maintainers/`)

For a deep, self-contained walkthrough that assumes **zero prior knowledge** of LUMI, read the 4-part handbook in [`maintainers/`](../maintainers/README.md):

1. **[01 — The System from Scratch](../maintainers/01-system-from-scratch.md):** What LUMI is, how a single-agent task runs (`Controller` → `Task` → `ToolExecutor` → `AttemptCompletionHandler`), how `AgentOrchestrator` and `BufferedDbPool` work, and how the 3 Agent Swarm engines (**Hierarchical Defer**, **Critical Completion Review**, **The Legion**) plug in while remaining 100% inert by default.
2. **[02 — Line-by-Line Codebase Tour](../maintainers/02-codebase-tour.md):** Exact file-by-file, method-by-method, and line-anchor walkthrough of every file you own — including **what breaks if you weaken each guard**.
3. **[03 — Day-2 Operating & SQLite Inspection Handbook](../maintainers/03-operating-handbook.md):** Where `joyzoning.sqlite` lives on macOS/Linux/Windows, WAL & corruption auto-recovery, `BufferedDbPool` 1s flush + 5min shadow expiry + operation sort order, log prefixes to grep, and **8 empirically verified `sqlite3` diagnostic queries (`Q1`–`Q8`)**.
4. **[04 — Failure Modes, War Games & Recovery Drills](../maintainers/04-failure-modes-and-drills.md):** Mutation-testing proofs (`M1`–`M4`) and hands-on recovery drills for stuck barriers, specialist crashes, SQLite flush errors, config precedence surprises, and interrupted AI subagent work.

---

## 1. What You Own (At a Glance)

| Area | Files | Core Invariant You Protect |
|---|---|---|
| **Toggle & Precedence** | `src/infrastructure/ai/AgentSwarmConfig.ts`, `package.json` (`lumi.agentSwarm.*`) | **Off by default**; 5-tier precedence; explicit-vs-default detection in `StateManager` ([ADR-0001](../adr/ADR-0001-auxiliary-off-by-default.md), [ADR-0006](../adr/ADR-0006-config-precedence-and-explicit-detection.md), [PM-004](../postmortems/PM-004-statemanager-defaults-clobber-settings.md)) |
| **Hierarchical Defer** | `src/infrastructure/ai/HierarchicalDeferCoordinator.ts` | **Defer ≠ cancel**; multi-level BFS barrier; dead-child reconciliation; no post-resume re-suspension; no blind step replay ([ADR-0002](../adr/ADR-0002-defer-is-not-cancel.md), [ADR-0004](../adr/ADR-0004-suspension-barrier-and-ancestor-walk.md), [PM-006](../postmortems/PM-006-multi-level-barrier-deadlock.md), [PM-012](../postmortems/PM-012-post-resume-reconcile-and-delete-upsert-ordering.md)) |
| **Critical Review** | `src/infrastructure/ai/CriticalCompletionReview.ts`, `src/core/task/tools/completionGatePipeline.ts`, `src/core/task/tools/handlers/AttemptCompletionHandler.ts` | **Bounded 1+1** (1 follow-up + 1 remediation max); strict `verified_defect` vs. `unverified_concern` separation; `finally` auto-resume ([ADR-0005](../adr/ADR-0005-bounded-review-with-category-separation.md), [PM-007](../postmortems/PM-007-review-left-pipeline-suspended-and-unwired.md)) |
| **The Legion** | `src/infrastructure/ai/LegionCoordinator.ts`, `src/infrastructure/ai/Orchestrator.ts` | Deterministic multi-signal classification; 5-stage gated handoff; active-only file reservation checks; **terminal states (`completed`/`failed`/`rerouted`) are final**; max 2 attempts per slot ([ADR-0008](../adr/ADR-0008-deterministic-legion-classification.md), [ADR-0009](../adr/ADR-0009-legion-lifecycle-dag-failover-terminal-states.md), [PM-008](../postmortems/PM-008-stale-reservation-false-positives.md), [PM-009](../postmortems/PM-009-terminal-state-flip-and-unwired-lifecycle.md)) |
| **Persistence** | `src/infrastructure/db/BufferedDbPool.ts`, `src/infrastructure/ai/Orchestrator.ts` | `TABLE_FK_ORDER` flush order; composite `conflictTarget: ["streamId", "key"]` on `agent_memory`; **no shadow writes after `commitWork` or on shared rows**; flush before same-batch reservation deletes ([ADR-0003](../adr/ADR-0003-durable-state-in-agent-memory.md), [ADR-0010](../adr/ADR-0010-direct-writes-for-shared-rows.md), [PM-001](../postmortems/PM-001-shadow-buffer-foreign-key-failure.md), [PM-011](../postmortems/PM-011-completion-state-stranded-in-shadow-overlay.md), [PM-012](../postmortems/PM-012-post-resume-reconcile-and-delete-upsert-ordering.md)) |
| **Settings Surface** | `proto/dietcode/state.proto`, `state-keys.ts`, `ExtensionMessage.ts`, `updateSettings.ts`, `updateTaskSettings.ts`, `ToolExecutor.ts`, `TaskConfig.ts`, `ToolConstants.ts`, `Controller`, `webview-ui/**` | All 7 layers move together ([ADR-0007](../adr/ADR-0007-settings-through-proto-with-boundary-clamping.md), [PB-02](../playbooks/PB-02-add-a-setting-end-to-end.md), [PM-005](../postmortems/PM-005-task-config-keys-drift.md)) |

---

## 2. PR Review Checklist (Copy-Paste into Pull Requests)

**Behavioural & Safety**
- [ ] With every Agent Swarm setting at default (`false`), single-agent behaviour is untouched (test: *"is disabled by default and does not alter normal completion or defer flows"*).
- [ ] No unbounded loop introduced; every retry/review/failover has a numeric cap and a unit test proving termination.
- [ ] Terminal member/stream states (`completed`, `failed`, `rerouted`) cannot be overwritten by later events, and `reconcilePipelineBarrier` only runs when `pipeline.phase` is `"waiting_for_children"` or `"suspending"`.

**Persistence (`BufferedDbPool` & SQLite)**
- [ ] Every new `agent_memory` upsert includes `conflictTarget: ["streamId", "key"]` and `where: [{ column: "streamId", ... }, { column: "key", ... }]`.
- [ ] No new `dbPool.push(op, agentId)` or `dbPool.pushBatch(ops, agentId)` on `agent_streams` or after `dbPool.commitWork(agentId)` ([ADR-0010](../adr/ADR-0010-direct-writes-for-shared-rows.md), [PM-011](../postmortems/PM-011-completion-state-stranded-in-shadow-overlay.md)).
- [ ] No un-flushed `delete` queued in the same 1s batch as a prior `upsert` on the same key without an intermediate `await dbPool.flush()` ([PM-012](../postmortems/PM-012-post-resume-reconcile-and-delete-upsert-ordering.md)).
- [ ] At least one test exercises the new code path against the **real SQLite `BufferedDbPool`** and calls `await dbPool.flush()`.

**Settings & UI**
- [ ] All 7 layers in [PB-02](../playbooks/PB-02-add-a-setting-end-to-end.md) updated; `TASK_CONFIG_KEYS` includes any new keys; numeric inputs clamped at the controller boundary (`updateSettings.ts` & `updateTaskSettings.ts`).
- [ ] Webview component test (`FeatureSettingsSection.test.tsx`) updated; accessible labels preserved.

**Hygiene**
- [ ] `npx tsc --noEmit` and `npx tsc -b webview-ui --pretty false` exit `0`.
- [ ] `npx biome check --diagnostic-level=error` clean on all touched files; no `DEBUG` or stray `console.error` left behind.
- [ ] ADR added/updated if an architectural decision changed; post-mortem added if a bug escaped.

---

## 3. Release Gates

1. Full automated verification block from [PB-07](../playbooks/PB-07-release-verification.md) passes (**34 tests** in `AgentSwarmAuxiliary.test.ts`, **46 tests** across `Orchestrator.test.ts` + `state-keys.test.ts`, **7 tests** in `FeatureSettingsSection.test.tsx`).
2. Real-SQLite persistence tests (Section 5 and Section 8 of `AgentSwarmAuxiliary.test.ts`) pass.
3. Manual smoke in a live VS Code Extension Development Host window (**not yet performed at wiki authoring time — see [findings](../implementation/findings.md#known-limits-and-open-questions)**).
4. Confirm defaults in `state-keys.ts` and `package.json` remain `false` / `safe_boundary` / `adaptive` / `1` / `1` / `4`.

---

## 4. Handling Incoming Work from AI Agents

Treat AI agent completion reports as **unverified claims** until proven on disk. Before merging or building on agent work:
- Run the 5-step audit in [04 — Failure Modes, War Games & Recovery Drills](../maintainers/04-failure-modes-and-drills.md#6-drill-5-auditing-an-interrupted-ai-subagent-or-pr-pb-08).
- Inspect `git diff --stat` and look for **regressions of earlier fixes** and **public methods with zero production callers** ([PM-009](../postmortems/PM-009-terminal-state-flip-and-unwired-lifecycle.md), [PM-010](../postmortems/PM-010-interrupted-worker-partial-work.md)).
- Confirm any test title the agent claims to have added actually exists (`grep -n "<test title>" src/`).

---

## 5. Known Operational Sharp Edges

1. **Environment variables beat the Webview UI:** `LUMI_AGENT_SWARM_*` overrides webview toggles and `settings.json` (precedence: Default < VS Code < Explicit `StateManager` < Env < Runtime override).
2. **30-second config cache:** `updateSettings` and `updateTaskSettings` call `invalidateAgentSwarmConfigCache()`; direct `StateManager` writes do not.
3. **Shadow overlays vs. `activeBuffer`:** Any write issued with an `agentId` after `commitWork(agentId)` never reaches SQLite and is garbage-collected after 5 minutes by `cleanupShadows` ([PM-011](../postmortems/PM-011-completion-state-stranded-in-shadow-overlay.md)).
4. **Same-batch `delete` vs. `upsert` sorting:** `BufferedDbPool.flush()` sorts operations on the same table and layer alphabetically by `op.type` (`delete` < `insert` < `update` < `upsert`). Deleting a row that was upserted in the same un-flushed batch requires calling `await dbPool.flush()` before queueing the delete ([PM-012](../postmortems/PM-012-post-resume-reconcile-and-delete-upsert-ordering.md)).
5. **Legion coordinates; host runners execute:** `LegionCoordinator` creates child streams and `pending` tasks and manages stage gates, failover, and synthesis when `completeStream`/`failStream` are called. Ensure your host task runner polls child stream tasks and invokes `completeStream`/`failStream`.

---

## 6. Deprecation / Alias Policy

`legion_Trends_ux` is a legacy alias for `legion_ux_ergonomics` ([ADR-0011](../adr/ADR-0011-legacy-role-alias.md)). Keep accepting it via `normalizeLegionRoleId`; always emit the canonical ID `legion_ux_ergonomics`. Do not remove the alias without a documented migration window.

---

## 7. Navigating the Rest of the Wiki

- **[Feature Changelog (`CHANGELOG.md`)](../CHANGELOG.md)** — Chronological history of Phases 1–5, architectural milestones, and bug fixes
- **[Maintainers' Handbook (`maintainers/`)](../maintainers/README.md)** — Zero-to-hero system guide, codebase tour, SQLite operating cookbook (`Q1`–`Q8`), and failure drills (`M1`–`M4`)
- **[ADRs (`adr/`)](../adr/README.md)** — Why every architectural decision was made (ADR-0001 through ADR-0011)
- **[Post-Mortems (`postmortems/`)](../postmortems/README.md)** — Every bug discovered and fixed during implementation and verification (PM-001 through PM-012)
- **[Playbooks (`playbooks/`)](../playbooks/README.md)** — Step-by-step operational recipes (PB-01 through PB-08)
- **[Papers (`papers/`)](../papers/01-philosophy.md)** — [Philosophy](../papers/01-philosophy.md) · [Stakeholder Handoff](../papers/02-stakeholder-handoff.md) · [Technical Whitepaper](../papers/03-technical-whitepaper.md)
