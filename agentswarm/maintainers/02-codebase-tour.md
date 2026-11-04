# 02 — Line-by-Line Codebase Tour & Ownership Map

This document walks you through every file that makes up Agent Swarm & The Legion, the exact line ranges of its critical mechanisms, and **what will break if you alter those lines**.

---

## 1. `src/infrastructure/ai/AgentSwarmConfig.ts` (~704 lines)

**Purpose:** Single source of truth for all Agent Swarm & Legion settings, defaults, clamping bounds, role normalization, and 5-tier configuration precedence.

### Key Types & Constants
- **`DEFAULT_AGENT_SWARM_CONFIG` (lines 118–137):**
  - `enabled: false`, `criticalCompletionReviewEnabled: false`, `hierarchicalDeferEnabled: false`, `autoDeferBeforeCriticalReview: false`, `allowManualTriggerWhenDisabled: true`, `maxFollowUpReviewPasses: 1`, `maxRemediationPasses: 1`, `defaultDeferBoundary: "safe_boundary"`, `legionEnabled: false`, `legionClassificationStrategy: "adaptive"`, `legionMaxConcurrency: 4`, `legionAutoFailoverEnabled: true`, `legionRequireSynthesisGate: true`.
- **`LegionSpecialistRole` & `normalizeLegionSpecialistRole` (lines 10–37):**
  - Defines the 7 canonical specialist role IDs (`legion_architect`, `legion_implementer`, `legion_ux_ergonomics`, `legion_hardener`, `legion_verifier`, `legion_researcher`, `legion_data_steward`).
  - Maps the legacy mixed-case alias `"legion_Trends_ux"` → `"legion_ux_ergonomics"` ([ADR-0011](../adr/ADR-0011-legacy-role-alias.md)).

### Critical Functions & Why They Exist
- **`getExplicitStateManagerSetting<K>` (lines 268–317):**
  - **What it does:** Checks `StateManager.getGlobalStateKey` and `StateManager.getTaskSettingsKey` **only after** verifying via `hasExplicitValueInRecord` (`taskSettings` / `globalStateCache` inspection) or VS Code's `workspace.getConfiguration("lumi").inspect(...)` that the user or task actually persisted a value.
  - **What breaks if you remove it:** `StateManager.initialize()` pre-fills its in-memory cache with `DEFAULT_SETTINGS` (`false`) before reading disk. If `loadStateManagerConfig()` blindly calls `stateManager.getGlobalSettingsKey("agentSwarmEnabled")`, it gets `false` and **clobbers** a user's `true` in `settings.json`! (See [ADR-0006](../adr/ADR-0006-config-precedence-and-explicit-detection.md), [PM-004](../postmortems/PM-004-statemanager-defaults-clobber-settings.md).)
- **`loadAgentSwarmConfig()` (lines 422–474):**
  - Evaluates the 5-tier precedence chain (cached for 30s unless `invalidateAgentSwarmConfigCache()` is called):
    1. `DEFAULT_AGENT_SWARM_CONFIG` (lowest)
    2. VS Code `workspace.getConfiguration("lumi.agentSwarm")`
    3. Explicit `StateManager` global/task settings
    4. Environment variables (`LUMI_AGENT_SWARM_*`)
    5. Runtime overrides (`setRuntimeAgentSwarmConfigOverride`, highest)
- **`resolveEffectiveAgentSwarmState(options)` (lines 541–676):**
  - Computes the effective boolean flags for a given `agentId`, `taskId`, `manualInvocation`, and `forceEnable` flag, and returns human-readable `reasons: string[]` explaining why each feature is enabled or disabled.

---

## 2. `src/infrastructure/ai/HierarchicalDeferCoordinator.ts` (~1,334 lines)

**Purpose:** Cooperative suspension, multi-level hierarchy barrier synchronization, control message inbox, durable checkpoints, and idempotent resume.

