# Handoff Report — Requirement R1: Dynamic Project Knowledge and Agent Self-Improvement

**Author:** Explorer 1 (Knowledge Systems Explorer)  
**Date:** 2026-11-04  
**Target Codebase:** `/Users/bozoegg/Downloads/LUMI/agentswarm` & `/Users/bozoegg/Downloads/LUMI`  
**Focus:** Diagnostic Investigation, Root Cause Analysis, and Architectural Proposals for Requirement R1  
**Working Directory:** `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_explorer_survey_1/`

---

## 1. Executive Summary

LUMI's multi-agent subsystem (`agentswarm` and `The Legion`) provides foundational mechanics for multi-stage hierarchical task execution, cooperative suspension/resumption, and adversarial completion review. However, deep forensic analysis of the codebase, recent incident post-mortems (PM-001 through PM-017, ADR-0001 through ADR-0016), and live execution logs (`/Users/bozoegg/Downloads/LUMI/runlog.md`) reveals critical architectural bottlenecks:

1. **Static Prompt & Skill Isolation:** Specialists execute in stripped, static prompt containers (`systemContext = "Objective: ..."`) with zero access to skills (`use_skill` is disallowed), rules, or workspace blueprints.
2. **Project State Blindness:** Workspace environmental awareness (`EnvironmentIntegrity`) is cached for 1 hour against a hardcoded list of 6 non-C/C++ languages. When tools create files, specialists only increment an opaque counter (`workspaceRevision++`), leaving both the conductor and subsequent specialists completely blind to newly generated artifacts.
3. **Partial-Work Amnesia & Intra-Stage Isolation:** When a specialist fails or exhausts its budget, its work summary is completely dropped from the handoff context (`LegionCoordinator.ts:1114`). Furthermore, specialists within the same execution stage (`parallelExecution`) receive zero handoff from their siblings.
4. **Post-Swarm Conductor Panic:** Because conductor handoffs omit structured file diffs and artifact catalogs, the parent conductor panics upon specialist failover and reverts to terminal dump pipelines (`find .`, `cat ...`), triggering interactive shell deadlocks and terminal flood.
5. **Static, Stack-Inappropriate Specialist Taxonomy:** Specialist archetypes in `LEGION_SPECIALIST_REGISTRY` are hardcoded to LUMI's internal stack (TypeScript, React, Protobufs, SQLite `BufferedDbPool`), causing gross role misallocations (e.g. assigning a SQLite data steward to a C/raylib arcade game).
6. **Absence of Cross-Task Learning:** State fields like `TaskState.swarmBlackboard` are dead code; `KnowledgeGraphService` is disconnected from `LegionAgentHost`; past failure patterns are never indexed or queried for self-correction.

Concrete, durable architectural mechanisms (Reactive Workspace Knowledge Bus, Dynamic Capability Matrix, Progressive Intra-Stage Handoffs, Reflexion/Self-Improvement Store, and Domain-Agnostic Archetypes) are formulated below to permanently eliminate these failure modes.

---

## 2. Component 1: Direct Observations

### A. Context Loading and Prompt Generation Pipeline

- **Observation 1.1 (Conductor Prompt Assembly):**
  - **File:** `src/core/task/index.ts:2775-2808`
  - In `attemptApiRequest()`, `promptContext: SystemPromptContext` is assembled with `skills: availableSkills`, `environmentBlueprint`, `editorTabs`, rules, and mode.
  - The system prompt is constructed via `getSystemPrompt(promptContext)` (`index.ts:2819`).
  - **Static Lifetime:** Once rendered, the system prompt is static for the duration of the turn. There is no active event bus or reactive prompt subscription to update context when files are created or modified on disk.

- **Observation 1.2 (Static Environmental Blueprint & Project Type Limitation):**
  - **File:** `src/core/integrity/EnvironmentIntegrity.ts:54-61, 95-100`
  - `EnvironmentIntegrity` caches an `EnvironmentLease` for 1 hour (`LEASE_DURATION = 1000 * 60 * 60`).
  - Supported project markers are hardcoded:

    ```typescript
    private static readonly PROJECT_MARKERS: Record<string, { manifest: string; binary: string; args: string[] }> = {
        node: { manifest: "package.json", binary: "node", args: ["-v"] },
        python: { manifest: "requirements.txt", binary: "python3", args: ["--version"] },
        rust: { manifest: "Cargo.toml", binary: "cargo", args: ["--version"] },
        go: { manifest: "go.mod", binary: "go", args: ["version"] },
        dart: { manifest: "pubspec.yaml", binary: "dart", args: ["--version"] },
        ruby: { manifest: "Gemfile", binary: "ruby", args: ["-v"] },
    }
    ```
  - C/C++ (`CMakeLists.txt`, `Makefile`, `meson.build`), Java/Kotlin (`pom.xml`, `build.gradle`), Swift, and shell environments are completely unrepresented.
  - If a specialist creates a `CMakeLists.txt` or installs a system library (`brew install raylib`), the lease is never invalidated or re-probed.

