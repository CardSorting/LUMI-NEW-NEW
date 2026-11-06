# File Map

Everything the feature touched, grouped by layer. (**New** = untracked at authoring time; **Mod** = modified tracked file.)

## Core engines (`src/infrastructure/ai/`)

| File                                    | Status | Owns                                                                                                                                                                                        |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentSwarmConfig.ts`                   | New    | Config model, defaults, VS Code/StateManager/env loaders, overrides, `resolveEffectiveAgentSwarmState`, `getExplicitStateManagerSetting`, role normalization                                |
| `HierarchicalDeferCoordinator.ts`       | New    | Defer/resume (single + pipeline), barrier, control messages, checkpoints                                                                                                                    |
| `CriticalCompletionReview.ts`           | New    | Bounded review, finding classification, decisions, roadmap merge, auto-resume                                                                                                               |
| `LegionCoordinator.ts`                  | New    | Specialist registry, classification, formation, stage progression, failover, synthesis, `settleSpecialistStream`                                                                            |
| `LegionExecutionReceipt.ts`             | New    | Durable specialist operation receipts (`beginLegionOperation`, `finishLegionOperation`) and execution evidence queries                                                                      |
| `LegionPipelineRunner.ts`               | New    | Autonomous multi-stage pipeline executor driving stages, context passing, and synthesis                                                                                                     |
| `Orchestrator.ts`                       | Mod    | Public façade for all of the above; `acceptingNewWork` guards; `completeStream`/`failStream` hooks (`reconcileAfterStreamFailure`, `settleLegionSpecialist`), `getOrCreateLegionTaskStream` |
| `__tests__/AgentSwarmAuxiliary.test.ts` | New    | 49 tests in 8 sections (toggle, review, defer, barrier, real SQLite, proto/config, Legion, Legion lifecycle)                                                                                |
| `__tests__/Orchestrator.test.ts`        | Mod    | 14 tests covering Orchestrator Swarm and Legion stream integration                                                                                                                          |

## Specialist Task Execution (`src/core/task/legion/` & `src/core/task/`)

| File                                        | Status | Owns                                                                                                                                                                                                           |
| ------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/task/legion/LegionAgentHost.ts`   | New    | Autonomous agent execution host driving native tool conversations, model token/cost budgets, heuristic fallbacks, UI progress streaming, and transport error circuit-breaking (`safeToRetry: false`)           |
| `src/core/task/legion/LegionToolAdapter.ts` | New    | Specialist tool execution bridge with isolated `TaskState`, execution ownership (`legion:<streamId>`), command lifecycle tracking, process group abortion, and upward file revision propagation                |
| `src/core/task/legion/delegationPolicy.ts`  | New    | Policy rules for automatic delegation eligibility (opt-outs, plan-mode exclusions, native tool prerequisites)                                                                                                  |
| `src/core/task/index.ts`                    | Mod    | `maybeRunAutomaticLegion`, `withLegionContext` objective-pinned handoff injection, `activeLegionController` steering interrupt abort, file attachment preservation, and `resumeTaskFromHistory` state recovery |
| `src/core/task/legion/__tests__/`           | New    | 54 tests across `TaskLegion.test.ts` (19), `LegionAgentHost.test.ts` (20), `LegionToolAdapter.test.ts` (13), `LegionNativeProvider.integration.test.ts` (1), and `delegationPolicy.test.ts` (1)                |

## Streaming Response & Provider Transport (`src/core/task/`, `src/core/api/`)

