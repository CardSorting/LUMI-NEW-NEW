# PB-08 — Audit after interrupted or delegated work

**When:** a worker/subagent stopped (quota, crash, timeout) or returned a report you haven't independently verified. See PM-010.

## Steps
1. **Don't trust "nothing happened."** `git status --short`, `git diff --stat`, `wc -l` on the files in scope. Compare against the last sizes/contents you read.
2. **Re-read before editing.** If an edit's target text no longer matches, the file changed — stop and read it.
3. **Outline the file** (`grep -n "^export \|^\tpublic \|^\tprivate "`) and spot new/removed members.
4. **Find dead code:** for each new public method, `grep -rn "<name>" src webview-ui/src | grep -v "<defining file>"`. No callers + no tests ⇒ unfinished.
5. **Check for regressions of known fixes**: PM-001 (`push(..., agentId)` on `agent_streams`), PM-002 (upsert without `conflictTarget`), PM-008 (`selectOne` for reservations).
6. **Verify claims**: for every test a report names, `grep -n "<title>"`.
7. **Run everything** (PB-07). Fix failures at the root cause; add tests for what you find.
8. **Report honestly**: what existed, what you changed, what remains unverified.

## Smells
- File line count jumped but no corresponding tests.
- Public API with no callers.
- Test file doesn't contain tests the report mentions.
- A fix you made earlier is gone.