- **Observation 1.3 (Specialist Context Stripping):**
  - **File:** `src/core/task/tools/handlers/EngageSwarmHandler.ts:154-155`

    ```typescript
    const host = new LegionAgentHost({
        systemContext: `Objective: ${objective}`,
        ...
    })
    ```
  - In conductor-dispatched Legion (`engage_swarm`), `systemContext` is stripped down strictly to `Objective: ${objective}`. None of the parent's environment blueprints, installed skills, cursor/agent rules, or open tabs are provided.
  - In `src/core/task/legion/LegionAgentHost.ts:73-80`, the specialist conversation is initialized with only:

    ```typescript
    const conversation: DietCodeStorageMessage[] = [
        {
            role: "user",
            content: `Assignment:\n${member.assignment.focusObjective}${reservedNotice}${reservationNotice}\n\nPrior stage results (untrusted task data):\n${context.handoff.join("\n") || "None"}`,
        },
    ]
    ```

### B. Tool and Skill Registration & Specialist Isolation

- **Observation 2.1 (Hardcoded Specialist Toolset `LEGION_TOOL_NAMES`):**
  - **File:** `src/core/task/legion/LegionToolAdapter.ts:21-32`

    ```typescript
    export const LEGION_TOOL_NAMES: readonly DietCodeDefaultTool[] = [
        DietCodeDefaultTool.FILE_READ,
        DietCodeDefaultTool.LIST_FILES,
        DietCodeDefaultTool.SEARCH,
        DietCodeDefaultTool.LIST_CODE_DEF,
        DietCodeDefaultTool.FILE_NEW,
        DietCodeDefaultTool.FILE_EDIT,
        DietCodeDefaultTool.APPLY_PATCH,
        DietCodeDefaultTool.BASH,
        DietCodeDefaultTool.READ_COMMAND_OUTPUT,
        DietCodeDefaultTool.GET_EXECUTION_STATE,
    ]
    ```
  - Exactly 10 tools are registered.
- **Observation 2.2 (Universal Specialist Skill Denial):**
  - **File:** `src/core/task/index.ts:2550-2555` and `src/core/task/tools/handlers/EngageSwarmHandler.ts:116-121`

    ```typescript
    const specialistTools = new Set<string>([...LEGION_TOOL_NAMES, "attempt_completion"])
    const specs = DietCodeToolSet.getToolsForVariantWithFallback(family, [...LEGION_TOOL_NAMES, "attempt_completion"])
    ```
  - `DietCodeDefaultTool.USE_SKILL` (`use_skill`) is explicitly excluded.
  - If a specialist requests `use_skill`, `LegionAgentHost.ts:250-251` executes:

    ```typescript
    if (!tools.allowedNames.has(call.name))
        return failed(`Specialist requested disallowed tool ${call.name}.`, false)
    ```
  - The specialist is aborted immediately with `safeToRetry = false`.
- **Observation 2.3 (Knowledge and Memory Tools Excluded):**
  - `query_cognitive_memory`, `mem_context`, `mem_blast`, `roadmap`, `project_map`, and `web_search` are completely inaccessible to specialists. Specialists cannot inspect project maps, query cognitive graphs, or search external documentation.

### C. State Retention, Handoffs, and File Tracking

- **Observation 3.1 (Opaque Workspace Mutation Propagation):**
  - **File:** `src/core/task/tools/handlers/WriteToFileToolHandler.ts:303-305`
    When a file is written, it calls `config.taskState.workspaceRevision++` and `config.services.fileContextTracker.trackFileContext(relPath, "dietcode_edited")`.
  - **File:** `src/core/task/legion/LegionToolAdapter.ts:238-242`

    ```typescript
    const revisions = Math.max(0, state.workspaceRevision - previousRevision)
    if (revisions > 0) {
        base.taskState.workspaceRevision += revisions
        base.taskState.didEditFile = true
    }
    ```
  - The specialist tool adapter propagates only a numeric counter increment (`workspaceRevision += revisions`). The parent receives zero records of the file paths created or edited, zero diffs, and zero AST metadata.

