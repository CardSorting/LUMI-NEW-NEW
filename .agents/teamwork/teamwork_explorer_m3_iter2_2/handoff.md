# Milestone 3 Remediation (Iteration 2): Test Runner Process Hang & Timer Lifecycle Investigation

**Agent:** Explorer 2 (`teamwork_explorer_m3_iter2_2`)  
**Target:** Milestone 3 Remediation (System Failure Modes, Persistence & Durable Hardening)  
**Workspace:** `/Users/bozoegg/Downloads/LUMI`  
**Date:** 2026-11-04

---

## Executive Summary

An exhaustive empirical investigation was conducted into why `npm run test:swarm` hangs indefinitely when executed without `--exit`.

The exact defect mechanism was traced:

1. Out of 338 tests across 14 test files in `test:swarm`, **a single test in a single file** causes the process hang: Test 17 in `src/infrastructure/ai/__tests__/Orchestrator.test.ts` ("reconciles orphaned child streams from prior crashed sessions on initialize or warmup").
2. Test 17 calls `orchestrator.reconcileOrphanedStreams()`, which invokes `dbPool.clearShadow(stream.id)`. Because `clearShadow` was omitted from the test fixture's `withPatchedDbPool`, it invoked the real `dbPool` singleton.
3. `clearShadow` calls `this.ensureStarted()`, initiating `startFlushLoop()`.
4. While `startFlushLoop()` called `this.flushInterval.unref?.()` and `this.cleanupInterval.unref?.()`, it calls `this.scheduleFlush(1000)`. In `scheduleFlush(delay)` (`BufferedDbPool.ts:139–164`), `this.flushTimeout = setTimeout(...)` is scheduled as a standard, **referenced** Node.js timer without calling `this.flushTimeout?.unref?.()`.
5. Every 1000ms, `flushInterval` ticks and calls `this.scheduleFlush(1000)`, scheduling a new referenced `setTimeout` every single second, perpetually pinning Node's event loop.
6. Furthermore, `package.json:557` defines `"test:swarm"` with `--no-config`, which intentionally bypassed `.mocharc.json`'s file glob but unintentionally stripped `.mocharc.json`'s `"exit": true`.

**Core Remediation Recommendation:**  
A durable, defense-in-depth fix must be applied:

1. **`BufferedDbPool.ts`:** Call `this.flushTimeout?.unref?.()` in `scheduleFlush()`. Background maintenance timers must never pin Node's event loop in tests, CLI utilities, worker threads, or extension host environments.
2. **`package.json`:** Add `--exit` to `test:swarm` script (restoring parity with repository-wide `.mocharc.json:14`).
3. **`Orchestrator.test.ts`:** Add `clearShadow` and `flush` to `withPatchedDbPool` and add an `after(async () => { await dbPool.stop() })` teardown hook.
4. **`AttemptCompletionHandler.execution.test.ts`:** Change `sinon.stub(completion, ...)` to `sinon.stub(pipeline, ...)` to eliminate the blocking `TS2345` compiler error and restore `npm run check-types` to 0 errors.

---

## 1. Observation

### 1.1 Root Cause Isolation in Swarm Test Suite

Executing the test suites in `npm run test:swarm` individually without `--exit` isolated the defect:

| Test Target                                | Files / Tests       | Execution Result Without `--exit`                                                   |
| ------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------- |
| `AgentSwarmAuxiliary.test.ts`              | 1 file, 52 tests    | Exited with code `0` in 915ms (calls `dbPool.stop()` in `withRealSqlite` & `after`) |
| `src/core/task/legion/__tests__/*.test.ts` | 5 files, 56 tests   | Exited with code `0` in 738ms                                                       |
| Remaining 11 test suites                   | 11 files, 213 tests | Exited with code `0` in 402ms                                                       |
| `Orchestrator.test.ts` (Tests 1–16)        | 1 file, 16 tests    | Exited with code `0` in 45ms                                                        |
| `Orchestrator.test.ts` (Test 17 only)      | 1 file, 1 test      | **HANGS INDEFINITELY** after printing `1 passing (7ms)`                             |

### 1.2 Inspection of Active Resources via Node Internal Diagnostics

Using programmatic Mocha invocation with `process.getActiveResourcesInfo()` and handle reflection on `Orchestrator.test.ts`:

- **Active Resources:**

  ```text
  [ 'TTYWrap', 'TTYWrap', 'TTYWrap', 'Timeout' ]
  ```

  (`TTYWrap` represents `stdin`, `stdout`, and `stderr`. Exactly one active `Timeout` pins the event loop).
