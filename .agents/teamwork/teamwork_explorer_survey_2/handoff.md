# Workspace Audit, Hygiene and Ergonomics Report (Requirement R2)

**Author:** Workspace Audit Explorer (Explorer 2)  
**Date:** 2026-11-04  
**Scope:** Target documentation & wiki tree (`/Users/bozoegg/Downloads/LUMI/agentswarm`), monorepo workspace hygiene, CI quality gates, developer tooling, and test ergonomics (`/Users/bozoegg/Downloads/LUMI`).

---

## 1. Observation

### 1.1 Documentation & Wiki Tree Integrity (`agentswarm/`)

1. **Repository Layout:**
   - Location: `/Users/bozoegg/Downloads/LUMI/agentswarm/`
   - Total files: 53 markdown (`.md`) files across 8 subdirectories (`adr/`, `architecture/`, `implementation/`, `maintainers/`, `onboarding/`, `papers/`, `playbooks/`, `postmortems/`) and 7 root markdown files (`agentswarm.md`, `agentswarm2.md`, `agentswarm3.md`, `agentswarm4.md`, `README.md`, `CHANGELOG.md`, `glossary.md`, `reincorporation.md`).
   - Markdown link check: 419 relative links inspected. **0 broken file targets** detected across the directory.
2. **Phase 10 Documentation Drift & Index Gaps:**
   - Commit `a98a6c1c` introduced Phase 10 (`ADR-0016` for terminal file read defense, token budget starvation fix, and conductor prompt parity; `PM-017` post-mortem).
   - `agentswarm/README.md`:
     - Line 25: Cites `(Phases 1–9, fixes, ADRs, PMs)` — fails to reflect Phase 10.
     - Line 47: Cites `adr/ ← Architecture Decision Records (0001–0015)` — omits `ADR-0016`.
     - Line 48: Cites `postmortems/ ← blameless post-mortems (PM-001–PM-016)` — omits `PM-017`.
     - Line 62: Cites `291 backend unit tests passing` — outdated test count (now 315/332).
   - `agentswarm/maintainers/README.md`:
     - Line 13: Mentions ADRs up to `ADR-0015`, omitting `ADR-0016`.
     - Line 14: Guided tour omits `terminalFileReadPolicy.ts` and `UseSkillToolHandler.ts`.
     - Line 16: Cites `PM-001 through PM-016`, omitting `PM-017`.
   - `agentswarm/implementation/file-map.md`:
     - Line 84–97 ("Terminal Execution & Command Policy Defense"): Omits `src/integrations/terminal/terminalFileReadPolicy.ts`, `src/integrations/terminal/__tests__/terminalFileReadPolicy.test.ts`, and `UseSkillToolHandler.ts`.
     - Line 117: Spec-to-implementation traceability table terminates at `ADR-0015` without documenting `ADR-0016`.
   - `agentswarm/reincorporation.md`:
     - Lines 15–16 (Steps 2 and 3): Omits `terminalFileReadPolicy.ts`, `UseSkillToolHandler.ts`, and prompt parity changes.
     - Line 21 (Step 8): States `Full PB-07 (291 passing)` instead of 315/332.
   - `agentswarm/playbooks/PB-07-release-verification.md`:
     - Line 7: `expect 291 passing tests...`
     - Lines 8–22: Verification command omits `src/integrations/terminal/__tests__/terminalFileReadPolicy.test.ts`.
   - `agentswarm/onboarding/for-maintainers.md`:
     - Anchor link anomaly: Links to `../maintainers/04-failure-modes-and-drills.md#6-drill-5-auditing-an-interrupted-ai-subagent-or-pr-pb-08`. In `04-failure-modes-and-drills.md:111`, the header contains an embedded markdown link `## 6. Drill 5: Auditing an Interrupted AI Subagent or PR ([PB-08](../playbooks/PB-08-audit-after-interrupted-work.md))`, creating a fragile markdown anchor slug.

### 1.2 Broken CI Guardrail Scripts & Package Version Drift

1. **`npm run docs:check-root-readme` Failure:**
   - Command: `npm run docs:check-root-readme`
   - Exit code: `1`
   - Verbatim error:

     ```text
     AssertionError [ERR_ASSERTION]: root README must include version 26.4.0
         at file:///Users/bozoegg/Downloads/LUMI/scripts/check-root-readme.mjs:38:8
     ```
   - Cause: `package.json:5` specifies `"version": "26.4.0"`, but `/Users/bozoegg/Downloads/LUMI/README.md` lines 18 and 618 still state `26.0.0`:
     - Line 18: `<a href="package.json"><img src="https://img.shields.io/badge/version-26.0.0-green" alt="Version" /></a>`
     - Line 618: `Include VS Code version, LUMI **26.0.0**, provider used, and steps to reproduce.`