| File                                                    | Status | Owns                                                                                                                                                                                                          |
| ------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/task/StreamResponseHandler.ts`                | Mod    | State-machine `extractJsonRoots` parser, `extractFirstCompleteJsonRoot`, `ToolArgumentError` diagnostics, stream-time snapshot deduplication, and terminal self-healing across identical duplicate JSON roots |
| `src/core/task/__tests__/StreamResponseHandler.test.ts` | New    | 15 unit tests covering deduplication, extension slicing, self-healing of nested objects and string braces, whitespace variations, and typed `ToolArgumentError` diagnostics                                   |
| `src/core/api/providers/openai-codex.ts`                | Mod    | Tool argument offset tracking and snapshot slicing via `toolCallDelta`, interleaved tool identity maps (`toolCallIdByItemId`, `toolCallNameByItemId`, `toolCallNameByCallId`)                                 |
| `src/core/api/providers/openai-native.ts`               | Mod    | Tool argument offset tracking and snapshot slicing via `toolCallDelta` on done chunks                                                                                                                         |
| `src/core/api/utils/responses_api_support.ts`           | Mod    | Responses API argument delta offset tracking, snapshot slicing via `toolCallDelta`, and interleaved tool call tracking via `functionCallByItemId`                                                             |
| `src/core/api/__tests__/openai-codex.streaming.test.ts` | Mod    | 15 unit tests (5 new in Phase 8) verifying snapshot deduplication, trailing suffix slicing, done chunks without deltas, and interleaved tool call name preservation                                           |

## Conductor Tool & System Prompt Integration (`src/core/prompts/` & `src/core/task/tools/`)

| File                                                                    | Status | Owns                                                                                                              |
| ----------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `src/core/prompts/system-prompt/tools/engage_swarm.ts`                  | New    | `engage_swarm` tool specification, parameters, and conditional enablement                                         |
| `src/core/task/tools/handlers/EngageSwarmHandler.ts`                    | New    | Handler executing `engage_swarm`, mapping parameters, streaming progress cards, and returning specialist handoffs |
| `src/core/task/tools/handlers/__tests__/EngageSwarmHandler.test.ts`     | New    | 8 unit tests covering `EngageSwarmHandler` (validation, config checks, progress streaming, abort)                 |
| `src/core/prompts/system-prompt/__tests__/DietCodeToolSetSwarm.test.ts` | New    | 3 unit tests verifying dynamic `engage_swarm` discovery and `isTesting` snapshot isolation                        |
| `src/core/prompts/system-prompt/components/joy_zoning.ts`               | Mod    | `# 🐝 AGENT SWARM & THE LEGION — Orchestrator Conductor` section injection                                        |
| `src/core/prompts/system-prompt/components/capabilities.ts`             | Mod    | Dynamic `{{SWARM_CAPABILITIES}}` injection when Swarm or Legion is enabled                                        |
| `src/core/prompts/system-prompt/components/act_vs_plan_mode.ts`         | Mod    | Role mapping in Plan Mode and `engage_swarm` delegation in Act Mode                                               |
| `src/core/prompts/system-prompt/registry/DietCodeToolSet.ts`            | Mod    | Registers `engage_swarm` in `getEnabledTools`                                                                     |
| `src/core/prompts/system-prompt/tools/init.ts`                          | Mod    | Variant registration for `engage_swarm`                                                                           |
| `src/core/task/tools/autoApprove.ts`                                    | Mod    | Auto-approval registration for `DietCodeDefaultTool.ENGAGE_SWARM`                                                 |
| `src/core/task/tools/ToolExecutorCoordinator.ts`                        | Mod    | Handler binding for `DietCodeDefaultTool.ENGAGE_SWARM`                                                            |
| `src/shared/tools.ts`                                                   | Mod    | Added `ENGAGE_SWARM = "engage_swarm"` to `DietCodeDefaultTool`                                                    |
| `src/core/assistant-message/index.ts`                                   | Mod    | Added `objective`, `strategy`, `preferred_roles`, `max_specialists` to `toolParamNames`                           |

## Persistence

| File                                      | Status | Change                                                                         |
| ----------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| `src/infrastructure/db/BufferedDbPool.ts` | Mod    | `TABLE_FK_ORDER` flush ordering; in-memory upsert matching on `conflictTarget` |

## Completion flow

| File                                                       | Status | Change                                                                         |
| ---------------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| `src/core/task/tools/completionGatePipeline.ts`            | Mod    | `evaluateOptionalCriticalCompletionReview`; wired into `runCompletionGateFlow` |
| `src/core/task/tools/handlers/AttemptCompletionHandler.ts` | Mod    | Calls the review after the audit gate; blocks on `REMEDIATE`/`ESCALATE`        |

