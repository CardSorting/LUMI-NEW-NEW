# PB-02 — Add a setting end-to-end

**When:** you add a new Agent Swarm tunable (e.g. `agentSwarmFoo`). Skipping a layer caused PM-004/PM-005.

## Steps (all of them)
1. **Config model** — `AgentSwarmConfig.ts`: add to `AgentSwarmConfig`, `DEFAULT_AGENT_SWARM_CONFIG`, `loadFromVSCodeSettings`, `loadFromStateManager` (via `getExplicitStateManagerSetting`), `loadFromEnv`, the override types, and `resolveEffectiveAgentSwarmState`/`EffectiveAgentSwarmFeatureState` if it is per-use.
2. **VS Code contribution** — `package.json`: `lumi.agentSwarm.<name>` with type, default, range, description.
3. **State keys** — `src/shared/storage/state-keys.ts`: `SETTINGS_DEFAULTS` entry (+ test expectations in `state-keys.test.ts`).
4. **Proto** — `proto/dietcode/state.proto`: `optional` field in **both** `Settings` and `UpdateSettingsRequest` (next free numbers); run `npm run protos`.
5. **Extension state** — `src/shared/ExtensionMessage.ts` (`ExtensionState`) and `Controller.getStateToPostToWebview()` (read from `getAgentSwarmConfig()`).
6. **Controller boundary** — `updateSettings.ts` (validate/clamp, then `invalidateAgentSwarmConfigCache()`), and `updateTaskSettings.ts` if per-task.
7. **Runtime config** — `ToolExecutor.asToolConfig()`, `TaskConfig.ts`, **`ToolConstants.ts` → `TASK_CONFIG_KEYS`**.
8. **Webview** — `ExtensionStateContext.tsx` (default + type), `FeatureSettingsSection.tsx` (control, label, description, search keywords), `settingsHandlers.ts` if conversion needed.
9. **Tests** — backend proto-sync/clamping test, `TASK_CONFIG_KEYS` test, webview component test.

## Verify
```bash
npm run protos && npx tsc --noEmit && npx tsc -b webview-ui
# mocha + vitest commands: see PB-07
```
Then toggle it in the UI, reload, and confirm the value persists and the effective value matches.

## Rollback
Revert the layers in reverse order; leave the proto field numbers reserved (never reuse a number).
