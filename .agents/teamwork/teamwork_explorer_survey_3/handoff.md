# System Resilience, Failure Modes & Durable Hardening Report (R2)

**Explorer:** Explorer 3 (System Resilience Explorer)  
**Date:** 2026-11-04  
**Target Codebase:** `/Users/bozoegg/Downloads/LUMI/agentswarm` and underlying LUMI engine (`src/infrastructure/ai/`, `src/infrastructure/db/`, `src/core/task/legion/`, `src/hosts/vscode/terminal/`, `src/integrations/terminal/`)  
**Status:** Completed

---

## Executive Summary

An exhaustive architectural and code-level investigation was conducted into the failure modes, weakpoints, and resilience characteristics of `agentswarm`. While the subsystem contains sophisticated protections (e.g. 17 documented postmortems, 16 ADRs, multi-tier terminal heredoc/read defenses, and 332 passing unit tests), deep inspection revealed **eight critical systemic weakpoints** spanning persistence reliability, concurrency bottlenecks, unhandled process lifecycle crashes, and completion gate friction.

Historically, several issues were patched using ad-hoc, localized workarounds (monkey patches)—such as manually calling `await dbPool.flush()` prior to deletes to counteract pool-level type sorting, or falling back to serialized single-specialist execution to bypass advisory file reservation collisions. This report analyzes each failure mode, maps the logic chain from code observation to production impact, contrasts fragile monkey patches against durable architectural hardening, audits existing test coverage, and establishes an actionable verification method.

---

## 1. Observation

### 1.1 `BufferedDbPool.ts` — Silent Flush Failure & Non-Retryable Error Swallowing

**Location:** `/Users/bozoegg/Downloads/LUMI/src/infrastructure/db/BufferedDbPool.ts:525–560`

In `BufferedDbPool.flush()`:

```ts
525: 		} catch (e: unknown) {
526: 			const err = e as { code?: string; message?: string }
527: 			const isRetryable =
528: 				err.code === "SQLITE_BUSY" ||
529: 				err.code === "SQLITE_LOCKED" ||
530: 				err.code === "SQLITE_MISUSE" ||
531: 				err.message?.includes("deadlock") ||
532: 				err.message?.includes("closed") ||
533: 				err.message?.includes("destroyed") ||
534: 				err.message?.includes("interrupted") ||
535: 				err.message?.includes("Library used incorrectly")
...
553: 				this.inFlightOps.clear()
554: 				this.inFlightSize = 0
555: 				this.inFlightIndex.clear()
556: 			} finally {
557: 				releaseStateFail()
558: 			}
559: 			if (isRetryable) throw e
560: 		} finally {
```

- **Direct Observation:** When SQLite encounters a non-retryable constraint failure (such as `SQLITE_CONSTRAINT_FOREIGNKEY`, `SQLITE_CONSTRAINT_NOTNULL`, `SQLITE_CONSTRAINT_CHECK`, or table schema mismatch), `isRetryable` evaluates to `false`.
- **Result:** Line 559 (`if (isRetryable) throw e`) is bypassed. The method logs **zero** error messages (`Logger.error` is absent), suppresses the rejection, clears `inFlightOps` (discarding every operation in the entire transaction), and resolves normally. Callers awaiting `await dbPool.flush()` receive a clean resolution while all buffered writes in that transaction are permanently lost.

---

### 1.2 `BufferedDbPool.ts` — Alphabetical Operation Type Sorting Inverts Causal Sequence

**Location:** `/Users/bozoegg/Downloads/LUMI/src/infrastructure/db/BufferedDbPool.ts:455–466`

In `BufferedDbPool.flush()` batch sorting:

```ts
455: 					opsToFlush = Array.from(dirtyBuffer.values())
456: 						.flat()
457: 						.sort((a, b) => {
458: 							const fkA = TABLE_FK_ORDER[a.table]
459: 							const fkB = TABLE_FK_ORDER[b.table]
460: 							if (fkA !== undefined && fkB !== undefined && fkA !== fkB) return fkA - fkB
461: 							const pA = LAYER_PRIORITY[a.layer ?? "plumbing"]
462: 							const pB = LAYER_PRIORITY[b.layer ?? "plumbing"]
463: 							if (pA !== pB) return pA - pB
464: 							if (a.table !== b.table) return (a.table as string).localeCompare(b.table as string)
465: 							return (a.type as string).localeCompare(b.type as string)
466: 						})
```

- **Direct Observation:** Within the same table and layer, operations are sorted by `(a.type as string).localeCompare(b.type as string)`. In JavaScript alphabetical order: `"delete" < "insert" < "update" < "upsert"`.
- **Result:** If an agent updates or upserts a row and subsequently deletes it within the same 1-second flush batch, the `delete` executes FIRST, and the `upsert` executes SECOND in SQLite. This resurrects the row. The author acknowledged this in `AgentSwarmAuxiliary.test.ts:868`: _"where the pool orders ops by type (delete before upsert) and would otherwise resurrect the reservation row"_.

---

### 1.3 `BufferedDbPool.ts` — 5-Minute Shadow Overlay Expiration Silently Discards Work

**Location:** `/Users/bozoegg/Downloads/LUMI/src/infrastructure/db/BufferedDbPool.ts:179–192`

```ts
179: 	private async cleanupShadows() {
180: 		const release = await this.stateMutex.acquire()
181: 		try {
182: 			const now = Date.now()
183: 			const SHADOW_EXPIRATION = 5 * 60 * 1000
184: 			for (const [agentId, shadow] of this.agentShadows.entries()) {
185: 				if (now - shadow.lastUpdated > SHADOW_EXPIRATION) {
186: 					this.agentShadows.delete(agentId)
187: 				}
188: 			}
189: 		} finally {
190: 			release()
191: 		}
192: 	}
```

- **Direct Observation:** Background interval `cleanupInterval` runs every 30 seconds. If an agent operation (e.g. slow build, large test suite, multi-turn tool chain, or waiting for human approval) remains idle for $> 5$ minutes between buffer pushes, its `agentShadows` entry is deleted.
- **Result:** When `commitWork(agentId)` is called later (line 362), `shadow` is `undefined`, so zero operations are committed to SQLite. All buffered changes are deleted without notice.

---

### 1.4 `Orchestrator.ts` — `selectOne` Anti-Pattern on Non-Unique Keys (PM-008 Recurrence)

**Location:** `/Users/bozoegg/Downloads/LUMI/src/infrastructure/ai/Orchestrator.ts:807` and `:1257`

In `reserveFiles`:

```ts
804: 		for (const file of files) {
805: 			const normalizedPath = normalizeReservationPath(file)
806: 			if (!normalizedPath) continue
807: 			const found = await dbPool.selectOne("agent_memory", { column: "key", value: `file_res:${normalizedPath}` })
808: 			if (found) {
809: 				const ownerStreamId = found.streamId
810: 				if (ownerStreamId !== streamId && activeStreamIds.has(ownerStreamId)) {
811: 					return {
812: 						reserved: false,
813: 						reason: `File '${path.basename(file)}' is already reserved by active Stream ${ownerStreamId.slice(0, 8)}.`,
814: 					}
815: 				}
816: 			}
817: 		}
```
In `detectFileCollisions`:

```ts
1254: 		for (const file of files) {
1255: 			const normalizedPath = normalizeReservationPath(file)
1256: 			if (!normalizedPath) continue
1257: 			const found = await dbPool.selectOne("agent_memory", { column: "key", value: `file_res:${normalizedPath}` })
1258: 			if (found) {
1259: 				const ownerStreamId = found.streamId
1260: 				if (ownerStreamId !== requestingStreamId && activeStreamIds.has(ownerStreamId)) {
1261: 					return `Collision detected: File '${path.basename(file)}' is reserved by active Stream ${ownerStreamId.slice(0, 8)}.`
1262: 				}
1263: 			}
1264: 		}
```