2. **`npm run docs:check-readme-metrics` Failure:**
   - Command: `npm run docs:check-readme-metrics`
   - Exit code: `1`
   - Verbatim error:

     ```text
     AssertionError [ERR_ASSERTION]: README badge must match version 26.4.0
         at file:///Users/bozoegg/Downloads/LUMI/scripts/check-readme-metrics.mjs:59:8
     ```

3. **`npm run doctor:ci` Impure Host State Check:**
   - Command: `npm run doctor:ci` (called by `npm run ci:check-all`)
   - Checks global editor paths `DEFAULT_EXTENSION_ROOTS` on the developer's workstation (`~/.vscode/extensions`, `~/.antigravity/extensions`), detecting old uninstalled extensions (`cardsorting.lumi-1.0.6-universal`, `dreambeesai.dietcode-5.11.0`) and exiting `1`. CI scripts must validate repository build output (`dist/` or `release-*/`), not global workstation directories.

### 1.3 Repository Root Clutter, Dead Files, and Non-Standard Layout

1. **Dead & Temporary Files Tracked in Git Root:**
   - `/Users/bozoegg/Downloads/LUMI/0`: 0-byte accidental empty file tracked in git.
   - `/Users/bozoegg/Downloads/LUMI/biome_errors.txt`: 13.5 KB stale linter error dump from September 23, 2026.
   - `/Users/bozoegg/Downloads/LUMI/build_output.txt`: 6.2 KB stale build error log from September 23, 2026.
   - `/Users/bozoegg/Downloads/LUMI/build_output2.txt`: 1.2 KB stale build error log from September 23, 2026.
   - `/Users/bozoegg/Downloads/LUMI/rename_list.txt` & `rename_script.py`: One-off migration scripts from September 23, 2026 left in root.
   - `/Users/bozoegg/Downloads/LUMI/grounding.txt`: 4.8 KB unformatted scratch notes from a historical policy pass.
   - `/Users/bozoegg/Downloads/LUMI/changelogv3.md`: Stale legacy changelog sitting alongside `CHANGELOG.md`.
2. **Benchmark & Media Artifacts in Root:**
   - 11 binary and research files are committed directly to `/Users/bozoegg/Downloads/LUMI/` instead of `evals/benchmarks/`:
     `BENCHMARK-METHODOLOGY.md`, `BENCHMARK-RESULTS.csv`, `BROCCOLIDB-BENCHMARK-RESEARCH.zip`, `BROCCOLIDB-PERFORMANCE-RESEARCH.pdf`, `PERFORMANCE-COMPARISON.pdf`, `Screenshot 2026-10-17 at 10.38.49 PM.png`, `benchmark_comparison_card.png`, `benchmark_side_by_side_showdown.png`, `EXECUTIVE-FINDINGS.md`, `INTERNAL-SECURITY-REVIEW.md`, `REPRODUCIBILITY-AND-LIMITATIONS.md`.
3. **Abandoned Tool Configuration:**
   - `/Users/bozoegg/Downloads/LUMI/knip.json` exists at the root, configuring dead-code detection.
   - However, `package.json` contains no `knip` dependency in `devDependencies` and no `npm run knip` script.
4. **Ignored Legacy Directories:**
   - `/Users/bozoegg/Downloads/LUMI/packages/` contains legacy v24.0.1 VSIX packages, ignored by `.gitignore:6`.
   - `/Users/bozoegg/Downloads/LUMI/scratch/` contains 10 unmanaged utility scripts (`scratch/benchmark_sep.js`, `scratch/commission_benchmark_runner.ts`, etc.) tracked in git without documentation or testing.

### 1.4 Test Suite Setup, Architecture & Developer Ergonomics

