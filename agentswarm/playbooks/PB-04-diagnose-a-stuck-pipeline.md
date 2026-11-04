# PB-04 — Diagnose a stuck pipeline (`waiting_for_children` forever)

## Triage
1. Read the pipeline: `orchestrator.getDeferredPipelineStatus(rootId)` → `phase`, `pendingChildStreamIds`, `suspendedStreamIds`.
2. For each pending id: `orchestrator.getAgentDeferStatus(id)` → `state`, `inFlightOperation`, `pipelineId`.

## Decision table
| What you see | Cause | Action |
|---|---|---|
| Child `suspending` with `inFlightOperation.status:"running"` | Atomic operation still running (by design) | Wait; the runner must call `completeInFlightAndYield(childId, receipt)` when it ends |
| Child `running`, no `defer_agent_status` | It never received the defer request | Re-run `deferPipeline(root)` (safe to repeat; returns the existing result if already suspended) |
| Child `failed`/`completed` but pipeline still waiting | Reconcile hook missed | Call `completeStream`/`failStream` (they reconcile), or `hierarchicalDeferCoordinator.reconcileAfterStreamFailure(childId)` |
| Intermediate node `waiting_for_children` while all its children are `deferred` | Barrier not re-evaluated | Trigger reconcile via any child yield/finish; confirm the ancestor walk reaches the stream owning `deferred_pipeline_status` with the same `pipelineId` |
| `pipelineId` differs between streams | Two overlapping defers | Resume the older pipeline first; avoid nested `deferPipeline` on the same tree |
| Child in `execute_command` running heredoc | Shell integration stalled on non-interactive stdin | Intercepted by policy; if encountered, fail the stream and inspect terminal circuit-breaker fallback ([ADR-0015](../adr/ADR-0015-multi-tier-terminal-heredoc-defense-and-prompt-parity.md), [PM-016](../postmortems/PM-016-terminal-heredoc-deadlock-and-prompt-parity.md)) |

## Verify
Pipeline `phase` becomes `suspended`; every `agentStatuses[*].state === "deferred"`.

## Escalate
If a child is alive but unresponsive, **do not** abort it to force the state. Fail it explicitly (`failStream`) — that is a decision for the coordinator, and it will be reflected as `failed`, never as `deferred`.
