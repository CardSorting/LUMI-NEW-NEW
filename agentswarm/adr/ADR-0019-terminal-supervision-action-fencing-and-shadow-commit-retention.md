# ADR-0019 — Terminal Supervision, Action Execution Fencing & Shadow Commit Retention

## Context

In complex agent interactions involving command dispatches, process lifecycles, and database write-behind buffering, several dangerous edge cases caused silent corruption or non-deterministic behavior:

1. **Lost Terminal vs. Process Termination:** When a terminal stream dropped or a terminal panel was closed by the user, earlier implementations inferred that the underlying command had stopped. Treating an unobservable process as completed or failed risked launching duplicate concurrent processes (e.g. running multiple database migrations or builds).
2. **Post-Spawn Stream Errors:** Stream observation errors (e.g. pipe disconnects) occurring after process spawn were caught by general error handlers that marked the command dead, even though the OS child process was still running.
3. **Task View Replacement Pollution:** When the chat UI reloaded or switched tasks, background readers from previous task views could publish output or write execution receipts into the replacement task's UI rows.
4. **Replayed Command Execution Races:** Replaying a command with the same execution identity could overwrite active execution state or launch duplicate commands.
5. **Silently Dropped Database Shadows on Flush Failure:** In `BufferedDbPool`, transaction shadows (`agentShadows`) encountering commit errors could be discarded or leave uncommitted state stranded during pool shutdown.

---

## Decisions

1. **Supervised Shell Isolation (`SupervisedShell.ts`):**
   - Implemented `onObservationError`: separates post-spawn stream errors from process exits. If stdout/stderr throw an error after `spawn` has fired, `onObservationError` is called to log the failure, but the child process is **not** declared dead.
   - Robust process tree cancellation: `stop()` ensures the child has spawned before sending termination signals (`taskkill /pid <pid> /T /F` on Windows, `process.kill(-pid, "SIGTERM")` followed by `SIGKILL` on POSIX). If cancellation fails, `stopPromise` is reset and `cancelled = false` to allow deliberate retries.

2. **Strict Command Outcome Classification (`commandOutcome.ts`):**
   - Success requires an observed numeric zero exit code: `details.exitCode === 0 ? "completed" : "failed"`.
   - A closed terminal or missing exit code produces `status = "unconfirmed"`, never `completed` or `failed`.

3. **Action Execution Semantic Fencing (`ActionExecutionRegistry.ts`):**
   - Unconfirmed commands retain their execution identity fence:

     ```ts
     if (state.status === "unconfirmed") {
         this.update(entry, "unconfirmed", state.detail ?? "Command outcome is unconfirmed; reconcile it before retrying.")
     }
     ```
   - Delayed foreground snapshots are forbidden from overwriting newer lost-outcome evidence.
   - `commandObserved` tracks whether a notification has observed the running process, preventing conflicting results from releasing the fence prematurely.
   - Surfaces `unresolved_commands` and `unresolved_actions` in formatted execution state (`ExecutionState.ts`).

4. **View Ownership Fencing (`CommandExecutor.ts`):**
   - Prevents stale readers from publishing into replacement task views: background reads verify task view epoch before mutating message state.
   - Replay protection: replaying an existing execution ID preserves the original row and marks the new command row `not_started`, preventing duplicate dispatches.

5. **Shadow Commit Retention & Affinity Ordering (`BufferedDbPool.ts`):**
   - Throws `ShadowCommitError`: retained transaction shadows on commit failure are kept in memory and must be explicitly retried or rolled back.
   - Graceful shutdown (`stop()`): refuses database shutdown if any uncommitted transaction shadows remain (`agentShadows.size > 0 || retainedCommitShadows.size > 0`).
   - SQLite column affinity: `applyAffinity` applies SQLite storage rules (`text`, `numeric`, `blob`) before predicate matching in `matchesWhere`, and `compareSqliteValues` implements standard SQLite ordering (NULL < number < text < blob).

---

## Consequences

### Positive

- Disconnected terminals never result in guessed process states or duplicate command execution.
- Command replays cannot corrupt existing task message rows.
- Stale UI readers cannot pollute replacement task views.
- Uncommitted database shadows cannot be silently lost during flush errors or shutdown.

### Negative / Trade-offs

- Commands with lost exit codes remain fenced as `unconfirmed` until explicitly reconciled by the user or coordinator.
- Database shutdown throws if shadows are abandoned without commit or rollback.

---

## Evidence

- **Terminal Suite:** `src/integrations/terminal/SupervisedShell.test.ts`, `src/integrations/terminal/CommandExecutor.ownership.test.ts`.
- **Action Execution Suite:** `src/core/task/__tests__/ActionExecutor.test.ts`, `src/core/task/__tests__/ExecutionRecovery.test.ts`.
- **Pool Persistence Suite:** `src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts` Section 5.
