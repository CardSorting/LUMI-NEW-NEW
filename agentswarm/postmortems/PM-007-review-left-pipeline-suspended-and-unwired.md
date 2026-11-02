# PM-007 — Review left the pipeline suspended and was not wired into `attempt_completion`

**Date:** 2026-11-02 · **Severity:** Medium · **Detected by:** Real-SQLite test or code audit · **Blameless format**

## Summary
`runReview` deferred the pipeline but never resumed it, and `AttemptCompletionHandler.execute` never called `evaluateOptionalCriticalCompletionReview` (only `runCompletionGateFlow` did).

## Reproduction
- **Input:** `autoDeferOnCompletionReview` + review `ACCEPT`; and an `attempt_completion` with review enabled.
- **Expected:** Pipeline resumes after review; the real tool flow runs the review.
- **Actual:** Hierarchy stayed frozen; review never ran in the tool handler.

## Root cause
Missing post-review `resumePipeline` and incomplete call-site wiring.

## Fix
Auto-resume unless `ESCALATE`; roadmap updated with confirmed corrective tasks; wired into `AttemptCompletionHandler` after the audit gate (`REMEDIATE`/`ESCALATE` block completion).

## Why it wasn't caught earlier
Tests exercised the service, not the handler.

## Prevention (now in place)
PB-07 checklist includes the handler path.

## Lessons
A capability isn't delivered until its real entry point calls it.
