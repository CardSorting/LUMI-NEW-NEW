---
title: "Runtime Stabilization & Subagent Decommissioning Report"
sidebarTitle: "Runtime Stabilization"
description: "Forensic postmortem and architectural guide explaining why subagents and advisory completion gates failed, the comprehensive zero-stub remediation executed in v24.0.0, and why the single-loop strategy is now working."
---

# Runtime Stabilization & Subagent Decommissioning Report

**Release**: LUMI v24.0.0 / v24.0.1  
**Status**: Production / Stabilized  
**Architecture Model**: Deterministic Single-Loop Agentic Runtime  

---

## 1. Executive Summary

In LUMI v23 and earlier, the agent runtime incorporated an intricate multi-agent delegation system ("Subagents") alongside a set of heuristic coaching, reminder, and completion-gating layers. While conceived to allow parallel task delegation and automated quality enforcement, in practice these mechanisms introduced critical runtime failure modes:

1. **State Corruption**: Child subagents operated with independent lifecycle loops, depth lanes, and tool registries, causing concurrent state collisions, desynchronized task receipts, and corrupted conversation histories.
2. **Infinite Loops & Completion Deadlocks**: Cascading completion gates (`subagentCompletionGates`, `focusChainReminders`, `FluidPolicyEngine` act-mode coaching, and "Catch rough drafts" placeholder detection) intercepted `attempt_completion`. Even when tasks were fully implemented, tested, and correct, the agent was perpetually rejected by automated heuristics and trapped in repetitive, token-draining loops.
3. **Execution Gating Latency**: Check-in timeouts, slot reservation locks, and speculative file-write advisories generated massive friction, stalling user interactions and blocking forward progress.

In **v24.0.0**, a complete architectural overhaul was executed. Seven broken feature toggles and the entire subagent infrastructure were excised using a strict **zero-stub** methodology—purging dead pathways across Protobuf specifications, backend executors, system prompt variants, and webview UI components.

The result is a clean, deterministic, single-loop agent that completes tasks with high fidelity, predictable token consumption, and zero completion gating deadlocks.

---

## 2. Forensic Root Cause Analysis: What Exactly Happened

### 2.1 The Seven Broken Actions

The following seven features in agent settings and backend execution were identified as structurally broken and actively harmful to task progression:

| Feature / Setting | Original Intention | Actual Failure Mode in Practice |
| :--- | :--- | :--- |
| **1. Delegate to subagents** (`use_subagents`) | Allow parent agent to spawn specialized helpers (workers, verifiers, researchers) and aggregate results. | Child agents ran detached lifecycles that deadlocked execution slots, corrupted shared memory (`mem_claim`/`mem_release`), and hallucinated completion status. |
| **2. Gentle reminders** (`focusChainReminders`) | Nudge the agent at recurring intervals during long-running tasks. | Injected repetitive prompt reminders into context, knocking the agent off its plan and triggering infinite completion rejection cycles. |
| **3. Helpful nudges while coding** (`auditActModeAdvisoryEnabled`) | Provide passive architectural and best-practice advice during act mode. | Intercepted tool execution with speculative warnings from `FluidPolicyEngine`, confusing the LLM and causing erratic tool retries. |
| **4. Stricter checks for risky tasks** (`auditIntentThresholdAdjustmentsEnabled`) | Dynamically raise security and validation thresholds for bug fixes and testing. | Artificially inflated gating barriers, rejecting valid edits based on crude heuristic pattern matching. |
| **5. Export check results (advanced)** (`auditSarifHookExportEnabled`) | Generate SARIF static analysis reports on completion. | Created unneeded background I/O overhead and hung task cleanup if SARIF formatting hooks failed. |
| **6. Save check notes in your project** (`auditWorkspaceArtifactsEnabled`) | Write audit summaries and notes to a `.audit/` workspace folder. | Polluted user workspaces with ephemeral `.audit/` directories, dirtying `git status` and causing file-watcher thrashing. |
| **7. Catch rough drafts** (`auditFileWriteAdvisoryEnabled`) | Detect `TODO`, `FIXME`, or placeholder text before marking tasks complete. | Triggered false positives on legitimate documentation, code comments, or third-party code, blocking `attempt_completion` indefinitely. |

### 2.2 The Subagent Concurrency & State Corruption Loop

The subagent architecture attempted to manage distributed multi-agent execution within a single VS Code extension instance. This introduced several fatal architectural flaws:

```
[Parent Task Execution]
        │
        ├─► use_subagents (Spawns Child Subagent Runner)
        │         │
        │         ├─► Slot Allocation (Contention on 3 fixed slots)
        │         ├─► Memory Claim (Race conditions on shared keys)
        │         └─► Dynamic Tool Dispatch (Clashed with parent tool registry)
        │
        ▼
[State Desynchronization]
  • Child mutations not committed to parent task state
  • Telemetry receipts interleaved out-of-order
  • Parent context window saturated with JSON-serialized helper snapshots
        │
        ▼
[Infinite Completion Gating]
  • Parent calls attempt_completion
  • subagentCompletionGates checks child state ──► "Waiting for helper settlement"
  • Helper checks parent state ────────────────► "Waiting for parent review"
        │
        ▼
   [DEADLOCK / RUNAWAY TOKEN SPIRAL]
```

1. **Depth Lanes & Slot Starvation**: Execution slots were bounded to 3 slots across tasks. When a parent task dispatched multiple helpers that further delegated or waited on child processes, slot exhaustion caused deadlocks where neither parent nor child could make forward progress.
2. **Context Saturation**: To maintain awareness of helpers, the system injected thousands of characters of serialized execution inventory (`get_execution_state`) and progress previews into every prompt turn. This consumed precious context window space and caused LLM attention degradation.
3. **Completion Gating Collisions**: `subagentCompletionGates.ts` enforced validation barriers on `attempt_completion`. If any child task logged a non-terminal status, unconfirmed outcome, or lingering tool execution, `attempt_completion` threw an error, forcing the model into an infinite loop trying to appease a gate it had no control over.

---

## 3. What Needed to Be Done: The Remediation Strategy

Rather than disabling flags or wrapping legacy code in try/catch blocks, we followed a principled **zero-stub elimination strategy**. Every layer of the system was scrubbed clean to prevent ghost behaviors, dead code maintenance, or runtime regressions.

### 3.1 Layer 1: Protocol Buffers & Wire Format Sanitization

The protobuf definitions govern inter-process communication between the extension backend and the webview UI:

- **`proto/dietcode/state.proto`**: Excised all 7 broken settings fields. Removed obsolete enum indices and marked removed field numbers as reserved to prevent future wire collisions.
- **`proto/dietcode/ui.proto`**: Reserved legacy message types `DietCodeAsk.USE_SUBAGENTS` (index 17) and `DietCodeSay` subagent variants (34, 35, 36).
- **Binding Generation**: Re-compiled all TypeScript types and Protobuf bus services with `npm run protos`.

### 3.2 Layer 2: Core Task Engine & Tool System

All files and classes associated with subagents were completely deleted from the workspace:

- **Deleted Modules**:
  - `src/core/prompts/system-prompt/tools/subagent.ts`
  - `src/core/task/tools/handlers/SubagentToolHandler.ts`
  - `src/core/task/tools/subagent/AgentConfigLoader.ts`
  - `src/core/task/tools/subagent/SubagentBuilder.ts`
  - `src/core/task/tools/subagent/SubagentProgress.ts`
  - `src/core/task/tools/subagent/SubagentRunner.ts`
  - `src/core/task/tools/subagent/SubagentToolName.ts`
  - `src/core/task/tools/subagent/SwarmConsensusHandler.ts`
  - `src/core/task/reconcileHelperExecutions.ts`
  - `src/core/task/tools/subagent/observeHelperOperation.ts`
  - `src/core/task/tools/subagentCompletionGates.ts`
  - `src/shared/subagents.ts`
  - `src/shared/audit/auditSubagentContext.ts`
  - `src/shared/audit/auditSubagentRollup.ts`
- **Task Loop Sanitization**: Removed all helper queues, subagent dispatchers, and reconciliation hooks from `src/core/task/index.ts`.
- **System Prompts**: Removed the `use_subagents` tool specification from all 13 system prompt variants across all model profiles.
- **Tool Coordination**: Relocated core regression tests (e.g., `ToolProgressTracker.test.ts`) into primary task test suites and removed subagent dynamic tool resolution.

### 3.3 Layer 3: Advisory & Completion Gate Simplification

- **Eliminated Focus Chain Gating**: Removed recurring reminder timers and completion interception from `attemptCompletionUtils.ts`.
- **Streamlined Policy Engine**: Spliced out the advisory coaching subsystem from `FluidPolicyEngine.ts` and removed dead heuristics (`sealReason`, `simulationEngine`, `detectConcurrentDrift`, `generateIntegrityAdvisor`).
- **Removed Intent Threshold Overrides**: Cleaned `gatePolicy.ts`, `auditGatePolicyLoader.ts`, `auditWorkspaceArtifacts.ts`, and `auditCiSummary.ts`, ensuring tool execution adheres strictly to user configuration without runtime threshold inflation.

### 3.4 Layer 4: Webview UI & Settings Interface