### Storage Keys Owned (`HIERARCHICAL_DEFER_STORAGE_KEYS`, lines 18–26)
| Key in `agent_memory` | Stream ID Owner | Contents |
|---|---|---|
| `stream_suspension_state` | Target `streamId` | `StreamSuspensionRecord` (`state`, `acceptingNewWork`, `pendingChildStreamIds`, `acknowledgedChildStreamIds`, `pipelineId`, etc.) |
| `stream_execution_checkpoint` | Target `streamId` | `StreamExecutionCheckpoint` (`currentStepIndex`, `completedStepReceipts`, `pendingTaskIds`, `SafeBoundaryType`, etc.) |
| `stream_control_inbox` | Target `streamId` | `StreamControlMessage[]` (`suspend`, `resume`, `prepare_review`, `release_barrier`) |
| `stream_step_receipts` | Target `streamId` | `Record<string, StepReceipt>` (prevents re-executing completed steps on resume) |
| `pipeline_defer_state:<pipelineId>` | Root `streamId` | `PipelineSuspensionState` (`phase`, `childStreamIds`, `pendingAckStreamIds`, `acknowledgedStreamIds`) |
| `active_pipeline_id` | Root or child `streamId` | String pointer to the active `pipelineId` |

### Critical Methods & Invariants
- **`withPipelineLock(pipelineId, fn)` (lines 222–239):**
  - Per-pipeline in-process Promise mutex (`this.pipelineLocks`). Serializes concurrent calls to `acknowledgeChildSuspension` and `reconcileAfterStreamFailure` so two children finishing in the same millisecond never clobber each other's acknowledgement in `pipeline_defer_state:<pipelineId>` ([ADR-0004](../adr/ADR-0004-suspension-barrier-and-ancestor-walk.md)).
- **`collectHierarchyStreams(rootStreamId)` (lines 1185–1225):**
  - Performs a BFS traversal across `agent_streams` (`SELECT * FROM agent_streams WHERE parentId = ?`) with a `visited` set (`maxDepth = 16`) so multi-level hierarchies (root → child → grandchild) are all included in the suspension barrier ([PM-006](../postmortems/PM-006-multi-level-barrier-deadlock.md)).
- **`deferHierarchy(request)` (lines 382–560):**
  - Sets `acceptingNewWork: false` on the root stream, discovers all active descendants via `collectHierarchyStreams`, sends `suspend` control messages, marks pending tasks with `deferred: true` (never cancelling them!), and sets `phase: "waiting_for_children"` (or `"suspended"` immediately if there are no active children).
- **`reconcilePipelineBarrier(rootStreamId, pipelineId)` (lines 760–866):**
  - Re-checks `pendingAckStreamIds` against both `acknowledgedStreamIds` and `agent_streams.status` (`completed` / `failed`).
  - **CRITICAL GUARD (lines 768–775, [PM-012](../postmortems/PM-012-post-resume-reconcile-and-delete-upsert-ordering.md)):**
    ```ts
    if (
      !pipeline ||
      (pipeline.phase !== "waiting_for_children" && pipeline.phase !== "suspending")
    ) {
      return null;
    }
    ```
    *What breaks if you weaken this guard:* If a pipeline is deferred and then resumed (`phase: "resumed"`), and a child later completes (`completeStream` → `reconcileAfterStreamFailure`), `reconcilePipelineBarrier` will think the pipeline just finished waiting for children and will **re-suspend the already-resumed parent stream**!
- **`reconcileAfterStreamFailure(streamId, reason)` (lines 702–758):**
  - Called automatically by `Orchestrator.completeStream` and `Orchestrator.failStream`. Walks up `parentId` ancestors and reconciles any waiting barrier so a crashed or completed child never deadlocks its parent.

---

## 3. `src/infrastructure/ai/CriticalCompletionReview.ts` (~744 lines)

**Purpose:** Bounded 1+1 adversarial review at task completion, strict separation of verified defects vs. unverified concerns, corrective task dispatch, and final coordinator report formatting.

### Critical Methods & Invariants
- **`classifyFindings(candidates)` (lines 204–264):**
  - Splits `ReviewFindingInput[]` into `verifiedDefects` and `unverifiedConcerns`.
  - A finding is a `verified_defect` **if and only if** `category === "verified_defect"` (or `blocking === true`) **and** it supplies non-empty `evidenceRefs` (or a concrete `recommendedFix`/`description` backed by audit evidence). Speculative items without evidence are downgraded to `unverified_concern`.
- **`determineDecision(verifiedDefects, unverifiedConcerns, cycleState, maxFollowUpPasses, maxRemediationPasses)` (lines 266–310):**
  - Implements the 4-way state machine (`ACCEPT`, `ACCEPT_WITH_NOTE`, `REMEDIATE`, `ESCALATE`).
  - Enforces the **1+1 bound** ([ADR-0005](../adr/ADR-0005-bounded-review-with-category-separation.md)): if `cycleState.remediationPassCount >= maxRemediationPasses` or `cycleState.followUpReviewCount >= maxFollowUpPasses` and verified defects still remain, it returns `ESCALATE` rather than looping forever.