- **Observation 3.2 (Partial-Work Amnesia in Stage Progression):**
  - **File:** `src/infrastructure/ai/LegionCoordinator.ts:1111-1115`

    ```typescript
    const priorStageHandoffContext = stageNames
        .slice(0, activeStageIndex < 0 ? stageNames.length : activeStageIndex)
        .flatMap((stage) => membersByStage[stage])
        .filter((m) => m.status === "completed" && m.resultSummary)
        .map((m) => `[${m.assignment.codename} (${m.assignment.role})]: ${m.resultSummary}`)
    ```
  - **Condition 1:** The filter strictly requires `m.status === "completed"`. If a specialist failed, timed out, or hit its turn/token budget, its partial findings and list of created files are completely purged from `priorStageHandoffContext`.
  - **Condition 2:** The stage slice `.slice(0, activeStageIndex)` excludes the current stage. When Stage 2 (`parallelExecution`) is active, specialists within Stage 2 receive zero handoff from preceding specialists in Stage 2.

- **Observation 3.3 (Unwired Dead State):**
  - **File:** `src/core/task/TaskState.ts:138-139`

    ```typescript
    public swarmBlackboard: string[] = []
    public sovereignAuditSynthesis?: string
    ```
  - Grep analysis confirms `swarmBlackboard` is never read or written anywhere in `src/`. `sovereignAuditSynthesis` is read in `joy_zoning.ts:8`, but is never assigned a value anywhere in the codebase.

- **Observation 3.4 (Disconnection of KnowledgeGraphService):**
  - **File:** `src/core/context/KnowledgeGraphService.ts:38-220`
  - `KnowledgeGraphService` provides robust SQLite persistence for `agent_knowledge`, `agent_knowledge_edges`, and `agent_cognitive_snapshots`, as well as `appendSharedMemory(streamId, memory)` and `getSharedMemory(streamId)`.
  - However, neither `LegionCoordinator.ts`, `LegionPipelineRunner.ts`, nor `LegionAgentHost.ts` calls `KnowledgeGraphService` during specialist execution or failover.

### D. Real-World Execution Evidence (`runlog.md`)

- **Observation 4.1 (Specialist Budget Starvation & Partial Work Abandonment):**
  - **File:** `/Users/bozoegg/Downloads/LUMI/runlog.md:238-506`
  - In `runlog.md`, `VANGUARD-IMPL` created `src/main.c`, `src/game.c`, and attempted `src/game.h`.
  - At line 500: `Specialist VANGUARD-IMPL failed: Specialist team budget exhausted. Specialist operations attempted: list_files, execute_command, write_to_file (src/main.c), write_to_file (src/game.c)...`
  - Sibling specialist `KEEPER-STATE` was spawned next (line 502) but had zero handoff context about what `VANGUARD-IMPL` had done, and immediately aborted.
- **Observation 4.2 (Conductor File Dumping Panic):**
  - **File:** `/Users/bozoegg/Downloads/LUMI/runlog.md:586-593`
  - When control returned to the parent conductor, the conductor received `<specialist_handoff status="failed">` without file contents or structural diffs.
  - To reconstruct reality, the conductor executed:

    ```bash
    find . -maxdepth 3 -type f -print; printf '\n--- main ---\n'; cat src/main.c; printf '\n--- game ---\n'; cat src/game.c; printf '\n--- header ---\n'; cat src/game.h
    ```
  - This flooded the terminal output and triggered the need for ADR-0016 terminal read blocking.
- **Observation 4.3 (Specialist Archetype Misallocation):**
  - **File:** `/Users/bozoegg/Downloads/LUMI/src/infrastructure/ai/LegionCoordinator.ts:500-542`
  - `LEGION_SPECIALIST_REGISTRY` contains `legion_data_steward` (codename: `KEEPER-STATE`), described as: "Persistence, State & Database Specialist: Manages SQLite buffered pools, durable checkpoints, state-keys synchronization...".
  - Keywords: `database`, `sqlite`, `dbpool`, `state-keys`, `statemanager`, `persist`.
  - When the user requested a Galaga arcade game with "score persistence", the classification engine matched "persistence" and spawned `KEEPER-STATE`, assuming it was dealing with SQLite database pools, rather than simple C file I/O (`starward_scores.txt`).