- **Deleted Components**: Removed `SubagentStatusRow.tsx`, `SubagentAuditBadge.tsx`, `SubagentHandoffStrip.tsx`, and `AuditIntentThresholdPanel.tsx`.
- **Purged Settings Toggles**: Cleaned `FeatureSettingsSection.tsx` by eliminating the checkboxes for subagents, gentle reminders, act-mode nudges, stricter checks, SARIF export, workspace notes, and rough drafts.
- **State Store Cleanliness**: Removed obsolete state properties and handlers from `ExtensionStateContext.tsx`, `useMessageHandlers.ts`, `buttonConfig.ts`, and `messageUtils.ts`.

### 3.5 Layer 5: Compiler, Type Checking & Lint Verification

- Resolved strict TypeScript issues across both Node extension and React webview (`npm run check-types` passing with 0 errors).
- Resolved Biome linter errors across all 1,727 files (`npm run lint` passing with 0 errors).
- Verified production bundling with `npm run compile`.

---

## 4. Release & Multi-Platform Distribution (v24.0.0)

To establish a clean architectural baseline, the extension version was bumped directly to major release **`24.0.0`**:

- **Repository**: Synced to `main` at commit `260489cf`.
- **Automated CI/CD**: Triggered the GitHub Actions `Build Marketplace VSIX Packages` workflow ([`.github/workflows/build-vsix.yml`](file:///Users/bozoegg/Downloads/LUMI/.github/workflows/build-vsix.yml)).
- **Build Run Result**: [Run #38581931887](https://github.com/CardSorting/LUMI-NEW-NEW/actions/runs/38581931887) completed with **100% success** across all matrix runners:
  - `darwin-arm64` (macOS Apple Silicon)
  - `darwin-x64` (macOS Intel)
  - `linux-x64` (Linux x64)
  - `win32-x64` (Windows x64)
- **Artifacts Produced**: Generated 8 verified `.vsix` packages (4 VS Code Marketplace packages + 4 Open VSX packages) bundled in `marketplace-vsix-all-platforms`.

---

## 5. Why This Strategy Is Now Working

The transition from a multi-agent speculative architecture to a **deterministic single-loop runtime** has yielded decisive performance and reliability benefits:

```
[User Request]
       │
       ▼
[Deterministic Single-Loop Agent] ◄── Direct API Provider (OpenRouter, Codex, Claude, Nous, Cline)
       │
       ├─► Inspects workspace (view_file, list_dir, grep_search)
       ├─► Executes changes (replace_file_content, write_to_file)
       ├─► Validates correctness (run_command: tests, linter, compiler)
       │
       ▼
[attempt_completion]
       │
       ▼ (Direct Resolution — Zero Gating Obstacles)
 [Task Completed Successfully]
```

### 5.1 Deterministic Execution State
Without child runners modifying state or claiming memory keys in parallel, the task state is strictly linear and deterministic. The agent always knows exactly what files were modified, what commands succeeded or failed, and what remains to be done.

### 5.2 Direct, Predictable Completion
`attempt_completion` now acts as an uninhibited signal of task completion. When the agent completes the user's requirements and verifies its work, it calls `attempt_completion` and finishes immediately. There are no synthetic "rough draft" blockers, no focus chain interruptions, and no unresolvable subagent consensus gates.

### 5.3 Maximized Context Window Efficiency
Stripping out helper execution inventories, snapshot serializations, and speculative advisory payloads saves thousands of tokens per conversation turn. The LLM focuses its entire context window on the user's actual codebase, resulting in higher reasoning accuracy and faster response times.

### 5.4 Robust Provider Compatibility
Direct API providers configured in [`src/shared/api.ts`](file:///Users/bozoegg/Downloads/LUMI/src/shared/api.ts) and [`src/shared/storage/state-keys.ts`](file:///Users/bozoegg/Downloads/LUMI/src/shared/storage/state-keys.ts) (including OpenRouter, OpenAI Codex, Anthropic Claude Direct SDK, Nous Research, Cline Pass, and others) interact directly with the agent loop without proxy interceptors or middleware desynchronization.

---

## 6. Architectural Rules for Future Maintenance

To preserve the stability achieved in v24.0.0, all future contributions must adhere to the following principles:

1. **Maintain Single-Loop Simplicity**: Do not introduce multi-agent delegation or background child runners inside the extension process. If long-running sub-tasks are needed, model them as transparent background commands or external scripts.
2. **No Completion-Blocking Heuristics**: Quality gates must be advisory to the user or enforced via actual project test suites and linters (`npm test`, `npm run lint`). The agent runtime must never reject `attempt_completion` based on regex searches for `TODO` comments or subjective advisory heuristics.
3. **Zero-Stub Cleanliness**: When deprecating or removing features, eliminate the code across all layers (Protobuf, backend, UI, tests). Avoid empty stub handlers, dummy fallbacks, or commented-out blocks that create dead-code traps.
4. **Protobuf Index Preservation**: Always mark decommissioned Protobuf field tags as `reserved` to ensure backwards compatibility across extension upgrades and remote bridges.
