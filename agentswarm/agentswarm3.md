1. What your backend actually does

I traced the relevant components.

Component

Actual responsibility

AgentEngine

Executes model turns and tool rounds.

BroccoliRuntimeQueue

Admits and serializes execution requests through BroccoliQueue.

LumiMonolith.forkSession()

Creates isolated child engine sessions.

AgentSwarmDispatcher

Delegates work to forked child sessions.

BroccoliInterAgentMailbox

Routes messages to recipients using agent IDs.

BroccoliTaskCoordinator

Tracks workers, task assignments, and heartbeats.

DesktopSession

Owns the desktop task queue, cancellation, continuation, and recorded run lifecycle.

Here's the particularly interesting part.

Your current AgentSwarmDispatcher.delegateSubagentTask():

Creates a task ID.

Acquires a fencing lease.

Takes a parent engine snapshot.

Forks a child engine.

Awaits childEngine.tick().

Returns the child result.

Releases the lease.

That is an isolated child execution, but the delegation function itself is synchronous in its orchestration lifecycle: it waits for the child tick to finish.

Meanwhile, the mailbox is currently an in-memory bounded message array, and the task coordinator maintains in-memory worker maps. They are not yet a durable, independently resumable hierarchy.

2. The surprising discovery: you already have a pause, but it's the wrong pause

Your desktop interface has a Pause control.

However, according to its own integration documentation, that control freezes the displayed activity feed. It does not suspend the agent's execution.

The runtime itself currently has cancellation through AbortSignal, but cancellation is not suspension.

The queue also cancels stale jobs on restart rather than replaying uncertain work. Its architecture explicitly avoids assuming that an interrupted operation can safely be repeated.

That means we should absolutely not implement defer by simply aborting every child agent.

That would destroy the distinction between:

Stop executing.

Temporarily yield execution.

Preserve the task for later continuation.

3. What I would actually build

I would introduce a new orchestration subsystem:

Broccoli Deferred Execution Coordinator

Recommended architecture
Its purpose is to coordinate suspension across independent agent streams without merging them.

The important change is that defer becomes a control-plane operation, not an agent conversation instruction.

Parent coordinator

Own execution context · Own inbox · Own roadmap

Child A

Independent session and inbox

Defer requested
Child B

Independent session and inbox

Defer requested
Child C

Independent session and inbox

Defer requested
Child D

Independent session and inbox

Defer requested
Deferred Execution Coordinator

Hierarchy membership

Control-message routing

Suspension acknowledgements

Durable execution checkpoints

Resume scheduling

Recovery and reconciliation

The coordinator controls execution without merging agent histories or inboxes.
Proposed API

deferPipeline({
  pipelineId,
  scope: "hierarchy",
  reason: "critical_completion_review",
  mode: "safe_boundary"
});

resumePipeline({
  pipelineId
});

getDeferredPipelineStatus({
  pipelineId
});
I would also expose individual operations:

deferAgent({ agentId });
resumeAgent({ agentId });
Hierarchy suspension would be built on those individual operations.

4. How suspension should actually work in your engine

This is the important implementation detail.

Your AgentEngine.tick() wraps the execution in a serialized request queue. Inside the tick, executeTurn() performs the model and tool work.

A safe suspension mechanism needs to introduce a cooperative yield at execution boundaries.

I would implement three levels:

Level

Behavior

before_turn

Prevent the next model turn from starting.

safe_boundary

Allow the current atomic provider/tool operation to finish, then yield before continuing.

immediate

Request interruption, but only where the current operation is safely cancellable.

Default should be safe_boundary.

Why?

Because aborting an active tool invocation and pretending it was suspended can leave uncertain external side effects. A database write, shell command, or file mutation may already have happened.

The system must never replay that operation merely because the agent was deferred.

The first implementation should suspend between turns and at explicitly supported execution boundaries. True mid-turn restoration would require persisting additional execution state: pending tool calls, completed tool results, provider-round state, and continuation metadata.

That is a separate capability, not something a conversation snapshot magically provides.

5. Make the inbox the control channel

Your existing mailbox is a useful starting point, but I'd extend the message protocol.

For example:

type AgentControlMessage =
  | {
      type: "DEFER_REQUEST";
      pipelineId: string;
      requestId: string;
      reason: string;
      mode: "before_turn" | "safe_boundary";
    }
  | {
      type: "DEFER_ACK";
      pipelineId: string;
      requestId: string;
      checkpointId: string;
    }
  | {
      type: "RESUME_REQUEST";
      pipelineId: string;
      requestId: string;
    }
  | {
      type: "RESUME_ACK";
      pipelineId: string;
      requestId: string;
    };
But I would not just add these types to the existing in-memory array.

I'd make control messages durable in BroccoliDB, with:

Per-agent recipient identity.

Pipeline and delegation correlation IDs.

Monotonic message sequence.

Idempotent delivery.

Acknowledgement state.

Durable checkpoint references.

The coordinator can receive notifications when messages are acknowledged rather than repeatedly polling every inbox.

6. The parent needs a suspension barrier

This is the piece that makes hierarchy-level defer work.

Imagine the parent has four children.

It sends all four a defer request, but it does not immediately declare the pipeline suspended.

Instead, it waits for the actual execution states:

Pipeline suspension barrier

Child A

Suspended
Child B

Suspended
Child C

Finishing operation
Child D

Suspended
Parent

Waiting to yield
The parent cannot claim the hierarchy is fully suspended until Child C acknowledges its checkpoint.

The parent saves its roadmap and coordination state, then yields.

On resume, the coordinator wakes the parent and its descendants independently.

No agent needs to share a transcript with another agent. The parent receives their reports through the existing delegation/message model.

7. What I would reuse instead of reinventing

This is where I would be careful about your existing infrastructure.

BroccoliDB: durable control records and checkpoints.

BroccoliQueue: execution admission and scheduling.

AgentEngine: cooperative execution-boundary checks.

LumiMonolith: isolated session restoration and lifecycle.

AgentSwarmDispatcher: hierarchy membership and delegation.

BroccoliInterAgentMailbox: recipient-addressed messaging.

BroccoliTaskCoordinator: worker status and heartbeat integration.

I would not create another parallel queue, another agent engine, or another independent mailbox.

The missing piece is an authoritative execution lifecycle that connects these existing subsystems.

8. The implementation sequence I'd give the coordinator

I'd split this into four bounded stages:

Runtime audit: Trace forkSession(), session persistence, the complete executeTurn() loop, tool scheduler boundaries, and queue lifecycle. Establish which execution state can actually be restored.

Individual defer: Add durable defer/resume for one agent, without hierarchy propagation.

Hierarchy orchestration: Add pipeline membership, control-message routing, acknowledgements, and the parent suspension barrier.

Recovery and verification: Test simultaneous child suspension, partial acknowledgement, duplicate requests, in-flight tool operations, restart recovery, and resume without replaying completed work.

Do not begin by implementing the whole hierarchy. Prove that one child can defer and resume correctly first.

My conclusion: you don't need to invent a way to freeze an LLM conversation stream. Your architecture already has session identities, serialized execution, queues, snapshots, and messaging. What it lacks is a durable, cooperative suspension protocol spanning those systems.

And one last thing: I would keep the critical completion review we discussed as a consumer of this mechanism. It can request a defer, wait for the relevant hierarchy to yield, perform its review, and then resume the coordinator.

That makes defer a general-purpose capability for your agents rather than a feature hardwired to one review workflow.

You have most of the organs. The missing thing is the nervous system that tells the whole hierarchy when to stop, wait, and wake up. 😂