1. **Ergonomic Friction in Running Swarm Tests:**
   - `package.json` contains no convenience script for testing the Agent Swarm or Legion subsystems (e.g., `npm run test:swarm` or `npm run test:legion`).
   - Running `npm run test:unit` executes every test matching `src/**/__tests__/*.ts` across the entire codebase (over 200 files, hundreds of tests, multi-minute execution).
   - Running `npm run test:unit -- src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts` fails to isolate the target test! Because `.mocharc.json:6` specifies `"spec": ["src/**/__tests__/*.ts"]`, Mocha executes all matching files plus the argument, unless `--no-config` is provided.
   - To execute the 332-test Swarm verification suite, a developer must enter a verbose command spanning 14 positional arguments and requiring exact flags (`--no-config`, `--require ts-node/register`, etc.).
2. **Structural Split: Unit vs Integration Tests:**
   - Total test files in `src/`: 266 files.
     - 205 files inside `**/__tests__/*.ts` (unit tests running via `mocha`).
     - 61 files directly in `src/` outside `__tests__/` (e.g. `src/hosts/vscode/terminal/VscodeTerminalProcess.test.ts`, `CommandOrchestrator.test.ts`).
   - `tsconfig.test.json:31` excludes `src/**/__tests__/*` for `@vscode/test-cli` compilation, while `.mocharc.json:6` includes only `src/**/__tests__/*.ts`.
   - Consequently, the 61 test files outside `__tests__/` are completely skipped during standard `npm run test:unit` execution.
3. **Automated Verification Execution Proofs (All Passing):**
   - TypeScript compilation: `npm run check-types` → 0 errors.
   - Linter: `npm run lint` → 1,769 files checked with Biome, 0 errors.
   - Webview tests: `npx vitest run src/components/settings/sections/FeatureSettingsSection.test.tsx` → 7 passing tests.
   - Swarm & Terminal defense suite: 332 passing tests in 2 seconds when executed via ts-node mocha:
     - `AgentSwarmAuxiliary.test.ts` (49 tests)
     - `TaskLegion.test.ts` (19 tests)
     - `LegionAgentHost.test.ts` (20 tests)
     - `LegionToolAdapter.test.ts` (13 tests)
     - `LegionProvider.integration.test.ts` (1 test)
     - `delegationPolicy.test.ts` (1 test)
     - `EngageSwarmHandler.test.ts` (8 tests)
     - `DietCodeToolSetSwarm.test.ts` (3 tests)
     - `heredocPolicy.test.ts` (33 tests)
     - `terminalFileReadPolicy.test.ts` (67 tests)
     - `ExecuteCommandToolHandler.approval.test.ts` (2 tests)
     - `VscodeTerminalProcess.test.ts` (29 tests)
     - `TerminalOutputDecoder.test.ts` (3 tests)
     - `VscodeTerminalLifecycle.test.ts` (28 tests)
     - `state-keys.test.ts` (32 tests)
     - `StreamResponseHandler.test.ts` (15 tests)
     - `openai-codex.streaming.test.ts` (15 tests)

---

## 2. Logic Chain

1. **Premise:** Requirement R2 mandates auditing the workspace, curating and tidying up established workspace strategies, eliminating friction, and hardening the repository against failure modes with durable fixes.
2. **From Observation 1.1:**
   - When new ADRs (ADR-0016) and post-mortems (PM-017) are committed without updating the index files (`agentswarm/README.md`, `maintainers/README.md`, `implementation/file-map.md`, `PB-07`), new engineers and autonomous agents navigate using stale maps.
   - Because `PB-07-release-verification.md` omits `terminalFileReadPolicy.test.ts` and cites 291 instead of 315/332 tests, verification fails to validate the full terminal defense barrier introduced in Phase 10.
   - `scripts/check-agent-docs-links.mjs` strictly validates `docs/` and `broccolidb/docs` but completely omits `agentswarm/`. Therefore, link and heading errors in `agentswarm/` remain undetected by CI.
3. **From Observation 1.2:**
   - `package.json` was bumped from 26.0.0 to 26.4.0 in commit `a98a6c1c`.
   - `scripts/check-root-readme.mjs` and `scripts/check-readme-metrics.mjs` assert that `README.md` contains the exact version from `package.json`.
   - Because `README.md` was not updated during the version bump, running `npm run ci:check-all` or individual doc check scripts throws fatal assertion errors, breaking the CI pipeline.
4. **From Observation 1.3:**
   - 0-byte files (`0`), stale error dumps (`biome_errors.txt`, `build_output.txt`), migration scripts (`rename_script.py`), and unorganized benchmark PDFs/PNGs tracked in git pollute repository history, degrade clone times, confuse search indexing, and represent non-standard monorepo hygiene.
   - `knip.json` provides false confidence of unused-code checking while the tool is not installed or wired into any npm script.
