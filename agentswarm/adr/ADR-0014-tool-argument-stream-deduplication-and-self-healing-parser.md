# ADR-0014 — Tool Argument Stream Deduplication, Self-Healing JSON Parser & Transport Circuit-Breaking

## Context

With [ADR-0012](ADR-0012-automatic-legion-default.md) and [ADR-0013](ADR-0013-orchestrator-conductor-tool-and-streaming-progress.md), Legion specialist agents execute multi-turn tool loops autonomously under `LegionAgentHost` using streaming provider transports (OpenAI Codex SSE/WebSocket, Responses API, OpenAI Native SSE). In practice, differences in how LLM provider streaming endpoints emit partial tool arguments led to a severe failure mode across tool execution:

1. **Delta Followed by Output Item Snapshot Concatenation:**
   Several model API endpoints (notably OpenAI Codex, OpenAI Native, and Responses API implementations) emit incremental chunks (`response.function_call_arguments.delta` or `response.tool_call_arguments.delta`) containing partial argument JSON, followed immediately by a terminal chunk (`response.output_item.done` or `response.function_call_arguments.done`) whose `arguments` property contains the *entire snapshot* rather than the terminal delta. When downstream consumers concatenated incoming chunks naively:
   ```text
   Delta 1: '{"path":'
   Delta 2: ' "."}'
   Done:    '{"path": "."}'
   Accumulated: '{"path": "."}{"path": "."}'
   ```
   This concatenation corrupted tool arguments into two adjacent JSON roots, causing `JSON.parse` to fail with:
   ```text
   SyntaxError: Unexpected non-whitespace character after JSON at position ...
   ```
2. **Interleaved Tool Calls in Streaming Providers:**
   When models emitted multiple tool calls in a single response or interleaved deltas across separate calls, the provider streams frequently emitted delta or done events lacking explicit function names or call IDs, or referencing temporary `item_id` values. If the provider had not mapped `item_id` to `call_id` and cached tool names, tool execution would fail with `missing tool name` or assign arguments to the wrong tool call.
3. **Fragile Parser State & Inability to Self-Heal:**
   In `StreamResponseHandler.ts`, `ToolUseHandler` relied on `JSONParser` from `@streamparser/json` during streaming and simple `JSON.parse(pending.input)` in `assertCompleteToolUses()`. When duplicate snapshots arrived, `JSON.parse` threw an unhandled `SyntaxError`, completely halting the tool call even though the argument payload was unambiguous and identical across both snapshots.
4. **Futile Specialist Failover Loops in `LegionAgentHost`:**
   When a specialist encountered a JSON parse error caused by stream snapshot concatenation, the host caught the error in its execution loop and returned `failed(errorMessage, true)` with `safeToRetry: true` by default. Under [ADR-0009](ADR-0009-legion-lifecycle-dag-failover-terminal-states.md), `LegionCoordinator` treated this failure as a transient failure, marked the specialist slot `"rerouted"`, and spawned a replacement specialist (Attempt 2). The replacement specialist executed against the exact same provider transport, received the identical duplicated streaming chunks, threw the identical `SyntaxError`, and failed again. This consumed double the token budget and wasted minutes of user time.

## Decisions

1. **Provider-Level Offset Tracking & Snapshot Slicing:**
   - In `openai-codex.ts`, `openai-native.ts`, and `responses_api_support.ts`, implemented `toolCallDelta(callId, args, snapshot = false)` with stateful offset tracking in `this.streamedText` / `streamedArgs`.
   - When a streaming delta arrives (`snapshot = false`), the raw delta is recorded and yielded directly.
   - When a snapshot done chunk arrives (`snapshot = true`, e.g. `output_item.done` or `function_call_arguments.done`):
     - If the incoming snapshot starts with the previously streamed text (`args.startsWith(previous)`), only the trailing unstreamed suffix is yielded (`args.slice(previous.length)`).
     - If the snapshot matches the accumulated text exactly, the delta is empty (`""`) and omitted, completely eliminating duplicate JSON emission at the provider layer.
   - Reset state maps (`pendingToolCallId`, `pendingToolCallName`, `toolCallIdByItemId`, `toolCallNameByItemId`, `toolCallNameByCallId`, `streamedText`) cleanly at the beginning of each request.

2. **Interleaved Tool Call Name & ID Maps:**
   - Across `openai-codex.ts` and `responses_api_support.ts`, added bidirectional tracking maps (`toolCallIdByItemId`, `toolCallNameByItemId`, `toolCallNameByCallId`, `functionCallByItemId`, `emittedCallIds`).
   - Ensures any subsequent delta or done event that supplies only `item_id` or `call_id` resolves its canonical tool name and call ID without loss, correctly separating interleaved tool calls.

