# 04 — Failure Modes, War Games & Recovery Drills

To truly own a complex distributed/multi-agent subsystem, you need to know **how it can fail**, **how the test suite proves it won't**, and **how to recover if a new edge case appears**.

This guide documents **7 hands-on War-Game Drills** (including the exact **Mutation Proofs `M1`–`M5`** executed during verification) that you can run in under 2 minutes on your machine.

---

## 1. Mutation Proofs: How We Know the Tests Catch Real Bugs

A passing test suite means nothing if breaking the production guard still leaves the tests green. During the authoring of this handbook, we deliberately injected the historical bugs back into the codebase (**Mutations `M1`–`M5`**) and ran the test suite to prove that our tests fail immediately with a clear diagnostic.

| Mutation ID       | What We Deliberately Broke                                                                                                         | File & Line Anchor                                                    | Test That Caught It Immediately                                                                                                                  | Exact Failure Output                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **`M1` (PM-009)** | Weakened terminal-state guard from `completed \| failed \| rerouted` to `member.status === event`                                  | `LegionCoordinator.ts` (`reconcileSpecialistStreamLifecycleUnlocked`) | _"automatically advances stages via Orchestrator.completeStream/failStream, enforces bounded failover, and prevents terminal state overwrite"_   | `AssertionError: expected 'failed' to equal 'rerouted'`                                                           |
| **`M2` (PM-008)** | Removed active-stream check (`streamRow.status === "active"`) when checking `file_res:*` conflicts                                 | `LegionCoordinator.ts` (`formLegion`)                                 | _"persists Legion formations, handoffs, synthesis, and active-only file reservation checks cleanly through the real SQLite BufferedDbPool"_      | `AssertionError: expected [ 'src/shared/contested.ts' ] to deeply equal []`                                       |
| **`M3` (PM-011)** | Re-added `streamId` as the 2nd argument (`pushBatch(ops, streamId)`) after `commitWork(streamId)` in `completeStream`              | `Orchestrator.ts` (`completeStream`)                                  | _"persists completeStream status and summary to SQLite (not stranded in a post-commit shadow overlay) and releases a parent suspension barrier"_ | `AssertionError: expected 'active' to equal 'completed'` & `expected 'waiting_for_children' to equal 'suspended'` |
| **`M4` (PM-012)** | Removed `pipeline.phase !== "waiting_for_children" && pipeline.phase !== "suspending"` guard in `reconcilePipelineBarrier`         | `HierarchicalDeferCoordinator.ts` (`reconcilePipelineBarrier`)        | _"does not re-suspend an already resumed pipeline when a child completes later, and deletes same-batch file reservations on disk"_               | `AssertionError: expected 'waiting_for_children' to equal 'resumed'`                                              |
| **`M5` (PM-015)** | Removed `isTransportError` check in `LegionAgentHost.execute`, returning `safeToRetry: true` on transport stream decoding failures | `LegionAgentHost.ts` (`execute` catch block)                          | _"flags transport decoding errors with safeToRetry: false to prevent futile specialist failovers"_                                               | `AssertionError: expected true to equal false`                                                                    |

---

## 2. Drill 1: Stuck Parent Suspension Barrier (`waiting_for_children`)

### Symptom

A parent stream throws:

```text
Error: Stream <parent-id> is currently suspended (waiting_for_children) and cannot accept new work (dispatchTask)
```
and never transitions to `suspended` or `resumed`.

### Root-Cause Checklist

1. Run `Q2` and `Q3` from [03-operating-handbook.md](03-operating-handbook.md) to get `pending_ack_ids`.
2. Run `Q1` to check `agent_streams.status` for each stream in `pending_ack_ids`.
3. **Case A — Child stream is still `active` in `agent_streams`:**
   - The child runner is either mid-tool or stopped polling its control inbox (`stream_control_inbox`) without calling `acknowledgeChildSuspension`, `completeStream`, or `failStream`.
