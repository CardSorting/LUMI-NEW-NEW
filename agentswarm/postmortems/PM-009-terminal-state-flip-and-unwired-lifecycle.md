# PM-009 — Terminal member state could flip (`rerouted → failed`); lifecycle APIs had no callers

**Date:** 2026-11-02 · **Severity:** Medium · **Detected by:** Newly written lifecycle test · **Blameless format**

## Summary
The first version of the Legion lifecycle code (stage progression, reroute, synthesis) existed but nothing called it, had no tests, and its idempotency guard only ignored events equal to the current status. A **repeated failure event** flipped an already-`rerouted` member back to `failed`, which corrupted stage readiness (a rerouted original counted as pending) and suppressed the synthesis report.

## Reproduction
- **Input:** `failStream(worker)` twice, then fail the replacement.
- **Expected:** One replacement ever; unresolved-failure report once the budget is exhausted.
- **Actual:** State flip; no report.

## Root cause
Weak idempotency; no wiring into `completeStream`/`failStream`; no tests.

## Fix
Terminal states are final (any later event is ignored); `settleSpecialistStream` wired from `completeStream`/`failStream`; per-formation lock; attempt cap; reroute guard (`failed` only, once). Seven lifecycle tests added.

## Why it wasn't caught earlier
There were no tests for the lifecycle at all; the flip was found by the first failing test ("unresolved-failure report").

## Prevention (now in place)
ADR-0009; Section 8 tests.

## Lessons
If an API has no caller and no test, assume it is wrong. Idempotency means *every* repeated event, not only the equal one.