## Settings surface

| File                                                                                         | Status | Change                                                                                                                                           |
| -------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`                                                                               | Mod    | `lumi.agentSwarm.*` contributions                                                                                                                |
| `proto/dietcode/state.proto`                                                                 | Mod    | `agent_swarm_*` in `Settings` (339–348) and `UpdateSettingsRequest` (55–64); generated TS via `npm run protos` (generated output is not tracked) |
| `src/shared/storage/state-keys.ts` (+ `__tests__/state-keys.test.ts`)                        | Mod    | Defaults/types and 32 type-safety tests                                                                                                          |
| `src/shared/ExtensionMessage.ts`                                                             | Mod    | `ExtensionState` fields                                                                                                                          |
| `src/core/controller/index.ts`                                                               | Mod    | Posts effective values to the webview                                                                                                            |
| `src/core/controller/state/updateSettings.ts`, `updateTaskSettings.ts`                       | Mod    | Validation, clamping, cache invalidation                                                                                                         |
| `src/core/task/ToolExecutor.ts`, `tools/types/TaskConfig.ts`, `tools/utils/ToolConstants.ts` | Mod    | Runtime `TaskConfig` + `TASK_CONFIG_KEYS`                                                                                                        |

## Webview (`webview-ui/src/`)

| File                                                                      | Status | Change                                                                                                    |
| ------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `components/settings/sections/FeatureSettingsSection.tsx` (+ `.test.tsx`) | Mod    | Filter bar, jump pills, Agent Swarm card, presets, progressive disclosure, Legion roster + stage pipeline |
| `components/settings/SettingsView.tsx`                                    | Mod    | Deep-link anchors (`agent-swarm-features`, …) → Preferences tab                                           |
| `components/settings/utils/settingsHandlers.ts`                           | Mod    | `updateSettingsBatch` (atomic presets)                                                                    |
| `context/ExtensionStateContext.tsx`                                       | Mod    | State defaults/types                                                                                      |

## Terminal Execution & Command Policy Defense

| File                                                                                                                   | Status | Change                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/integrations/terminal/heredocPolicy.ts` (+ `__tests__/heredocPolicy.test.ts`)                                     | New    | Shell-token parser `findTopLevelHeredocs`, `detectHeredocFileRedirection`, `isMultilineHeredocCommand`, and 33 unit tests                                    |
| `src/integrations/terminal/terminalFileReadPolicy.ts` (+ `__tests__/terminalFileReadPolicy.test.ts`)                   | New    | Terminal file read command interception (`cat`, `head`, `tail`, `more`, `less`, compound pipelines), automatic redirection to `read_file`, and 67 unit tests |
| `src/integrations/terminal/commandPolicy.ts`                                                                           | Mod    | Re-exports `heredocPolicy` and `terminalFileReadPolicy` helpers                                                                                              |
| `src/integrations/terminal/index.ts`                                                                                   | Mod    | Public exports of heredoc detection functions, terminal read policy functions, and types                                                                     |
| `src/core/task/legion/LegionAgentHost.ts` (+ `__tests__/LegionAgentHost.test.ts`)                                      | Mod    | `LEGION_CORE_RULES` export, specialist system prompt injection for prompt parity, and token budget starvation fix                                            |
| `src/core/task/tools/handlers/ExecuteCommandToolHandler.ts` (+ `__tests__/ExecuteCommandToolHandler.approval.test.ts`) | Mod    | Pre-execution interception of heredoc file writes and approval prompt suppression                                                                            |
| `src/core/task/tools/handlers/UseSkillToolHandler.ts`                                                                  | Mod    | Tool handler enabling agent skill invocation with `AbortSignal` cancellation and metadata validation                                                         |
| `src/core/policy/UniversalGuard.ts`                                                                                    | Mod    | Pre-execution heredoc file write rejection in `guardPreExecution`                                                                                            |
| `src/core/policy/FluidPolicyEngine.ts` (+ `__tests__/FluidPolicyEngine.execution.test.ts`)                             | Mod    | Heredoc file write rejection in `validatePreExecution`                                                                                                       |
| `src/core/task/tools/ToolValidator.ts`                                                                                 | Mod    | Command parameter validation blocking heredoc file writes                                                                                                    |
| `src/hosts/vscode/terminal/VscodeTerminalProcess.ts` (+ `.test.ts`)                                                    | Mod    | Multiline heredoc shell integration circuit-breaker with managed fallback and safe refusal                                                                   |
| `src/hosts/vscode/terminal/VscodeTerminalManager.ts`                                                                   | Mod    | Fast-path microtask deferral for multiline heredocs                                                                                                          |

