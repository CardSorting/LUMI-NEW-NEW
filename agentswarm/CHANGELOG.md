# Agent Swarm & The Legion — Feature Changelog

All notable changes, architectural milestones, bug fixes, schema/storage additions, and operational hardening passes for LUMI's **Agent Swarm** (`Critical Completion Review`, `Hierarchical Defer & Resume`, and `The Legion`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), augmented with **Invariant Impact**, **Post-Mortem / ADR Traceability**, and **Verification Proofs** so maintainers can track this ongoing multi-engine subsystem without guesswork.

> **Original Specification Anchor:** [`agentswarm.md`](agentswarm.md), [`agentswarm2.md`](agentswarm2.md), [`agentswarm3.md`](agentswarm3.md), [`agentswarm4.md`](agentswarm4.md) (preserved untouched).

---

## Release & Phase Summary

| Phase / Milestone | Date | Focus | Key Post-Mortems / ADRs | Test Count (`AgentSwarmAuxiliary.test.ts`) |
|---|---|---|---|---|
| **[Phase 5 — Maintainer Hand-off, SQLite Cookbook & Persistence Hardening](#phase-5--maintainer-hand-off-sqlite-cookbook--persistence-hardening-2026-11-02)** | 2026-11-02 | Zero-to-hero Maintainers' Handbook, real-SQLite `Q1`–`Q8` probe, post-commit shadow stranding fix, post-resume barrier guard, same-batch `delete`/`upsert` ordering fix | [PM-011](postmortems/PM-011-completion-state-stranded-in-shadow-overlay.md), [PM-012](postmortems/PM-012-post-resume-reconcile-and-delete-upsert-ordering.md), [ADR-0010](adr/ADR-0010-direct-writes-for-shared-rows.md) | **34** (80 total backend + 7 webview) |
| **[Phase 4 — Zenith Tier: Legion Lifecycle, DAG Stage Gating, Bounded Failover & Wiki](#phase-4--zenith-tier-legion-lifecycle-dag-stage-gating-bounded-failover--wiki-2026-11-02)** | 2026-11-02 | Automatic stage progression on `completeStream`/`failStream`, bounded 1-retry specialist failover (`LEGION_MAX_ATTEMPTS_PER_SLOT = 2`), absorbing terminal states, per-formation mutex, Interrupted-Worker Audit, full Knowledge Base Wiki | [PM-008](postmortems/PM-008-stale-reservation-false-positives.md), [PM-009](postmortems/PM-009-terminal-state-flip-and-unwired-lifecycle.md), [PM-010](postmortems/PM-010-interrupted-worker-partial-work.md), [ADR-0009](adr/ADR-0009-legion-lifecycle-dag-failover-terminal-states.md), [ADR-0011](adr/ADR-0011-legacy-role-alias.md) | **31** |
| **[Phase 3 — The Legion: Specialist Classification, Formation & Webview Roster](#phase-3--the-legion-specialist-classification-formation--webview-roster-2026-11-02)** | 2026-11-02 | 10 specialist archetypes across 5 stages, deterministic multi-signal classifier, file-reservation partitioning, remedial specialist spawning, proto + Webview UI Legion controls | [ADR-0008](adr/ADR-0008-deterministic-legion-classification.md) | **25** |
| **[Phase 2 — Multi-Level Barrier, Real-SQLite Flush Order & Config Precedence Hardening](#phase-2--multi-level-barrier-real-sqlite-flush-order--config-precedence-hardening-2026-11-02)** | 2026-11-02 | 4-level BFS hierarchy barrier, dead-child failure reconciliation, `BufferedDbPool` `TABLE_FK_ORDER` & composite `conflictTarget` upserts, `AttemptCompletionHandler` gate wiring, explicit `StateManager` detection | [PM-001](postmortems/PM-001-shadow-buffer-foreign-key-failure.md)–[PM-007](postmortems/PM-007-review-left-pipeline-suspended-and-unwired.md), [ADR-0003](adr/ADR-0003-durable-state-in-agent-memory.md)–[ADR-0007](adr/ADR-0007-settings-through-proto-with-boundary-clamping.md) | **20** |
| **[Phase 1 — Foundation: Auxiliary Toggle, Cooperative Defer & Critical Completion Review](#phase-1--foundation-auxiliary-toggle-cooperative-defer--critical-completion-review-2026-11-02)** | 2026-11-02 | Initial `AgentSwarmConfig`, `HierarchicalDeferCoordinator`, `CriticalCompletionReviewService`, `Orchestrator` integration, protobuf & React Settings UI | [ADR-0001](adr/ADR-0001-auxiliary-off-by-default.md), [ADR-0002](adr/ADR-0002-defer-is-not-cancel.md) | **12** |

---

## [Unreleased / Active Working Tree]

> **Git Working Tree Note:** At the time of this changelog entry, all Phase 1–5 changes reside in the working tree (`git status` shows modified tracked files and untracked files under `src/infrastructure/ai/` and `agentswarm/`). Verify `git log` when cutting a tagged release.

---

## Phase 5 — Maintainer Hand-off, SQLite Cookbook & Persistence Hardening (2026-11-02)

### Added
- **Zero-to-Hero Maintainers' Handbook (`agentswarm/maintainers/`):**
  - [`maintainers/README.md`](maintainers/README.md): 4-part structured learning path and quick-reference index.
  - [`maintainers/01-system-from-scratch.md`](maintainers/01-system-from-scratch.md): Zero-prior-knowledge system walkthrough (`Controller` → `Task` → `ToolExecutor` → `AttemptCompletionHandler`, `AgentOrchestrator`, `BufferedDbPool` active buffer vs. shadow overlays, and the 3 Agent Swarm engines).
  - [`maintainers/02-codebase-tour.md`](maintainers/02-codebase-tour.md): File-by-file, line-anchor ownership map and invariant guide.
  - [`maintainers/03-operating-handbook.md`](maintainers/03-operating-handbook.md): OS-specific paths for `joyzoning.sqlite` (`workspaceStorage`/`globalStorage`) and `dietcode.db`, WAL & `.corrupt.<timestamp>` recovery behavior, `BufferedDbPool` 1s flush + 5min shadow expiration + sort order, log prefixes, and **8 empirically verified `sqlite3` diagnostic queries (`Q1`–`Q8`)**.
  - [`maintainers/04-failure-modes-and-drills.md`](maintainers/04-failure-modes-and-drills.md): Mutation-testing proofs (`M1`–`M4`) and 5 operational war-game drills.
- **Post-Mortems & Real-SQLite Regression Tests:**
  - Added [`PM-011`](postmortems/PM-011-completion-state-stranded-in-shadow-overlay.md) and [`PM-012`](postmortems/PM-012-post-resume-reconcile-and-delete-upsert-ordering.md).
  - Added 3 real-SQLite persistence tests in `src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts` (Section 5) covering on-disk `completeStream` status/summary visibility, on-disk reservation deletion, barrier release on child completion, and post-resume child completion stability.

### Fixed
- **Post-Commit Shadow Overlay Stranding in `Orchestrator.completeStream` & File Reservation Releases ([PM-011](postmortems/PM-011-completion-state-stranded-in-shadow-overlay.md)):**
  - `Orchestrator.completeStream` previously called `await dbPool.commitWork(streamId)` and *then* called `dbPool.pushBatch(ops, streamId)` with `streamId` as the shadow `agentId`. Because nothing ever called `commitWork(streamId)` a second time, the stream's `status = 'completed'` and `stream_summary` never reached SQLite and were discarded after 5 minutes by `cleanupShadows`. `releaseFiles` and `releaseAllReservations` had the same shadow-stranding bug for `delete` operations.
  - **Fix (`src/infrastructure/ai/Orchestrator.ts`):** Removed the `streamId` second argument from `completeStream`'s final `pushBatch` and from `releaseFiles` / `releaseAllReservations` so completion state and reservation releases write directly to `activeBuffer`.
- **Post-Resume Barrier Reconciliation Re-Suspending a Resumed Parent ([PM-012a](postmortems/PM-012-post-resume-reconcile-and-delete-upsert-ordering.md)):**
  - When a deferred hierarchy was resumed (`pipeline.phase = "resumed"`) and a child stream subsequently finished (`completeStream` → `reconcileAfterStreamFailure` → `reconcilePipelineBarrier`), `reconcilePipelineBarrier` re-evaluated the already-resumed pipeline and set the root stream back to `state: "waiting_for_children"`, `acceptingNewWork: false`.
  - **Fix (`src/infrastructure/ai/HierarchicalDeferCoordinator.ts`):** Guarded `reconcilePipelineBarrier` so it immediately returns `null` unless `pipeline.phase === "waiting_for_children" || pipeline.phase === "suspending"`.
- **Same-Batch Reservation `delete` Sorted Before `upsert` in `BufferedDbPool.flush()` ([PM-012b](postmortems/PM-012-post-resume-reconcile-and-delete-upsert-ordering.md)):**
  - Because `BufferedDbPool.flush()` sorts operations on the same table and layer alphabetically by `op.type` (`"delete"` < `"insert"` < `"update"` < `"upsert"`), reserving (`upsert`) and releasing (`delete`) a file within the same un-flushed 1s window caused `DELETE` to execute before `INSERT ... ON CONFLICT DO UPDATE`, resurrecting the deleted `file_res:*` row on disk.
  - **Fix (`src/infrastructure/ai/Orchestrator.ts`):** `releaseFiles` and `releaseAllReservations` now call `await dbPool.flush()` before queuing `delete` operations when reservations exist.

---

## Phase 4 — Zenith Tier: Legion Lifecycle, DAG Stage Gating, Bounded Failover & Wiki (2026-11-02)

### Added
- **End-to-End Legion Lifecycle & DAG Stage Gating (`src/infrastructure/ai/LegionCoordinator.ts`, `src/infrastructure/ai/Orchestrator.ts`):**
  - Implemented `settleSpecialistStream`, `reconcileSpecialistStreamLifecycle`, `failoverSpecialistStream`, and `synthesizeLegionOutcome` ([ADR-0009](adr/ADR-0009-legion-lifecycle-dag-failover-terminal-states.md)).
  - Wired `Orchestrator.completeStream` and `Orchestrator.failStream` to automatically call `settleLegionSpecialist` so specialist completions advance downstream stages (`leadAndRecon` → `parallelExecution` → `verificationAndHardening`) and inject upstream handoff summaries into downstream task payloads.
  - Added per-formation in-process Promise mutex (`withFormationLock(formationId)`) to prevent lost updates when sibling specialists settle concurrently.
  - Added bounded automatic failover (`LEGION_MAX_ATTEMPTS_PER_SLOT = 2`): when a specialist stream fails, `LegionCoordinator` marks the original slot `"rerouted"` and spawns one fallback specialist from `fallbackRoleIds`. If the second attempt fails, the slot is marked `"failed"` and escalated in the synthesis report.
- **Complete `agentswarm/` Knowledge Base Wiki (41 initial documents):**
  - 3 Papers: [`01-philosophy.md`](papers/01-philosophy.md), [`02-stakeholder-handoff.md`](papers/02-stakeholder-handoff.md), [`03-technical-whitepaper.md`](papers/03-technical-whitepaper.md).
  - 3 Role-Specific Onboarding Guides: [`for-human-developers.md`](onboarding/for-human-developers.md), [`for-agents.md`](onboarding/for-agents.md), [`for-maintainers.md`](onboarding/for-maintainers.md).
  - Architecture Docs: [`how-it-works.md`](architecture/how-it-works.md), [`data-model.md`](architecture/data-model.md), [`configuration.md`](architecture/configuration.md).
  - 11 ADRs ([`ADR-0001`](adr/ADR-0001-auxiliary-off-by-default.md) through [`ADR-0011`](adr/ADR-0011-legacy-role-alias.md)), 10 initial Post-Mortems (`PM-001` through `PM-010`), 8 Playbooks (`PB-01` through `PB-08`), [`glossary.md`](glossary.md), [`reincorporation.md`](reincorporation.md), and [`implementation/`](implementation/file-map.md).

### Fixed
- **Interrupted Subagent Audit & Restoration ([PM-010](postmortems/PM-010-interrupted-worker-partial-work.md), [PB-08](playbooks/PB-08-audit-after-interrupted-work.md)):**
  - After a background worker hit a provider quota limit (`429 RESOURCE_EXHAUSTED`) mid-turn while editing `LegionCoordinator.ts`, audited the partial diff and restored two regressed persistence invariants:
    1. Restored direct (non-shadow) `agent_streams` inserts in `formLegion` and `failoverSpecialistStream` ([PM-001](postmortems/PM-001-shadow-buffer-foreign-key-failure.md)).
    2. Restored `dbPool.selectWhere("agent_memory", ...)` active-stream filtering for `file_res:*` conflict checks ([PM-008](postmortems/PM-008-stale-reservation-false-positives.md)).
- **Absorbing Terminal Member States ([PM-009](postmortems/PM-009-terminal-state-flip-and-unwired-lifecycle.md)):**
  - Prevented repeated or out-of-order lifecycle events from flipping a slot's status from `"rerouted"` to `"failed"` (or `"completed"` to `"failed"`). Terminal states (`"completed"`, `"failed"`, `"rerouted"`) are now strictly final and idempotent.
- **Canonical Role Normalization (`legion_ux_ergonomics` vs. `legion_Trends_ux`, [ADR-0011](adr/ADR-0011-legacy-role-alias.md)):**
  - Standardized on `legion_ux_ergonomics` across registry, UI, and docs while keeping `legion_Trends_ux` accepted as a backwards-compatible alias via `normalizeLegionRoleId`.

---

## Phase 3 — The Legion: Specialist Classification, Formation & Webview Roster (2026-11-02)

### Added
- **`LegionCoordinator` Engine (`src/infrastructure/ai/LegionCoordinator.ts`, [ADR-0008](adr/ADR-0008-deterministic-legion-classification.md)):**
  - Defined 7 core + 3 extended specialist archetypes (`legion_systems_architect`, `legion_codebase_researcher`, `legion_implementation_engineer`, `legion_resilience_hardener`, `legion_ux_ergonomics`, `legion_verification_qa`, `legion_security_auditor`, `legion_performance_profiler`, `legion_data_migration_specialist`, `legion_documentation_synthesizer`).
  - Implemented deterministic multi-signal classification (`classifyTask`) using weighted keyword groups, file-path regex patterns, task intent bonuses, complexity scoring (`1..10`), and formation strategies (`adaptive`, `tactical_strike` / `lean`, `balanced_squad` / `balanced`, `full_legion` / `thorough`, `verification_heavy`).
  - Implemented `formLegion` to spawn specialist child streams, partition target files so no two specialists reserve the same file, and update the parent stream's `rolling_roadmap_snapshot`.
  - Integrated Remedial Legion recommendations into `CriticalCompletionReviewService`: when a review emits `REMEDIATE`, corrective tasks are annotated with recommended specialist archetypes and can spawn a remedial cohort via `spawnRemedialLegionForReview`.
- **End-to-End Legion Settings & Protobuf Surface:**
  - Added `agent_swarm_legion_enabled`, `agent_swarm_legion_default_strategy`, and `agent_swarm_legion_max_specialists` (`346–348` in `Settings`, `62–64` in `UpdateSettingsRequest` in `proto/dietcode/state.proto`).
  - Added interactive Legion Specialist Roster preview, strategy selector, max specialist slider (`1..8`), and 1-click *Legion Only* / *Full Swarm + Legion* presets in `webview-ui/src/components/settings/sections/FeatureSettingsSection.tsx`.

---

## Phase 2 — Multi-Level Barrier, Real-SQLite Flush Order & Config Precedence Hardening (2026-11-02)

### Added
- **Completion Gate Wiring (`src/core/task/tools/completionGatePipeline.ts`, `src/core/task/tools/handlers/AttemptCompletionHandler.ts`):**
  - Wired `evaluateOptionalCriticalCompletionReview` directly into `AttemptCompletionHandler` after the build/audit gate passes ([PM-007](postmortems/PM-007-review-left-pipeline-suspended-and-unwired.md)).
- **Webview Settings Navigation & Ergonomics (`webview-ui/src/components/settings/sections/FeatureSettingsSection.tsx`, `SettingsView.tsx`):**
  - Added preference search/filter bar with match counts and 1-click reset, section jump pills, 1-click Workflow Presets (*Standard (Off)*, *Review Only*, *Defer Only*, *Full Swarm*), and `updateSettingsBatch` for atomic preset updates.

### Fixed
- **Shadow Buffer Foreign-Key Failures on `agent_streams` ([PM-001](postmortems/PM-001-shadow-buffer-foreign-key-failure.md), [ADR-0010](adr/ADR-0010-direct-writes-for-shared-rows.md)):**
  - Changed `Orchestrator.createStream` and `spawnSubAgent` to push `agent_streams` inserts directly to `activeBuffer` (no `agentId` shadow parameter) so child rows in `agent_tasks` and `agent_memory` never flush before their parent stream row exists in SQLite.
- **Composite Primary-Key Upserts on `agent_memory` ([PM-002](postmortems/PM-002-upsert-without-conflict-target.md)):**
  - Updated all `agent_memory` upserts across `Orchestrator`, `HierarchicalDeferCoordinator`, `CriticalCompletionReview`, and `LegionCoordinator` to include `conflictTarget: ["streamId", "key"]` and composite `where` clauses; updated `BufferedDbPool.push()` in-memory upsert coalescing to match all columns in `conflictTarget`.
- **FK-Safe Table Flush Ordering in `BufferedDbPool.flush()` ([PM-003](postmortems/PM-003-flush-order-layer-priority.md)):**
  - Added `TABLE_FK_ORDER` (`agent_streams: 5` < `agent_tasks: 6` < `agent_memory: 7`) as the primary sort key in `BufferedDbPool.flush()` ahead of `LAYER_PRIORITY`.
- **Unpersisted `StateManager` Defaults Clobbering `settings.json` & Env Overrides ([PM-004](postmortems/PM-004-statemanager-defaults-clobber-settings.md), [ADR-0006](adr/ADR-0006-config-precedence-and-explicit-detection.md)):**
  - Added `getExplicitStateManagerSetting` in `AgentSwarmConfig.ts` to inspect raw backing maps and `workspace.getConfiguration("lumi").inspect(...)` so pre-filled `DEFAULT_SETTINGS` in `StateManager` never mask `settings.json` or environment variables.
  - Updated `Controller.getStateToPostToWebview` (`src/core/controller/index.ts`) to post effective resolved Agent Swarm values to the webview.
- **`TASK_CONFIG_KEYS` Synchronization ([PM-005](postmortems/PM-005-task-config-keys-drift.md)):**
  - Added all `agentSwarm*` keys to `TASK_CONFIG_KEYS` (`src/core/task/tools/utils/ToolConstants.ts`) and added a unit test asserting their presence.
- **Multi-Level Hierarchy Barrier Deadlocks & Child Crash Handling ([PM-006](postmortems/PM-006-multi-level-barrier-deadlock.md), [ADR-0004](adr/ADR-0004-suspension-barrier-and-ancestor-walk.md)):**
  - Replaced single-level child lookup with cycle-safe BFS traversal (`collectHierarchyStreams`) across arbitrary hierarchy depths (parent → child → grandchild), added per-pipeline mutex (`withPipelineLock`), and wired `reconcileAfterStreamFailure` into `Orchestrator.completeStream` and `failStream`.
- **Auto-Deferred Pipelines Left Suspended After Review ([PM-007](postmortems/PM-007-review-left-pipeline-suspended-and-unwired.md)):**
  - Wrapped `CriticalCompletionReviewService.runReview` in a `try / finally` that automatically resumes any hierarchy auto-suspended for the review (unless the review decision is `ESCALATE`).

---

## Phase 1 — Foundation: Auxiliary Toggle, Cooperative Defer & Critical Completion Review (2026-11-02)

### Added
- **Auxiliary Configuration & Precedence (`src/infrastructure/ai/AgentSwarmConfig.ts`, [ADR-0001](adr/ADR-0001-auxiliary-off-by-default.md)):**
  - Created opt-in configuration system (default **off**) supporting Global, Per-Agent, Per-Task, Environment Variable, and Manual Invocation overrides.
- **Cooperative Hierarchical Defer (`src/infrastructure/ai/HierarchicalDeferCoordinator.ts`, [ADR-0002](adr/ADR-0002-defer-is-not-cancel.md)):**
  - Implemented `deferAgent`, `resumeAgent`, `deferHierarchy`, `resumeHierarchy`, `acknowledgeChildSuspension`, durable control inboxes (`stream_control_inbox`), execution checkpoints (`stream_execution_checkpoint`), step receipts (`stream_step_receipts`), and parent work-acceptance gates (`acceptingNewWork`).
- **Bounded Critical Completion Review (`src/infrastructure/ai/CriticalCompletionReview.ts`, [ADR-0005](adr/ADR-0005-bounded-review-with-category-separation.md)):**
  - Implemented evidence-based finding classification (`verified_defect` vs. `unverified_concern` vs. `optional_improvement`), 4-way decisive resolution (`ACCEPT`, `ACCEPT_WITH_NOTE`, `REMEDIATE`, `ESCALATE`), 1+1 review/remediation bounds, and coordinator report formatting (`formatCoordinatorFinalReport`).
- **Initial Protobuf & Settings Plumbing (`proto/dietcode/state.proto`, `state-keys.ts`, `updateSettings.ts`, `updateTaskSettings.ts`, `FeatureSettingsSection.tsx`):**
  - Added initial 7 `agent_swarm_*` protobuf fields (`339–345`), controller clamping (`0..3` passes), and React settings toggles.

---

## How to Maintain This Changelog Going Forward

Whenever you modify any file listed in [`implementation/file-map.md`](implementation/file-map.md):
1. Add an entry under a dated phase/version header at the top of this file (`Added`, `Changed`, `Fixed`, `Removed`).
2. Link any new architectural decision to a new ADR in [`adr/`](adr/README.md) and any escaped defect to a new post-mortem in [`postmortems/`](postmortems/README.md).
3. Update the test count in the **Release & Phase Summary** table and run the verification suite in [`playbooks/PB-07-release-verification.md`](playbooks/PB-07-release-verification.md).