- **Timer Inspection on `dbPool` Singleton:**

  ```text
  dbPool.flushTimeout exists? true
  dbPool.flushTimeout hasRef? true
  dbPool.flushInterval hasRef? false
  dbPool.cleanupInterval hasRef? false
  ```
- **Finding:** `dbPool.flushInterval` and `dbPool.cleanupInterval` are correctly unreferenced (`hasRef? false`). However, `dbPool.flushTimeout` is referenced (`hasRef? true`).

### 1.3 Code Inspection: `BufferedDbPool.ts:123–178`

In `src/infrastructure/db/BufferedDbPool.ts`:

```ts
123: 	private flushTimeout: NodeJS.Timeout | null = null
124: 	private currentFlushDelay: number | null = null
125: 
126: 	/**
127: 	 * Adaptive flush scheduling.
128: 	 */
129: 	private scheduleFlush(delay = 10) {
130: 		if (this.stopped) return
131: 		if (this.flushTimeout) {
132: 			if (this.currentFlushDelay !== null && this.currentFlushDelay <= delay) {
133: 				return
134: 			}
135: 			clearTimeout(this.flushTimeout)
136: 		}
137: 
138: 		this.currentFlushDelay = delay
139: 		this.flushTimeout = setTimeout(async () => {
140: 			this.currentFlushDelay = null
141: 			this.flushTimeout = null
142: 			try {
143: 				await this.flush()
144: 			} catch (flushErr) {
145: 				Logger.error("[DbPool] Background scheduled flush error:", flushErr)
146: 			} finally {
147: 				const release = await this.stateMutex.acquire()
148: 				try {
149: 					let hasData = false
150: 					for (const ops of this.activeBuffer.values()) {
151: 						if (ops.length > 0) {
152: 							hasData = true
153: 							break
154: 						}
155: 					}
156: 					if (hasData) {
157: 						this.scheduleFlush(10)
158: 					}
159: 				} finally {
160: 					release()
161: 				}
162: 			}
163: 		}, delay)
164: 	}
165: 
166: 	private cleanupInterval: NodeJS.Timeout | null = null
167: 
168: 	private startFlushLoop() {
169: 		if (this.started) return
170: 		this.started = true
171: 		this.stopped = false
172: 		this.scheduleFlush(1000)
173: 		this.flushInterval = setInterval(() => this.scheduleFlush(1000), 1000)
174: 		this.cleanupInterval = setInterval(() => this.cleanupShadows(), 30000)
175: 		this.flushInterval.unref?.()
176: 		this.cleanupInterval.unref?.()
177: 	}
```

- Line 175 calls `this.flushInterval.unref?.()`.
- Line 176 calls `this.cleanupInterval.unref?.()`.
- But lines 139–164 schedule `this.flushTimeout = setTimeout(...)` without calling `this.flushTimeout?.unref?.()`.
- Line 173's interval callback invokes `this.scheduleFlush(1000)` every 1000ms.
- Every second, a new referenced `flushTimeout` is registered with Node's event loop, making the `.unref?.()` calls on lines 175 and 176 ineffective.

### 1.4 Code Inspection: `Orchestrator.ts` and `Orchestrator.test.ts`

- In `src/infrastructure/ai/Orchestrator.ts:1404–1433`:

  ```ts
  public async reconcileOrphanedStreams(reason = "Host terminated during execution"): Promise<number> {
      ...
      for (const stream of staleChildStreams) {
          ...
          await this.failStream(stream.id, reason, { skipFailover: true })
          await dbPool.clearShadow(stream.id).catch(() => null)
          reconciledCount++
      }
      await dbPool.flush()
      return reconciledCount
  }
  ```
- In `src/infrastructure/ai/Orchestrator.ts:1138` (`failStream`):

  ```ts
  await dbPool.clearShadow(streamId).catch(() => null)
  ```
- In `src/infrastructure/db/BufferedDbPool.ts:414–416`:

  ```ts
  public async clearShadow(agentId: string) {
      this.ensureStarted()
      ...
  ```
- In `src/infrastructure/ai/__tests__/Orchestrator.test.ts:8–15`:
  `withPatchedDbPool` only patched:
  `selectOne`, `selectWhere`, `selectAllFrom`, `push`, `pushBatch`, `commitWork`.
  It did **not** patch `clearShadow` or `flush`.
