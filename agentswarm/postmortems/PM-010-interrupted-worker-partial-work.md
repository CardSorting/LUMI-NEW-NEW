# PM-010 — Interrupted worker left partial, regressed and unwired work; status was mis-reported

**Date:** 2026-11-02 · **Severity:** Medium (process) · **Detected by:** Re-read of the file before an edit (line counts had changed) · **Blameless format**

## Summary
A delegated worker hit a provider quota error (`RESOURCE_EXHAUSTED`, 429) a few minutes into the Legion "zenith" pass. The orchestrator reported the pass as **not started**. In fact the worker had already rewritten ~700 lines of `LegionCoordinator.ts`. That partial work (a) reverted two earlier fixes (PM-001, PM-008) in `formAndSpawnLegion`, (b) introduced the PM-001 pattern again in `rerouteFailedSpecialist`, (c) added lifecycle APIs with no callers or tests. An earlier worker report also listed three regression tests that were not found in the test file.

## Reproduction
- **Input:** Resume work after an interrupted subagent.
- **Expected:** Know exactly what changed; no regressions.
- **Actual:** File sizes/contents differed from the last read; regressions and dead code.

## Root cause
The interruption message carried no work summary; the orchestrator assumed "no message ⇒ no work" and did not diff the tree. Claims in reports were not cross-checked against files.

## Fix
Audited with `git status`, `wc -l`, symbol outlines and caller greps; restored the two fixes; fixed the new code; wired and tested it; corrected the status with the user.

## Why it wasn't caught earlier
No post-interruption audit step existed.

## Prevention (now in place)
[PB-08](../playbooks/PB-08-audit-after-interrupted-work.md); maintainers/agents onboarding: treat reports as claims, verify named tests exist.

## Lessons
After any interruption: re-read before editing, diff, search for APIs without callers, rerun everything. Never report "not started" without checking the tree.
