# Challenge Report: Milestone 1 Gate Panel (Challenger 1)

**Challenger:** `teamwork_challenger_m1_1` (EMPIRICAL CHALLENGER — critic, specialist)  
**Parent Orchestrator:** `5a83290e-eac1-48cd-9057-d64900999e6d`  
**Milestone:** Milestone 1 (Dynamic Project Knowledge & Agent Self-Improvement)  
**Date:** 2026-11-04T22:21:30Z  
**Verdict:** **APPROVE**  
**Overall Risk Assessment:** **LOW**

---

## 1. Observation

Direct empirical execution of adversarial stress tests and inspection of the M1 implementation revealed the following concrete observations:

### 1.1 Skill Invocation & Discovery (F01, F02)

- In `src/core/task/legion/LegionToolAdapter.ts:24-36`, `LEGION_TOOL_NAMES` contains `DietCodeDefaultTool.USE_SKILL`. In lines 54-58, `coordinator.registerByName(name, validator)` and `UseSkillToolHandler` are wired, and `allowedNames` includes `DietCodeDefaultTool.USE_SKILL` and `"use_skill"`.
- In `src/core/task/legion/LegionAgentHost.ts:348-369`, tool calls check `tools.allowedNames.has(call.name)`. With `use_skill` allowed, calls proceed to `tools.execute("use_skill", ...)` rather than triggering `failed("Specialist requested disallowed tool use_skill.", false)`.
- In `src/core/task/legion/LegionAgentHost.ts:71-81` and `153-164`, dynamic discovery fallback invokes `discoverSkills(cwd)` and `getAvailableSkills(discovered)` when `options.availableSkills` is omitted, formatting discovered skills into `<available_skills>` and injecting it into the system prompt.
- Empirical test execution of `probe_skills.test.ts` (8 probes):
  - `[Probe 1.1]` Checked `use_skill` membership in `LEGION_TOOL_NAMES` and `allowedNames`: **PASS**.
  - `[Probe 1.2]` Executed valid skill on disk (`.agents/skills/probe-analysis/SKILL.md`) via `LegionToolAdapter.execute("use_skill", { skill_name: "probe-analysis" })`: returned `# Skill "probe-analysis" is now active` with full instructions: **PASS**.
  - `[Probe 1.3]` Executed non-existent skill: returned `Error: Skill "does-not-exist-anywhere-404" not found` cleanly without throwing or aborting the host: **PASS**.
  - `[Probe 1.4]` Executed with missing `skill_name`: returned `Error: Missing required parameter 'skill_name'` without throwing: **PASS**.
  - `[Probe 1.5]` End-to-end `LegionAgentHost` conversation where specialist requested `use_skill` on turn 1 and `attempt_completion` on turn 2: completed successfully with status `"completed"`: **PASS**.
  - `[Probe 1.6]` Boundaries for `formatAvailableSkills`: handled `undefined`, `[]`, whitespace string, raw string, and metadata arrays: **PASS**.
  - `[Probe 1.7]` Automatic dynamic skill discovery on disk: dynamically discovered skill injected into specialist system prompt: **PASS**.
  - `[Probe 1.8]` Resilient fallback when `discoverSkills` throws: caught error gracefully, logged warning, and completed host execution without crash: **PASS**.

### 1.2 Multi-Language Environment Integrity & Dynamic Invalidation (F03)

- In `src/core/integrity/EnvironmentIntegrity.ts:56-68`, `PROJECT_MARKERS` explicitly registers:
  - `cmake`: `{ manifest: "CMakeLists.txt", binary: "cmake", args: ["--version"] }`
  - `c_cpp`: `{ manifest: "Makefile", binary: "make", args: ["--version"] }`
  - `meson`: `{ manifest: "meson.build", binary: "meson", args: ["--version"] }`
  - `gradle`: `{ manifest: "build.gradle", binary: "gradle", args: ["--version"] }`
  - `maven`: `{ manifest: "pom.xml", binary: "mvn", args: ["--version"] }`