- **Direct Observation:** `agent_memory` has a compound primary key `(streamId, key)`. Multiple rows can exist with the identical key `file_res:<path>` for different streams.
- **Result:** While `LegionCoordinator.ts:1262` resolved PM-008 by using `selectWhere` and searching across all matching rows, `Orchestrator.ts:807` and `1257` still call `selectOne`. If an older, terminated stream has an uncollected reservation row, `selectOne` returns that inactive row. `activeStreamIds.has(ownerStreamId)` evaluates to `false`, causing the method to conclude no conflict exists—completely ignoring an active stream's reservation on the same file!

---

### 1.5 `LegionPipelineRunner.ts` — Serialized Concurrency Bottleneck in "Parallel" Stages

**Location:** `/Users/bozoegg/Downloads/LUMI/src/infrastructure/ai/LegionPipelineRunner.ts:190, 203–205`

```ts
190: 		const member = progress.readyToExecuteMembers[0]
191: 		if (!member) return { status: "needs_reconciliation" }
...
203: 		// Serialize writes until the host provides enforceable file ownership. Legion's
204: 		// current reservations are advisory and cannot safely arbitrate parallel edits.
205: 		const claimed = await legionCoordinator.claimReadySpecialist(member.streamId)
```

- **Direct Observation:** In `drivePipeline`, `readyToExecuteMembers` is never mapped concurrently. Even when multiple specialists are assigned disjoint file sets in the `parallelExecution` stage (e.g., `legion_implementer` on `src/foo.ts` and `legion_data_steward` on `src/db/bar.ts`), the runner picks only `progress.readyToExecuteMembers[0]` and executes it to completion before advancing to the next member.
- **Result:** Specialists run sequentially, creating a massive throughput and latency bottleneck.

---

### 1.6 `LegionPipelineRunner.ts` & `Task.ts` — Orphaned Running Member Trap & Restart Deadlock

**Location:** `/Users/bozoegg/Downloads/LUMI/src/infrastructure/ai/LegionPipelineRunner.ts:159–164` and `src/core/task/index.ts:2669–2672`

```ts
159: 		const ambiguous = Object.values(progress.stages).some((stage) => {
160: 			if (stage.status === "blocked_by_prior_stage") return false
161: 			const accounted = new Set([...stage.readyStreamIds, ...stage.completedStreamIds, ...stage.failedStreamIds])
162: 			return stage.memberStreamIds.some((id) => !accounted.has(id))
163: 		})
164: 		if (ambiguous) return { status: "needs_reconciliation" }
```
In `src/core/task/index.ts`:

```ts
2669: 			} else if (result.decision === "needs_reconciliation") {
2670: 				this.legionContext =
2671: 					"An earlier specialist execution has an unresolved outcome. Inspect existing work before repeating it."
2672: 			}
```

- **Direct Observation:** If the VS Code extension host restarts, crashes, or is reloaded while a specialist is `status: "running"`, the SQLite row remains `active` and the member status remains `running`.
- **Result:** On restart, `accounted.has(id)` is false because the member is neither ready, completed, nor failed. `ambiguous` evaluates to `true`. `drivePipeline` returns `{ status: "needs_reconciliation" }`. The parent `Task` sets a warning string, but **no automated reaper or startup reconciliation exists**. The child stream is orphaned in SQLite, its file reservations remain locked, and the formation can never proceed.

---

### 1.7 `LegionAgentHost.ts` — Abort Cancellation Caught as General Retryable Failure

**Location:** `/Users/bozoegg/Downloads/LUMI/src/core/task/legion/LegionAgentHost.ts:205, 261–276`

```ts
205: 				signal.throwIfAborted()
...
261: 		} catch (error) {
262: 			const isTransportError =
263: 				(error instanceof ToolArgumentError && (error.kind === "concatenation" || error.kind === "syntax")) ||
264: 				error instanceof SyntaxError ||
265: 				(error instanceof Error &&
266: 					(error.message.includes("concatenated tool call") ||
267: 						error.message.includes("duplicate snapshot") ||
268: 						error.message.includes("Unexpected token") ||
269: 						error.message.includes("is not valid JSON") ||
270: 						error.message.includes("JSON.parse")))
271: 
272: 			const errorMessage = error instanceof Error ? error.message : String(error)
273: 			if (isTransportError) {
274: 				return failed(`[Transport Error] Stream decoding failed: ${errorMessage}`, false)
275: 			}
276: 			return failed(errorMessage, true)
277: 		}
```

