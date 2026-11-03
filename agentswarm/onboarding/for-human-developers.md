# Onboarding — Human Developers (15 minutes)

**Goal:** after this page you can find any piece of the feature, run its tests, and make a safe change.

## 1. What it is (60 seconds)

Three configurable capabilities: Legion is enabled by default; Review and Defer default to **off**.

| Capability | One-liner | Main file |
|---|---|---|
| Hierarchical Defer & Resume | Pause a parent + all children at safe points; resume later without replaying finished work | `src/infrastructure/ai/HierarchicalDeferCoordinator.ts` |
| Critical Completion Review | One bounded, evidence-based review after a task completes | `src/infrastructure/ai/CriticalCompletionReview.ts` |
| The Legion | Classify a task, spawn the right specialist child agents, run them in stages, fail over once | `src/infrastructure/ai/LegionCoordinator.ts` |

Glue: `Orchestrator.ts` (public API), `AgentSwarmConfig.ts` (toggles/precedence), `BufferedDbPool.ts` (persistence).

## 2. Mental model (3 rules)

1. **Streams are independent.** Parent and children never share a transcript or inbox. The parent only *observes reports* and updates the roadmap.
2. **Defer is not cancel.** We never abort running work to look "suspended". We wait for a boundary, checkpoint, ack.
3. **Everything durable lives in `agent_memory`** (key/value per stream) written through `BufferedDbPool`. No new queues or engines.

## 3. Run it

```bash
# backend suites (Agent Swarm + Orchestrator + state keys)
npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha --no-config --timeout 20000 \
  --require ts-node/register --require tsconfig-paths/register --require ./src/test/requires.cjs \
  src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts \
  src/infrastructure/ai/__tests__/Orchestrator.test.ts \
  src/shared/storage/__tests__/state-keys.test.ts

# settings UI
cd webview-ui && npx vitest run src/components/settings/sections/FeatureSettingsSection.test.tsx

# types + lint
npx tsc --noEmit && npx tsc -b webview-ui
npx biome lint --diagnostic-level=error <files you touched>
```

Run time: seconds. One test (`updateSettings … clamping`) takes ~4 s — that is normal.

## 4. Turn it on locally

Any one of:

- **UI:** Settings → *Preferences* → *Agent Swarm & Hierarchy Orchestration* → pick a **Quick mode preset**.
- **VS Code settings:** `"lumi.agentSwarm.enabled": true` (see [configuration](../architecture/configuration.md)).
- **Env:** `LUMI_AGENT_SWARM_ENABLED=1`.
- **Tests/code:** `toggleAgentSwarmFeature(true, { legionEnabled: true })`.

> ⚠ Precedence gotcha: **environment variables beat the UI toggle.** If a UI switch "won't stick", check your env first.

## 5. Where to look when…

| Symptom | Look at |
|---|---|
| A toggle does nothing | [configuration.md](../architecture/configuration.md) precedence; `getAgentSwarmConfig()` 30 s cache (invalidated by `updateSettings`) |
| Pipeline stuck in `waiting_for_children` | [PB-04](../playbooks/PB-04-diagnose-a-stuck-pipeline.md) |
| `FOREIGN KEY constraint failed` on flush | [PB-06](../playbooks/PB-06-triage-sqlite-flush-errors.md), [PM-001](../postmortems/PM-001-shadow-buffer-foreign-key-failure.md) |
| Legion specialist failed | [PB-05](../playbooks/PB-05-recover-a-failed-legion-formation.md) |
| Adding a setting | [PB-02](../playbooks/PB-02-add-a-setting-end-to-end.md) |
| Adding a specialist | [PB-03](../playbooks/PB-03-add-a-legion-specialist.md) |

## 6. Rules before you open a PR

- [ ] Default behaviour with everything off is **unchanged** (there is a test for it — keep it green).
- [ ] New persistence writes use `conflictTarget: ["streamId","key"]` **and** a matching `where`, **without** an `agentId` argument unless you truly need a private overlay ([ADR-0010](../adr/ADR-0010-direct-writes-for-shared-rows.md)).
- [ ] Any new setting touches **all** layers in [PB-02](../playbooks/PB-02-add-a-setting-end-to-end.md) (the `TASK_CONFIG_KEYS` miss is [PM-005](../postmortems/PM-005-task-config-keys-drift.md)).
- [ ] Add a test against the **real SQLite pool** if you add a new table write path. The in-memory mock in the test file ignores `agentId` and FK order — it hides exactly the bugs we hit.
- [ ] Update the relevant ADR/playbook if you change a decision.

## 7. Glossary & deeper reading

[glossary.md](../glossary.md) · [how-it-works.md](../architecture/how-it-works.md) · [whitepaper](../papers/03-technical-whitepaper.md)

