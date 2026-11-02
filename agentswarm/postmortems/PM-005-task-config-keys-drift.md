# PM-005 — `TASK_CONFIG_KEYS` missed the new `agentSwarm*` keys

**Date:** 2026-11-02 · **Severity:** Low–Medium · **Detected by:** Real-SQLite test or code audit · **Blameless format**

## Summary
Seven (later ten) `agentSwarm*` fields were added to `TaskConfig` and `ToolExecutor.asToolConfig()` but not to `TASK_CONFIG_KEYS`, which `validateTaskConfig` uses and which is documented as "keep in sync with the TaskConfig interface".

## Reproduction
- **Input:** `validateTaskConfig(config)` on a config carrying the new fields.
- **Expected:** All keys known.
- **Actual:** Schema drift.

## Root cause
A hand-maintained key list with no compile-time link to the interface.

## Fix
Added all keys to `TASK_CONFIG_KEYS`; test asserts every `agentSwarm*` key is present (incl. Legion).

## Why it wasn't caught earlier
No test compared the list with the interface.

## Prevention (now in place)
[PB-02](../playbooks/PB-02-add-a-setting-end-to-end.md) lists `ToolConstants.ts` explicitly.

## Lessons
Every hand-synced list needs a test or a type that proves the sync.