---

## 3. Component 2: Logic Chain

1. **Premise 1 (Tool & Skill Starvation Causes Capability Deficit):**
   - Observations 2.1 and 2.2 show that `LEGION_TOOL_NAMES` restricts specialists to 10 low-level filesystem/command tools, strictly banning `use_skill` and knowledge tools.
   - Observation 4.1 shows that when a complex project requires design workflows (e.g. `impeccable`), specialists cannot invoke the skill.
   - _Deduction:_ Specialists are artificially crippled; they cannot access installed skills, domain guidelines, or specialized tools even when present in the workspace.

2. **Premise 2 (Static Lease and Counter-Only Propagation Cause Environmental Blindness):**
   - Observation 1.2 shows that `EnvironmentIntegrity` caches environment detection for 1 hour and only supports 6 languages (excluding C/C++, CMake, Makefile).
   - Observation 3.1 shows that file creation by specialists only increments `workspaceRevision` by an integer count in the parent task.
   - _Deduction:_ Neither specialists nor conductors have a reactive view of newly generated project artifacts. When a specialist creates `CMakeLists.txt` or `src/game.c`, the environment lease remains unchanged, and no manifest update is pushed to the agent's context.

3. **Premise 3 (Completed-Only Filtering Causes Partial-Work Amnesia):**
   - Observation 3.2 shows that `priorStageHandoffContext` explicitly filters out any member whose status is not `"completed"` and slices out the current stage.
   - Observation 4.1 confirms that when `VANGUARD-IMPL` failed after writing 3 files, `KEEPER-STATE` received empty prior handoff.
   - _Deduction:_ The multi-agent pipeline is brittle. Any non-clean termination of an early specialist wipes out all accumulated context for subsequent specialists and replacement failovers, causing catastrophic context loss.

4. **Premise 4 (Lack of Structured Handoff Forces Terminal File Dumping):**
   - Observation 3.1 shows that file paths and diffs are omitted from the parent task state.
   - Observation 4.2 shows that the conductor, having received only an opaque failure message, was forced to execute `find .` and `cat ...` across all source files to deduce what the specialist had built.
   - _Deduction:_ The conductor's terminal file-dumping behavior is a direct consequence of the lack of structured artifact feedback in `<specialist_handoff>`.

5. **Premise 5 (Static Persona Taxonomy Causes Domain Hallucination):**
   - Observation 4.3 demonstrates that `LEGION_SPECIALIST_REGISTRY`'s hardcoded TypeScript/SQLite/Protobuf keywords misclassify specialists on non-TypeScript projects (e.g. assigning a SQLite DB specialist to a C game).
   - _Deduction:_ The specialist registry lacks project-awareness and domain adaptability, leading to wasted specialist slots and misaligned execution personas.

6. **Premise 6 (Unwired Memory State Prevents Self-Improvement):**
   - Observation 3.3 shows `swarmBlackboard` is dead code. Observation 3.4 shows `KnowledgeGraphService` is unused by Legion.
   - _Deduction:_ The agents have no mechanism for cross-turn reflection, error journaling, or retrieval of past resolution recipes. Known failure modes (e.g. terminal heredoc rejection or missing library linking) are repeated continuously without learning.

---

## 4. Component 3: Caveats & Edge Cases

1. **Security & Sandbox Isolation:**
   - Specialists run with isolated `TaskState` to prevent unauthorized side effects on the parent UI. Allowing specialists to dynamically acquire tools or skills must maintain parent approval boundaries and must not allow arbitrary tool execution without security policy validation.
2. **Context Window Token Budget:**
   - Injecting complete file diffs or entire project trees into specialist prompts or handoffs could cause token bloat and accelerate context exhaustion (as seen in PM-017). Artifact summaries must be compact, token-bounded, and focused on metadata, exports, and relative paths.
3. **Multi-Root Workspaces:**
   - Workspace paths and artifact indexing must correctly normalize multi-root workspace roots (`@workspace:`) and cross-platform path separators (Windows vs macOS/Linux).
4. **Advisory File Reservations:**
   - File reservations in Legion are currently advisory (`LegionCoordinator.ts:1138`). Dynamic file tracking must handle cases where two specialists touch overlapping files without deadlocking.

