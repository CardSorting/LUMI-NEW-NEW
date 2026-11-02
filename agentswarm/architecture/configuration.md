# Configuration Reference

## Settings

| VS Code setting | Proto/State key | Type | Default | Range |
|---|---|---|---|---|
| `lumi.agentSwarm.enabled` | `agentSwarmEnabled` | bool | `false` | master switch |
| `lumi.agentSwarm.criticalCompletionReview.enabled` | `agentSwarmCriticalCompletionReviewEnabled` | bool | `false` | |
| `lumi.agentSwarm.criticalCompletionReview.maxInitialReviews` | `agentSwarmMaxInitialCompletionReviews` | int | `1` | 1–5 |
| `lumi.agentSwarm.criticalCompletionReview.maxCorrectivePasses` | `agentSwarmMaxCorrectiveVerificationPasses` | int | `1` | 1–5 |
| `lumi.agentSwarm.hierarchicalDefer.enabled` | `agentSwarmHierarchicalDeferEnabled` | bool | `false` | |
| `lumi.agentSwarm.hierarchicalDefer.defaultBoundary` | `agentSwarmDefaultDeferBoundary` | enum | `safe_boundary` | `before_turn` \| `safe_boundary` \| `immediate` |
| `lumi.agentSwarm.autoDeferOnCompletionReview` | `agentSwarmAutoDeferOnCompletionReview` | bool | `true` | only acts if both Review and Defer are on |
| `lumi.agentSwarm.legion.enabled` | `agentSwarmLegionEnabled` | bool | `false` | |
| `lumi.agentSwarm.legion.strategy` | `agentSwarmLegionStrategy` | enum | `adaptive` | `adaptive` \| `tactical_strike` \| `balanced_squad` \| `full_legion` \| `verification_heavy` |
| `lumi.agentSwarm.legion.maxSpecialists` | `agentSwarmLegionMaxSpecialists` | int | `4` | 1–8 |

Proto fields: `Settings` 339–348 and `UpdateSettingsRequest` 55–64 in `proto/dietcode/state.proto` (`agent_swarm_*`, all `optional`). Invalid enum values and out-of-range numbers are **clamped/ignored at the controller boundary** (`updateSettings.ts`, `updateTaskSettings.ts`).

## Environment variables (each also accepts a `DIETCODE_` twin where noted)

| Variable | Effect |
|---|---|
| `LUMI_AGENT_SWARM_ENABLED` (`DIETCODE_…`) | master |
| `LUMI_CRITICAL_COMPLETION_REVIEW_ENABLED` (`DIETCODE_…`) | review |
| `LUMI_HIERARCHICAL_DEFER_ENABLED` (`DIETCODE_…`) | defer |
| `LUMI_AGENT_SWARM_DEFER_BOUNDARY` | boundary |
| `LUMI_AGENT_SWARM_AUTO_DEFER_ON_REVIEW` | auto-defer |
| `LUMI_AGENT_SWARM_MAX_INITIAL_REVIEWS`, `LUMI_AGENT_SWARM_MAX_CORRECTIVE_PASSES` | bounds (clamped 1–5) |
| `LUMI_AGENT_SWARM_LEGION_ENABLED` (`DIETCODE_…`) | legion |
| `LUMI_AGENT_SWARM_LEGION_STRATEGY` | strategy |
| `LUMI_AGENT_SWARM_LEGION_MAX_SPECIALISTS` | cap (clamped 1–8) |

Booleans accept `1/true/yes/on/enabled` and `0/false/no/off/disabled`.

## Precedence

**Global config layer** (`getAgentSwarmConfig`, later wins):

```
defaults  <  VS Code settings  <  StateManager (explicit only)  <  environment  <  runtime override
```

Cached for 30 s; `invalidateAgentSwarmConfigCache()` is called by `updateSettings`/`updateTaskSettings` and the programmatic setters.

**Per-use resolution** (`resolveEffectiveAgentSwarmState`):

```
global  →  per-agent override  →  per-task override  →  manual invocation
```

Within the "global" step, a task's `settingsPatch` (from `TaskConfig`) is consulted as: `runtime override` → `settingsPatch` → global config. That is how a task can carry its own settings even when nothing is set globally.

### Rules that surprise people

1. **Environment beats the UI.** A webview toggle will not change a value pinned by env.
2. **"Explicit only" for StateManager.** `StateManager` pre-populates defaults for every key; those would otherwise overwrite `settings.json`. `getExplicitStateManagerSetting` only honours values that were really persisted/overridden (PM-004).
3. **The master switch is OR-ed in.** `reviewEnabled = enabled || reviewSetting` (same for defer and legion). You cannot turn one sub-capability off while the master is on — the UI therefore flips the master off and re-asserts the other sub-flags in one batch.
4. **Manual invocation forces review and legion, not defer.** `manualInvocation` sets `enabled`, `reviewEnabled`, `legionEnabled`. Defer is forced by passing `forceEnable: true` to the defer methods. (Documented as a finding; intentional-by-implementation, not by spec.)
5. **Presets** in the UI are just batched updates — see `handleApplySwarmPreset` in `FeatureSettingsSection.tsx`.

## Quick recipes

```jsonc
// settings.json — everything on
{ "lumi.agentSwarm.enabled": true, "lumi.agentSwarm.legion.strategy": "adaptive" }
```
```bash
# Env — Legion only, 6 specialists
LUMI_AGENT_SWARM_LEGION_ENABLED=1 LUMI_AGENT_SWARM_LEGION_MAX_SPECIALISTS=6 code .
```
```ts
// Code/test — per-task override
setAgentSwarmTaskOverride(taskId, { criticalCompletionReviewEnabled: true })
```