4. **Case B — Child stream is `completed` in memory, but `active` in SQLite:**
   - Someone wrote a completion status into a shadow overlay (`push(op, streamId)`) after `commitWork(streamId)` ([PM-011](../postmortems/PM-011-completion-state-stranded-in-shadow-overlay.md)).

### Programmatic Recovery (Code or Debug Console)

- Call `await orchestrator.failStream(stuckChildStreamId, "Manual operator timeout")` — this automatically triggers `reconcileAfterStreamFailure` and releases the parent barrier; **or**
- Call `await orchestrator.resumeHierarchy({ rootStreamId, actorId: "operator", reason: "Manual barrier override", forceEnable: true })`.

---

## 3. Drill 2: Specialist Crash, Failover & Budget Exhaustion

### Symptom

A Legion specialist stream crashes (`failStream`). You want to know whether a fallback specialist took over or whether the formation slot permanently failed.

### How the Bounded Failover Machine Works (`LegionCoordinator.ts`)

1. **Attempt 1 Fails (`attempt = 1`):**
   - If Legion is enabled and `safeToRetry` is not `false` (e.g. no unsettled commands, disallowed tools, or exhausted budgets), `rerouteFailedSpecialist` spawns a replacement specialist.
   - Original slot is marked `status: "rerouted"` (a **final, absorbing terminal state**), and `reroutedToStreamId` records the replacement stream.
   - Replacement specialist is spawned with `attempt = 2`, inheriting the assignment role (e.g. `legion_implementer`) and files, enriched with failover context and the prior failure reason.
2. **Attempt 2 Fails (`attempt = 2 === LEGION_MAX_ATTEMPTS_PER_SLOT`):**
   - Failover budget is exhausted. No third specialist is spawned.
   - Slot remains `status: "failed"` (final, absorbing).
   - If all other members in that stage are settled, the formation still advances to the next stage (recording the failed slot as an unverified finding in the synthesis report) rather than hanging the parent task forever.

### Inspection Command

Run `Q6` and `Q7` from [03-operating-handbook.md](03-operating-handbook.md) to see every member's `member_status`, `attempt`, and `rerouted_to`.

---

## 4. Drill 3: SQLite Flush Errors (`FOREIGN KEY` or `ON CONFLICT`)

### Symptom

`[DbPool]` logs one of:

- `SqliteError: FOREIGN KEY constraint failed`
- `SqliteError: ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`

### Root Cause & Immediate Fix ([PB-06](../playbooks/PB-06-triage-sqlite-flush-errors.md))

1. **`FOREIGN KEY constraint failed`:**
   - **Cause:** A child row (`agent_tasks` or `agent_memory`) was pushed **directly** (`dbPool.push(op)` with no `agentId`), while its parent `agent_streams` row was pushed into a **shadow overlay** (`dbPool.push(op, streamId)`). On the 1s timer, `activeBuffer` flushes the child row before the parent stream row exists in SQLite ([PM-001](../postmortems/PM-001-shadow-buffer-foreign-key-failure.md)).
   - **Audit One-Liner:**

     ```bash
     grep -rn 'table: "agent_streams"' src/
     ```

     Verify that **no** `insert` on `agent_streams` passes a second argument (`agentId`) to `dbPool.push` or `dbPool.pushBatch`.
2. **`ON CONFLICT clause does not match...`:**
   - **Cause:** An `upsert` on `agent_memory` omitted `conflictTarget: ["streamId", "key"]` (`BufferedDbPool` defaults `conflictTarget` to `["id"]`, and `agent_memory` has no `id` column — [PM-002](../postmortems/PM-002-upsert-without-conflict-target.md)).
   - **Audit One-Liner:**

     ```bash
     grep -rn -A6 'type: "upsert"' src/infrastructure/ai/
     ```

     Verify every `agent_memory` upsert has `conflictTarget: ["streamId", "key"]`.

---

## 5. Drill 4: Webview Toggle Says "On" (or "Off") After Reload

### Symptom

The user toggles Agent Swarm in the Settings UI (or edits `settings.json`), reloads the window, and sees a different state than expected.