- **`runReview(request)` (lines 312–530):**
  - Auto-defers the hierarchy before review if `effective.autoDeferBeforeReview` is true and the stream has active children or a pipeline.
  - **CRITICAL `finally` BLOCK (lines 510–525, [PM-007](../postmortems/PM-007-review-left-pipeline-suspended-and-unwired.md)):** Always calls `deferCoordinator.resumeHierarchy` if `autoDeferredByReview` was true and the decision is not `ESCALATE`, so a completed review never strands the parent stream in `suspended`.

---

## 4. `src/infrastructure/ai/LegionCoordinator.ts` (~1,896 lines)

**Purpose:** Specialist role registry, deterministic task classification, stage-ordered formation, file-reservation conflict avoidance, automatic stage progression on stream completion, bounded failover on stream failure, and synthesis reporting.

### Key Constants & Registry
- **`LEGION_SPECIALIST_REGISTRY` (lines 269–540):**
  - Declarative profiles for all 7 specialist archetypes: `role`, `title`, `codename`, `subagentType`, `description`, `capabilities`, `preferredLayers`, `defaultExecutionBoundary`, `keywords` (weighted), and `filePatterns` (regexes).
- **`LegionExecutionStageName` (line 66):**
  1. `"leadAndRecon"`
  2. `"parallelExecution"`
  3. `"verificationAndHardening"`
  (Followed by automated stage synthesis into conductor handoff).
- **`LEGION_MAX_ATTEMPTS_PER_SLOT = 2` (line 141):**
  - Initial specialist spawn (`attempt = 1`) + at most 1 failover reroute (`attempt = 2`).

### Critical Methods & Invariants
- **`withFormationLock(formationId, fn)` (lines 620–637):**
  - Per-formation in-process Promise mutex (`this.formationLocks`). Prevents parallel specialists finishing/failing simultaneously from racing on `legion_formation:<formationId>`.
- **`classifyTaskForLegion(input)` (lines 738–949):**
  - Evaluates `taskDescription`, `targetFiles`, `strategy` (`"adaptive" | "tactical_strike" | "balanced_squad" | "full_legion" | "verification_heavy"`), `maxSpecialists`, and `preferredRoles`.
  - Scores archetypes with keyword weights, file patterns, and intent bonuses, and partitions non-overlapping file reservations.
- **`formLegion(parentStreamId, input)` (lines 955–1240):**
  - Creates child rows in `agent_streams` via **direct writes** (`dbPool.push({ type: "insert", table: "agent_streams", ... })` with **NO** `agentId` — [PM-001](../postmortems/PM-001-shadow-buffer-foreign-key-failure.md)).
  - Checks active file reservations via `dbPool.selectWhere("agent_memory", ...)` and filters by `agent_streams.status === "active"` so stale reservations from completed/failed streams never block new formations ([PM-008](../postmortems/PM-008-stale-reservation-false-positives.md)).
  - Dispatches Stage 1 (`leadAndRecon`) tasks immediately (`status: "active"`) while queueing downstream stage members (`status: "queued"`).
- **`reconcileSpecialistStreamLifecycleUnlocked` (lines 1501–1780):**
  - **CRITICAL TERMINAL-STATE GUARD (lines 1530–1545, [PM-009](../postmortems/PM-009-terminal-state-flip-and-unwired-lifecycle.md)):**
    ```ts
    if (
      member.status === "completed" ||
      member.status === "failed" ||
      member.status === "rerouted"
    ) {
      return { ... }; // Terminal states are final and absorbing!
    }
    ```
    *What breaks if you change this to `if (member.status === event)`:* Calling `failStream` twice on the same failed stream will see `member.status === "rerouted"` on the second call (`"rerouted" !== "failed"`), overwrite `"rerouted"` to `"failed"`, and increment `failedStreams` even though a fallback specialist was already spawned! (Proven by Mutation M1 in [04-failure-modes-and-drills.md](04-failure-modes-and-drills.md).)

---

## 5. `src/infrastructure/ai/Orchestrator.ts` (~890 lines)

