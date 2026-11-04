# Architecture Decision Records

Format: **Context → Decision → Consequences → Alternatives → Evidence**. Status values: `Accepted`, `Superseded`, `Proposed`.
To change a decision, add a new ADR that supersedes the old one — never rewrite history.

| ADR | Title | Status |
|---|---|---|
| [0001](ADR-0001-auxiliary-off-by-default.md) | Auxiliary, off by default, zero overhead when off | Superseded for Legion by 0012 |
| [0002](ADR-0002-defer-is-not-cancel.md) | Defer is cooperative suspension, never cancellation | Accepted |
| [0003](ADR-0003-durable-state-in-agent-memory.md) | Persist all swarm state in `agent_memory` via `BufferedDbPool` | Accepted |
| [0004](ADR-0004-suspension-barrier-and-ancestor-walk.md) | Parent suspension barrier with ancestor walk and per-pipeline lock | Accepted |
| [0005](ADR-0005-bounded-review-with-category-separation.md) | Bounded 1+1 review with strict finding categories | Accepted |
| [0006](ADR-0006-config-precedence-and-explicit-detection.md) | Config precedence and explicit-vs-default detection | Accepted |
| [0007](ADR-0007-settings-through-proto-with-boundary-clamping.md) | Settings flow through proto with clamping at the controller | Accepted |
| [0008](ADR-0008-deterministic-legion-classification.md) | Deterministic, model-free Legion classification | Accepted |
| [0009](ADR-0009-legion-lifecycle-dag-failover-terminal-states.md) | Legion lifecycle: stage DAG, bounded failover, final terminal states, per-formation lock | Accepted |
| [0010](ADR-0010-direct-writes-for-shared-rows.md) | Direct (non-shadow) writes for rows others must read; FK-ordered flush | Accepted |
| [0011](ADR-0011-legacy-role-alias.md) | Keep `legion_Trends_ux` as a legacy alias of `legion_ux_ergonomics` | Accepted |
| [0012](ADR-0012-automatic-legion-default.md) | Automatic Legion formation by default | Accepted |
| [0013](ADR-0013-orchestrator-conductor-tool-and-streaming-progress.md) | Orchestrator Conductor tool (`engage_swarm`), progress streaming, auto-approval & hardened gating | Accepted |
| [0014](ADR-0014-tool-argument-stream-deduplication-and-self-healing-parser.md) | Tool argument stream deduplication, self-healing JSON parser & transport circuit-breaking | Accepted |
