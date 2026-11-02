# ADR-0007 — Settings flow through proto with clamping at the controller boundary

**Status:** Accepted

## Context
The webview talks to the extension over generated gRPC (`state.proto`). Settings must exist in `Settings`, `UpdateSettingsRequest`, state keys, extension state, runtime `TaskConfig`, and the controller.

## Decision
One `optional` field per setting in both messages (`agent_swarm_*`, fields 339–348 and 55–64). Validation and clamping happen **once**, in `updateSettings.ts` / `updateTaskSettings.ts` (counts 1–5 and 1–8, enum guards). The runtime `TaskConfig` mirrors the keys and `TASK_CONFIG_KEYS` must list them (`validateTaskConfig`). Batched updates (`updateSettingsBatch`) apply presets atomically.

## Consequences
+ Single source of truth; invalid UI input can't reach runtime.
− Adding a setting touches ~12 files (hence [PB-02](../playbooks/PB-02-add-a-setting-end-to-end.md)).

## Alternatives
- Free-form JSON blob setting — rejected (no type safety, no per-field clamping).

## Evidence
Tests: proto sync + clamping; `TASK_CONFIG_KEYS` includes all `agentSwarm*` keys.