5. **From Observation 1.4:**
   - When developers must run hundreds of unrelated tests taking several minutes just to check changes in `agentswarm`, or construct 14-argument commands to bypass `.mocharc.json`, ergonomics degrade and turnaround time increases.
   - Adding a dedicated convenience script (`npm run test:swarm` or `npm run test:legion`) and updating `.mocharc.json` to allow single-file targeting restores fast, ergonomic feedback loops (< 3 seconds).

---

## 3. Caveats

1. **Read-Only Scope:** As an Explorer agent, no changes were applied directly to target codebase files or git. All remediation recommendations below are structured for immediate implementation by the subsequent builder/hardening phase.
2. **VS Code Extension Host Execution:** Automated tests verify pure TypeScript logic, mocked VS Code environments, and real SQLite `BufferedDbPool` behavior. Live UI behavior inside a real VS Code extension host process with external network latency was not exercised (consistent with `implementation/findings.md`).
3. **Host-Specific Doctor Behavior:** `npm run doctor:ci` examines local editor extension directories if run without flags; in true CI container environments without local extensions, this check behaves differently.

---

## 4. Conclusion

The `agentswarm` subsystem and LUMI monorepo exhibit robust core engineering: all 332 backend swarm tests pass in ~2 seconds, webview settings tests pass cleanly, and TypeScript and Biome checks pass with 0 errors.

However, the workspace suffers from four specific hygiene, tooling, and ergonomic weakpoints:

1. **Broken CI Guardrails:** Root `README.md` version mismatch causes `npm run docs:check-root-readme` and `docs:check-readme-metrics` to fail.
2. **Knowledge Base Documentation Drift:** `agentswarm/README.md`, `maintainers/README.md`, `file-map.md`, `reincorporation.md`, and `PB-07` are missing Phase 10 entries (`ADR-0016`, `PM-017`, `terminalFileReadPolicy`, and updated test counts).
3. **Workspace Clutter:** 8 dead/temporary files and 11 root benchmark/media files are tracked in git root, alongside an orphaned `knip.json`.
4. **Developer Ergonomics Friction:** Lack of dedicated `test:swarm` npm scripts, rigid `.mocharc.json` preventing single-file test runs, and lack of CI doc validation for `agentswarm/`.

---

## 5. Verification Method & Actionable Recommendations

### 5.1 Verification Commands

To verify the audit findings independently:

```bash
# 1. Reproduce the 2 failing CI scripts
npm run docs:check-root-readme
npm run docs:check-readme-metrics

# 2. Verify all 332 backend swarm tests pass when explicitly targeted
npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha --no-config --timeout 20000 \
  --require ts-node/register --require tsconfig-paths/register --require ./src/test/requires.cjs \
  src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts \
  src/infrastructure/ai/__tests__/Orchestrator.test.ts \
  "src/core/task/legion/__tests__/*.test.ts" \
  src/core/task/tools/handlers/__tests__/EngageSwarmHandler.test.ts \
  src/core/prompts/system-prompt/__tests__/DietCodeToolSetSwarm.test.ts \
  src/shared/storage/__tests__/state-keys.test.ts \
  src/core/api/__tests__/openai-codex.streaming.test.ts \
  src/core/task/__tests__/StreamResponseHandler.test.ts \
  src/integrations/terminal/__tests__/heredocPolicy.test.ts \
  src/integrations/terminal/__tests__/terminalFileReadPolicy.test.ts \
  src/core/task/tools/handlers/__tests__/ExecuteCommandToolHandler.approval.test.ts \
  src/hosts/vscode/terminal/VscodeTerminalProcess.test.ts \
  src/hosts/vscode/terminal/TerminalOutputDecoder.test.ts \
  src/hosts/vscode/terminal/VscodeTerminalLifecycle.test.ts

# 3. Verify TypeScript and Biome linting pass cleanly
npm run check-types
npm run lint

# 4. Check dead/temporary files tracked in git
git ls-files "0" "biome_errors.txt" "build_output.txt" "build_output2.txt" "rename_list.txt" "rename_script.py" "grounding.txt" "changelogv3.md"
```

### 5.2 Concrete Recommendations for Implementer / Hardening Phase

#### Priority 1: Fix Active CI Breakages

