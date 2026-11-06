# Paper 2 — Stakeholder Hand-off

_For product, engineering leadership, and release owners. Plain language; no code required._

## 1. What you are getting

Three optional capabilities for LUMI's multi-agent work, controlled from **Settings → Preferences → Agent Swarm & Hierarchy Orchestration**:

| Capability                      | What it does for users                                                                                                                                        | Default           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **Hierarchical Defer & Resume** | Pause an agent and all its helpers safely, then continue without redoing finished work                                                                        | Off               |
| **Critical Completion Review**  | After a task "completes", run one bounded, evidence-based check that ends in a clear decision                                                                 | Off               |
| **The Legion**                  | Pick the right specialist helpers (architect, implementer, UX, hardener, QA, recon, data) for a task, run them in order, retry once on failure, and summarize | **On** (ADR-0012) |

Quick presets let a user choose _Standard (Off)_, _Review Only_, _Defer Only_, _Legion Only_, or _Full Swarm + Legion_ in one click.

## 2. Why it matters

- **Safety:** long agent runs can be interrupted without losing or duplicating work.
- **Quality:** completions get a disciplined second look that cannot spiral into endless nitpicking.
- **Scale:** big tasks are split among specialists with clear ordering and a single consolidated report.

## 3. Status (honest)

| Area                          | Status                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build / type safety           | ✅ Passing                    | Type-check (extension + webview)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Automated tests               | ✅ Passing                    | 455 backend unit tests passing in `npm run test:swarm` across Auxiliary, Legion Host, Tool Adapter, Task Legion, Engage Swarm Handler, ToolSet Discovery, Orchestrator, State Keys, Codex Streaming deduplication, StreamResponseHandler self-healing, terminal heredoc policy, terminal file read defense, command approval interception, and terminal process lifecycle; 465 passing in `npm run test:execution`; 32 webview tests; includes real-SQLite tests |
| Lint                          | ✅ No errors on touched files | Biome (1,765 files checked)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Specialist task execution** | ✅ Implemented & Hardened     | `LegionAgentHost`, `LegionToolAdapter`, and `LegionPipelineRunner` execute native-tool specialist loops, stream progress cards, and enforce token/cost budgets                                                                                                                                                                                                                                                                                                   |
| **Live product smoke test**   | ⚠️ **Not done**               | Never exercised in a running VS Code window with real model runs                                                                                                                                                                                                                                                                                                                                                                                                 |
| Code committed?               | ⚠️ **Check**                  | Work was uncommitted when this was written                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Recommendation:** treat as _ready for internal dogfooding with Legion enabled by default_, **not** ready for general release until the manual smoke test is closed.

> **Update (Phase 5, 8, 9, 10 & 11):** while preparing and empirically verifying the maintainers' handbook against a real SQLite database, we found and fixed **two additional persistence/phase defects**: (1) a stream's _completed_ state, its summary, and its file-reservation releases were stranded in a private shadow overlay ([PM-011](../postmortems/PM-011-completion-state-stranded-in-shadow-overlay.md)), and (2) late child completion after a pipeline resumed could re-suspend the parent, while same-batch reservation deletes sorted before upserts ([PM-012](../postmortems/PM-012-post-resume-reconcile-and-delete-upsert-ordering.md)). In Phase 8, we resolved streaming tool argument snapshot duplication and interleaved tool identity loss across model streaming endpoints ([ADR-0014](../adr/ADR-0014-tool-argument-stream-deduplication-and-self-healing-parser.md)), added state-machine JSON root extraction with self-healing, and circuit-broken transport decoding errors in `LegionAgentHost` with `safeToRetry: false` to stop futile failover loops ([PM-015](../postmortems/PM-015-tool-argument-snapshot-concatenation-and-stream-decoding-loop.md)). In Phase 9, we resolved terminal heredoc deadlocks in non-interactive shell integration through specialist prompt parity (`LEGION_CORE_RULES`), shell-token policy detection, pre-execution interception, and terminal process circuit-breakers ([ADR-0015](../adr/ADR-0015-multi-tier-terminal-heredoc-defense-and-prompt-parity.md), [PM-016](../postmortems/PM-016-terminal-heredoc-deadlock-and-prompt-parity.md)). In Phase 10, terminal file read commands were intercepted and redirected to `read_file`, and specialist token budgets were decoupled from multi-turn accumulation ([ADR-0016](../adr/ADR-0016-terminal-file-read-defense-budget-starvation-and-conductor-prompt-parity.md), [PM-017](../postmortems/PM-017-terminal-file-dump-specialist-starvation-and-conductor-fallback.md)). In Phase 11, dynamic project knowledge with credential scrubbing was introduced ([ADR-0017](../adr/ADR-0017-dynamic-project-knowledge-blackboard-and-credential-sanitization.md)), environment integrity manifest fingerprinting was wired into file mutations ([ADR-0018](../adr/ADR-0018-workspace-environment-integrity-and-manifest-fingerprinting.md)), terminal supervision and action execution fencing were hardened ([ADR-0019](../adr/ADR-0019-terminal-supervision-action-fencing-and-shadow-commit-retention.md), [PM-018](../postmortems/PM-018-unconfirmed-command-outcome-fencing-and-replacement-view-pollution.md)), and Legion handoffs were protected with XML sanitization and two-phase formation reservations ([ADR-0020](../adr/ADR-0020-legion-handoff-sanitization-two-phase-reservation-and-unsettled-reconciliation.md), [PM-019](../postmortems/PM-019-unpersisted-specialist-settlement-and-formation-dispatch-race.md)). All are now covered by 455 passing backend tests.