- **Direct Observation:** When a user aborts execution, `signal.throwIfAborted()` throws an `AbortError`. The `catch` block catches this error. Because `AbortError` is not a `isTransportError`, it reaches line 276: `return failed(errorMessage, true)`.
- **Result:** It returns `{ status: "failed", safeToRetry: true }`. Unless the downstream caller catches `signal.aborted` synchronously, this can trigger automatic failover rerouting (`rerouteFailedSpecialist`), spawning a replacement specialist despite the user explicitly cancelling the task!

---

### 1.8 `AttemptCompletionHandler.ts` — Remediation Mistake Counter Inversion

**Location:** `/Users/bozoegg/Downloads/LUMI/src/core/task/tools/handlers/AttemptCompletionHandler.ts:288–296`

```ts
288: 		if (
289: 			criticalReviewReport?.executed &&
290: 			(criticalReviewReport.decision === "REMEDIATE" || criticalReviewReport.decision === "ESCALATE")
291: 		) {
292: 			config.taskState.consecutiveMistakeCount++
293: 			const blockCount = recordCompletionGateBlockEvent(config, "audit_gate", { result })
294: 			emitCompletionGateBlockTelemetry(config, "audit_gate", blockCount)
295: 			return formatCompletionToolError(criticalReviewReport.coordinatorFinalReportMarkdown, config, { result })
296: 		}
```

- **Direct Observation:** `CriticalCompletionReview` is designed as a bounded 1+1 refinement pass (`agentswarm2.md`). When the reviewer issues `decision: "REMEDIATE"` to dispatch corrective tasks, line 292 increments `config.taskState.consecutiveMistakeCount++`.
- **Result:** After 2 review iterations or 1 earlier audit failure + 1 review pass, `consecutiveMistakeCount >= 3` trips the `completionGate` circuit breaker, imposing a throttling cooldown and permanently locking out task completion. Legitimate automated adversarial feedback is penalized as an unrecoverable agent error.

---

### 1.9 Test Suite Execution & Coverage Audit

**Command Executed:**

```bash
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
  src/integrations/terminal/__tests__/terminalFileReadPolicy.test.ts \
  src/core/task/tools/handlers/__tests__/ExecuteCommandToolHandler.approval.test.ts \
  src/hosts/vscode/terminal/VscodeTerminalProcess.test.ts \
  src/hosts/vscode/terminal/TerminalOutputDecoder.test.ts \
  src/hosts/vscode/terminal/VscodeTerminalLifecycle.test.ts
```
**Test Audit Result:**

- **Passing Tests:** 332 passing (executed in 2.08s).
- **Existing Coverage Scope:** Auxiliary toggles (49), Orchestrator integration (14), Task Legion lifecycle (19), Legion Agent Host (22), Legion Tool Adapter (13), Native Provider & Policy (2), Engage Swarm (8), DietCode ToolSet (3), State Keys (32), Codex streaming & snapshot slicing (15), StreamResponseHandler self-healing (15), Terminal Heredoc & Read policies (70), Approval interception (29), Terminal process lifecycle & decoding (41).
- **Critical Untested Scenarios Identified:**
  1. _Concurrent Reservation Race:_ No test runs two concurrent `formLegion` or `reserveFiles` calls competing for the same file.
  2. _SQLite Non-Retryable Flush Failure:_ No test forces a schema/FK violation in `BufferedDbPool.flush()` to verify error reporting and data retention.
  3. _Process Crash / Orphaned Member Recovery:_ No test simulates a process restart with active members stuck in `running` status.
  4. _Shadow Overlay Timeout:_ No test verifies behaviour when an agent shadow exceeds the 5-minute idle window.
  5. _True Parallel Specialist Execution:_ Concurrency in `parallelExecution` stage is untested because the pipeline runner serializes execution to a single item.
  6. _`Orchestrator.reserveFiles` Stale Conflict:_ No test validates whether `selectOne` in `Orchestrator.ts:807` ignores active holders when preceded by inactive rows.

