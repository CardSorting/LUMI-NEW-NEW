# Task Assignment: Milestone 3 Remediation Worker (Iteration 2)

**Timestamp:** 2026-11-04T21:33:00Z  
**Worker:** `teamwork_worker_m3_iter2`  
**Working Directory:** `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_worker_m3_iter2/`  
**Target Workspace:** `/Users/bozoegg/Downloads/LUMI`  
**Orchestrator ID:** `5a83290e-eac1-48cd-9057-d64900999e6d`

---

## Mandatory Prerequisites

1. Read `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/ORIGINAL_REQUEST.md`
2. Read `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/PROJECT.md`
3. Read the three explorer handoff reports:
   - `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_explorer_m3_iter2_1/handoff.md` (Typecheck TS2345 fix)
   - `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_explorer_m3_iter2_2/handoff.md` (Test runner hang fix & timer unref)
   - `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_explorer_m3_iter2_3/handoff.md` (Workspace hygiene & verification integrity)
4. Read the Forensic Auditor report from Iteration 1:
   - `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_auditor_m3/handoff.md`

---

## Exclusive Write Ownership

You own and may edit ONLY the following files:

- `src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts`
- `src/infrastructure/db/BufferedDbPool.ts`
- `package.json`
- `src/infrastructure/ai/__tests__/Orchestrator.test.ts`
- You may delete `tests/challenger_m3_empirical.test.ts` and stage `scripts/check-agentswarm-docs.mjs`.

DO NOT touch any other source files.

---

## Exact Implementation Instructions

### 1. Fix TS2345 in `AttemptCompletionHandler.execution.test.ts`

In `src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts`:

- Import `pipeline` from `"../../completionGatePipeline"` (already present) and `CriticalCompletionReviewReport` from `@/infrastructure/ai/CriticalCompletionReview`.
- Change `sinon.stub(completion, "evaluateOptionalCriticalCompletionReview")` to `sinon.stub(pipeline, "evaluateOptionalCriticalCompletionReview")` on lines 272 and 285.
- Create a typed factory function `createMockReviewReport(...)` returning a fully-formed `CriticalCompletionReviewReport` so that NO `as any` type casting or `@ts-ignore` is used.
- Ensure the two unit tests pass when executed under Mocha.

### 2. Fix Unreferenced Timer in `BufferedDbPool.ts`

In `src/infrastructure/db/BufferedDbPool.ts`:

- In `scheduleFlush(delay: number)` around line 163, add:

  ```ts
  this.flushTimeout?.unref?.()
  ```

  This ensures background maintenance flush timeouts never pin Node's event loop in test, CLI, or child process environments.

### 3. Add `--exit` to `test:swarm` in `package.json`

In `package.json` around line 557:

- Add `--exit` to the `"test:swarm"` script:

  ```json
  "test:swarm": "cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha --exit --no-config --timeout 20000 -r ts-node/register -r tsconfig-paths/register -r ./src/test/requires.cjs src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts src/infrastructure/ai/__tests__/Orchestrator.test.ts \"src/core/task/legion/__tests__/*.test.ts\" ...",
  ```

  This restores parity with `.mocharc.json:14` (`"exit": true`).

### 4. Patch `clearShadow` and `flush` in `Orchestrator.test.ts`

In `src/infrastructure/ai/__tests__/Orchestrator.test.ts`:

- Update `withPatchedDbPool` to include `clearShadow` and `flush` in `DbPoolPatch` so Test 17 does not leak invocations to the unmocked `dbPool` singleton.
- Add an `after` hook at the end of `describe("AgentOrchestrator audit ergonomics", ...)`:

  ```ts
  after(async () => {
      await dbPool.stop()
  })
  ```

### 5. Workspace Cleanliness

- Delete the untracked challenger scratch file:
  `rm tests/challenger_m3_empirical.test.ts`
- Stage `scripts/check-agentswarm-docs.mjs` in git:
  `git add scripts/check-agentswarm-docs.mjs`

### 6. Full Authentic Verification

Execute ALL four verification commands and include their verbatim outputs in your handoff report:

1. `npm run check-types` -> MUST exit 0 with 0 errors across all projects.
2. `npm run lint` -> MUST exit 0 with 0 errors.
3. `npm run test:swarm` -> MUST execute 338 tests and exit cleanly in ~2 seconds (no hang).
4. `npm run docs:check-agentswarm` -> MUST exit 0 (68 files, 432 links).

---

## MANDATORY INTEGRITY WARNING

DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.