**Purpose:** The public façade (`AgentOrchestrator`) consumed by the rest of LUMI. Connects stream/task lifecycle events to the 3 Agent Swarm engines.

### Critical Hooks & Invariants
- **`ensureStreamAcceptingWork(streamId, operationName)` (lines 81–99):**
  - Called at the top of `dispatchTask`, `spawnSubAgent`, and `delegateWork`. Throws `Stream <id> is currently suspended (<state>) and cannot accept new work (<op>)` if `acceptingNewWork === false` (unless `bypassSuspensionCheck: true` is passed for corrective review tasks).
- **`completeStream(streamId, summary)` (lines 287–362):**
  1. Calls `await this.releaseAllReservations(streamId)`.
  2. Calls `await dbPool.commitWork(streamId)` to drain any uncommitted shadow overlay writes for that stream.
  3. Calls `await dbPool.pushBatch([...])` **WITHOUT a second `streamId` argument** ([PM-011](../postmortems/PM-011-completion-state-stranded-in-shadow-overlay.md)) so `agent_streams.status = 'completed'` and `agent_memory.stream_summary` go directly into `activeBuffer` and flush to SQLite.
  4. Calls `await this.reconcileAfterStreamFailure(streamId, "Stream completed")` so any parent suspension barrier waiting on this child releases immediately.
  5. Calls `await this.settleLegionSpecialist(streamId, "completed", summary)` so any Legion formation advances its stage or synthesizes its final report.
- **`failStream(streamId, reason)` (lines 364–425):**
  1. Rolls back any uncommitted shadow overlay (`dbPool.rollbackWork(streamId)`).
  2. Releases all file reservations (`releaseAllReservations(streamId)`).
  3. Marks `agent_streams.status = 'failed'` and active tasks `'failed'` via direct `pushBatch`.
  4. Calls `reconcileAfterStreamFailure(streamId, reason)` and `settleLegionSpecialist(streamId, "failed", reason)`.
- **`releaseFiles` & `releaseAllReservations` (lines 714–770):**
  - **CRITICAL FLUSH BEFORE DELETE ([PM-012](../postmortems/PM-012-post-resume-reconcile-and-delete-upsert-ordering.md)):** Calls `await dbPool.flush()` before pushing the `delete` operations on `agent_memory` so that if `reserveFiles` (`upsert`) was called in the same 1-second window, `BufferedDbPool.flush()` does not sort `delete` before `upsert` and resurrect the deleted reservation row!

---

## 6. `src/infrastructure/db/BufferedDbPool.ts` (~515 lines)

**Purpose:** Write-behind batching pool and per-agent shadow overlay manager over `better-sqlite3`.

### Critical Invariants ([ADR-0003](../adr/ADR-0003-durable-state-in-agent-memory.md), [ADR-0010](../adr/ADR-0010-direct-writes-for-shared-rows.md))
- **`TABLE_FK_ORDER` (lines 34–43):**
  ```ts
  const TABLE_FK_ORDER: Record<string, number> = {
    users: 0,
    projects: 1,
    tasks: 2,
    task_steps: 3,
    logs: 4,
    agent_streams: 5,
    agent_tasks: 6,
    agent_memory: 7,
  };
  ```
  `flush()` sorts by `TABLE_FK_ORDER` **before** `LAYER_PRIORITY` so parent rows in `agent_streams` (`5`) are always inserted before child rows in `agent_tasks` (`6`) and `agent_memory` (`7`), preventing `SqliteError: FOREIGN KEY constraint failed` ([PM-003](../postmortems/PM-003-flush-order-layer-priority.md)).
- **Composite-Key Upserts on `agent_memory`:**
  `agent_memory` has a composite primary key `PRIMARY KEY (streamId, key)`. Every `upsert` on `agent_memory` **must** specify `conflictTarget: ["streamId", "key"]` and `where: [{ column: "streamId", value: ... }, { column: "key", value: ... }]` ([PM-002](../postmortems/PM-002-upsert-without-conflict-target.md)).

---

## 7. Completion Gate & Settings Surface

- **`src/core/task/tools/completionGatePipeline.ts` & `src/core/task/tools/handlers/AttemptCompletionHandler.ts`:**
  - `AttemptCompletionHandler` invokes `runCompletionGateFlow` (`completionGatePipeline.ts`). When the standard build/audit gate passes, `AttemptCompletionHandler` calls `evaluateOptionalCriticalCompletionReview`. If `blocked === true` (`REMEDIATE` or `ESCALATE`), `AttemptCompletionHandler` returns the formatted review blockage message as a tool result instead of completing the task.