## Terminal Supervision, Action Execution & Process Protection

| File                                                                                                    | Status | Change                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/integrations/terminal/SupervisedShell.ts` (+ `.test.ts`)                                           | Mod    | Post-spawn observation error isolation via `onObservationError`, spawn-gated process group cancellation (`taskkill /T /F`, POSIX `kill`), retry support    |
| `src/integrations/terminal/CommandExecutor.ts` (+ `.ownership.test.ts`)                                 | Mod    | View epoch verification preventing background reader output pollution across task switches, command replay protection marking duplicate runs `not_started` |
| `src/integrations/terminal/CommandOrchestrator.ts` (+ `.test.ts`)                                       | Mod    | Orchestration lifecycle coordination, active command ownership fences, and process group tracking                                                          |
| `src/integrations/terminal/CommandRuntime.ts`                                                           | Mod    | Command persistence gating and process state lifecycle reconciliation                                                                                      |
| `src/integrations/terminal/commandOutcome.ts`                                                           | Mod    | Strict exit code verification: requires `exitCode === 0` for `completed`; missing exit codes remain `unconfirmed`                                          |
| `src/core/task/ActionExecutionRegistry.ts`                                                              | Mod    | Semantic fences for `unconfirmed` commands, `commandObserved` notification tracking, `unresolved` execution snapshot listings                              |
| `src/core/task/ActionExecutor.ts` (+ `__tests__/ActionExecutor.test.ts`)                                | Mod    | Command execution reconciliation, foreground snapshot fence preservation, receipt finalization safety                                                      |
| `src/core/task/ExecutionRecovery.ts` (+ `__tests__/ExecutionRecovery.test.ts`)                          | Mod    | Durable execution recovery, legacy unconfirmed receipt reconciliation, action lifecycle consistency validation                                             |
| `src/core/task/ExecutionState.ts` (+ `__tests__/ExecutionState.test.ts`, `Task.executionState.test.ts`) | Mod    | Formats and prioritizes `unresolved_commands` and `unresolved_actions` in execution context snapshots                                                      |
| `src/core/task/TaskState.ts`                                                                            | Mod    | Added `specialistUsageUnverified` session fence when specialist usage cannot be persisted reliably                                                         |

## Dynamic Project Knowledge & Workspace Integrity

| File                                                                                       | Status | Change                                                                                                                                                        |
| ------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/infrastructure/ai/LegionKnowledge.ts`                                                 | New    | SHA-256 workspace scoping (`legionWorkspaceScope`), `agent_knowledge` storage with 30-day TTL, multi-pattern credential scrubbing (`CREDENTIAL_PATTERNS`)     |
| `src/core/integrity/EnvironmentIntegrity.ts` (+ `__tests__/EnvironmentIntegrity.test.ts`)  | Mod    | Deterministic manifest fingerprinting (`getManifestFingerprint`), WeakRef registry, generational probe concurrency, `isManifest` check, PATH shadowing alerts |
| `src/core/storage/disk.ts`                                                                 | Mod    | `saveDietCodeMessagesStrict`, reactive `EnvironmentIntegrity.invalidateCache` invocation on disk writes                                                       |
| `src/core/task/tools/handlers/ApplyPatchHandler.ts`                                        | Mod    | Workspace artifact tracking (`trackWorkspaceArtifact`), reactive `EnvironmentIntegrity.invalidateCache()` on manifest changes                                 |
| `src/core/task/tools/handlers/WriteToFileToolHandler.ts`                                   | Mod    | Workspace artifact tracking (`trackWorkspaceArtifact`), reactive `EnvironmentIntegrity.invalidateCache()` on manifest changes                                 |
| `src/core/context/instructions/user-instructions/skills.ts` (+ `__tests__/skills.test.ts`) | Mod    | `AbortSignal` propagation across all skill scanning/reading functions, metadata integrity re-validation (`name`, `description`) on use                        |
| `src/core/prompts/system-prompt/components/skills.ts`                                      | Mod    | Untrusted catalog warning framing, description clamping to 1,000 characters                                                                                   |
| `.agents/teamwork/`                                                                        | New    | Dynamic teamwork and multi-agent coordination instructions directory                                                                                          |

