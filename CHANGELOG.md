# Changelog

## [22.0.0] - 2026-09-27

- Persist command and helper execution identities, completed results, and partial evidence across extension-host restarts. Unfinished commands without a live execution handle remain explicitly unknown and are never automatically replayed.
- Reconcile helper batches and status rows by identity without duplicate work. Cancelled and retired helpers cannot regain authority or execute queued file writes after recovery.
- Supervise fallback shell execution, retain command ownership when tasks reopen, and normalize escaped shell operators before dispatch.
- Serialize file saves, reject stale writes, preserve committed partial results, and isolate optional tracking and UI failures from execution outcomes.
- Add regression coverage for restart recovery, helper deduplication and cancellation, shell lifecycle, and concurrent file mutations.

See [command and helper execution reliability](docs/architecture/command-helper-execution.md) for restart semantics and platform boundaries.
