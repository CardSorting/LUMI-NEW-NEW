Commission: Integrate Hierarchical Agent Defer Into This Workspace

From: MAJO, Executive Commission
To: Deputy Gemini
Priority: High
Assignment: Investigate, design, and integrate hierarchical agent defer and resume into the existing workspace.

1. Objective

This workspace needs to incorporate a general-purpose hierarchical defer capability into its existing agent execution architecture.

The objective is to allow a parent agent to defer its own execution and coordinate the suspension of all its child agents, preserving their independent execution streams, outstanding work, and coordination state so that the hierarchy can subsequently resume.

This is an integration task.

Do not turn this into a cross-repository comparison, a multi-codebase audit, or a proposal for a separate agent harness.

Work within this workspace and its existing architecture.

2. Understand the existing machinery first

Trace how the existing components connect and establish the actual execution lifecycle.

Investigate the relevant implementations of:

AgentEngine

executeTurn()

tick()

forkSession()

AgentSwarmDispatcher

delegateSubagentTask()

BroccolidbInterAgentMailbox

BroccolidbTaskCoordinator

BroccoliQueue

BroccoliRuntimeQueue

Session persistence and restoration.

Tool execution and continuation scheduling.

Parent/child delegation and reporting.

Determine which components own execution, which own state, which coordinate agents, and which persist information.

Identify existing extension points that can support defer without duplicating infrastructure.

3. Required capability: Hierarchical defer

Implement a mechanism through which an agent can request suspension of its execution hierarchy.

The intended lifecycle:

Parent receives a defer request.

Parent records the request and stops accepting additional work that would conflict with suspension.

Parent propagates defer requests to its active children.

Each child independently reaches a safe execution boundary.

Each child preserves its execution and coordination state.

Each child acknowledges suspension.

Parent waits for the required descendant acknowledgements.

Parent checkpoints its own state and roadmap.

Parent acknowledges that the hierarchy is suspended.

A subsequent resume request restores each independent stream.

The parent must not report the hierarchy as suspended while descendants are still executing.

A child that has deferred must not be reported as completed or failed.

4. Execution boundary semantics

Support or establish a design for:

before_turn: yield before beginning the next model turn.

safe_boundary: finish the current atomic operation and yield before proceeding.

immediate: interrupt only where safe interruption and recovery are guaranteed.

Use safe-boundary suspension as the default unless the existing architecture establishes a better choice.

Do not confuse cancellation with defer.

Do not discard a running execution merely to make it appear suspended.

5. Preserve independent agent streams

Parent and child agents must retain their separate execution contexts.

The parent remains the coordinator.

Children continue to own their individual execution streams, tasks, and reports.

The parent maintains an actionable rolling roadmap that tracks:

Objectives.

Child assignments.

Execution status.

Completed work.

Outstanding work.

Dependencies.

Blockers.

Decisions.

Next actions.

Synchronization status.

Suspension must preserve this coordination state.

Resumption must restore each agent independently and re-establish coordination without collapsing their conversations into one shared stream.

6. Delegation and scheduling integration

Investigate how the current synchronous and asynchronous delegation paths interact with suspension.

In particular, ensure that a parent awaiting a child does not remain blocked indefinitely when that child defers.

A deferred child should return an explicit deferred execution outcome, not a false completion or failure.

Preserve correct behaviour for:

Queue ownership.

Execution leases.

Fencing tokens.

Task assignment.

Heartbeats.

Retry handling.

Continuation scheduling.

Child result collection.

7. Persistence and recovery

Establish what execution state must be persisted to support reliable resumption.

Consider pending model requests, tool calls, completed tool results, continuation metadata, session identity, task assignments, outstanding messages, and parent coordination state.

Use existing persistence infrastructure wherever possible.

Ensure duplicate requests, process restarts, stale leases, and uncertain tool side effects cannot silently corrupt execution.

Do not blindly replay operations whose completion status is unknown.

8. Implementation approach

Proceed incrementally:

Phase 1 — Runtime understanding

Trace the actual execution lifecycle and identify the precise points where an agent can safely yield.

Phase 2 — Individual defer

Introduce a defer request, checkpoint, explicit deferred outcome, and resume mechanism for an individual agent.

Phase 3 — Hierarchical coordination

Propagate defer and resume through the parent/child hierarchy. Implement acknowledgement barriers and hierarchy status.

Phase 4 — Persistence and recovery

Ensure suspended execution survives the relevant lifecycle and recovery scenarios.

Phase 5 — Verification

Test individual suspension, nested hierarchies, partial suspension, duplicate requests, process restarts, and independent stream restoration.

9. Constraints

Modify the existing architecture rather than creating another harness.

Reuse existing execution engines, queues, session management, persistence, and coordination components.

Do not merge independent agent streams.

Do not treat UI pause as runtime suspension.

Do not use cancellation as a substitute for defer.

Do not introduce unnecessary parallel infrastructure.

Preserve existing agent autonomy and delegation semantics.

Do not claim a capability is implemented until it has been verified.

10. Deliverables

Return:

An explanation of how the existing workspace architecture connects.

The precise execution boundaries available for defer.

The proposed integration design.

The exact classes and functions requiring modification.

The implementation itself, where feasible.

Tests and verification results.

Any remaining limitations or unresolved persistence concerns.

Distinguish verified implementation behaviour from assumptions and proposed changes.

Governing principle: Extend this workspace's existing machinery so that hierarchical agent suspension and resumption become native execution capabilities. Preserve independent streams, coordinate explicitly, checkpoint safely, and resume deterministically.