## Robust Legion Handoff & Concurrency Hardening

| File                                                               | Status | Change                                                                                                                                                      |
| ------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/task/legion/LegionHandoff.ts`                            | New    | Surrogate-safe XML escaping and binary-search UTF-8 truncation capped at 12 KB (`formatLegionHandoffText`), regex status validation (`legionHandoffStatus`) |
| `src/core/task/legion/LegionAgentHost.ts`                          | Mod    | `awaitAbortable` with `AbortSignal`, XML escaping of context artifacts/blackboard, catalog truncation (50 skills, 300 chars), usage failure notifications   |
| `src/core/task/legion/LegionToolAdapter.ts`                        | Mod    | Tool isolation with cancellation awareness, nested status tracking in `getPendingWork`, process cleanup                                                     |
| `src/infrastructure/ai/LegionCoordinator.ts`                       | Mod    | Two-phase formation reservations (`acquireFormationReservation`, `acquireAutomaticFormationToken`, `acquireFormationDispatchToken`), blackboard persistence |
| `src/infrastructure/ai/LegionExecutionReceipt.ts`                  | Mod    | `hasOutstandingFormationReservation`, `hasLegionFormationIntent`, bounded operation evidence queries, corrupt receipt resilience                            |
| `src/infrastructure/ai/LegionPipelineRunner.ts`                    | Mod    | `needs_reconciliation` state machine transition for unconfirmed host halts and settlement persistence failures                                              |
| `src/infrastructure/ai/__tests__/fixtures/legion-claim-worker.cjs` | Mod    | Multi-process concurrency worker asserting atomic SQLite claim, driver, and reservation acquisition                                                         |

## Persistence

| File                                      | Status | Change                                                                                                                                                                                           |
| ----------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/infrastructure/db/BufferedDbPool.ts` | Mod    | `TABLE_FK_ORDER` flush ordering, in-memory upsert matching, `ShadowCommitError` retention, graceful `stop()` shadow guard, `pruneExpiredAgentKnowledge`, SQLite column affinity & value ordering |

## Docs

`agentswarm/` — original specs (`agentswarm.md`…`agentswarm4.md`, untouched) + this wiki.

## Spec → implementation traceability

