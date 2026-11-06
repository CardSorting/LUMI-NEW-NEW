# Milestone 2 Empirical Challenge Report: Workspace Audit, Hygiene, CI Fixes & Ergonomics

**Author:** Challenger M2 (teamwork_challenger_m2_1)  
**Date:** 2026-11-04  
**Scope:** Milestone 2 (Features F08, F09, F10, F11)  
**Target Workspace:** `/Users/bozoegg/Downloads/LUMI`  
**Verdict:** **APPROVE** (confirmed correct, durable, and fail-closed)

---

## 1. Observation

### 1.1 Baseline CI Guardrail Execution

All baseline commands were directly executed in `/Users/bozoegg/Downloads/LUMI` with exit code 0:

- `npm run docs:check-root-readme`:

  ```
  docs:check-root-readme OK — v26.4.0, 64 tools, 13 read-only, 10 slash, 8 hooks, 7 providers
  ```
- `npm run docs:check-readme-metrics`:

  ```
  docs:check-readme-metrics OK — v26.4.0, 64 tools, 13 read-only, 10 slash, 8 hooks, 7 providers
  ```
- `npm run docs:check-agentswarm`:

  ```
  docs:check-agentswarm OK — 68 files, 432 links verified, 16 ADRs, 17 PMs indexed
  ```
- `npm run check-types`: Clean compilation across root and webview-ui (`tsc --noEmit && tsc -b webview-ui`, exit code 0).
- `npm run lint`: Checked 1769 files in 12s, 0 errors; `proto-lint.sh` clean (exit code 0).
- `npm run docs:check-agent-links && npm run docs:check-agent-branding && npm run docs:check-root-readme-links && npm run docs:check-docs-readme`: All passed with exit code 0.

### 1.2 Negative & Boundary Stress-Testing of `scripts/check-agentswarm-docs.mjs`

A dedicated automated negative-testing harness was executed against `scripts/check-agentswarm-docs.mjs` to test error reporting, assert messages, and exit codes:

- **Test 1 (Broken relative markdown link):** Introduced `[Broken Target](./non_existent_target_12345.md)` in temporary markdown file. Exited with status `1`:

  ```
  AssertionError [ERR_ASSERTION]: Broken agentswarm links or anchors detected:
  agentswarm/test_broken_link_temp.md → ./non_existent_target_12345.md (file not found: agentswarm/non_existent_target_12345.md)
  ```
- **Test 2 (Broken cross-document heading anchor):** Introduced `[Broken Anchor](README.md#this-anchor-does-not-exist)` in temporary markdown file. Exited with status `1`:

  ```
  AssertionError [ERR_ASSERTION]: Broken agentswarm links or anchors detected:
  agentswarm/test_broken_anchor_temp.md → README.md#this-anchor-does-not-exist (heading anchor #this-anchor-does-not-exist not found in README.md)
  ```
- **Test 3 (Broken same-document heading anchor):** Introduced `[Broken Local Anchor](#non-existent-local-heading)` in temporary markdown file. Exited with status `1`:

  ```
  AssertionError [ERR_ASSERTION]: Broken agentswarm links or anchors detected:
  agentswarm/test_broken_local_anchor_temp.md → #non-existent-local-heading (heading anchor #non-existent-local-heading not found in agentswarm/test_broken_local_anchor_temp.md)
  ```
- **Test 4 (Unindexed ADR file):** Created unindexed `agentswarm/adr/ADR-9999-stress-test-adr.md`. Exited with status `1`:

  ```
  AssertionError [ERR_ASSERTION]: ADR file ADR-9999-stress-test-adr.md not indexed in agentswarm/adr/README.md
  ```
- **Test 5 (Unindexed Post-Mortem file):** Created unindexed `agentswarm/postmortems/PM-999-stress-test-pm.md`. Exited with status `1`:

  ```
  AssertionError [ERR_ASSERTION]: PM file PM-999-stress-test-pm.md not indexed in agentswarm/postmortems/README.md
  ```
- **Test 6 (Missing required document):** Temporarily renamed required file `agentswarm/glossary.md` to `glossary.md.bak`. Exited with status `1`:

  ```
  AssertionError [ERR_ASSERTION]: Required agentswarm doc missing: agentswarm/glossary.md
  ```
- **Test 7 (External link filtering):** Created temporary markdown file with `https://google.com`, `http://example.org`, and `mailto:test@example.com`. Exited with status `0` (correctly bypassed local file existence checks).
  All temporary fixtures were immediately cleaned up; post-test baseline re-verified green.

### 1.3 Negative Stress-Testing of README Checks

A mutation testing harness was executed against `scripts/check-root-readme.mjs` and `scripts/check-readme-metrics.mjs`:

