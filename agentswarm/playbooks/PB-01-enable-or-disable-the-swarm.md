# PB-01 — Enable / disable the swarm

**When:** turning features on for yourself, an environment, a test, or a single task.

## Steps
| Scope | How |
|---|---|
| End user | Settings → Preferences → *Agent Swarm & Hierarchy Orchestration*. Use a **Quick mode preset** (`Standard (Off)`, `Review Only`, `Defer Only`, `Legion Only`, `Full Swarm + Legion`) or the individual switches. |
| Workspace/user JSON | `"lumi.agentSwarm.enabled": true` (or any single `lumi.agentSwarm.*` key — [configuration](../architecture/configuration.md)). |
| Operator / CI | `LUMI_AGENT_SWARM_ENABLED=1` (or individual `LUMI_*` variables). **Env wins over the UI.** |
| Code / tests | `toggleAgentSwarmFeature(true, { legionEnabled: true })`; clear with `setAgentSwarmConfigOverride(null)`. |
| One agent | `setAgentSwarmAgentOverride(agentId, { hierarchicalDeferEnabled: true })` |
| One task | `setAgentSwarmTaskOverride(taskId, { criticalCompletionReviewEnabled: true })` |
| One call | pass `manualInvocation: true` (review/legion) or `forceEnable: true` (defer methods) |

## Verify
- UI shows the **Active** badge and the green dot on the *Swarm & Legion* jump pill.
- `orchestrator.isAuxiliaryFeatureEnabled({ streamId })` returns the expected flags and `resolvedFrom`.
- Conductor tool `engage_swarm` is enabled in `DietCodeToolSet.getEnabledTools` (when `!context.isTesting`).
- Conductor system prompt section `# 🐝 AGENT SWARM & THE LEGION — Orchestrator Conductor` is injected into `joy_zoning.ts`.
- If the UI toggle "doesn't stick": check env variables, then wait ≤30 s or trigger any settings update (cache invalidation).

## Disable / rollback
Choose preset **Standard (Off)** or set `enabled:false` and each sub-capability `false`. Remember the master OR (turning only a sub-capability off while the master is on is not possible; the UI handles this by turning the master off and re-asserting the others).