---

## 2. Logic Chain

The investigated weakpoints form four systemic failure chains:

```
[Write-Behind Flush Error] ──> isRetryable: false ──> Error Swallowed ──> Silent Data Loss
                                                                                 │
[Type-String Sort (PM-012)] ──> 'delete' < 'upsert' ──> Same-Batch Reordering ───┘
```

1. **Persistence Reliability Chain:**
   - _Premise:_ `BufferedDbPool` was built to optimize throughput with in-memory buffering and batch flushes.
   - _Inference:_ Because flush operations are decoupled from caller execution, any unhandled or suppressed error in `flush()` separates caller expectation from disk reality.
   - _Failure:_ If an invalid op is queued, `BufferedDbPool.flush()` catches the non-retryable error, does not log it, does not throw it, and wipes `inFlightOps`. The application assumes the data is safely in WAL/SQLite, resulting in silent data corruption.

```
[Extension Host Reload] ──> In-Memory State Lost ──> DB Stream Remains 'active'
                                                              │
                                            drivePipeline: 'needs_reconciliation'
                                                              │
                                              Specialist Permanently Orphaned
```

2. **Process Lifecycle & Orphaned State Chain:**
   - _Premise:_ VS Code extension hosts frequently reload, crash, or restart across workspace changes and updates.
   - _Inference:_ In-memory tracking (`activeFormations`, `activeDecisions`) is volatile, while database state (`agent_streams`, `agent_memory`) is durable.
   - _Failure:_ When a reload occurs during execution, the durable state records the specialist as `running`. Because no startup reconciliation exists, `drivePipeline` flags this as an ambiguous unaccounted member (`needs_reconciliation`) and refuses to start any further specialists. The entire formation is deadlocked forever unless an engineer manually executes SQL queries to mutate `agent_streams`.

```
[Advisory File Reservations] ──> Check-Then-Act Window ──> Race on File Keys
                                                                 │
                                            Workaround: Serialized Execution
                                                                 │
                                              Multi-Specialist Latency 10x
```

3. **Concurrency Bottleneck Chain:**
   - _Premise:_ Parallel execution is a key value proposition of multi-agent architectures (specialists working concurrently across frontend, backend, and verifier).
   - _Inference:_ Because file reservations are advisory warnings rather than transactional locks, concurrent writes risk file clobbering.
   - _Failure:_ Rather than implementing transactional file leases, the pipeline runner applied a local monkey patch: serializing all specialist runs one-by-one. A stage designed for parallel acceleration is reduced to linear execution.

```
[Review REMEDIATE Decision] ──> Mistake Count++ ──> Consecutive Mistake Threshold (3)
                                                              │
                                                  Completion Gate Tripped
                                                              │
                                                   Task Execution Halted
```

4. **Completion Review Friction Chain:**
   - _Premise:_ `CriticalCompletionReview` is intended to objectively catch defects and guide the model through a 1+1 remediation cycle.
   - _Inference:_ The completion gate maintains a circuit breaker (`consecutiveMistakeCount`) designed to stop runaway loops.
   - _Failure:_ Treating a `REMEDIATE` review recommendation as an agent mistake links constructive architectural critique to error throttling. After 2-3 reviews, the circuit breaker trips, aborting completion even if all defects were resolved.

---

## 3. Caveats

