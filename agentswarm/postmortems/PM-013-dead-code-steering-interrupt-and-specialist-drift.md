# PM-013 — Dead-Code Steering Interrupt and Specialist Context Drift on Follow-Up Turns

| Field | Value |
|---|---|
| Incident date | 2026-11-03 |
| Severity | High (loss of user steering control during autonomous execution; context corruption on multi-turn resumes) |
| Affected components | `src/core/task/index.ts`, `src/core/task/legion/` |
| First failing test | `src/core/task/legion/__tests__/TaskLegion.test.ts` ("interrupts an active specialist pipeline when new steering arrives") |
| Fixed in | `src/core/task/index.ts` |
| Related ADRs | [ADR-0009](../adr/ADR-0009-legion-lifecycle-dag-failover-terminal-states.md), [ADR-0012](../adr/ADR-0012-automatic-legion-default.md) |

---

## 1. Summary

During automatic Legion coordination in `Task.ts`, when specialists were dispatched via `maybeRunAutomaticLegion`, any incoming user message or steering input in chat was ignored because `shouldAcceptSteeringInterrupt` only checked `this.taskState.isStreaming || this.taskState.isWaitingForFirstChunk`. Since the parent agent loop had not yet started streaming, `shouldAcceptSteeringInterrupt` returned `false`, leaving `this.activeLegionController?.abort()` dead code.

Furthermore, when a task completed specialist execution and the user subsequently submitted follow-up feedback on Turn 2, `withLegionContext` used `findLastIndex` to locate the user message, pinning the `<specialist_handoff>` block to the *newest* steering message instead of the initial user objective that the specialists had actually resolved.

## 2. Reproduction

1. Start a task with an objective requiring specialist coordination.
2. While `maybeRunAutomaticLegion` is coordinating specialist stages (`isStreaming: false`), submit a steering interrupt in chat.
3. Observe: `shouldAcceptSteeringInterrupt` returns `false`, `this.activeLegionController?.abort()` is never called, and specialist stages continue executing.
4. On follow-up turn: provide additional guidance.
5. Observe: `<specialist_handoff>` is prepended to the follow-up guidance rather than the initial task prompt.

## 3. Root Cause

1. **Dead Code Condition:** `shouldAcceptSteeringInterrupt` was designed around parent LLM streaming. While `activeLegionController` was running in the background, `isStreaming` was `false`.
2. **Backwards Search in Handoff Injection:** `withLegionContext` used `findLastIndex` to search backwards from the end of the history array, which targets the latest user message rather than the root objective prompt.

## 4. Fix

1. **Steering Condition Update:** In `handleWebviewAskResponse`, pass `isStreaming: this.taskState.isStreaming || !!this.activeLegionController` to `shouldAcceptSteeringInterrupt`. When steering is accepted, call `this.activeLegionController?.abort()`.
2. **Pinned Objective Search:** In `withLegionContext`, search forwards for the user message matching `this.legionObjective` (or the first non-tool user message), ensuring handoff text remains anchored to the resolved objective.

## 5. Prevention

- Added integration tests in `TaskLegion.test.ts` verifying that steering interrupts abort `activeLegionController` when `isStreaming` is `false`.
- Added multi-turn conversation tests asserting that follow-up user messages do not receive `<specialist_handoff>` blocks.