- **The 7 Settings Plumbing Layers ([PB-02](../playbooks/PB-02-add-a-setting-end-to-end.md)):**
  1. `package.json` (`contributes.configuration` → `lumi.agentSwarm.*`)
  2. `proto/dietcode/state.proto` (`Settings` fields `339–348`, `UpdateSettingsRequest` fields `55–64`)
  3. `src/shared/storage/state-keys.ts` & `src/shared/ExtensionMessage.ts`
  4. `src/core/controller/state/updateSettings.ts` & `updateTaskSettings.ts` (clamps numeric ranges and calls `invalidateAgentSwarmConfigCache()`)
  5. `src/core/controller/index.ts` (resolves effective state via `loadAgentSwarmConfig()` and posts it to the webview)
  6. `src/core/task/ToolExecutor.ts`, `TaskConfig.ts`, `ToolConstants.ts` (`TASK_CONFIG_KEYS` — enforced by unit test so no key is ever dropped, [PM-005](../postmortems/PM-005-task-config-keys-drift.md))
  7. `webview-ui/src/components/settings/sections/FeatureSettingsSection.tsx` & `SettingsView.tsx` (Quick Filter bar, section jump pills, 1-click Workflow Presets `Off`/`Conservative`/`Balanced`/`Full Swarm`, progressive disclosure, and Legion roster & 5-stage pipeline visualization).

---

## 8. Specialist Execution Host & Sandboxed Adapter (`src/core/task/legion/`)

**Purpose:** Autonomous specialist loop execution, tool sandboxing, command settlement tracking, and parent context integration.

### Key Components & Invariants
- **`LegionAgentHost.ts`:**
  - Manages independent LLM client conversations for specialists.
  - Implements budget capping (`maxTokens`, `maxCost`) and heuristic token estimation when usage chunks are omitted by providers or return 0 tokens.
  - Enforces specialist prompt parity: injects `LEGION_CORE_RULES` into each specialist's system prompt upon execution, mandating `write_to_file`/`replace_in_file` for all file creations and edits, strictly prohibiting multiline heredocs (`cat <<'EOF'`, `tee`, `echo >`) and interactive stdin redirection, and explaining that non-interactive terminal sessions deadlock on heredocs ([ADR-0015](../adr/ADR-0015-multi-tier-terminal-heredoc-defense-and-prompt-parity.md), [PM-016](../postmortems/PM-016-terminal-heredoc-deadlock-and-prompt-parity.md)).
  - Defends UI streaming: wraps `onUsage` in `.catch()` error logging so webview transport disconnections do not fail the execution pipeline.
  - Circuit-breaks transport decoding errors: inspects caught errors with `isTransportError` (identifying `ToolArgumentError(concatenation | syntax)`, `SyntaxError`, or `"Stream decoding failed"`). Emits `[Transport Error] Stream decoding failed: ...` with `safeToRetry: false`, preventing futile specialist failover loops ([ADR-0014](../adr/ADR-0014-tool-argument-stream-deduplication-and-self-healing-parser.md), [PM-015](../postmortems/PM-015-tool-argument-snapshot-concatenation-and-stream-decoding-loop.md)).
- **`LegionToolAdapter.ts`:**
  - Isolates tool state with `executionOwner = legion:<streamId>`.
  - Maps parent permissions, approval callbacks, universal execution guards, and `.dietcodeignore` filters into the specialist context.
  - Commands lifecycle tracking: captures command start, registers uncertainty, and resolves settlement via `getPendingWork` across composite `{ status, command?.status, action?.status }` returns ([PM-014](../postmortems/PM-014-composite-command-settlement-and-reservation-boundary.md)).
  - Process group abort wiring: binds `parentSignal` directly into the composite `AbortSignal.any` signal array.
- **`Task.ts` Integration Points:**
  - `maybeRunAutomaticLegion`: Coordinates specialist pipeline before initiating the parent LLM loop.
  - `shouldAcceptSteeringInterrupt`: Evaluates `this.activeLegionController`, ensuring incoming user steering immediately halts in-flight specialists ([PM-013](../postmortems/PM-013-dead-code-steering-interrupt-and-specialist-drift.md)).
  - `withLegionContext`: Injects `<specialist_handoff>` evidence into a copy of the original user prompt matching `this.legionObjective`, avoiding drift across multi-turn follow-ups.
  - `resumeTaskFromHistory`: Unconditionally sets `legionAttempted = true` and recovers persisted receipts.
  - File Attachment Preservation: Preserves `this.legionObjective` when files are attached, only deferring to multimodal parent when images are present.
  - Gating Resilience: Allows tactical strike strategies and test projects to execute even below the 3.2 complexity score floor.