1. **Host-Level Model Streaming:** All tested LLM streams were executed using mock generators (`guardedStream`) and canned chunks in Mocha. Live behaviour under volatile network socket drops (TCP reset during chunk transmission) was not directly observed in a live VS Code window.
2. **Multi-Root Workspace Anchoring:** `normalizeReservationPath` defaults to `process.cwd()`. In headless CI or CLI runs, this resolves to the repo root; in live multi-root VS Code sessions where the user opens multiple folders, path normalization requires explicit injection of `vscode.workspace.workspaceFolders`.
3. **OS-Specific Shell Integration:** Terminal heredoc and read policies were verified on macOS Darwin (`zsh`). While shell tokenization handles POSIX syntax, Windows `cmd.exe` or PowerShell command chains may have different redirection semantics.

---

## 4. Conclusion

`agentswarm` possesses a strong theoretical architecture (clear separation of concerns, bounded review, hierarchical deferral), but its durability is compromised by **reliance on localized monkey patches rather than durable systemic invariants**.

The most urgent hazards are:

1. **Silent data drops in `BufferedDbPool`** on non-retryable errors.
2. **5-minute shadow buffer work eviction**.
3. **Recurrence of the `selectOne` non-unique key anti-pattern** in `Orchestrator.ts`.
4. **Permanent formation deadlocks on extension restart** due to missing automated reconciliation.
5. **Sequential execution bottleneck** in parallel stages.

Addressing these requires structural hardening, not additional local workarounds.

---

## 5. Durable Remediation Strategy & Verification Method

### 5.1 Monkey Patches vs. Durable Architectural Hardening

| Failure Mode                       | Fragile Monkey Patch / Workaround                                                                                                     | Durable, Robust Architectural Fix                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Flush Type Reordering**          | Calling `await dbPool.flush()` manually before `push({ type: "delete" })` in specific callers (`Orchestrator.releaseFiles`).          | **Preserve Causal Order in `BufferedDbPool`**: Assign each `WriteOp` a monotonic sequence number `opSeq` on push; sort flush operations by `(TABLE_FK_ORDER, LAYER_PRIORITY, opSeq)` so updates and deletes for an entity execute in strict causal sequence.                                                                               |
| **Silent Flush Failure**           | Suppressing non-retryable errors in `BufferedDbPool.flush()` catch block without logging so background flushes don't crash the timer. | **Dead-Letter Logging & Transaction Rejection**: Log critical errors via `Logger.error`, reject the `flush()` promise to notifying awaiting callers, and persist poisoned ops into a dedicated `db_dead_letter_queue` table for diagnostic triage.                                                                                         |
| **Shadow Buffer Work Eviction**    | Fixed 5-minute timeout `cleanupShadows` purging in-memory shadows.                                                                    | **Lifecycle-Bound Shadow Buffers**: Tie shadow buffers directly to stream/task lifecycle (`beginWork` -> `completeStream`/`failStream`). Never discard uncommitted work based on wall-clock idle time; if memory pressure occurs, spill shadows to temporary disk WAL.                                                                     |
| **`selectOne` Stale Collisions**   | Using `selectOne("agent_memory", ...)` and checking `activeStreamIds.has(found.streamId)`.                                            | **Exhaustive Matching or Dedicated Index**: Replace `selectOne` in `Orchestrator.ts:807` and `1257` with `selectWhere` across all rows and filter by active streams, matching `LegionCoordinator.ts:1262`.                                                                                                                                 |
| **Orphaned Member Deadlock**       | Manual CLI intervention (Drill 1) calling `orchestrator.failStream(id)` or `resumeHierarchy` in debug console.                        | **Engine Startup & Lease Reconciliation**: On startup / extension activation, run an automated reconciliation pass: scan `agent_streams` for `status = 'active'` children with dead PIDs or expired host leases, mark them `status: "failed"` with reason `"Host terminated during execution"`, and transition formations to ready/failed. |
| **Parallel Stage Serialization**   | Running `readyToExecuteMembers[0]` sequentially in `LegionPipelineRunner`.                                                            | **Transactional File Locks & Concurrency Pool**: Implement atomic file reservation via conditional SQLite insertion (`INSERT INTO file_leases ... WHERE NOT EXISTS (...)`); allow specialists with disjoint leases to execute concurrently using `Promise.allSettled` bounded by `maxConcurrency`.                                         |
| **Completion Gate Trip on Review** | Decreasing mistake threshold or manual gate bypass.                                                                                   | **Review-Aware Gate Pipeline**: Decouple `CriticalCompletionReview` outcomes from `consecutiveMistakeCount`. Track review iterations exclusively within `CriticalReviewCycleState` and reserve mistake increments for unhandled agent errors.                                                                                              |
| **Abort Triggering Failovers**     | Relying on downstream callers to check `signal.aborted` after receiving `{ status: "failed", safeToRetry: true }`.                    | **Explicit Cancellation Sentinel**: Check `if (signal.aborted                                                                                                                                                                                                                                                                              |     | error.name === "AbortError")`in`LegionAgentHost.ts`catch block and return`{ status: "cancelled", safeToRetry: false }` immediately. |