### Root-Cause Checklist ([ADR-0006](../adr/ADR-0006-config-precedence-and-explicit-detection.md), [PM-004](../postmortems/PM-004-statemanager-defaults-clobber-settings.md))

1. **Check Environment Variables First:**
   Run `env | grep LUMI_AGENT_SWARM` in the terminal where VS Code was launched. Tier 4 (`LUMI_AGENT_SWARM_*`) **always overrides** Tier 3 (`StateManager` / Webview UI) and Tier 2 (`settings.json`).
2. **Check `resolveEffectiveAgentSwarmState` Reasons:**
   In code or a debug session, call:

   ```ts
   const state = resolveEffectiveAgentSwarmState();
   console.log(state.reasons);
   ```

   `state.reasons` prints the exact winning tier (e.g., `"Global Agent Swarm master switch is disabled"` vs. `"Legion enabled via configuration"`).
3. **Check the 30-Second Config Cache:**
   If you mutated `StateManager` directly in a new handler without going through `updateSettings.ts` or `updateTaskSettings.ts`, call `invalidateAgentSwarmConfigCache()` (`src/infrastructure/ai/AgentSwarmConfig.ts`).

---

## 6. Drill 5: Auditing an Interrupted AI Subagent or PR (PB-08)

See companion runbook: [PB-08](../playbooks/PB-08-audit-after-interrupted-work.md).

During the development of this system, an AI worker (`DeepCoder`) hit a `429 RESOURCE_EXHAUSTED` quota limit mid-turn after writing ~700 lines of `LegionCoordinator.ts`, and its outer wrapper reported "completed" ([PM-010](../postmortems/PM-010-interrupted-worker-partial-work.md)).

Whenever an AI agent (or human contributor) hands you a branch or an interrupted workspace, run this exact 5-step audit before trusting any claim:

```bash
# 1. Inspect what files were actually modified or left untracked
git status

# 2. Check for regressions of the 3 classic persistence anti-patterns
grep -rn 'table: "agent_streams"' src/infrastructure/ai/
grep -rn -B2 -A4 'commitWork(' src/infrastructure/ai/
grep -rn 'selectOne("agent_memory"' src/infrastructure/ai/

# 3. Verify that every new public Coordinator method has a real production caller (not just tests!)
grep -rn 'reconcileAfterStreamFailure\|settleSpecialistStream\|evaluateOptionalCriticalCompletionReview' src/

# 4. Run both TypeScript compilers (Extension Host + Webview UI)
npx tsc --noEmit && npx tsc -b webview-ui --pretty false

# 5. Run the full real-SQLite + unit test verification block (291 tests)
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
  src/core/task/tools/handlers/__tests__/ExecuteCommandToolHandler.approval.test.ts \
  src/hosts/vscode/terminal/VscodeTerminalProcess.test.ts \
  src/hosts/vscode/terminal/TerminalOutputDecoder.test.ts \
  src/hosts/vscode/terminal/VscodeTerminalLifecycle.test.ts
```

---

## 7. Drill 6: Conductor Swarm Engagement & Budget Exhaustion

### Symptom

A conductor calls `engage_swarm`, but execution fails or specialists stop prematurely.

### Root-Cause Checklist

1. **Check Swarm/Legion Configuration:**
   If `state.enabled` and `state.legionEnabled` are both `false`, `EngageSwarmHandler` returns an immediate tool error advising that Swarm or Legion must be enabled in settings.
2. **Check Remaining Parent Budgets:**
   `LegionAgentHost` deducts prior parent task token usage and cost. If `remainingTokens === 0` or `remainingCost === 0`, execution is halted immediately. In `LegionAgentHost`, exceeding `maxTokens` or `maxCost` halts execution with reason `"Specialist team budget exhausted."` and `safeToRetry: false`.
3. **Check Steering Abort:**
   If the user sent a chat message while specialists were active, `activeLegionController.abort()` immediately fires, causing `pipelineResult.status === "cancelled"`.
