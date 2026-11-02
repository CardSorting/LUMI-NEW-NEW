# ADR-0006 — Config precedence and explicit-vs-default detection

**Status:** Accepted

## Context
Settings can come from VS Code `settings.json`, the webview (persisted in `StateManager`), environment variables, tests, per-agent and per-task overrides. `StateManager` pre-fills defaults for every key, so naïvely reading it makes the default `false` silently overwrite `settings.json` and hides user intent (PM-004).

## Decision
Precedence: `defaults < VS Code < StateManager(explicit) < env < runtime override`, then `agent override → task override → manual invocation`. `getExplicitStateManagerSetting` treats a value as explicit only if it comes from remote config, session/task caches, a pending write, a persisted global-state entry, or differs from the default. The master switch is OR-ed into sub-capabilities.

## Consequences
+ `settings.json` and env work without a UI interaction; the UI shows the *effective* value (`Controller.getStateToPostToWebview` reads `getAgentSwarmConfig()`).
− Env beats UI — operators must know (documented).
− `getExplicitStateManagerSetting` peeks at `StateManager` internals; a refactor there must keep it working (test covers it).
− OR-ing the master means a sub-capability can't be disabled under an enabled master (UI compensates).

## Alternatives
- UI always wins — rejected (can't tell UI intent from default).
- Add an "unset" sentinel to `StateManager` — rejected (broad blast radius).

## Evidence
Test: *"preserves VS Code workspace settings.json and env overrides when StateManager has only unpersisted default values"*.
