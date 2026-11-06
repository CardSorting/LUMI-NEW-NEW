# Post-Mortem PM-018 — Unconfirmed Command Outcome Fencing & Replacement View Pollution

**Incident Date:** 2026-11-05  
**Severity:** High (Duplicate Execution Risk & UI State Corruption)  
**Affected Subsystems:** `src/integrations/terminal/SupervisedShell.ts`, `src/integrations/terminal/CommandExecutor.ts`, `src/integrations/terminal/commandOutcome.ts`, `src/core/task/ActionExecutionRegistry.ts`, `src/core/task/ActionExecutor.ts`  
**Related ADRs:** [ADR-0019](../adr/ADR-0019-terminal-supervision-action-fencing-and-shadow-commit-retention.md)

---

## 1. Summary

During long-running command executions (such as large package builds and migration tasks), two critical defects surfaced:

1. When a user closed a terminal tab or when an observation stream encountered an I/O disconnect, the system treated the loss of terminal observation as a command completion or failure. The coordinator or model immediately re-executed the same command, creating concurrent competing processes that corrupted workspace build locks and filesystem caches.
2. When the user switched tasks or reloaded the chat interface while an earlier command reader was still awaiting completion, the background reader continued executing and published its final output and message updates into the replacement task's chat rows.

---

## 2. Root Cause Analysis

### A. Permissive Command Outcome Classification

In `commandOutcome.ts`:

```ts
// Flawed logic:
status: details?.cancelled
	? "cancelled"
	: details?.signal || (typeof details?.exitCode === "number" && details.exitCode !== 0)
		? "failed"
		: details?.exitCode === 0
			? "completed"
			: "unconfirmed"
```
When a terminal closed unexpectedly without an exit code, several callers treated undefined exit codes as failed, immediately releasing execution claims. In truth, an unobserved terminal does not establish that the OS process has terminated.

### B. Missing Semantic Fencing for Lost Outcomes

In `ActionExecutionRegistry.ts`, when a command returned from the foreground with `status = "unconfirmed"`, older receipts finalized the execution receipt. The registry cleared the active execution entry, allowing another agent turn or specialist to launch the exact same action while the underlying process was still running in the background.

### C. Unscoped View Callbacks in CommandExecutor

In `CommandExecutor.ts`, background output readers retained references to `callbacks.updateDietCodeMessage` without checking whether the active chat view or task session had changed. When a view was replaced, stale readers published completion updates to timestamp indices belonging to the new view.

---

## 3. The Fix

1. **Strict Numeric Exit Code Verification (`commandOutcome.ts`):**
   - Success requires an explicit `exitCode === 0`.
   - Any missing exit code without explicit cancellation or signal produces `status: "unconfirmed"`.
2. **Semantic Fencing (`ActionExecutionRegistry.ts`):**
   - Commands with `unconfirmed` status retain their execution identity fence in `this.keys` and `this.active`.
   - Added `commandObserved`: once a notification observes a running process, conflicting or delayed foreground snapshots cannot prematurely clear the fence.
   - Surfaces `unresolved_commands` and `unresolved_actions` in `ExecutionState.ts` so coordinators see unfinished work.
3. **View Ownership Fencing (`CommandExecutor.ts`):**
   - Background readers verify task view epoch before updating messages; old readers finish without writing or publishing into a replacement view.
   - Replay protection: replaying an existing execution ID preserves the original row and marks the new command row `not_started`.
4. **Post-Spawn Observation Error Isolation (`SupervisedShell.ts`):**
   - Added `onObservationError`: post-spawn stream errors are logged without killing or misreporting the process.

---

## 4. Why It Escaped Earlier Testing

1. **Mock Terminal Transports:** Tests previously used mock terminals that always emitted clean exit events (`exitCode: 0`) synchronously or on timer ticks, never simulating pipe disconnections or abrupt terminal closures mid-command.
2. **Single-Task Test Environments:** Test fixtures instantiated one task and executor at a time, never exercising task switching or view replacement while background readers were in flight.

---

## 5. Prevention & Regression Proofs

- `src/integrations/terminal/CommandExecutor.ownership.test.ts`:
  - `lets an old reader finish without writing or publishing into a replacement view`
  - `marks a replayed execution as not started on the new command row`
  - `preserves the original row when refreshing the same execution ID`
  - `updates only the command row with the matching timestamp and execution identity`
- `src/integrations/terminal/SupervisedShell.test.ts`:
  - `reports post-spawn supervised errors while retaining late exit ownership`
  - `reconnects a real supervised shell with its stdin, output, and exit receipt intact`