3. **State-Machine JSON Root Extractor (`extractJsonRoots`):**
   - Implemented `extractJsonRoots(raw: string): ExtractedJsonResult` in `StreamResponseHandler.ts`.
   - Performs character-by-character scanning tracking structural depth (`depth`), string state (`inString`), escape characters (`escape`), nested objects/arrays, and string literals containing braces (e.g. `{"cmd": "awk '{print $1}'"}`).
   - Extracts all sequentially complete JSON root objects/arrays with exact character slice offsets (`startIndex`, `endIndex`, `raw`, `value`), preserving any unparsed remainder.
   - Added helper `extractFirstCompleteJsonRoot(raw: string)` for lightweight head extraction.

4. **Dual-Layer Self-Healing in `ToolUseHandler`:**
   - **Stream-Time Healing (`processToolUseDelta`):**
     - Slices delta if `inputDelta.startsWith(pending.input)`.
     - Uses `extractJsonRoots` and `deepEqual` (`fast-deep-equal`) to check if `inputDelta` is an identical complete JSON duplicate of `pending.input`. If so, drops `inputDelta` to `""`.
   - **Terminal-Time Healing (`assertCompleteToolUses`):**
     - If `JSON.parse` fails, extracts all complete JSON roots from `pending.input`.
     - If multiple roots exist with no trailing remainder (`roots.length > 1 && remainder.trim() === ""`) and all extracted roots are deeply equal (`roots.every(r => deepEqual(r.value, roots[0].value))`), self-heals by assigning the unified object to `pending.parsedInput` and `pending.input = roots[0].raw`.
     - Execution proceeds successfully without failing the tool call.

5. **Diagnostic Typing with `ToolArgumentError`:**
   - Replaced generic `Error` with `ToolArgumentError`:
     - `kind: "incomplete"` — Stream cut off mid-JSON (e.g. `Unexpected end of JSON`, unterminated strings, dangling braces/colons).
     - `kind: "concatenation"` — Non-identical complete JSON roots or complete root followed by trailing garbage.
     - `kind: "syntax"` — Invalid JSON tokens (e.g. unquoted identifiers, bad characters).
     - `kind: "invalid_format"` — Non-object or array root where object arguments are expected, or missing tool name.
   - Preserves `toolName` and `rawInput` for precise upstream triage.

6. **Transport Circuit-Breaking in `LegionAgentHost`:**
   - In `LegionAgentHost.execute`, inspected errors caught during the specialist loop:
     ```ts
     const isTransportError =
       (error instanceof ToolArgumentError && (error.kind === "concatenation" || error.kind === "syntax")) ||
       error instanceof SyntaxError ||
       (error instanceof Error &&
         (error.message.includes("concatenated tool call") ||
           error.message.includes("duplicate snapshot") ||
           error.message.includes("Unexpected token") ||
           error.message.includes("is not valid JSON") ||
           error.message.includes("JSON.parse")));
     ```
   - If `isTransportError` is true, returns:
     ```ts
     failed(`[Transport Error] Stream decoding failed: ${errorMessage}`, false);
     ```
   - **Crucial Invariant:** `safeToRetry: false`. Prevents `LegionCoordinator` from dispatching futile fallback specialists on stream transport corruption, stopping runaway failovers and preserving user token quotas.

## Consequences

- **Stream Hygiene:** Tool argument deltas are sliced at the source; providers never emit duplicate JSON arguments.
- **Resilience:** If network jitter, proxy re-chunking, or atypical provider behaviors still introduce duplicate snapshots, `StreamResponseHandler` self-heals the arguments seamlessly without manual retry.
- **Failover Economy:** Transport syntax errors and un-healable concatenation failures fail fast with `safeToRetry: false`, alerting the orchestrator immediately rather than burning a second specialist attempt.
- **Safety:** True malformed payloads (e.g. two completely different tool payloads merged together) are never guessed; they throw a typed `ToolArgumentError(kind: "concatenation")` and halt safely.

## Alternatives Considered

- *Full stream buffering until `done`:* Rejected because streaming tool call arguments allows live token progress and early validation.
- *Blind regex deduplication:* Rejected because regex cannot reliably match nested JSON braces or distinguish braces inside quoted string literals from structural syntax.
- *Always retrying on tool errors:* Rejected because stream encoding errors originate in transport or model output; retrying with identical prompts produces identical failures.

## Evidence

- Verified by unit tests in `src/core/api/__tests__/openai-codex.streaming.test.ts` (5 tests covering deduplication, slicing, unstreamed suffix, done without deltas, interleaved call names).
- Verified by unit tests in `src/core/task/__tests__/StreamResponseHandler.test.ts` (15 tests covering self-healing across identical snapshots, nested objects, braces in strings, whitespace/formatting variations, typed error diagnostics, and parser offset extraction).
- Verified by unit tests in `src/core/task/legion/__tests__/LegionAgentHost.test.ts` (2 tests covering transport error circuit-breaking with `safeToRetry: false` and seamless snapshot healing).
- All 50 targeted streaming/host tests and 190 Agent Swarm auxiliary/legion tests pass with 0 errors.