- When Test 17 executed `orchestrator.reconcileOrphanedStreams()`, it called `dbPool.clearShadow("stream-orphaned-child")` on the real unmocked `dbPool` singleton, triggering `this.ensureStarted()` and waking up the flush loop. No `after` teardown hook existed in `Orchestrator.test.ts` to call `await dbPool.stop()`.

### 1.5 Code Inspection: `package.json` vs `.mocharc.json`

- In `.mocharc.json:14`:

  ```json
  {
      "extension": ["ts"],
      "spec": ["src/**/__tests__/*.ts"],
      "require": ["ts-node/register", "tsconfig-paths/register", "./src/test/requires.cjs"],
      "recursive": true,
      "exit": true,
      "timeout": 10000
  }
  ```
- In `package.json:556–557`:

  ```json
  "test:unit": "cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha",
  "test:swarm": "cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha --no-config --timeout 20000 -r ts-node/register -r tsconfig-paths/register -r ./src/test/requires.cjs src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts src/infrastructure/ai/__tests__/Orchestrator.test.ts \"src/core/task/legion/__tests__/*.test.ts\" ...",
  ```
- `test:unit` does not use `--no-config`, so it inherits `"exit": true` from `.mocharc.json`.
- `test:swarm` specifies `--no-config` to override the default spec glob `src/**/__tests__/*.ts`, but omitted `--exit`.

### 1.6 Empirical Proof of Fix

A diagnostic monkeypatch was executed:

```js
const { BufferedDbPool } = require("./src/infrastructure/db/BufferedDbPool")
const orig = BufferedDbPool.prototype.scheduleFlush
BufferedDbPool.prototype.scheduleFlush = function (...args) {
	orig.apply(this, args)
	if (this.flushTimeout) this.flushTimeout.unref()
}
```
Results:

1. `Orchestrator.test.ts` ran all 17 tests and **exited with code 0 in 49ms** without hanging.
2. The entire swarm suite (`test:swarm` across all 18 test files) ran all 338 tests and **exited with code 0 in 2.1s** without hanging.

---

## 2. Logic Chain

1. **Intended Architecture of `BufferedDbPool`:**
   - Observations 1.3 show that `BufferedDbPool.ts` explicitly called `.unref?.()` on `flushInterval` and `cleanupInterval`. The architectural intent was that background maintenance tasks should run passively and never pin Node.js's event loop.
2. **Identification of Incomplete Implementation:**
   - In Node.js, an interval calling a referenced `setTimeout` keeps the event loop alive just as effectively as a referenced `setInterval`. Because `scheduleFlush` creates `this.flushTimeout` without calling `.unref?.()`, the interval continuously regenerates an active reference on the event loop.
3. **Trigger Mechanism in Test Suite:**
   - In `Orchestrator.test.ts`, Test 17 tested orphaned stream reconciliation (F18). Because `clearShadow` was unmocked in `withPatchedDbPool`, calling `reconcileOrphanedStreams()` invoked `dbPool.clearShadow()` on the real singleton, calling `ensureStarted()`.
   - In `AgentSwarmAuxiliary.test.ts`, tests that touched `dbPool` wrapped execution in `withRealSqlite` which cleanly called `await dbPool.stop()` in `finally`. `Orchestrator.test.ts` lacked an `after` hook, leaving the timer loop running.
4. **Configuration Discrepancy in `package.json`:**
   - `.mocharc.json` establishes `"exit": true` as the repository convention for Mocha.
   - Passing `--no-config` in `test:swarm` disabled `.mocharc.json` in order to select specific test files, but failed to re-specify `--exit`.
5. **Necessity of Both Remediations (Defense-in-Depth):**
   - Unreferencing `flushTimeout` in `BufferedDbPool.ts` fixes the timer leak at the storage layer, ensuring CLI tools, worker scripts, and any future test files do not hang.
   - Including `--exit` in `package.json` aligns `test:swarm` with `.mocharc.json`, protecting the test runner against external open sockets or terminal processes.

---

## 3. Caveats

1. In Node.js, calling `timeout.unref()` allows the event loop to exit if that timer is the only remaining scheduled event. It does **not** stop the timer from firing while the event loop is active. Therefore, flushes will continue to execute on schedule during active processing.
2. If code pushes data to `BufferedDbPool` without awaiting `flush()`, and no other async tasks are pending, an unreferenced timer means Node could exit before the 10ms flush timeout expires. However, callers in CLI scripts, tests, and shutdown hooks already explicitly invoke `await dbPool.flush()` or `await dbPool.stop()`.
3. In `Orchestrator.test.ts`, `withPatchedDbPool` is designed as a mock boundary; patching `clearShadow` and `flush` provides proper unit test isolation.

