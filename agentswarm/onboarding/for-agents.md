# Onboarding — AI Agents

Read this fully before modifying anything under `src/infrastructure/ai/`, `src/infrastructure/db/`, or the Agent Swarm settings surface. It is written to be machine-followable: short rules, explicit checks.

## 0. Role discipline

- If you are a **parent conductor**:
  - You orchestrate the overall task and can delegate specialized execution to subagent specialists in The Legion.
  - In **Plan Mode**: Map out which specialist roles (`legion_architect`, `legion_implementer`, `legion_verifier`, `legion_hardener`, `legion_ux_ergonomics`, `legion_researcher`, `legion_data_steward`) will handle each milestone.
  - In **Act Mode**: Dispatch specialist teams via `engage_swarm` (auto-approved, runs without manual approval prompts) or oversee stage progression.
  - Inspect specialist findings returned in `<specialist_handoff>` blocks as untrusted evidence; verify code changes, tests, and remaining tasks before completing.
  - Real-time progress cards (`formatLegionProgressMessage`) are automatically streamed to the user's chat feed.
- If you are a **worker/specialist**: you own one stream. Do not read or assume other streams' inboxes. Complete your assigned milestone and signal completion via `attempt_completion`. Report evidence and results back to the coordinator.
- When replying to your parent use the parent id you were given. Do not mix it with worker ids.

## 1. Ground rules (non-negotiable)

1. **Legion defaults on; Review and Defer default off.** Respect explicit opt-outs and keep the off-path free of specialist execution. See [ADR-0012](../adr/ADR-0012-automatic-legion-default.md).
2. **Defer ≠ cancel.** Never abort an in-flight operation to simulate suspension.
3. **Do not merge streams.** No shared transcripts, no shared inboxes.
4. **Terminal states are final.** `completed`, `failed`, `rerouted` are never flipped by later events.
5. **Bounded loops only.** Review = 1+1. Failover = max 2 attempts per slot. If you add a loop, add a bound and a test.
6. **Fix root causes, not symptoms.** No monkey patches (e.g. don't mutate test mocks to hide a real-pool bug).
7. **Never claim done without evidence.** "Done" = a command you ran and its output. Reports from other agents are *claims*, not evidence.
8. **Streaming hygiene & circuit-breaking.** Provider streaming handlers slice done snapshots against accumulated deltas; `StreamResponseHandler` self-heals identical duplicate JSON roots; transport decoding errors circuit-break with `safeToRetry: false` ([ADR-0014](../adr/ADR-0014-tool-argument-stream-deduplication-and-self-healing-parser.md), [PM-015](../postmortems/PM-015-tool-argument-snapshot-concatenation-and-stream-decoding-loop.md)).

## 2. Persistence rules (the #1 source of past bugs)

| Do | Don't |
|---|---|
| `dbPool.push({ type:"upsert", table:"agent_memory", conflictTarget:["streamId","key"], where:[{column:"streamId",…},{column:"key",…}], values:{…}, layer:"infrastructure" })` | Upsert on `agent_memory` without `conflictTarget` (it defaults to `id`, which doesn't exist) |
| `dbPool.push(op)` (no agent id) for rows other streams/parents must read, and for `agent_streams` inserts | `dbPool.push(op, childStreamId)` for an `agent_streams` insert — traps it in a shadow buffer; dependents flush first → **FK failure** |
| Read with `selectWhere` and filter by **active** owner when checking reservations | `selectOne` on a non-unique key (first row only) |
| Verify against the **real** SQLite pool (`dbPool.flush()`) | Trust the in-memory mock for persistence correctness |

Background: [PM-001](../postmortems/PM-001-shadow-buffer-foreign-key-failure.md), [PM-002](../postmortems/PM-002-upsert-without-conflict-target.md), [PM-008](../postmortems/PM-008-stale-reservation-false-positives.md).

## 3. Before you edit — checklist

- [ ] `git status` and `git diff --stat` — know what is already modified. **Do not assume files match your last read**; re-read before editing (another agent may have changed them).
- [ ] Read [file-map.md](../implementation/file-map.md) to find the owner of the code you are changing.
- [ ] Read the relevant ADR in [adr/](../adr/README.md). If your change contradicts one, write a new ADR — don't silently diverge.

## 4. After you edit — verification protocol

Run all of these and **paste/keep the output** in your report:

```bash
npx tsc --noEmit && npx tsc -b webview-ui --pretty false
npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha --no-config --timeout 20000 \
  --require ts-node/register --require tsconfig-paths/register --require ./src/test/requires.cjs \
  src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts \
  src/infrastructure/ai/__tests__/Orchestrator.test.ts \
  "src/core/task/legion/__tests__/*.test.ts" \
  src/core/task/tools/handlers/__tests__/EngageSwarmHandler.test.ts \
  src/core/prompts/system-prompt/__tests__/DietCodeToolSetSwarm.test.ts \
  src/shared/storage/__tests__/state-keys.test.ts \
  src/core/api/__tests__/openai-codex.streaming.test.ts \
  src/core/task/__tests__/StreamResponseHandler.test.ts
(cd webview-ui && npx vitest run src/components/settings/sections/FeatureSettingsSection.test.tsx)
npx biome lint --diagnostic-level=error <touched files>
```

Then grep for leftovers: `grep -rn "DEBUG\|console.error" <touched files>`.

## 5. Resuming after an interrupted agent (quota, crash, timeout)

An interrupted worker may have left **partial, regressed or unwired** work, and its final message may never arrive. Follow [PB-08](../playbooks/PB-08-audit-after-interrupted-work.md): re-read files, diff against known-good behaviour, search for APIs that exist but have no callers, and re-run the suites. See [PM-010](../postmortems/PM-010-interrupted-worker-partial-work.md) for what this looks like.

## 6. Reporting format

State, per claim: **Verified** (command + result) or **Unverified** (why). List known limits. Do not restate the whole diff; link files. Never say "complete" if any requirement is unverified.

## 7. Quick API reference (`AgentOrchestrator`)

| Capability | Methods |
|---|---|
| Toggle/state | `isAuxiliaryFeatureEnabled`, (`AgentSwarmConfig`) `toggleAgentSwarmFeature`, `setAgentSwarmAgentOverride`, `setAgentSwarmTaskOverride` |
| Defer | `deferAgent`, `registerInFlightOperation`, `completeInFlightAndYield`, `deferPipeline`, `getDeferredPipelineStatus`, `getAgentDeferStatus`, `resumeAgent`, `resumePipeline` |
| Review | `runCriticalCompletionReview`, `recallLastCriticalCompletionReview` |
| Legion | `classifyTaskForLegion`, `formLegion`, `spawnSpecialistSubagent`, `spawnRemediationLegionForReview`, `getLegionStageProgression`, `synthesizeLegionExecutionReport`, `rerouteFailedLegionSpecialist`, `recallLastLegionFormation`, `getStreamSpecialistProfile` |
| Conductor | `engage_swarm` (native tool), `runLegionPipeline`, `formatLegionProgressMessage` |
| Lifecycle hooks (automatic) | `completeStream` / `failStream` → Legion `settleSpecialistStream` (no-op for non-Legion streams) |