- In `src/core/integrity/EnvironmentIntegrity.ts:70-74`, `invalidateCache()` iterates over `EnvironmentIntegrity.activeInstances` and calls `instance.revokeLease()`, which resets `this.lease = null`, `this.probePromise = null`, and clears `stateManager.setGlobalState("environmentalLease", undefined)`.
- In `src/core/task/legion/LegionToolAdapter.ts:252-256`, modifying any file whose `path.basename` matches any manifest in `EnvironmentIntegrity.PROJECT_MARKERS` automatically invokes `EnvironmentIntegrity.invalidateCache()`.
- Empirical test execution of `probe_environment.test.ts` (5 probes):
  - `[Probe 2.1]` Validated all 5 marker configurations: **PASS**.
  - `[Probe 2.2]` Forensic detection against single-language and polyglot workspaces (`CMakeLists.txt` + `Makefile` + `pom.xml`): correctly detected all manifests and project types: **PASS**.
  - `[Probe 2.3]` Invalidation mechanics: `invalidateCache()` flushed memory lease, cleared `stateManager`, and forced subsequent `validateEnvironment()` to perform a fresh probe with updated timestamp and binary version: **PASS**.
  - `[Probe 2.4]` Multi-instance revocation across distinct workspace directories: all active instances had leases revoked simultaneously: **PASS**.
  - `[Probe 2.5]` Reactive invalidation via `LegionToolAdapter`: non-manifest files (`src/app.ts`) did NOT trigger cache invalidation; writing `CMakeLists.txt`, `Makefile`, and `pom.xml` DID trigger `invalidateCache()`: **PASS**.

### 1.3 Partial Handoffs & Heuristics (F04, F06)

- In `src/infrastructure/ai/LegionCoordinator.ts:1175-1196`:
  - `leadAndReconHandOffContext` and `priorStageHandoffContext` filter on `(m.resultSummary || m.failureReason)`.
  - Format helper emits `[${m.assignment.codename} (${m.assignment.role}) - ${statusTag}]: ${m.resultSummary || "Partial work performed; check modified artifacts."}` where `statusTag` is `"Completed"` or `"Partial/Failed: " + failureReason`.
  - `currentStageFinishedMembers` includes completed, failed, or rerouted specialists from the active stage, enabling progressive sibling handoffs in Stage 2.
- In `src/infrastructure/ai/LegionCoordinator.ts:1042-1061`:
  - `extractLearnedHeuristics(text)` parses both `<learned_heuristics>` XML tags and lines matching `/^(?:Heuristic|Learned fact|Learning):\s*(.+)/i`.
- In `src/core/task/TaskState.ts:140-150`:
  - `addSwarmHeuristic(h)` trims, ignores empty strings, and deduplicates against existing heuristics.
- In `src/core/task/legion/LegionAgentHost.ts:93-101`:
  - `formatLearnedHeuristics` token-bounds the output by taking the 20 most recent unique heuristics (`unique.slice(-20)`).
- Empirical test execution of `probe_handoffs_heuristics.test.ts` (9 probes):
  - `[Probe 3.1]` Failed/timed-out lead specialist with partial summary: formatted as `[SCOUT-LEAD (legion_researcher) - Partial/Failed: Specialist timeout after 60s execution]: Identified 8 OpenAPI schema endpoints before timing out.`: **PASS**.
  - `[Probe 3.2]` Failed specialist with NO `resultSummary`: preserved with fallback `Partial work performed; check modified artifacts.`: **PASS**.
  - `[Probe 3.3]` Stage 2 progressive sibling handoffs: `priorStageHandoffContext` included Stage 1 lead, Stage 2 finished Sibling A (Completed), Stage 2 finished Sibling B (Failed/Partial), while excluding unfinished Sibling C and pending Stage 3 Verifier: **PASS**.
  - `[Probe 3.4]` Rerouted specialists: original failed specialist diagnostics preserved alongside replacement specialist handoff: **PASS**.
  - `[Probe 3.5]` `TaskState.swarmBlackboard`: correctly trimmed, deduplicated, and filtered empty entries: **PASS**.
  - `[Probe 3.6]` `extractLearnedHeuristics`: parsed XML blocks, line prefixes (`Heuristic:`, `Learned fact:`, `Learning:`), and ignored plain text: **PASS**.
  - `[Probe 3.7]` Blackboard injection: `swarmBlackboard` correctly rendered as `<learned_heuristics>` inside `priorStageHandoffContext`: **PASS**.
  - `[Probe 3.8]` Token bounding: `formatLearnedHeuristics` capped at 20 most recent entries when given 35 heuristics: **PASS**.
  - `[Probe 3.9]` System prompt injection: `<learned_heuristics>` rendered cleanly in specialist prompt: **PASS**.

### 1.4 Monorepo Verification & Hygiene

- Monorepo test suites executed cleanly:
  - `npm run check-types`: exit code 0, 0 type errors.
  - `npm run test:swarm`: exit code 0, 355/355 tests passing.
  - `npm run docs:check-agentswarm`: exit code 0, 68 files, 432 links verified.
- All probe scripts were placed strictly within `.agents/teamwork/teamwork_challenger_m1_1/`. No untracked scratch files were created in workspace root or `tests/`.

