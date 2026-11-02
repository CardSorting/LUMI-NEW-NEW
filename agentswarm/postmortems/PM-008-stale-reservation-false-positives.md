# PM-008 — File-reservation check used `selectOne` and ignored stream liveness

**Date:** 2026-11-02 · **Severity:** Medium · **Detected by:** Real-SQLite test or code audit · **Blameless format**

## Summary
Legion file reservations read the *first* `file_res:<path>` row and treated any holder as a conflict, even completed/failed streams — and could miss an active holder hiding behind a stale first row. The check regressed once more during PM-010.

## Reproduction
- **Input:** Stream A reserved a file and finished; parent B forms a Legion on the same file.
- **Expected:** No conflict (A is inactive).
- **Actual:** False conflict or missed conflict.

## Root cause
`selectOne` on a non-unique key; no active-stream membership test.

## Fix
`selectWhere` all holders, then `find` one that is not the child, not the parent, **and** belongs to an active stream.

## Why it wasn't caught earlier
Mock `selectOne` returned an arbitrary row.

## Prevention (now in place)
Test: concurrent forms with overlapping files; stale reservations ignored.

## Lessons
Non-unique key ⇒ never `selectOne`.