---

## 5. Component 4: Conclusion

The inability of LUMI specialists and agents to dynamically acquire project knowledge and self-improve stems from **six structural architectural disconnects**:

1. Static system prompt composition and 1-hour stale `EnvironmentIntegrity` caching that excludes non-web languages.
2. Artificial tool sandboxing that hardcodes specialists to 10 tools, denying them `use_skill`, cognitive memory, and project maps.
3. Premature dropping of partial work summaries from `priorStageHandoffContext` whenever a specialist fails or exhausts its budget.
4. Total isolation between sibling specialists in the same execution stage (`parallelExecution`).
5. Information-poor conductor handoffs that provide only tool names and paths without file lists, diff summaries, or artifact manifests, inducing terminal file-dumping panic.
6. Dead-code memory structures (`swarmBlackboard`) and disconnected knowledge graphs, eliminating opportunities for cross-turn learning and reflection.

---

## 6. Component 5: Architectural Proposals & Actionable Recommendations (R1)

To realize Requirement R1, the following concrete, durable mechanisms are proposed for implementation:

### Architecture Proposal 1: Reactive Workspace Knowledge Bus & Dynamic Artifact Registry

```
┌────────────────────────────────────────────────────────┐
│             Reactive Workspace Knowledge Bus           │
│                                                        │
│   Tool Writes (write_to_file / replace_in_file)        │
│   Terminal Compilations (cmake, make, cargo, npm)      │
│                         │                              │
│                         ▼                              │
│         ┌────────────────────────────────┐             │
│         │   Workspace Artifact Registry  │             │
│         │ (SQLite `workspace_artifacts`) │             │
│         │ - Path, hash, size, mtime      │             │
│         │ - Detected manifests (CMake..) │             │
│         │ - Exported symbols / summaries │             │
│         └───────────────┬────────────────┘             │
│                         │                              │
│                         ▼                              │
│         ┌────────────────────────────────┐             │
│         │ Dynamic <workspace_artifacts>  │             │
│         │ Injected into Conductor &      │             │
│         │ Specialist Execution Context   │             │
│         └────────────────────────────────┘             │
└────────────────────────────────────────────────────────┘
```

1. **`workspace_artifacts` Persistence Table:**
   - Add SQLite table in `src/infrastructure/db/` tracking:
     `path` (TEXT PRIMARY KEY), `streamId` (TEXT), `size` (INT), `hash` (TEXT), `category` (manifest | source | test | doc | binary), `symbols` (TEXT), `updatedAt` (INT).
2. **Auto-Tracking in `FileEditProvider` and `LegionToolAdapter`:**
   - In `WriteToFileToolHandler.ts` and `LegionToolAdapter.ts`:
     Record exact created/modified file paths into `workspace_artifacts` upon successful file writes.
3. **Dynamic Manifest Invalidation for `EnvironmentIntegrity`:**
   - Expand `PROJECT_MARKERS` in `EnvironmentIntegrity.ts` to include:
     - `cmake`: `CMakeLists.txt`, `cmake --version`
     - `c_cpp`: `Makefile`, `cc --version`
     - `meson`: `meson.build`, `meson --version`
     - `gradle`: `build.gradle`, `gradle --version`
     - `maven`: `pom.xml`, `mvn --version`
   - When any manifest file is written to disk, immediately invalidate the cached `EnvironmentLease` so subsequent turns reflect the updated project type.
4. **Token-Bounded `<workspace_artifacts>` Context Injection:**
   - In `withExecutionContext.ts` (for the conductor) and `LegionAgentHost.ts` (for specialists):
   - Inject a compact, token-bounded `<workspace_artifacts>` section (max 400 tokens):

     ```xml
     <workspace_artifacts>
     Detected Project: C (CMake)
     Recent Changes:
       - src/game.h [created, 14 lines]
       - src/game.c [created, 27 lines]
       - src/main.c [created, 41 lines]
       - CMakeLists.txt [created, 25 lines]
     </workspace_artifacts>
     ```
   - **Benefit:** Completely eliminates the conductor's need to run `find .` or `cat ...` after specialist execution.

---

### Architecture Proposal 2: Dynamic Specialist Capability Matrix & Skill Activation

