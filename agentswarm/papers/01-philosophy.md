# Paper 1 — Philosophy

*Why agentswarm exists, what it believes, and what it refuses to become.*

## The problem in one sentence
Autonomous agents are good at starting work and bad at three things that matter once the work is real: **stopping safely**, **finishing honestly**, and **delegating to the right helper**.

## Core beliefs

### 1. Streams are sovereign
Parent and child agents are separate minds with separate inboxes and histories. The coordinator **observes and facilitates**; it does not merge transcripts or reach into a worker's context. Independence is what makes delegation scale and failures containable. (*agentswarm.md*)

### 2. Pausing is not killing
A pause that destroys in-flight work is just a crash with better branding. We suspend **cooperatively** — at a boundary the agent can stand behind — checkpoint what is done, and never replay a side effect whose outcome we can't prove. A deferred agent is neither "completed" nor "failed"; it is *waiting*, and the system says so. (*agentswarm3/4.md*)

### 3. Criticism must converge
Skepticism that never terminates is a bug. A review earns its keep by ending in a **decision**: accept, remediate, escalate, or accept with disclosed limits. It distinguishes what is *demonstrably broken* from what is *merely possible* or *merely preferred*, and it is allowed — expected — to conclude "this is correct." *Challenge assumptions. Demand evidence. Correct actual defects. Make a decision. Stop.* (*agentswarm2.md*)

### 4. Optional means optional
Power that taxes everyone is a tax. Review and Defer are **off by default** and cost nothing when off; per [ADR-0012](../adr/ADR-0012-automatic-legion-default.md), Legion defaults to on for eligible tasks to provide immediate specialist assistance, while remaining fully opt-outable via settings. When off or bypassed, execution remains strictly single-agent with zero tax. Opt-in/opt-out control is a feature of the design, not a deployment detail.

### 5. Right specialist, explained
Delegation quality depends on routing. The Legion routes with **deterministic, inspectable rules**: same input, same roster, with a stated rationale. We prefer a transparent heuristic you can steer over an opaque router you must trust.

### 6. Bounded automation
Every loop has a ceiling and an exit: one review plus one corrective pass; two attempts per specialist slot; a capped control inbox. When a bound is hit, the system **escalates to a human or coordinator** instead of trying harder.

### 7. Boring infrastructure
We built no new queue, engine, or mailbox. The same durable store that holds everything else holds this. Novel mechanisms are liabilities; leverage is the point.

### 8. Honest reporting
Claims are labelled **verified** or **unverified**. A green test run is evidence; a worker's confidence is not. Reports state what was *not* checked. (This wiki follows the rule.)

### 9. Stream hygiene over futile retries
Transport stream decoding errors (such as concatenated snapshots or syntax corruption) are not transient logical failures. Retrying them against the same provider stream is futile and wastes token quotas. We slice snapshots at the source, self-heal unambiguous duplicates, and circuit-break transport errors with `safeToRetry: false`.

### 10. Native tool discipline & terminal safety
File modifications belong in tracked, discrete tool operations (`write_to_file`, `replace_in_file`), never hidden inside terminal heredocs (`cat <<'EOF'`, `tee`). Terminal environments are non-interactive pipes where stdin prompts freeze shell integration. We enforce specialist prompt parity, pre-execution interception, and terminal process circuit-breakers to protect developer sessions from deadlocks ([ADR-0015](../adr/ADR-0015-multi-tier-terminal-heredoc-defense-and-prompt-parity.md), [PM-016](../postmortems/PM-016-terminal-heredoc-deadlock-and-prompt-parity.md)).

## What agentswarm refuses to be
- A replacement for the host's agent engine or UI.
- A framework that needs a model call to decide anything it can decide deterministically.
- A source of silent behaviour change: with the switches off, nothing is different.
- A place where failures are hidden: unrecoverable failures surface as explicit escalations with reports.

## Trade-offs we chose, knowingly
| We chose | Over | Cost |
|---|---|---|
| Wait for a safe boundary | Instant suspension | Latency up to the longest atomic operation |
| Deterministic classification | Model-based routing | Heuristic mis-ranks unusual phrasing (steerable) |
| Block downstream on a failed slot | Skip-and-continue | Needs a human/coordinator on exhaustion |
| In-process locks | Distributed locking | Single extension host assumed |
| Reuse existing store | Purpose-built tables | Must respect the store's sharp edges (see post-mortems) |

## How to use this philosophy day-to-day
When a design choice is unclear, ask in order: *Does it change behaviour when off? Could it destroy in-flight work? Does it have a bound? Can a human see why it did that? Did we prove it, or just believe it?*