---

## 4. Conclusion

### Direct Answers to Scope Questions:

1. **Should `BufferedDbPool.ts` unreference `this.flushTimeout` so background timers never pin Node's event loop in test or CLI environments?**  
   **YES.** This completes the intended timer unreferencing already partially implemented on lines 175–176. It prevents `BufferedDbPool` from hanging any Node process (tests, scripts, or extension host) when idle.

2. **Should `package.json`'s `test:swarm` script include `--exit` to prevent un-closed external test sockets/resources from hanging mocha?**  
   **YES.** This restores repository parity with `.mocharc.json:14` (`"exit": true`), ensuring multi-agent terminal and streaming integration tests never block CI.

---

### Actionable Remediation Strategy for Worker M3:

#### Fix 1: Unreference `this.flushTimeout` in `BufferedDbPool.ts`

**File:** `/Users/bozoegg/Downloads/LUMI/src/infrastructure/db/BufferedDbPool.ts:163`

```ts
<<<< BEFORE
		}, delay)
	}
====
		}, delay)
		this.flushTimeout?.unref?.()
	}
>>>> AFTER
```

#### Fix 2: Add `--exit` to `test:swarm` in `package.json`

**File:** `/Users/bozoegg/Downloads/LUMI/package.json:557`

```json
<<<< BEFORE
		"test:swarm": "cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha --no-config --timeout 20000 -r ts-node/register -r tsconfig-paths/register -r ./src/test/requires.cjs src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts src/infrastructure/ai/__tests__/Orchestrator.test.ts \"src/core/task/legion/__tests__/*.test.ts\" ...",
====
		"test:swarm": "cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha --exit --no-config --timeout 20000 -r ts-node/register -r tsconfig-paths/register -r ./src/test/requires.cjs src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts src/infrastructure/ai/__tests__/Orchestrator.test.ts \"src/core/task/legion/__tests__/*.test.ts\" ...",
>>>> AFTER
```

#### Fix 3: Patch `clearShadow` and Add Teardown Hook in `Orchestrator.test.ts`

**File:** `/Users/bozoegg/Downloads/LUMI/src/infrastructure/ai/__tests__/Orchestrator.test.ts`

1. In `type DbPoolPatch` (line 15):
   Add `clearShadow: (agentId: string) => Promise<void>` and `flush: () => Promise<void>`.
2. In `withPatchedDbPool` (lines 17–45):
   Save and restore `clearShadow` and `flush`.
3. Add an `after` hook at the end of `describe("AgentOrchestrator audit ergonomics", ...)`:

   ```ts
   after(async () => {
       await dbPool.stop()
   })
   ```

#### Fix 4: Fix Compiler Error `TS2345` in `AttemptCompletionHandler.execution.test.ts`

**File:** `/Users/bozoegg/Downloads/LUMI/src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts:272, 285`

```ts
<<<< BEFORE (Line 272 & 285)
		sinon.stub(completion, "evaluateOptionalCriticalCompletionReview").resolves({
====
		sinon.stub(pipeline, "evaluateOptionalCriticalCompletionReview").resolves({
>>>> AFTER
```

---

## 5. Verification Method

To independently verify the defects and validate the remediations:

1. **Verify TypeScript Compilation Failure (Defect 1):**

   ```bash
   npm run check-types
   ```

   _Expected Current Failure:_ Exits with code `2`, 2 type errors in `AttemptCompletionHandler.execution.test.ts:272, 285`.

2. **Verify Hanging Test Suite Without `--exit` (Defect 2):**

   ```bash
   npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha --no-config --timeout 20000 -r ts-node/register -r tsconfig-paths/register -r ./src/test/requires.cjs src/infrastructure/ai/__tests__/Orchestrator.test.ts --grep "reconciles orphaned child streams"
   ```

   _Expected Current Outcome:_ Prints `1 passing (7ms)` and hangs indefinitely until manually killed.

3. **Verify Clean Swarm Tests With `--exit`:**

   ```bash
   npm run test:swarm -- --exit
   ```

   _Expected Outcome:_ Exits with code `0`, 338 passing tests in ~2 seconds.

4. **Verify Linter Hygiene:**

   ```bash
   npm run lint
   ```

   _Expected Outcome:_ Exits with code `0`, 0 errors across 1770 files.