---

## 9. Orchestrator Conductor, Tool Discovery & Progress Streaming (`src/core/prompts/` & `src/core/task/tools/`)

**Purpose:** Provide the parent agent with explicit specialist conductor capabilities, auto-approval, prompt instructions, and human-observable streaming feedback.

### Key Components & Invariants
- **`EngageSwarmHandler.ts` (`src/core/task/tools/handlers/`):**
  - Implements `IToolHandler` for `DietCodeDefaultTool.ENGAGE_SWARM`.
  - Validates `objective` and checks that Swarm or Legion is enabled.
  - Extracts and clamps parameters: `maxSpecialists` (1..8), `strategy` (validated via `isValidLegionStrategy`), `preferredRoles`.
  - Converts specialist tool specifications into provider native tool schemas (`DietCodeToolSet.getNativeConverter`).
  - Injects a fallback `attempt_completion` tool specification with a single `result` string parameter.
  - Instantiates `LegionAgentHost` with parent task budget constraints (`maxTokens`, `maxCost`) and dispatches `runLegionPipeline`.
  - Streams progress cards to the chat feed via `config.callbacks.say("text", formatLegionProgressMessage(event))`.
  - Returns structured `<specialist_handoff status="...">` blocks containing synthesized markdown and unverified execution receipts.
- **`engage_swarm.ts` (`src/core/prompts/system-prompt/tools/`):**
  - Tool definition registered with `DietCodeDefaultTool.ENGAGE_SWARM`.
  - Dynamic context requirement: enabled when `legionEnabled || enabled` and `!context.isTesting`.
- **`autoApprove.ts` (`src/core/task/tools/`):**
  - Automatically approves `DietCodeDefaultTool.ENGAGE_SWARM` in `AutoApprove.shouldAutoApproveToolWithPath`.
  - Prevents interactive confirmation prompts from interrupting autonomous conductor workflows.
- **System Prompt Components (`src/core/prompts/system-prompt/components/`):**
  - `joy_zoning.ts`: Injects `# 🐝 AGENT SWARM & THE LEGION — Orchestrator Conductor` detailing the conductor role, 7 specialist roles, and Plan/Act mode expectations.
  - `capabilities.ts`: Injects `{{SWARM_CAPABILITIES}}` describing specialist delegation and multi-agent coordination.
  - `act_vs_plan_mode.ts`: Explains Plan Mode milestone role mapping and Act Mode `engage_swarm` execution.
- **`LegionPipelineRunner.ts` (`formatLegionProgressMessage`):**
  - Formats stage transitions, active specialist badges, completions, failure alerts, and ADR-0009 failover notifications into human-centered markdown cards streamed directly into the chat feed.
- **Hardened Task Gating (`src/core/task/index.ts`):**
  - Preserves `legionObjective` in `Task.startTask` when files are attached (only images defer to multimodal parent).
  - Falls back to conversation history user prompt in `maybeRunAutomaticLegion` if `this.legionObjective` is not set directly.
  - Relaxes the 3.2 complexity score floor and 2-member minimum for `tactical_strike` strategy, test projects, or explicit swarm/legion keywords.
  - Defensively guards `messageStateHandler` in `hasUnansweredAsk` and `setResponseValues`.

---

## 10. Streaming Tool Argument Hygiene & Self-Healing Parser (`StreamResponseHandler.ts`, `openai-codex.ts`)

**Purpose:** Protect specialist and orchestrator tool execution from stream snapshot duplication, interleaved call ID loss, and futile retry loops across model streaming endpoints.