```
┌────────────────────────────────────────────────────────┐
│         Dynamic Specialist Capability Matrix           │
│                                                        │
│  Base Execution Tools:                                 │
│  - read_file, write_to_file, replace_in_file           │
│  - list_files, search_files, list_code_definition_names│
│  - execute_command, read_command_output                │
│  - get_execution_state, attempt_completion             │
│                                                        │
│  Dynamic Additions:                                    │
│  - use_skill (Permitted for all specialists)           │
│  - query_cognitive_memory (Read-only knowledge graph)  │
│  - roadmap (Read-only status / cockpit)                │
│  - web_search (Conditionally enabled for researchers)  │
└────────────────────────────────────────────────────────┘
```

1. **Permit `use_skill` in `LEGION_TOOL_NAMES`:**
   - In `src/core/task/legion/LegionToolAdapter.ts:21-32`:
     Add `DietCodeDefaultTool.USE_SKILL` to `LEGION_TOOL_NAMES`.
   - In `LegionToolAdapter.execute()`:
     Bind `UseSkillToolHandler` using the specialist's sandboxed `TaskConfig`.
2. **Context-Aware Skill Discovery in `LegionAgentHost`:**
   - In `LegionAgentHost.ts:79`:
     Query `discoverSkills(cwd)` and inject a compact `Available Skills` index into the specialist's base system prompt, matching skills relevant to the specialist's codename or role (e.g. `impeccable` for `AESTHETE-UX` or feature implementers).
3. **Read-Only Knowledge Tool Binding:**
   - Add `MEM_QUERY` (`query_cognitive_memory`) and `ROADMAP` (`roadmap` action="guide|status") to `LEGION_TOOL_NAMES`.
   - Specialists can read semantic relations and roadmap targets without mutating parent state.

---

### Architecture Proposal 3: Progressive Intra-Stage Handoff & Partial-Work Resiliency

```
Stage 1: Lead & Recon
   │
   ├─► Lead Specialist completes ──► Summary & Artifacts
   ▼
Stage 2: Specialist Execution
   ├─► Specialist 1 (VANGUARD-IMPL) ──► Partial / Completed Artifacts
   │                                           │ (Forwarded immediately)
   │                                           ▼
   └─► Specialist 2 (KEEPER-STATE) ──► Inherits Stage 1 + Spec 1 Artifacts
   ▼
Stage 3: Verification & Hardening
   └─► Sentinel QA ──► Inherits ALL Stage 1 + Stage 2 Artifacts & Changes
```

1. **Preserve Partial Work in Handoff Context:**
   - Modify `src/infrastructure/ai/LegionCoordinator.ts:1111-1116`:

     ```typescript
     const priorStageHandoffContext = stageNames
         .slice(0, activeStageIndex < 0 ? stageNames.length : activeStageIndex)
         .flatMap((stage) => membersByStage[stage])
         .filter((m) => m.resultSummary || m.failureReason)
         .map((m) => {
             const statusTag = m.status === "completed" ? "Completed" : `Partial/Failed: ${m.failureReason}`;
             return `[${m.assignment.codename} (${m.assignment.role}) - ${statusTag}]:\n${m.resultSummary || "Incomplete execution; inspect generated artifacts."}`;
         });
     ```

2. **Intra-Stage Progressive Forwarding:**
   - In `getLegionStageProgression()`, when multiple specialists are assigned to Stage 2 (`parallelExecution`), specialists executing in turn 2 of Stage 2 must inherit the handoffs and artifact lists of specialists that completed in turn 1 of Stage 2.
3. **Structured Failover Envelope:**
   - In `rerouteFailedSpecialistUnlocked()` (`LegionCoordinator.ts:1780`):
     Query `getLegionOperationEvidence([failedStreamId])` and append:
     - Exact files created or modified by the failed specialist.
     - The last executed command and its exit code.
     - Concrete unverified items to pick up.

---

### Architecture Proposal 4: Cross-Turn Reflexion & Continuous Self-Improvement Engine

```
┌────────────────────────────────────────────────────────┐
│            Reflexion & Self-Improvement Loop           │
│                                                        │
│  1. Execution Event / Failure                          │
│     (Tool error, heredoc rejection, budget warning)    │
│                        │                               │
│                        ▼                               │
│  2. Distill Failure Pattern & Resolution Recipe        │
│                        │                               │
│                        ▼                               │
│  3. Persist in SQLite `agent_knowledge` /              │
│     `agent_streams.sharedMemoryLayer`                  │
│                        │                               │
│                        ▼                               │
│  4. Retrieve & Inject as `<learned_heuristics>` into   │
│     Conductor & Specialist System Prompts              │
└────────────────────────────────────────────────────────┘
```

