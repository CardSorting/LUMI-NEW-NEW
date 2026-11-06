# Task Assignment: Milestone 1 Worker (Iteration 1)

**Timestamp:** 2026-11-04T21:51:00Z  
**Worker:** `teamwork_worker_m1`  
**Working Directory:** `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_worker_m1/`  
**Target Workspace:** `/Users/bozoegg/Downloads/LUMI`  
**Milestone:** M1 — Dynamic Project Knowledge and Agent Self-Improvement (Requirement R1)  
**Orchestrator ID:** `5a83290e-eac1-48cd-9057-d64900999e6d`

---

## Mandatory Prerequisites

1. Read `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/ORIGINAL_REQUEST.md`
2. Read `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/PROJECT.md`
3. Read the exhaustive architectural survey report:
   `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_explorer_survey_1/handoff.md`

---

## Scope & Feature Inventory (F01–F07)

You are tasked with implementing durable, genuine mechanisms for dynamic project knowledge acquisition, agent continuous learning, and self-improvement across `agentswarm`:

### F01: Specialist Skill Activation

- File: `src/core/task/legion/LegionToolAdapter.ts`
- In `LEGION_TOOL_NAMES`: add `DietCodeDefaultTool.USE_SKILL` (`use_skill`).
- In `LegionToolAdapter.execute()`: when `toolName === DietCodeDefaultTool.USE_SKILL` or `"use_skill"`, invoke `UseSkillToolHandler` using the specialist's sandboxed `TaskConfig`.

### F02: Dynamic Skill Discovery Context

- File: `src/core/task/legion/LegionAgentHost.ts`
- In `buildSystemPrompt()` / conversation initialization: query available skills or discover skills in the workspace root and inject a compact `<available_skills>` index into the specialist system prompt so specialists know what skills can be called via `use_skill`.

### F03: Multi-Language Environment Integrity & Dynamic Invalidation

- File: `src/core/integrity/EnvironmentIntegrity.ts`
- In `PROJECT_MARKERS`: expand beyond node/python/rust/go/dart/ruby to include:
  - `cmake`: manifest `CMakeLists.txt`, binary `cmake`, args `["--version"]`
  - `c_cpp`: manifest `Makefile`, binary `make`, args `["--version"]`
  - `meson`: manifest `meson.build`, binary `meson`, args `["--version"]`
  - `gradle`: manifest `build.gradle`, binary `gradle`, args `["--version"]`
  - `maven`: manifest `pom.xml`, binary `mvn`, args `["--version"]`
- Add a public static method `invalidateCache()` to force re-probing of environment leases when workspace manifests change.

### F04: Progressive Intra-Stage Handoffs & Partial Work Preservation

- File: `src/infrastructure/ai/LegionCoordinator.ts`
- In `priorStageHandoffContext` (around line 1111):
  - Do NOT drop failed or partial specialists! Change `.filter((m) => m.status === "completed" && m.resultSummary)` to include members with `m.resultSummary || m.failureReason`.
  - Format with status tag: `[${m.assignment.codename} (${m.assignment.role}) - ${m.status === "completed" ? "Completed" : "Partial/Failed: " + (m.failureReason || "incompleted")}]: ${m.resultSummary || "Partial work performed; check modified artifacts."}`.

### F05: Reactive Workspace Artifact Tracking

- Files: `src/core/task/legion/LegionToolAdapter.ts` and/or `src/core/task/TaskState.ts`
- Track list of created/modified files during specialist execution and inject a token-bounded `<workspace_artifacts>` section in specialist prompt/handoff.

### F06: Cross-Turn Reflexion & Blackboard

- Files: `src/core/task/TaskState.ts`, `src/infrastructure/ai/LegionCoordinator.ts`, `src/core/task/legion/LegionAgentHost.ts`
- Wire `TaskState.swarmBlackboard`: when specialists record learned facts or heuristics, append them to `swarmBlackboard` and propagate them into subsequent specialist system prompts as `<learned_heuristics>`.

### F07: Domain-Agnostic Specialist Archetypes

