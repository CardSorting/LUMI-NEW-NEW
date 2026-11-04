# PM-015 — Tool Argument Snapshot Concatenation and Stream Decoding Failover Loop

| Field | Value |
|---|---|
| Incident date | 2026-11-04 |
| Severity | High (tool execution failure; duplicate JSON corruption; futile specialist failover loop) |
| Affected components | `src/core/api/providers/openai-codex.ts`, `src/core/api/providers/openai-native.ts`, `src/core/api/utils/responses_api_support.ts`, `src/core/task/StreamResponseHandler.ts`, `src/core/task/legion/LegionAgentHost.ts` |
| First failing test | `src/core/api/__tests__/openai-codex.streaming.test.ts`, `src/core/task/__tests__/StreamResponseHandler.test.ts`, `src/core/task/legion/__tests__/LegionAgentHost.test.ts` |
| Fixed in | `src/core/api/providers/openai-codex.ts`, `src/core/api/providers/openai-native.ts`, `src/core/api/utils/responses_api_support.ts`, `src/core/task/StreamResponseHandler.ts`, `src/core/task/legion/LegionAgentHost.ts` |
| Related ADRs | [ADR-0009](../adr/ADR-0009-legion-lifecycle-dag-failover-terminal-states.md), [ADR-0012](../adr/ADR-0012-automatic-legion-default.md), [ADR-0014](../adr/ADR-0014-tool-argument-stream-deduplication-and-self-healing-parser.md) |

---

## 1. Summary

During streaming tool execution with OpenAI Codex and Responses API-compatible providers, specialists encountered abrupt tool call failures with JSON syntax errors:
```text
SyntaxError: Unexpected non-whitespace character after JSON at position 15 (line 1 column 16)
```
Inspection of the accumulated arguments revealed that providers yielded incremental streaming deltas (e.g. `{"path": "."}`) followed immediately by a terminal `output_item.done` or `function_call_arguments.done` chunk containing the entire argument snapshot. Naive chunk accumulation produced duplicated concatenated JSON strings:
```json
{"path": "."}{"path": "."}
```
Furthermore, when `LegionAgentHost` encountered this syntax error, it failed the specialist with default `safeToRetry: true`. This triggered ADR-0009 bounded failover in `LegionCoordinator`, immediately dispatching a replacement specialist (Attempt 2). Because the replacement specialist executed against the identical provider endpoint with identical stream characteristics, it experienced the exact same failure, wasting model quota, inflating latency, and ultimately aborting the formation.

In addition, interleaved tool calls in multi-tool responses frequently caused name attribution errors because `name` fields were omitted on subsequent chunk events or only referenced by temporary `item_id`.

## 2. Root Cause

1. **Provider Delta vs. Snapshot Mismatch:** Streaming handlers in `openai-codex.ts`, `openai-native.ts`, and `responses_api_support.ts` yielded both delta arguments and `output_item.done` arguments without calculating stream offset deltas or verifying whether the terminal chunk was a snapshot duplicate.
2. **Missing Interleaved Tool Identity Maps:** When multiple tool calls were yielded in a single stream turn, providers lacked mapping between `item_id`, `call_id`, and `name`. When done events arrived without `name`, providers fell back to undefined or stale pending call IDs.
3. **Fragile Single-Root JSON Parser in `StreamResponseHandler`:** `ToolUseHandler.assertCompleteToolUses` executed a raw `JSON.parse` across accumulated `pending.input`. If the stream contained identical duplicate snapshots, the parser failed catastrophically instead of self-healing the duplicated root.
4. **Indiscriminate Failover on Transport Errors:** `LegionAgentHost` did not distinguish between logical task failures (which can be retried by a fallback specialist) and transport stream decoding / syntax errors (which will predictably recur on retry). It marked all uncaught errors with `safeToRetry: true`.

## 3. The Fix

1. **Offset-Based Tool Argument Slicing in Providers:**
   - In `openai-codex.ts`, `openai-native.ts`, and `responses_api_support.ts`, implemented `toolCallDelta(callId, args, snapshot = false)`.
   - Incoming done snapshots are checked against previously streamed text (`args.startsWith(previous)`): only unstreamed suffixes are yielded, and identical duplicates are suppressed (`delta = ""`).
2. **Bidirectional Tool Call Name and Item ID Tracking:**
   - Added `toolCallIdByItemId`, `toolCallNameByItemId`, and `toolCallNameByCallId` maps to resolve tool names and call IDs across interleaved events.
3. **State-Machine Parser & Self-Healing in `StreamResponseHandler`:**
   - Implemented `extractJsonRoots(raw: string)` capable of parsing multiple root objects while properly tracking nested braces, brackets, quotes, and escaped characters.
   - Added stream-time deduplication in `processToolUseDelta` and terminal-time self-healing in `assertCompleteToolUses`: if all extracted roots are identical (`deepEqual`), the first root is accepted and execution proceeds without error.
   - Introduced typed `ToolArgumentError` with diagnostic kinds: `"incomplete"`, `"concatenation"`, `"syntax"`, and `"invalid_format"`.
4. **Transport Circuit-Breaking in `LegionAgentHost`:**
   - Added `isTransportError` inspection for `ToolArgumentError(concatenation | syntax)`, `SyntaxError`, and stream decoding failures.
   - Transport failures now return `failed('[Transport Error] Stream decoding failed: ...', false)` with `safeToRetry: false`, circuit-breaking futile failover attempts.

## 4. Prevention Now in Place

1. **Codex Streaming Test Suite:** `src/core/api/__tests__/openai-codex.streaming.test.ts` validates that deltas followed by `output_item.done`, suffix slicing, and interleaved tool calls produce valid non-duplicated tool arguments.
2. **Response Handler Test Suite:** `src/core/task/__tests__/StreamResponseHandler.test.ts` explicitly tests snapshot deduplication, nested objects, strings containing braces (`awk '{print $1}'`), formatting variations, and typed error classifications.
3. **Host Circuit-Breaker Test Suite:** `src/core/task/legion/__tests__/LegionAgentHost.test.ts` asserts that transport decoding errors result in `safeToRetry: false` and that duplicate snapshots heal seamlessly during specialist execution.

