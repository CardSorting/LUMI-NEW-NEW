# Post-mortems

Blameless. Each lists reproduction, root cause, fix, why it escaped, and the prevention now in place. Dates are the authoring date of this wiki; all incidents occurred during the initial implementation.

| ID | Title | Severity |
|---|---|---|
| [PM-001](PM-001-shadow-buffer-foreign-key-failure.md) | Shadow-buffer push caused `FOREIGN KEY constraint failed` on flush | High (flush failure; reappeared twice) |
| [PM-002](PM-002-upsert-without-conflict-target.md) | `agent_memory` upserts without `conflictTarget` failed or duplicated rows | High |
| [PM-003](PM-003-flush-order-layer-priority.md) | Flush ordered by layer priority, not by FK dependency | Medium |
| [PM-004](PM-004-statemanager-defaults-clobber-settings.md) | Unpersisted `StateManager` defaults clobbered `settings.json` and the webview showed "Off" | Medium |
| [PM-005](PM-005-task-config-keys-drift.md) | `TASK_CONFIG_KEYS` missed the new `agentSwarm*` keys | Low–Medium |
| [PM-006](PM-006-multi-level-barrier-deadlock.md) | Suspension barrier stuck in multi-level hierarchies and on child failure | High |
| [PM-007](PM-007-review-left-pipeline-suspended-and-unwired.md) | Review left the pipeline suspended and was not wired into `attempt_completion` | Medium |
| [PM-008](PM-008-stale-reservation-false-positives.md) | File-reservation check used `selectOne` and ignored stream liveness | Medium |
| [PM-009](PM-009-terminal-state-flip-and-unwired-lifecycle.md) | Terminal member state could flip (`rerouted → failed`); lifecycle APIs had no callers | Medium |
| [PM-010](PM-010-interrupted-worker-partial-work.md) | Interrupted worker left partial, regressed and unwired work; status was mis-reported | Medium (process) |
| [PM-011](PM-011-completion-state-stranded-in-shadow-overlay.md) | Completion state and reservation releases were stranded in a shadow overlay | High |
| [PM-012](PM-012-post-resume-reconcile-and-delete-upsert-ordering.md) | Post-resume barrier reconciliation re-suspended a resumed parent; same-batch reservation `delete` sorted before `upsert` | High |
| [PM-013](PM-013-dead-code-steering-interrupt-and-specialist-drift.md) | Dead-code steering interrupt during active Legion execution; specialist handoff drift across multi-turn user messages | High |
| [PM-014](PM-014-composite-command-settlement-and-reservation-boundary.md) | Composite command settlement failure in `LegionToolAdapter`; false multi-root reservation collisions | Medium |
| [PM-015](PM-015-tool-argument-snapshot-concatenation-and-stream-decoding-loop.md) | Tool argument snapshot concatenation caused JSON parse errors and futile specialist failover loops | High |
| [PM-016](PM-016-terminal-heredoc-deadlock-and-prompt-parity.md) | Terminal heredoc shell integration deadlock and specialist prompt parity drift | High |

## Cross-cutting themes
1. **Permissive mocks hide real defects** (PM-001/002/003/008/011/012). Always add a real-store test.
2. **Defaults vs. intent** (PM-004, PM-005) — hand-synced lists and pre-filled stores need proofs.
3. **Shape, phase transitions and concurrency** (PM-006, PM-009, PM-012) — test depth, repetition, parallelism, failure, and events arriving *after* a phase has finished.
4. **Delivered ≠ wired** (PM-007, PM-009, PM-010) — a capability exists only when its real entry point calls it and a test proves it.
5. **Process** (PM-010) — verify claims; audit after interruptions.
6. **Streaming transport hygiene & circuit breaking** (PM-015) — model streaming providers yield heterogeneous delta/snapshot contracts; parsers must self-heal duplicate roots, and transport decoding errors must never trigger futile specialist failover loops.
7. **Terminal safety, prompt parity & shell circuit-breaking** (PM-016) — models instructed to write files via terminal heredocs deadlock non-interactive shell integration and bypass file tracking; defense requires prompt parity, pre-execution interception, and terminal process circuit-breakers.