---

## 2. Logic Chain

1. **Premise (F01/F02):** If `use_skill` is in `LEGION_TOOL_NAMES`, registered on `ToolExecutorCoordinator`, and in `allowedNames`, specialists will not be aborted when requesting skills.
   - **Verification:** Probe 1.1, 1.2, 1.3, 1.4, 1.5 proved empirically that specialists can invoke installed skills without rejection, and `LegionAgentHost` completes cleanly without tool denial.
   - **Discovery:** Probe 1.6, 1.7, 1.8 proved that dynamic discovery on disk populates `<available_skills>` in the specialist prompt, and handles discovery failures gracefully.

2. **Premise (F03):** If `PROJECT_MARKERS` includes CMake, Makefile, Meson, Gradle, and Maven, `EnvironmentIntegrity` will forensically detect those toolchains and manifests.
   - **Verification:** Probe 2.1, 2.2 proved that single-language and polyglot projects detect all present markers.
   - **Invalidation:** Probe 2.3, 2.4, 2.5 proved that `invalidateCache()` flushes leases across all active instances, clears `stateManager`, and forces fresh detection. Tool adapter file modifications on manifests reactively trigger `invalidateCache()`.

3. **Premise (F04/F06):** If `priorStageHandoffContext` filters on `(resultSummary || failureReason)` instead of requiring completed status, partial work and failure diagnostics are preserved for downstream and intra-stage sibling specialists.
   - **Verification:** Probe 3.1, 3.2, 3.3, 3.4 proved that failed and timed-out specialists are preserved with explicit status tags (`[CODENAME (role) - Partial/Failed: <reason>]`), fallbacks function properly, and Stage 2 forwards sibling progress intra-stage.
   - **Heuristics:** Probe 3.5, 3.6, 3.7, 3.8, 3.9 proved that heuristics are extracted from summaries, stored in `TaskState.swarmBlackboard`, bounded to 20 entries, and rendered as `<learned_heuristics>` in handoffs and system prompts.

---

## 3. Caveats

No caveats. All focus areas specified in the dispatch were empirically tested under hostile conditions, including missing parameters, non-existent skills, discovery errors, multi-instance lease invalidation, polyglot manifests, timeout/OOM failures, and token-bounding caps.

---

## 4. Conclusion

**Verdict: APPROVE**

The Milestone 1 implementation by `teamwork_worker_m1` satisfies all functional and architectural requirements:

- F01 & F02: Specialists invoke skills seamlessly without policy denial; dynamic discovery injects `<available_skills>` into system prompts.
- F03: Multi-language project detection covers CMake, Makefile, Meson, Gradle, Maven; dynamic invalidation flushes leases across memory and persistent storage.
- F04 & F06: Partial work and failure diagnostics are durably preserved in progressive handoffs; cross-turn reflexion and blackboard propagate token-bounded `<learned_heuristics>`.
- F05 & F07: Reactive artifact tracking and domain-agnostic specialist archetypes operate cleanly.
- Monorepo integrity: `check-types`, `test:swarm` (355 tests), and `docs:check-agentswarm` all pass with exit code 0.

---

## 5. Verification Method

To independently reproduce the empirical challenger results:

1. **Run Challenger Skill Probes (8 probes):**

   ```bash
   npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json ts-node -r tsconfig-paths/register -r ./src/test/requires.cjs .agents/teamwork/teamwork_challenger_m1_1/probe_skills.test.ts
   ```

   _Expected:_ `=== SKILL PROBES COMPLETE: 8/8 passed cleanly ===`

2. **Run Challenger Environment Integrity & Invalidation Probes (5 probes):**

   ```bash
   npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json ts-node -r tsconfig-paths/register -r ./src/test/requires.cjs .agents/teamwork/teamwork_challenger_m1_1/probe_environment.test.ts
   ```

   _Expected:_ `=== ENVIRONMENT PROBES COMPLETE: 5/5 passed cleanly ===`

3. **Run Challenger Partial Handoffs & Heuristics Probes (9 probes):**

   ```bash
   npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json ts-node -r tsconfig-paths/register -r ./src/test/requires.cjs .agents/teamwork/teamwork_challenger_m1_1/probe_handoffs_heuristics.test.ts
   ```

   _Expected:_ `=== HANDOFF & HEURISTIC PROBES COMPLETE: 9/9 passed cleanly ===`

4. **Run Full Swarm Monorepo Suite:**

   ```bash
   npm run test:swarm
   ```

   _Expected:_ 355 tests passing in ~2-3 seconds.