1. **Activate `TaskState.swarmBlackboard` via `agent_streams`:**
   - Wire `TaskState.swarmBlackboard` to read/write `sharedMemoryLayer` in `agent_streams` via `KnowledgeGraphService`.
   - When a specialist discovers a key project truth (e.g. `raylib 5.5 is installed via Homebrew at /opt/homebrew/opt/raylib`), post it to the blackboard.
   - All subsequent specialists and the parent conductor automatically inherit blackboard items.
2. **Post-Mortem Journaling (`agent_learnings`):**
   - When an agent encounters a fatal error or a policy circuit-break:
     - Store a structured learning node in `agent_knowledge`:
       - `type`: `reflexion_learning`
       - `content`: `"CMake build requires linking raylib via pkg-config or homebrew prefix."`
       - `tags`: `["build", "cmake", "raylib"]`
3. **Dynamic Prompt Injection (`<learned_heuristics>`):**
   - In `PromptBuilder.ts` and `LegionAgentHost.ts`:
   - Query `KnowledgeGraphService` for recent `reflexion_learning` nodes matching the task domain.
   - Inject `<learned_heuristics>`:

     ```xml
     <learned_heuristics>
     - Past runs in this project established that raylib 5.5 is available locally at /opt/homebrew/opt/raylib.
     - Avoid using terminal heredocs (cat <<'EOF'); use write_to_file directly.
     </learned_heuristics>
     ```

---

### Architecture Proposal 5: Domain-Agnostic Specialist Archetype Adaptation

1. **Decouple Specialist Descriptors from LUMI-Specific Stack:**
   - In `LEGION_SPECIALIST_REGISTRY` (`LegionCoordinator.ts:269-542`):
     - Generalize `legion_data_steward`: Change focus from "SQLite buffered pools and state-keys" to "Persistence, File Serialization, State Integrity, and Data Schemas".
     - Generalize `legion_architect`: Change focus from "Protobuf/schema definitions" to "System Architecture, Module Decomposition, and Contract Design".
     - Generalize `legion_verifier`: Adapt keywords from "mocha/vitest" to include "ctest, unity, pytest, cargo test, make test".
2. **Inject Workspace Blueprint into Specialist Assignments:**
   - In `buildSpecialistFocusObjective()`:
     Pass the detected project type (e.g. `C/CMake`) so the generated objective reads:
     `Objective: Implement domain gameplay and file persistence for C/CMake project...`
     rather than generic or TypeScript-biased instructions.

---

## 7. Component 5: Independent Verification Methods

To independently verify these diagnostic findings and validate future implementations:

1. **Verify Toolset Hardcoding:**
   - Command: `grep -rn "LEGION_TOOL_NAMES" src/core/task/`
   - Inspect `src/core/task/legion/LegionToolAdapter.ts:21-32` and `src/core/task/index.ts:2550-2555`.
   - Confirm that `use_skill`, `query_cognitive_memory`, and `roadmap` are absent from `LEGION_TOOL_NAMES`.

2. **Verify Completed-Only Handoff Filtering:**
   - Command: `grep -rn -A 10 "priorStageHandoffContext" src/infrastructure/ai/LegionCoordinator.ts`
   - Inspect line 1114.
   - Confirm `.filter((m) => m.status === "completed" && m.resultSummary)` drops all non-completed members.

3. **Verify Stale Environment Blueprint Markers:**
   - Command: `grep -rn -A 15 "PROJECT_MARKERS" src/core/integrity/EnvironmentIntegrity.ts`
   - Inspect lines 54-61.
   - Confirm only 6 languages exist; C/C++, CMake, Makefile, Meson, Gradle, Maven are missing.

4. **Verify Dead Code State Fields:**
   - Command: `grep -rn "swarmBlackboard" src/`
   - Confirm only one occurrence exists in `src/core/task/TaskState.ts:138`.

5. **Run Existing Test Suite for Legion & Task Integrity:**
   - Command: `npx mocha -r ts-node/register "src/core/task/legion/__tests__/TaskLegion.test.ts" "src/core/task/legion/__tests__/LegionAgentHost.test.ts" "src/core/task/legion/__tests__/LegionToolAdapter.test.ts"`
   - Confirm all 54 existing tests pass cleanly before making changes.