## 4. Risks and mitigations

| Risk                                                   | Likelihood                                          | Impact                                        | Mitigation                                                                                                  |
| ------------------------------------------------------ | --------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Specialist task execution & runner wiring              | Low                                                 | Work fails to execute                         | Resolved in Phase 6 & 7 via `LegionAgentHost`, `LegionPipelineRunner`, and `EngageSwarmHandler` (L2 closed) |
| Operator env var silently overrides a user's UI choice | Medium                                              | Confusion                                     | Documented; UI shows effective values                                                                       |
| Heuristic picks a sub-optimal specialist               | Medium                                              | Wasted effort                                 | Users/code can steer roles; one-click strategy choice                                                       |
| Persistence edge cases on real DB                      | Medium (found & fixed 5; other modules not audited) | Failed or silently dropped saves              | Real-DB tests; triage playbook; audit open item L12                                                         |
| Single-process locking assumption                      | Low                                                 | Only if multi-process execution is introduced | Documented; revisit then                                                                                    |
| Regression to default behaviour                        | Low                                                 | High                                          | Off-path test; defaults asserted in tests                                                                   |

## 5. Decisions we need from you

1. **Go/No-go for internal dogfood** with Legion enabled by default and Review/Defer opt-in.
2. **Review streaming progress cards** (`formatLegionProgressMessage`) and conductor tool ergonomics (`engage_swarm`).
3. **Telemetry:** do we track specialist outcomes (success, failover, escalation) to tune routing?
4. **Release gate:** require the manual smoke test (PB-07) before any external release?

## 6. How to turn it on, and off

- **On:** pick a preset in Settings, or set `lumi.agentSwarm.enabled`. Operators: `LUMI_AGENT_SWARM_ENABLED=1`.
- **Off / rollback:** choose _Standard (Off)_ or unset the switch — instant, no redeploy. Resume any suspended hierarchies first (see [reincorporation §4](../reincorporation.md)).

## 7. What we'd measure

Adoption per preset; review outcomes (accept vs. remediate vs. escalate); specialist failover rate; time-to-suspend; unresolved-failure escalations; any change in baseline task completion (should be none when off).

## 8. What happened along the way (one paragraph)

Nineteen defects were found and fixed during implementation, SQLite verification, and terminal execution hardening (details in [post-mortems](../postmortems/README.md)). One work stream was interrupted by a provider quota limit; its partial output was audited, two earlier fixes it had undone were restored, and unfinished pieces were completed and tested. Lessons were codified in [playbooks](../playbooks/README.md) and the [Maintainers' Handbook](../maintainers/README.md).

## 9. Where to read more

Philosophy → [Paper 1](01-philosophy.md) · Engineering depth → [Paper 3](03-technical-whitepaper.md) · Onboarding → [developers](../onboarding/for-human-developers.md), [maintainers](../onboarding/for-maintainers.md).
