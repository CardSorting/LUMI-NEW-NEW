---
title: "Working with Sub-agents"
sidebarTitle: "Sub-agents"
description: "How LUMI delegates work via use_subagents and the subagent runtime."
---

# Working with Sub-agents

LUMI can spawn **subagents** — isolated agent runs with their own prompts, tools, and optional model configuration — through the `use_subagents` tool and dynamic subagent tool names.

## Code map

| Component | Path |
|-----------|------|
| Tool entry | `use_subagents` → `SubagentToolHandler` |
| Runner | `src/core/task/tools/subagent/SubagentRunner.ts` |
| Config loader | `src/core/task/tools/subagent/AgentConfigLoader.ts` |
| Builder | `src/core/task/tools/subagent/SubagentBuilder.ts` |
| Dynamic tool names | `src/core/task/tools/subagent/SubagentToolName.ts` |
| Swarm consensus | `src/core/task/tools/subagent/SwarmConsensusHandler.ts` |
| Orchestrator metadata | `src/infrastructure/ai/Orchestrator.ts` |

`ToolExecutorCoordinator` registers static tools from `DietCodeDefaultTool` and **dynamic subagent handlers** loaded at runtime.

## How it works

1. The main `Task` calls `use_subagents` with agent type(s) and prompts.
2. `SubagentBuilder` constructs a child task with inherited or overridden API configuration (`buildApiHandler`).
3. `SubagentRunner` executes the child loop with scoped tools.
4. Results return to the parent task as tool output; shared memory tools (`mem_append_shared`, `mem_get_shared`, `mem_claim`, `mem_release`) coordinate cross-agent state.

## Agent types

Subagent configs can specify types such as `worker`, `verifier`, and `researcher` (see `Orchestrator` task traces). Each type can carry different tool allowlists and completion gates (`subagentCompletionGates.ts`).

## User-facing usage

- Enable subagents in settings when exposed in the webview.
- Ask LUMI to delegate research or verification explicitly.
- Monitor subagent messages in the chat timeline like any other tool call.

## Progress and recovery

The helper row distinguishes an assignment being prepared, a request awaiting approval, and work queued for an available execution slot. Once dispatched, each helper shows its current operation and target, streamed public updates, prominent elapsed time, time in the current step, and changed files. The last three activity events are visible immediately; **Activity history** retains up to 60 events with timestamps and an explicit omitted count. **Tool results** retains eight calls, bounded result previews, and whether each returned, failed, or has an unconfirmed outcome. A returned tool result does not imply that a background command has finished. Helper-owned command output is sampled every three seconds without consuming output or rerunning the command. Previews retain at most the latest 4,000 characters; they are not a complete session transcript. Private reasoning and XML tool payloads are excluded from the public preview.

**Runtime check-in** and **Activity** are different clocks. A three-second check-in confirms that the extension's observer is responding; it does not prove the provider, a subprocess, or a tool is making progress. No new activity for 30 seconds produces a quiet-operation notice. Check-ins absent for 12 seconds produce an updates-delayed notice and replace the animated running icon. These are observation thresholds, not automatic failure declarations. Provider chunk/byte counts are actual received activity, not a completion percentage. Queue position, retry countdowns and wait deadlines explain why work has not moved. Required execution-policy/file-coordination checks stop safely after 60 seconds; completion validation has a 180-second deadline. Neither timeout bypasses validation or repeats a mutation.

Live helper rows use task-scoped, revisioned partial delivery independently of full-state auth/settings refreshes and conversation persistence. Reordered updates cannot roll back an existing newer row or revive completed work. Slow consumers are bounded; history writes are coalesced to once per second, with terminal updates bypassing the delay. New execution evidence remains durable immediately; unchanged telemetry does not repeatedly flush recovery receipts. Errors stay visible, and **Show output** opens a completed result or explicitly labeled partial work. A failed helper does not prevent queued independent assignments from running.