### Key Components & Invariants
- **`StreamResponseHandler.ts` (`src/core/task/`):**
  - `extractJsonRoots(raw: string)`: State-machine scanner parsing sequential complete JSON roots from stream buffers. Accurately tracks nested braces, brackets, quotes, escapes, and string literals with braces (e.g. `awk '{print $1}'`).
  - `ToolUseHandler.processToolUseDelta`: Stream-time deduplication; checks prefix slicing and drops identical duplicate complete JSON roots (`deepEqual`).
  - `ToolUseHandler.assertCompleteToolUses`: Terminal self-healing; when `JSON.parse` fails, extracts all complete JSON roots. If multiple identical roots exist (`deepEqual`) with no remainder, unifies them to `roots[0].value` and accepts the tool call cleanly.
  - `ToolArgumentError`: Typed diagnostics (`"incomplete"`, `"concatenation"`, `"syntax"`, `"invalid_format"`) capturing `toolName` and `rawInput`.
- **Streaming Provider Handlers (`src/core/api/providers/` & `src/core/api/utils/`):**
  - `openai-codex.ts`, `openai-native.ts`, `responses_api_support.ts`: Stateful argument offset tracking via `toolCallDelta(callId, args, snapshot)`. When terminal snapshot chunks (`output_item.done`, `function_call_arguments.done`) follow deltas, slices unstreamed suffixes and drops duplicate snapshots (`delta = ""`).
  - Interleaved tool identity maps (`toolCallIdByItemId`, `toolCallNameByItemId`, `toolCallNameByCallId`, `functionCallByItemId`) preserving tool call names across interleaved chunk streams.

---

## 11. Multi-Tier Terminal Heredoc Defense & Shell Integration Circuit-Breaking (`src/integrations/terminal/`, `src/core/policy/`, `src/hosts/vscode/terminal/`)

**Purpose:** Defend against VS Code shell integration deadlocks, interactive stdin freezing, and file reservation bypasses caused by models issuing terminal heredoc file creations (`cat <<'EOF'`, `tee`, `echo >`).

### Key Components & Invariants
- **`heredocPolicy.ts` (`src/integrations/terminal/`):**
  - `findTopLevelHeredocs(command: string)`: Shell-token scanner tracking single quotes, double quotes, escapes, and arithmetic expansions (`$((...))` / `((...))`). Accurately detects top-level `<<` heredoc operators while ignoring arithmetic bitwise shifts and quoted literals.
  - `detectHeredocFileRedirection(command: string)`: Detects file creation across all shell variations: redirection before delimiter (`cat > file << 'EOF'`), tee before delimiter (`tee file << 'EOF'`, `sudo tee`), redirection on delimiter line (`cat << 'EOF' > file`), piped heredocs (`cat << 'EOF' | sudo tee file`), and delimiter line redirection (`EOF > file`). Handles quoted filenames and filters `/dev/null`. Returns `{ isHeredocFileWrite, targetFiles, reason }` directing the model to `write_to_file`.
  - `isMultilineHeredocCommand(command: string)`: Identifies any multiline command containing heredoc syntax that threatens interactive shell integration with input deadlock.
- **`ExecuteCommandToolHandler.ts` (`src/core/task/tools/handlers/`):**
  - Approval suppression: suppresses interactive user approval prompts when `detectHeredocFileRedirection(command).isHeredocFileWrite` is true, avoiding interactive prompt stalls on forbidden commands.
  - Pre-execution interception: intercepts heredoc file write commands before permission validation and execution, emits `command_permission_denied`, and returns `formatResponse.toolError(reason)`.
- **`UniversalGuard.ts` & `FluidPolicyEngine.ts` (`src/core/policy/`):**
  - `guardPreExecution` & `validatePreExecution`: Pre-flight checks reject heredoc file redirection with actionable policy errors directing callers to `write_to_file`.
- **`ToolValidator.ts` (`src/core/task/tools/`):**
  - `validateExecuteCommandParams`: Blocks heredoc file redirection commands before execution dispatch.
- **`VscodeTerminalProcess.ts` & `VscodeTerminalManager.ts` (`src/hosts/vscode/terminal/`):**
  - Multiline shell integration circuit breaker: In `VscodeTerminalProcess.run`, if `isMultilineHeredocCommand(command)` is true under interactive shell integration, safely falls back to a supervised managed terminal if available, or throws an error refusing execution to prevent terminal deadlock.
  - Fast-path microtask deferral: `VscodeTerminalManager.runCommand` defers dispatch for multiline heredocs to ensure output and completion listeners attach prior to execution.

---

Next: Read **[03 — Day-2 Operating & SQLite Inspection Handbook](03-operating-handbook.md)** to learn how to inspect a live database, grep logs, and diagnose production state in under 60 seconds.