| Spec                                                                                                          | Requirement (short)                                                                                        | Where                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agentswarm.md`                                                                                               | Separate streams; coordinator observes & maintains rolling roadmap                                         | Streams stay independent; `rolling_roadmap_snapshot` kept by Defer/Review/Legion                                                                 |
| `agentswarm2.md` §1                                                                                           | Optional, default off, per-agent/task override, manual invocation                                          | `AgentSwarmConfig`, `resolveEffectiveAgentSwarmState`                                                                                            |
| `agentswarm2.md` §2–4                                                                                         | Evidence categories, decisive resolution                                                                   | `CriticalCompletionReview.classifyFindings`, decisions                                                                                           |
| `agentswarm2.md` §5–7                                                                                         | Corrective execution, bounded termination                                                                  | corrective tasks, 1+1 cycle state                                                                                                                |
| `agentswarm2.md` §8                                                                                           | Final report distinguishing verified/unverified                                                            | `formatCoordinatorFinalReport`                                                                                                                   |
| `agentswarm3.md` §2–6                                                                                         | Don't abort; cooperative boundaries; control inbox; barrier                                                | `HierarchicalDeferCoordinator`                                                                                                                   |
| `agentswarm3.md` §8 / `agentswarm4.md` §8                                                                     | Review consumes defer; phased approach                                                                     | `runReview` auto-defer/resume                                                                                                                    |
| `agentswarm4.md` §3                                                                                           | Parent stops accepting conflicting work                                                                    | `acceptingNewWork` guards                                                                                                                        |
| `agentswarm4.md` §6–7                                                                                         | Deferred ≠ completed/failed; persistence, no blind replay                                                  | task metadata, receipts, durable checkpoints                                                                                                     |
| _(Extension, not in the specs)_                                                                               | Legion specialists                                                                                         | `LegionCoordinator` — see ADR-0008/0009                                                                                                          |
| [ADR-0012](../adr/ADR-0012-automatic-legion-default.md)                                                       | Automatic Legion execution host & sandboxed tools                                                          | `LegionAgentHost`, `LegionToolAdapter`, `Task.ts`, `LegionPipelineRunner`                                                                        |
| [ADR-0013](../adr/ADR-0013-orchestrator-conductor-tool-and-streaming-progress.md)                             | Orchestrator Conductor tool, streaming cards, auto-approval & gating heuristics                            | `engage_swarm.ts`, `EngageSwarmHandler.ts`, `autoApprove.ts`, `joy_zoning.ts`, `formatLegionProgressMessage`                                     |
| [ADR-0014](../adr/ADR-0014-tool-argument-stream-deduplication-and-self-healing-parser.md)                     | Tool argument stream deduplication, self-healing JSON parser & transport circuit-breaking                  | `StreamResponseHandler.ts`, `openai-codex.ts`, `openai-native.ts`, `responses_api_support.ts`, `LegionAgentHost.ts` — see ADR-0014, PM-015       |
| [ADR-0015](../adr/ADR-0015-multi-tier-terminal-heredoc-defense-and-prompt-parity.md)                          | Multi-tier terminal heredoc defense, specialist prompt parity & shell integration circuit-breaking         | `heredocPolicy.ts`, `LegionAgentHost.ts`, `ExecuteCommandToolHandler.ts`, `UniversalGuard.ts`, `VscodeTerminalProcess.ts` — see ADR-0015, PM-016 |
| [ADR-0016](../adr/ADR-0016-terminal-file-read-defense-budget-starvation-and-conductor-prompt-parity.md)       | Terminal file read defense, specialist token budget starvation fix, and conductor-specialist prompt parity | `terminalFileReadPolicy.ts`, `LegionAgentHost.ts`, `VscodeTerminalProcess.ts`, `UseSkillToolHandler.ts` — see ADR-0016, PM-017                   |
| [ADR-0017](../adr/ADR-0017-dynamic-project-knowledge-blackboard-and-credential-sanitization.md)               | Dynamic project knowledge, scoped blackboard sharing & credential sanitization                             | `LegionKnowledge.ts`, `BufferedDbPool.ts` — see ADR-0017                                                                                         |
| [ADR-0018](../adr/ADR-0018-workspace-environment-integrity-and-manifest-fingerprinting.md)                    | Workspace environment integrity, manifest fingerprinting & reactive invalidation                           | `EnvironmentIntegrity.ts`, `ApplyPatchHandler.ts`, `WriteToFileToolHandler.ts`, `disk.ts` — see ADR-0018                                         |
| [ADR-0019](../adr/ADR-0019-terminal-supervision-action-fencing-and-shadow-commit-retention.md)                | Terminal supervision, action execution fencing & shadow commit retention                                   | `SupervisedShell.ts`, `CommandExecutor.ts`, `ActionExecutionRegistry.ts`, `BufferedDbPool.ts` — see ADR-0019, PM-018                             |
| [ADR-0020](../adr/ADR-0020-legion-handoff-sanitization-two-phase-reservation-and-unsettled-reconciliation.md) | Legion handoff sanitization, two-phase formation reservations & unsettled state reconciliation             | `LegionHandoff.ts`, `LegionCoordinator.ts`, `LegionPipelineRunner.ts`, `skills.ts` — see ADR-0020, PM-019                                        |
