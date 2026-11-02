# Reincorporation Guide — re-apply, port, or cleanly remove

Use this when you need to (a) re-apply the feature after a rebase/merge conflict, (b) port it to another branch/fork, or (c) remove it.

## 0. Preconditions
- Know where the code lives: [implementation/file-map.md](implementation/file-map.md). At authoring time it was **uncommitted** — first make it durable: `git add agentswarm src/infrastructure/ai src/... && git commit` (or `git stash -u`), otherwise nothing below is recoverable.
- Capture a patch: `git diff > agentswarm.patch` plus copy the **untracked** files (`AgentSwarmConfig.ts`, `CriticalCompletionReview.ts`, `HierarchicalDeferCoordinator.ts`, `LegionCoordinator.ts`, `AgentSwarmAuxiliary.test.ts`).

## 1. Re-apply / port — in this order
Order matters because each layer compiles against the previous.

| Step | Do | Check |
|---|---|---|
| 1 | **Persistence first:** `BufferedDbPool.ts` (`TABLE_FK_ORDER`, `conflictTarget` matching) | `tsc`; existing DB tests |
| 2 | **Engines:** add `AgentSwarmConfig.ts`, `HierarchicalDeferCoordinator.ts`, `CriticalCompletionReview.ts`, `LegionCoordinator.ts` | `tsc` |
| 3 | **Façade:** merge the `Orchestrator.ts` changes (imports/exports, `acceptingNewWork` guards in `createTask`/`spawnChildStream`/`spawnTeammateTask`, delegation methods, `completeStream`/`failStream` hooks, `createTask` insert columns) | `Orchestrator.test.ts` |
| 4 | **Completion flow:** `completionGatePipeline.ts`, `AttemptCompletionHandler.ts` | review tests |
| 5 | **Settings surface (all layers, PB-02):** `package.json`, `state.proto` → `npm run protos`, `state-keys.ts`, `ExtensionMessage.ts`, `Controller`, `updateSettings.ts`, `updateTaskSettings.ts`, `ToolExecutor.ts`, `TaskConfig.ts`, `ToolConstants.ts` | `tsc`; proto/clamp test |
| 6 | **Webview:** `ExtensionStateContext.tsx`, `settingsHandlers.ts`, `FeatureSettingsSection.tsx`, `SettingsView.tsx` | `tsc -b webview-ui`; vitest |
| 7 | **Tests:** `AgentSwarmAuxiliary.test.ts`, `state-keys.test.ts` updates | Full PB-07 |

### Conflict hot-spots
- `state.proto`: field numbers. Take the next free numbers in *your* branch; **do not reuse numbers** and keep the same names. Regenerate; fix `state-keys.ts`/`updateSettings.ts` if names differ.
- `Orchestrator.ts`, `FeatureSettingsSection.tsx`, `SettingsView.tsx`: large shared files — re-apply hunks, don't overwrite.
- `completionGatePipeline.ts`/`AttemptCompletionHandler.ts`: confirm the review call still runs *after* the audit gate and that off-path is a no-op.
- `BufferedDbPool.ts`: if upstream changed flush ordering, re-check FK order with the real-SQLite tests.

### Adapting to a different host
The feature needs only: (1) a stream tree (`agent_streams.parentId`), (2) a per-stream durable key/value store with composite-key upsert, (3) an ordered buffered writer, (4) callbacks when a stream completes/fails, (5) cooperative pause points. Map each to your host, keep the invariants in the [ADRs](adr/README.md), and port the real-store tests first.

## 2. Verify after re-applying
Run [PB-07](playbooks/PB-07-release-verification.md). Also confirm the **off-path**: with all settings at defaults, nothing new runs.

## 3. Remove cleanly
1. Set everything off (PB-01) and ship that first if users are affected.
2. Remove in reverse order (webview → settings surface → completion flow → façade → engines → persistence changes).
3. Keep the `BufferedDbPool` fixes (`TABLE_FK_ORDER`, `conflictTarget` matching) — they are general bug fixes.
4. Leave proto field numbers `reserved`; delete stored keys only if desired — they live in `agent_memory` under the names in [data-model.md](architecture/data-model.md) and are harmless when unused.
5. Delete the tests for removed behaviour; keep the real-SQLite regression test pattern.

## 4. Rollback of a bad release
Disable via settings/env (instant, no deploy), then follow [PB-04](playbooks/PB-04-diagnose-a-stuck-pipeline.md)/[PB-05](playbooks/PB-05-recover-a-failed-legion-formation.md) for in-flight pipelines: resume deferred hierarchies (`resumePipeline`) before disabling Defer so no stream is left suspended.
