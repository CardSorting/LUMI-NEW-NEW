# Paper 1 — Philosophy

_Why agentswarm exists, what it believes, and what it refuses to become._

## The problem in one sentence

Autonomous agents are good at starting work and bad at three things that matter once the work is real: **stopping safely**, **finishing honestly**, and **delegating to the right helper**.

## Core beliefs

### 1. Streams are sovereign

Parent and child agents are separate minds with separate inboxes and histories. The coordinator **observes and facilitates**; it does not merge transcripts or reach into a worker's context. Independence is what makes delegation scale and failures containable. (_agentswarm.md_)

### 2. Pausing is not killing

A pause that destroys in-flight work is just a crash with better branding. We suspend **cooperatively** — at a boundary the agent can stand behind — checkpoint what is done, and never replay a side effect whose outcome we can't prove. A deferred agent is neither "completed" nor "failed"; it is _waiting_, and the system says so. (_agentswarm3/4.md_)

### 3. Criticism must converge

Skepticism that never terminates is a bug. A review earns its keep by ending in a **decision**: accept, remediate, escalate, or accept with disclosed limits. It distinguishes what is _demonstrably broken_ from what is _merely possible_ or _merely preferred_, and it is allowed — expected — to conclude "this is correct." _Challenge assumptions. Demand evidence. Correct actual defects. Make a decision. Stop._ (_agentswarm2.md_)

### 4. Optional means optional

Power that taxes everyone is a tax. Review and Defer are **off by default** and cost nothing when off; per [ADR-0012](../adr/ADR-0012-automatic-legion-default.md), Legion defaults to on for eligible tasks to provide immediate specialist assistance, while remaining fully opt-outable via settings. When off or bypassed, execution remains strictly single-agent with zero tax. Opt-in/opt-out control is a feature of the design, not a deployment detail.

### 5. Right specialist, explained

Delegation quality depends on routing. The Legion routes with **deterministic, inspectable rules**: same input, same roster, with a stated rationale. We prefer a transparent heuristic you can steer over an opaque router you must trust.

### 6. Bounded automation

Every loop has a ceiling and an exit: one review plus one corrective pass; two attempts per specialist slot; a capped control inbox. When a bound is hit, the system **escalates to a human or coordinator** instead of trying harder.

### 7. Boring infrastructure

We built no new queue, engine, or mailbox. The same durable store that holds everything else holds this. Novel mechanisms are liabilities; leverage is the point.

### 8. Honest reporting

Claims are labelled **verified** or **unverified**. A green test run is evidence; a worker's confidence is not. Reports state what was _not_ checked. (This wiki follows the rule.)

### 9. Stream hygiene over futile retries

Transport stream decoding errors (such as concatenated snapshots or syntax corruption) are not transient logical failures. Retrying them against the same provider stream is futile and wastes token quotas. We slice snapshots at the source, self-heal unambiguous duplicates, and circuit-break transport errors with `safeToRetry: false`.

### 10. Native tool discipline & terminal safety

File modifications belong in tracked, discrete tool operations (`write_to_file`, `replace_in_file`), never hidden inside terminal heredocs (`cat <<'EOF'`, `tee`). Terminal environments are non-interactive pipes where stdin prompts freeze shell integration. We enforce specialist prompt parity, pre-execution interception, and terminal process circuit-breakers to protect developer sessions from deadlocks ([ADR-0015](../adr/ADR-0015-multi-tier-terminal-heredoc-defense-and-prompt-parity.md), [PM-016](../postmortems/PM-016-terminal-heredoc-deadlock-and-prompt-parity.md)).

### 11. Read files through tools, not terminal dumps

Terminal pipes are designed for commands, not file dumping. Using `cat`, `head`, or `tail` to inspect code dumps hundreds of lines into interactive sessions and exhausts context tokens. We intercept terminal file reads before execution and redirect models to `read_file` ([ADR-0016](../adr/ADR-0016-terminal-file-read-defense-budget-starvation-and-conductor-prompt-parity.md), [PM-017](../postmortems/PM-017-terminal-file-dump-specialist-starvation-and-conductor-fallback.md)).

### 12. Workspace integrity, credential hygiene & outcome fencing

Heuristics shared across agents must never leak credentials or cross workspace boundaries. Manifest file modifications immediately invalidate environment leases. Losing terminal observation is not proof of command death; unconfirmed processes retain execution fencing until reconciled, and unpersisted specialist settlements halt in `needs_reconciliation` rather than advancing blindly ([ADR-0017](../adr/ADR-0017-dynamic-project-knowledge-blackboard-and-credential-sanitization.md)–[ADR-0020](../adr/ADR-0020-legion-handoff-sanitization-two-phase-reservation-and-unsettled-reconciliation.md), [PM-018](../postmortems/PM-018-unconfirmed-command-outcome-fencing-and-replacement-view-pollution.md), [PM-019](../postmortems/PM-019-unpersisted-specialist-settlement-and-formation-dispatch-race.md)).

## What agentswarm refuses to be

- A replacement for the host's agent engine or UI.
- A framework that needs a model call to decide anything it can decide deterministically.
- A source of silent behaviour change: with the switches off, nothing is different.
- A place where failures are hidden: unrecoverable failures surface as explicit escalations with reports.

## Trade-offs we chose, knowingly

| We chose                          | Over                 | Cost                                                    |
| --------------------------------- | -------------------- | ------------------------------------------------------- |
| Wait for a safe boundary          | Instant suspension   | Latency up to the longest atomic operation              |
| Deterministic classification      | Model-based routing  | Heuristic mis-ranks unusual phrasing (steerable)        |
| Block downstream on a failed slot | Skip-and-continue    | Needs a human/coordinator on exhaustion                 |
| In-process locks                  | Distributed locking  | Single extension host assumed                           |
| Reuse existing store              | Purpose-built tables | Must respect the store's sharp edges (see post-mortems) |

## How to use this philosophy day-to-day

When a design choice is unclear, ask in order: _Does it change behaviour when off? Could it destroy in-flight work? Does it have a bound? Can a human see why it did that? Did we prove it, or just believe it?_