1. In `/Users/bozoegg/Downloads/LUMI/README.md`:
   - Line 18: Update badge version from `version-26.0.0-green` to `version-26.4.0-green`.
   - Line 618: Update `LUMI **26.0.0**` to `LUMI **26.4.0**`.
   - Verify `npm run docs:check-root-readme` and `npm run docs:check-readme-metrics` pass cleanly.

#### Priority 2: Synchronize `agentswarm/` Knowledgebase to Phase 10

1. `agentswarm/README.md`:
   - Line 25: Update `Phases 1–9` → `Phases 1–10`.
   - Line 47: Update `0001–0015` → `0001–0016`.
   - Line 48: Update `PM-001–PM-016` → `PM-001–PM-017`.
   - Line 62: Update test count from 291 to 315 passing backend unit tests (332 total verification suite).
2. `agentswarm/maintainers/README.md`:
   - Line 13: Add ADR-0016 to the learning path module description.
   - Line 14: Add `terminalFileReadPolicy.ts` and `UseSkillToolHandler.ts` to the codebase tour list.
   - Line 16: Update `PM-001 through PM-016` → `PM-001 through PM-017`.
3. `agentswarm/implementation/file-map.md`:
   - Under "Terminal Execution & Command Policy Defense": Add `terminalFileReadPolicy.ts` and `terminalFileReadPolicy.test.ts`.
   - In the traceability table: Add row for `[ADR-0016](../adr/ADR-0016-terminal-file-read-defense-budget-starvation-and-conductor-prompt-parity.md)`.
4. `agentswarm/playbooks/PB-07-release-verification.md` & `reincorporation.md`:
   - Include `src/integrations/terminal/__tests__/terminalFileReadPolicy.test.ts` in step 2.
   - Update expected passing count from 291 to 315/332.
5. `agentswarm/onboarding/for-maintainers.md`:
   - Simplify header anchor link on Drill 5 to prevent slug formatting anomalies.

#### Priority 3: Monorepo Workspace Cleanup & Curation

1. Remove tracked dead/temporary files:
   - `git rm 0 biome_errors.txt build_output.txt build_output2.txt rename_list.txt rename_script.py grounding.txt changelogv3.md`
2. Curate benchmark artifacts:
   - Relocate root benchmark media (`BENCHMARK-METHODOLOGY.md`, `BENCHMARK-RESULTS.csv`, `*.pdf`, `*.zip`, benchmark images) into `evals/benchmarks/commission-012/` or similar structured evaluation subdirectory.
3. Remove orphaned config:
   - Remove `knip.json` or add `@knip/knip` into `devDependencies` with a corresponding `npm run knip` audit script.

#### Priority 4: Developer Ergonomics & Tooling Improvements

1. Add dedicated npm scripts to `package.json`:
   - `"test:swarm": "cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha --no-config --timeout 20000 -r ts-node/register -r tsconfig-paths/register -r ./src/test/requires.cjs src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts src/infrastructure/ai/__tests__/Orchestrator.test.ts \"src/core/task/legion/__tests__/*.test.ts\" src/core/task/tools/handlers/__tests__/EngageSwarmHandler.test.ts src/core/prompts/system-prompt/__tests__/DietCodeToolSetSwarm.test.ts src/shared/storage/__tests__/state-keys.test.ts src/core/api/__tests__/openai-codex.streaming.test.ts src/core/task/__tests__/StreamResponseHandler.test.ts src/integrations/terminal/__tests__/heredocPolicy.test.ts src/integrations/terminal/__tests__/terminalFileReadPolicy.test.ts src/core/task/tools/handlers/__tests__/ExecuteCommandToolHandler.approval.test.ts src/hosts/vscode/terminal/VscodeTerminalProcess.test.ts src/hosts/vscode/terminal/TerminalOutputDecoder.test.ts src/hosts/vscode/terminal/VscodeTerminalLifecycle.test.ts"`
2. Add automated link & docs checker for `agentswarm/`:
   - Create `scripts/check-agentswarm-docs.mjs` (mirroring `check-agent-docs-links.mjs`) to validate relative links, ADR/PM index coverage, and heading slugs across `agentswarm/**/*.md`.
   - Wire into `npm run ci:check-all` and `npm run docs:check-all`.
3. Support single-file unit test execution:
   - Add `"test:unit:file": "cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha --no-config -r ts-node/register -r tsconfig-paths/register -r ./src/test/requires.cjs"` so developers can execute `npm run test:unit:file -- <filePath>` without running the full suite.