4. **Check Failover Eligibility:**
   Verify `safeToRetry` status. Failures with unconfirmed commands, disallowed tools, or duplicate IDs cannot be safely retried.

---

## 8. Drill 7: Stream Decoding Failures, Concatenated Snapshots & Transport Circuit-Breaking

### Symptom

Specialist execution halts with:

```text
[Transport Error] Stream decoding failed: Malformed arguments for tool <tool_name>: ...
```
or `SyntaxError: Unexpected non-whitespace character after JSON`.

### Root-Cause Checklist ([PM-015](../postmortems/PM-015-tool-argument-snapshot-concatenation-and-stream-decoding-loop.md), [ADR-0014](../adr/ADR-0014-tool-argument-stream-deduplication-and-self-healing-parser.md))

1. **Check if Self-Healing Activated:**
   - If the provider emitted identical duplicate snapshots (e.g. `{"path": "."}{"path": "."}`), `StreamResponseHandler.extractJsonRoots` detects multiple identical roots and automatically self-heals without throwing.
   - If `status: "failed"` occurred, inspect the logged error: non-identical concatenated objects (e.g. two conflicting parameter payloads) or invalid syntax will throw `ToolArgumentError` (`kind: "concatenation"` or `kind: "syntax"`).
2. **Verify Circuit-Breaking (`safeToRetry: false`):**
   - Check that `safeToRetry` is `false`. When stream decoding or JSON syntax fails, `LegionAgentHost` prevents `LegionCoordinator` from triggering an automatic failover replacement. Retrying the same model with the same transport would hit the exact same decoding bug.
3. **Verify Provider Offset Tracking:**
   - If a new streaming provider is added, verify that its stream response generator uses `toolCallDelta(callId, args, snapshot)` to slice terminal done snapshots against accumulated deltas.

---

## Drill 8 — Diagnosing Terminal Heredoc Deadlocks & File Modification Interception (PM-016, ADR-0015)

### When to Use

A specialist agent or parent conductor command appears stuck in `execute_command`, or returns `command_permission_denied` with:

```text
Terminal heredoc file creation detected for '<filename>'. Writing files through terminal heredocs deadlocks interactive shell integration and bypasses file tracking. Use the 'write_to_file' tool directly to create or overwrite each file instead.
```

### Symptom

- **Normal Interception:** The command fails immediately with a `command_permission_denied` tool error, no terminal processes hang, and the model self-corrects using `write_to_file`.
- **Unhandled Deadlock (if guards were bypassed):** The task spins indefinitely waiting for `onDidEndTerminalShellExecution`; terminal output stays empty or stalled; no exit code is received.

### Root-Cause Checklist ([PM-016](../postmortems/PM-016-terminal-heredoc-deadlock-and-prompt-parity.md), [ADR-0015](../adr/ADR-0015-multi-tier-terminal-heredoc-defense-and-prompt-parity.md))

1. **Check Specialist System Prompt Parity:**
   - Verify `LEGION_CORE_RULES` is present in the specialist's system prompt in `LegionAgentHost.ts`. If prompt parity is broken, the specialist may believe terminal heredocs (`cat <<'EOF'`) are an acceptable method for file creation.
2. **Verify Pre-Execution Interception & Approval Suppression:**
   - Ensure `ExecuteCommandToolHandler.ts` suppresses UI approval prompting and intercepts the command via `detectHeredocFileRedirection`. The user should not be prompted to manually approve an unexecutable heredoc command.
   - Verify `UniversalGuard.guardPreExecution` and `FluidPolicyEngine.validatePreExecution` reject the command before execution starts.
3. **Inspect Terminal Process Circuit-Breaker:**
   - If a multiline heredoc slipped past handlers, check `VscodeTerminalProcess.ts`: `isMultilineHeredocCommand` must route the command to `runManaged` fallback or throw `Command execution blocked: multiline heredoc commands cannot be safely executed via interactive shell integration without deadlocking`.
4. **Resolution:**
   - Ensure the agent receives the error message instructing it to use `write_to_file`. Verify the agent calls `write_to_file` on the subsequent turn.