- File: `src/infrastructure/ai/LegionCoordinator.ts`
- In `LEGION_SPECIALIST_REGISTRY`: decouple role descriptions from LUMI-specific stack keywords (e.g. broaden `legion_data_steward` from SQLite/state-keys to general persistence/file serialization; broaden `legion_architect` to system architecture and contract design; broaden `legion_verifier` to multi-language test runners).

---

## Testing & Verification Requirements

1. Add or update unit tests in `src/core/task/legion/__tests__/` (e.g. `LegionToolAdapter.test.ts`, `LegionAgentHost.test.ts`, `TaskLegion.test.ts`) and `src/core/integrity/__tests__/` or `src/infrastructure/ai/__tests__/` verifying:
   - `use_skill` is allowed in `LEGION_TOOL_NAMES` and executes cleanly.
   - `EnvironmentIntegrity.PROJECT_MARKERS` detects CMake/Makefile/Meson/Gradle/Maven and `invalidateCache()` flushes leases.
   - `priorStageHandoffContext` preserves partial/failed specialist summaries.
   - `swarmBlackboard` entries are propagated to specialist prompts.
2. Execute all repository-wide verification commands:
   - `npm run check-types` -> must pass with exit code 0.
   - `npm run lint` -> must pass with exit code 0.
   - `npm run test:swarm` -> must pass all 338+ tests with exit code 0.
   - `npm run docs:check-agentswarm` -> must pass with exit code 0.

---

## MANDATORY INTEGRITY WARNING

DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## 2026-11-04T21:51:58Z

You are the Knowledge Systems & Specialist Improvement Worker for Milestone 1 (Dynamic Project Knowledge & Agent Self-Improvement).
Working directory: /Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_worker_m1/
Target Workspace: /Users/bozoegg/Downloads/LUMI

MANDATORY PREREQUISITES:
Read the following files before taking any action:

1. /Users/bozoegg/Downloads/LUMI/.agents/teamwork/ORIGINAL_REQUEST.md
2. /Users/bozoegg/Downloads/LUMI/.agents/teamwork/PROJECT.md
3. /Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_worker_m1/DISPATCH.md
4. Survey Report: /Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_explorer_survey_1/handoff.md

EXCLUSIVE WRITE OWNERSHIP:
You own and may edit ONLY:

- src/core/task/legion/LegionToolAdapter.ts
- src/core/task/legion/LegionAgentHost.ts
- src/core/integrity/EnvironmentIntegrity.ts
- src/infrastructure/ai/LegionCoordinator.ts
- src/core/task/TaskState.ts
- Associated tests in src/core/task/legion/**tests**/ and src/infrastructure/ai/**tests**/

TASKS (F01–F07):

1. F01 (Specialist Skill Activation): Add DietCodeDefaultTool.USE_SKILL ("use_skill") to LEGION_TOOL_NAMES and wire UseSkillToolHandler in LegionToolAdapter.
2. F02 (Dynamic Skill Discovery Context): In LegionAgentHost, discover skills or query available skills and inject compact <available_skills> into specialist prompt.
3. F03 (Multi-Language Environment Integrity): Expand EnvironmentIntegrity.PROJECT_MARKERS to include CMake, Makefile, Meson, Gradle, Maven and add invalidateCache() method.
4. F04 (Progressive Intra-Stage Handoffs & Partial Work Preservation): Update priorStageHandoffContext in LegionCoordinator.ts to retain partial/failed specialist summaries with status annotations.
5. F05 (Reactive Workspace Artifact Tracking): Track created/modified files during specialist execution and inject token-bounded <workspace_artifacts> section in specialist prompt/handoff.
6. F06 (Cross-Turn Reflexion & Blackboard): Wire TaskState.swarmBlackboard so heuristics and learned facts persist and propagate to subsequent specialist prompts as <learned_heuristics>.
7. F07 (Domain-Agnostic Archetypes): Generalize specialist descriptions in LEGION_SPECIALIST_REGISTRY (data steward, architect, verifier) to be domain-agnostic.
8. Add comprehensive unit tests verifying all new capabilities.
9. Run and document passing outputs for:
   - npm run check-types
   - npm run lint
   - npm run test:swarm
   - npm run docs:check-agentswarm
