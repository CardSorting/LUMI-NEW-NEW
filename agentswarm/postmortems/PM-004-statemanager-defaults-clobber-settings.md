# PM-004 — Unpersisted `StateManager` defaults clobbered `settings.json` and the webview showed "Off"

**Date:** 2026-11-02 · **Severity:** Medium · **Detected by:** Real-SQLite test or code audit · **Blameless format**

## Summary
`StateManager` pre-populates every key with its default. `loadFromStateManager()` spread after the VS Code settings, so the default `false` overwrote `"lumi.agentSwarm.enabled": true`. `Controller.getStateToPostToWebview` also read `StateManager` directly, so the UI displayed Off.

## Reproduction
- **Input:** `settings.json`/env enables the swarm; the user never touched the webview.
- **Expected:** Effective config honours settings/env; UI shows On.
- **Actual:** Always Off.

## Root cause
No distinction between *unpersisted default* and *explicit user choice* in `StateManager`.

## Fix
`getExplicitStateManagerSetting` (explicit-only), applied in `getAgentSwarmConfig`, `ToolExecutor.asToolConfig`, `evaluateOptionalCriticalCompletionReview`; `Controller` now posts `getAgentSwarmConfig()` values.

## Why it wasn't caught earlier
Tests used lightweight `StateManager` mocks without defaults.

## Prevention (now in place)
ADR-0006; regression test *"preserves VS Code workspace settings.json and env overrides…"*.

## Lessons
When a store fills defaults, "is it set?" and "what is it?" are different questions.
