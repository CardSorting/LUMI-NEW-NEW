# File Map

Everything the feature touched, grouped by layer. (**New** = untracked at authoring time; **Mod** = modified tracked file.)

## Core engines (`src/infrastructure/ai/`)
| File | Status | Owns |
|---|---|---|
| `AgentSwarmConfig.ts` | New | Config model, defaults, VS Code/StateManager/env loaders, overrides, `resolveEffectiveAgentSwarmState`, `getExplicitStateManagerSetting`, role normalization |
| `HierarchicalDeferCoordinator.ts` | New | Defer/resume (single + pipeline), barrier, control messages, checkpoints |
| `CriticalCompletionReview.ts` | New | Bounded review, finding classification, decisions, roadmap merge, auto-resume |
| `LegionCoordinator.ts` | New | Specialist registry, classification, formation, stage progression, failover, synthesis, `settleSpecialistStream` |
| `Orchestrator.ts` | Mod | Public façade for all of the above; `acceptingNewWork` guards; `completeStream`/`failStream` hooks (`reconcileAfterStreamFailure`, `settleLegionSpecialist`) |
| `__tests__/AgentSwarmAuxiliary.test.ts` | New | 34 tests in 8 sections (toggle, review, defer, barrier, real SQLite, proto/config, Legion, Legion lifecycle) |

## Persistence
| File | Status | Change |
|---|---|---|
| `src/infrastructure/db/BufferedDbPool.ts` | Mod | `TABLE_FK_ORDER` flush ordering; in-memory upsert matching on `conflictTarget` |

## Completion flow
| File | Status | Change |
|---|---|---|
| `src/core/task/tools/completionGatePipeline.ts` | Mod | `evaluateOptionalCriticalCompletionReview`; wired into `runCompletionGateFlow` |
| `src/core/task/tools/handlers/AttemptCompletionHandler.ts` | Mod | Calls the review after the audit gate; blocks on `REMEDIATE`/`ESCALATE` |

## Settings surface
| File | Status | Change |
|---|---|---|
| `package.json` | Mod | `lumi.agentSwarm.*` contributions |
| `proto/dietcode/state.proto` | Mod | `agent_swarm_*` in `Settings` (339–348) and `UpdateSettingsRequest` (55–64); generated TS via `npm run protos` (generated output is not tracked) |
| `src/shared/storage/state-keys.ts` (+ `__tests__/state-keys.test.ts`) | Mod | Defaults/types |
| `src/shared/ExtensionMessage.ts` | Mod | `ExtensionState` fields |
| `src/core/controller/index.ts` | Mod | Posts effective values to the webview |
| `src/core/controller/state/updateSettings.ts`, `updateTaskSettings.ts` | Mod | Validation, clamping, cache invalidation |
| `src/core/task/ToolExecutor.ts`, `tools/types/TaskConfig.ts`, `tools/utils/ToolConstants.ts` | Mod | Runtime `TaskConfig` + `TASK_CONFIG_KEYS` |

## Webview (`webview-ui/src/`)
| File | Status | Change |
|---|---|---|
| `components/settings/sections/FeatureSettingsSection.tsx` (+ `.test.tsx`) | Mod | Filter bar, jump pills, Agent Swarm card, presets, progressive disclosure, Legion roster + stage pipeline |
| `components/settings/SettingsView.tsx` | Mod | Deep-link anchors (`agent-swarm-features`, …) → Preferences tab |
| `components/settings/utils/settingsHandlers.ts` | Mod | `updateSettingsBatch` (atomic presets) |
| `context/ExtensionStateContext.tsx` | Mod | State defaults/types |

## Docs
`agentswarm/` — original specs (`agentswarm.md`…`agentswarm4.md`, untouched) + this wiki.

## Spec → implementation traceability
| Spec | Requirement (short) | Where |
|---|---|---|
| `agentswarm.md` | Separate streams; coordinator observes & maintains rolling roadmap | Streams stay independent; `rolling_roadmap_snapshot` kept by Defer/Review/Legion |
| `agentswarm2.md` §1 | Optional, default off, per-agent/task override, manual invocation | `AgentSwarmConfig`, `resolveEffectiveAgentSwarmState` |
| `agentswarm2.md` §2–4 | Evidence categories, decisive resolution | `CriticalCompletionReview.classifyFindings`, decisions |
| `agentswarm2.md` §5–7 | Corrective execution, bounded termination | corrective tasks, 1+1 cycle state |
| `agentswarm2.md` §8 | Final report distinguishing verified/unverified | `formatCoordinatorFinalReport` |
| `agentswarm3.md` §2–6 | Don't abort; cooperative boundaries; control inbox; barrier | `HierarchicalDeferCoordinator` |
| `agentswarm3.md` §8 / `agentswarm4.md` §8 | Review consumes defer; phased approach | `runReview` auto-defer/resume |
| `agentswarm4.md` §3 | Parent stops accepting conflicting work | `acceptingNewWork` guards |
| `agentswarm4.md` §6–7 | Deferred ≠ completed/failed; persistence, no blind replay | task metadata, receipts, durable checkpoints |
| *(Extension, not in the specs)* | Legion specialists | `LegionCoordinator` — see ADR-0008/0009 |