- **Mutation 1 (`package.json` version drift to `99.9.9`):**
  - `npm run docs:check-root-readme` failed with exit code 1 (`AssertionError [ERR_ASSERTION]: root README must include version 99.9.9`).
  - `npm run docs:check-readme-metrics` failed with exit code 1 (`AssertionError [ERR_ASSERTION]: README badge must match version 99.9.9`).
- **Mutation 2 (`README.md` tool count drift from `**64**` to `**63**`):**
  - `npm run docs:check-root-readme` failed with exit code 1 (`AssertionError [ERR_ASSERTION]: root README must cite **64** tools`).
  - `npm run docs:check-readme-metrics` failed with exit code 1 (`AssertionError [ERR_ASSERTION]: README/companion-brief metrics out of sync with codebase: 64 tools`).
- **Mutation 3 (`docs/papers/companion-brief.md` tool count drift from `**64**` to `**63**`):**
  - `npm run docs:check-readme-metrics` failed with exit code 1 (`AssertionError [ERR_ASSERTION]: README/companion-brief metrics out of sync with codebase: 64 tools`).
    Restoring the files returned both checks to passing with exit code 0.

### 1.4 `test:swarm` Suite Reliability & Flakiness Stress Test

`npm run test:swarm` was executed 3 times consecutively via automated child process runner:

- **Run 1:** 332 passing, 0 failing, 0 pending (8.94s).
- **Run 2:** 332 passing, 0 failing, 0 pending (9.45s).
- **Run 3:** 332 passing, 0 failing, 0 pending (10.14s).
- Every run completed in <11s with 100% pass rate, zero test timeouts, and zero flakiness.

### 1.5 Repository Hygiene & Dead File Purge

- `git ls-files "0" "biome_errors.txt" "build_output.txt" "build_output2.txt" "rename_list.txt" "rename_script.py" "grounding.txt" "changelogv3.md" "knip.json"` returned empty (exit code 0).
- Filesystem check confirmed none of the 9 files exist on disk.
- Grep of the codebase confirmed no active code references `changelogv3.md`, `biome_errors.txt`, `build_output.txt`, or `rename_script.py`. References in `.vscodeignore` and `TspPolicyPlugin.ts` are static ignore patterns and whitelists that do not require the files to exist.

---

## 2. Logic Chain

1. **Guardrail Robustness:** Observations in Section 1.2 and 1.3 demonstrate that `scripts/check-agentswarm-docs.mjs`, `scripts/check-root-readme.mjs`, and `scripts/check-readme-metrics.mjs` are strict fail-closed guardrails. Any documentation drift, broken link, stale anchor, missing required document, or metric discrepancy immediately triggers an unhandled `AssertionError` with exit code 1.
2. **Ergonomics & Durability of `test:swarm`:** Observations in Section 1.4 show that `npm run test:swarm` encapsulates the exact 14-target verification suite defined in PB-07 Step 2. Executing the suite across multiple runs consistently completes with all 332 tests passing and 0 failures.
3. **Hygiene & Dead File Removal:** Observations in Section 1.5 confirm that dead files were permanently removed from both git tracking and the filesystem without leaving broken links in `README.md` or scripts (which now link canonically to `CHANGELOG.md`).
4. **Build & CI Cleanliness:** Observations in Section 1.1 confirm that TypeScript type checks, Biome formatting/linting, and all subsidiary documentation linters pass without errors or warnings.

---

## 3. Caveats

- `docs:check-links` relies on `mintlify broken-links` inside `docs/`, which expects an external network or global tool not packaged inside node_modules. This is standard for this monorepo and documented in Worker M2's report.
- No production TypeScript source code outside CI scripts and documentation was modified in Milestone 2.

---

## 4. Conclusion

**Verdict: APPROVE**

Milestone 2 (Workspace Audit, Hygiene, CI Fixes & Ergonomics) satisfies all requirements from `ORIGINAL_REQUEST.md` and `PROJECT.md`:

1. Version 26.4.0 and 64-tool metric alignment are durably enforced by fail-closed CI scripts.
2. `agentswarm/` documentation is synchronized with Phase 10 changes (ADR-0016, PM-017, terminal defense, 315/332 test metrics) and verified by `scripts/check-agentswarm-docs.mjs`.
3. 9 dead files were successfully purged and changelog references normalized.
4. `npm run test:swarm` provides a durable, fast (~9s), 332-test verified test target with zero flakes.

---

## 5. Verification Method

To independently re-verify Challenger M2's findings:

```bash
# 1. Verify docs checks baseline
npm run docs:check-root-readme
npm run docs:check-readme-metrics
npm run docs:check-agentswarm

# 2. Run the 332-test swarm suite
npm run test:swarm

# 3. Verify TypeScript and Biome
npm run check-types
npm run lint

# 4. Confirm deleted files are untracked
git ls-files 0 biome_errors.txt build_output.txt build_output2.txt rename_list.txt rename_script.py grounding.txt changelogv3.md knip.json
```