---

### 5.2 Step-by-Step Durable Hardening Plan

1. **Step 1 (Persistence Hardening):**
   - Update `BufferedDbPool.ts`: add `opSeq: number` to `WriteOp`. Replace `(a.type as string).localeCompare(b.type as string)` with `opSeq` ordering.
   - In `BufferedDbPool.flush()` catch block: add structured logging `Logger.error("[DbPool] Non-retryable flush failure:", err)` and re-throw the error or capture it in a dead-letter log.
   - In `BufferedDbPool.cleanupShadows`: remove the hardcoded 5-minute eviction for active stream IDs.
2. **Step 2 (Orchestrator Reservation Hardening):**
   - In `Orchestrator.ts:807` and `Orchestrator.ts:1257`: replace `selectOne("agent_memory", { column: "key", value: "file_res:${normalizedPath}" })` with `selectWhere("agent_memory", { column: "key", value: "file_res:${normalizedPath}" })` and iterate through all holders matching active stream IDs.
3. **Step 3 (Lifecycle & Host Hardening):**
   - In `LegionAgentHost.ts`: add explicit check for `AbortError` / `signal.aborted` in the catch block to return `{ status: "cancelled", safeToRetry: false }`.
   - In `AttemptCompletionHandler.ts`: do not increment `consecutiveMistakeCount` when `criticalReviewReport.decision === "REMEDIATE"`.
4. **Step 4 (Startup Recovery Runner):**
   - Create `reconcileOrphanedLegionStreams(db)` in `Orchestrator.ts`, invoked during `Orchestrator.initialize()`. Auto-settle any stale active stream whose host lease has expired.

---

### 5.3 Verification Method

To independently verify the implementation and prove resilience against these failure modes:

1. **Execute Existing Test Suite Baseline:**

   ```bash
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
     src/integrations/terminal/__tests__/terminalFileReadPolicy.test.ts \
     src/core/task/tools/handlers/__tests__/ExecuteCommandToolHandler.approval.test.ts \
     src/hosts/vscode/terminal/VscodeTerminalProcess.test.ts \
     src/hosts/vscode/terminal/TerminalOutputDecoder.test.ts \
     src/hosts/vscode/terminal/VscodeTerminalLifecycle.test.ts
   ```

   _Expected outcome:_ All 332 tests pass cleanly.

2. **Add Regression Mutation Tests:**
   - Add test verifying that an `update` followed by a `delete` in the same buffered batch deletes the record in SQLite (proves `opSeq` ordering).
   - Add test verifying that a non-retryable constraint failure during `dbPool.flush()` rejects the returned Promise and logs the error.
   - Add test creating a stale inactive reservation row followed by an active reservation row; verify `Orchestrator.reserveFiles` detects the active conflict.
   - Add test verifying that `LegionAgentHost` aborted via `AbortSignal` returns `status: "cancelled"` and `safeToRetry: false`.
   - Add test simulating process restart with an active child stream; verify startup reconciliation transitions the stream to failed and releases reservations.

3. **Type-Check and Lint:**

   ```bash
   npm run check-types
   npm run lint
   ```

   _Expected outcome:_ 0 errors across TypeScript and Biome.