The in-context activity trail, expandable output and step timing follow familiar [GitHub Actions monitoring](https://docs.github.com/en/actions/how-tos/monitor-workflows?tool=cli) patterns. Restrained progress indicators and explicit phase messages follow [VS Code's progress UX guidance](https://code.visualstudio.com/api/ux-guidelines/notifications). The panel respects the existing VS Code theme, keyboard disclosures, reduced-motion preferences, and narrow-panel wrapping.

Helper batches share three execution slots per task and depth. Separate depth lanes keep a parent waiting for child work from occupying every child slot; the default helper allowlist still leaves further delegation to the parent. Each helper owns its provider and cancellation signal. Cancelling a task stops dispatching queued work and checks cancellation again before each subsequent tool call. An operation already in flight may still finish; its recorded result is retained instead of automatically executing it again.

Every assignment is registered before queueing. Identical prompts within a batch are coalesced; a second batch requesting an already queued or running assignment receives the existing execution ID. Shell calls and MCP requests also reserve their semantic inputs before entering their execution queues. Parent and helper owners share this registry, so a new tool-call ID or JSON argument key order cannot bypass duplicate detection. Commands keep their separate process ownership after the foreground action returns.

Parent and helper model requests receive a fresh execution inventory at provider dispatch, after prompt preparation and compaction, including on request retries. This transient context supersedes earlier snapshots without being saved in conversation history. It identifies owners, execution IDs, queued and running work, unresolved waits, and recent results. `get_execution_state` retrieves the full tracked inventory or inspects either a command ID or an action ID.

Automatic snapshots keep execution handles and status before adding previews. They prioritize the observer's own work and unresolved outcomes, report totals and omitted records, and label summaries whose details were omitted. The serialized snapshot is limited to 12,000 UTF-8 bytes, with a smaller allowance for small context windows (at least 2,048 bytes). This limits added context rather than estimating exact tokens. Queue previews retain the observer's queued positions even beyond the first three waiters. Oversized labels cannot displace an otherwise usable execution handle, and embedded runtime delimiters are JSON-escaped. This use of compact references with explicit inspection follows [Anthropic's context engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

Action records include bounded input previews, the current attempt, and the retry limit. Common credential fields in structured inputs are redacted; arbitrary text is not automatically scrubbed. Queue records show capacity, occupied slots, active execution IDs, and wait order. Occupants without a receipt are explicitly counted as untracked. An action marked `awaiting_completion` still holds its slot until the underlying operation settles, even though its caller stopped waiting. Polling inventory does not count as progress. Separating queue waits from execution attempts follows the distinction in [Temporal's activity timeout guidance](https://docs.temporal.io/encyclopedia/detecting-activity-failures).

Current approval settings and bounded trust information help the model choose work it can perform, while runtime policies and each helper's tool allowlist still apply. Unavailable observation is labeled explicitly: it does not mean no work is running, and it does not grant permission. A failed terminal observer does not prevent inspecting other registered actions or retained foreground evidence. Its failure is not reported as an expired command. Commands rejected before a terminal was created remain visible in recent action receipts; only actions already represented by a linked command are folded out of the inventory. Optional observation failure does not block the next provider request. Coverage is limited to the current task instance's tracked commands, MCP requests, and helpers; other work may be unlisted.

Action receipts retain bounded result previews, including late outcomes, in a cache of the latest 128 completed actions in the running extension. Lookups are scoped to the owning task instance; they do not survive an extension restart. Active identities are never evicted to admit duplicate work. This is in-flight duplicate suppression, not permanent result caching: after an operation settles, a deliberate new invocation is allowed. It does not provide server-side idempotency. A remote transport failure may leave side effects uncertain even after the local request settles, so reconcile remote state before repeating a mutation. See [AWS's guidance on safe retries and idempotency](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/).

Helpers with shell access also receive `read_command_output`. Commands return an execution ID, allowing the helper or parent to inspect the same run after a foreground timeout without starting it again. Reads wait at most 30 seconds and do not consume other readers' output. The latest 64 completed command results remain available within the task session. `get_execution_state` can find any retained command by either its command ID or linked action ID, including results older than the recent summary or the separate action receipt. Command summaries mark truncated command text and output; `read_command_output` returns the retained command output. A completed foreground action is not proof that its terminal command finished. Changing a wait duration does not reset the stall window, and pending or failed commands do not renew completion evidence.

Parent and helper provider reads have a three-minute first-response deadline and a two-minute idle deadline between chunks. Time spent executing tools or waiting for the user does not consume the read deadline. Recovery does not wait for an unresponsive provider's cleanup. Provider cancellation remains best effort when a provider does not implement it.

Transient failures use bounded backoff with jitter and respect `Retry-After`. Authentication, balance, and non-retryable request failures require resolving their cause. Provider retry exhaustion is not multiplied by the initial-response recovery layer. After an interrupted helper response, up to two continuation attempts retain prior execution results and discard unfinished calls; they do not replay the original request. Repeated blank turns and unsuccessful tools share the same progress window, with a change-of-approach nudge before a blocker handoff.

Configured token and cost limits apply across the helper batch, including reported cache usage. Usage is checked during responses and before another request or tool begins. Provider usage may arrive late, so these limits stop additional work when consumption is reported; they cannot guarantee an exact billing cap for requests already in flight. A batch also has a twenty-minute deadline.

Failed or cancelled helpers retain changed paths and a bounded excerpt of their eight most recent returned tool results. The parent receives successful sibling results and partial work, with an instruction to continue independent authorized work and resolve blockers before repeating an assignment. Partial work is evidence, not a successful completion claim.

These choices follow the bounded retry and idempotency guidance in [AWS's retry pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/retry-backoff.html), evidence-based progress described in [Anthropic's agent guidance](https://www.anthropic.com/engineering/building-effective-agents), and visible session status and result inspection familiar from [VS Code agent sessions](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions).

## Safety

Subagents use the parent's configured permissions and the scoped helper tool allowlist:

- The policy guard checks actions before execution; optional post-execution observations have a bounded wait.
- **Auto-approve** rules from `src/core/task/tools/autoApprove.ts` still gate mutating tools.
- **Completion gates** can block `attempt_completion` until subagent results pass validation.

## Related

- [Subagents feature guide](features/subagents.mdx)
- [All tools — use_subagents](tools-reference/all-dietcode-tools.mdx)
- [Memory & reasoning](MEMORY_AND_REASONING.md)
