# PM-014 — Composite Command Settlement Failure and Multi-Root Reservation Boundary Collisions

| Field | Value |
|---|---|
| Incident date | 2026-11-03 |
| Severity | Medium (command completion deadlock; false file-reservation contention) |
| Affected components | `src/core/task/legion/LegionToolAdapter.ts`, `src/infrastructure/ai/LegionCoordinator.ts` |
| First failing test | `src/core/task/legion/__tests__/LegionToolAdapter.test.ts`, `src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts` |
| Fixed in | `src/core/task/legion/LegionToolAdapter.ts`, `src/infrastructure/ai/LegionCoordinator.ts`, `src/infrastructure/ai/Orchestrator.ts` |
| Related ADRs | [ADR-0008](../adr/ADR-0008-deterministic-legion-classification.md), [ADR-0009](../adr/ADR-0009-legion-lifecycle-dag-failover-terminal-states.md) |

---

## 1. Summary

Two distinct runtime defects were uncovered during deep auditing of specialist tool execution and file reservation:

1. **Composite Command Settlement Failure:** In `LegionToolAdapter.ts`, `getPendingWork` checked execution registry status via `base.callbacks.getExecutionState(id)`. When an execution was recorded as `{ action: { status: "completed" }, command: undefined }` (standard return for non-command actions), line 155 checked `observed && "command" in observed && typeof observed.command === "object" ? observed.command : observed`. Because `observed.command` was `undefined`, it fell back to the root object which lacked a `status` property, permanently trapping the ID in `unresolvedCommandIds` and blocking specialist completion.
2. **False Substring Collision on Workspace Roots:** In `LegionCoordinator.ts`, `normalizeReservationPath` used `r.path.toLowerCase().endsWith(hint.toLowerCase())` when matching relative path hints against root folders. A path hint `@frontend` matched `/projects/myfrontend` because `myfrontend` ended with `frontend`, leading to false reservation conflicts between unrelated projects. Additionally, trailing slashes on POSIX paths caused key divergence.

## 2. Root Cause

1. The execution state registry returns composite objects with both `action` and `command` sub-records. Code only inspected `observed.command`, ignoring `observed.action.status` and `observed.status`.
2. Workspace root path matching did not enforce directory boundary delimiters (`/`), treating any folder with the hint as a suffix as a match.

## 3. Fix

1. In `LegionToolAdapter.ts`, resolve `observed.status`, `observed.command?.status`, and `observed.action?.status` before deciding whether an execution has settled.
2. In `LegionCoordinator.ts`, added directory boundary checks (`path.basename === h` or `endsWith("/" + h)`), empty string guards, and trailing slash stripping on reservation paths.

## 4. Prevention

- Added regression tests in `LegionToolAdapter.test.ts` verifying that nested `{ action: { status: "completed" } }` objects settle unresolved command tracking.
- Added tests in `AgentSwarmAuxiliary.test.ts` verifying that root suffix substrings do not match different workspace folder names.

