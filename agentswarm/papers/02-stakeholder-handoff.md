# Paper 2 — Stakeholder Hand-off

*For product, engineering leadership, and release owners. Plain language; no code required.*

## 1. What you are getting
Three optional capabilities for LUMI's multi-agent work, controlled from **Settings → Preferences → Agent Swarm & Hierarchy Orchestration**:

| Capability | What it does for users | Default |
|---|---|---|
| **Hierarchical Defer & Resume** | Pause an agent and all its helpers safely, then continue without redoing finished work | Off |
| **Critical Completion Review** | After a task "completes", run one bounded, evidence-based check that ends in a clear decision | Off |
| **The Legion** | Pick the right specialist helpers (architect, implementer, UX, hardener, QA, recon, data) for a task, run them in order, retry once on failure, and summarize | **On** (ADR-0012) |

Quick presets let a user choose *Standard (Off)*, *Review Only*, *Defer Only*, *Legion Only*, or *Full Swarm + Legion* in one click.

## 2. Why it matters
- **Safety:** long agent runs can be interrupted without losing or duplicating work.
- **Quality:** completions get a disciplined second look that cannot spiral into endless nitpicking.
- **Scale:** big tasks are split among specialists with clear ordering and a single consolidated report.

## 3. Status (honest)
| Area | Status | Evidence |
|---|---|---|
| Build / type safety | ✅ Passing | Type-check (extension + webview) |
| Automated tests | ✅ Passing | 291 backend unit tests passing across Auxiliary, Legion Host, Tool Adapter, Task Legion, Engage Swarm Handler, ToolSet Discovery, Orchestrator, State Keys, Codex Streaming deduplication, StreamResponseHandler self-healing, terminal heredoc policy, command approval interception, and terminal process lifecycle; 7 webview tests; includes real-SQLite tests |
| Lint | ✅ No errors on touched files | Biome (1,765 files checked) |
| **Specialist task execution** | ✅ Implemented & Hardened | `LegionAgentHost`, `LegionToolAdapter`, and `LegionPipelineRunner` execute native-tool specialist loops, stream progress cards, and enforce token/cost budgets |
| **Live product smoke test** | ⚠️ **Not done** | Never exercised in a running VS Code window with real model runs |
| Code committed? | ⚠️ **Check** | Work was uncommitted when this was written |

**Recommendation:** treat as *ready for internal dogfooding with Legion enabled by default*, **not** ready for general release until the manual smoke test is closed.

> **Update (Phase 5, 8 & 9):** while preparing and empirically verifying the maintainers' handbook against a real SQLite database, we found and fixed **two additional persistence/phase defects**: (1) a stream's *completed* state, its summary, and its file-reservation releases were stranded in a private shadow overlay ([PM-011](../postmortems/PM-011-completion-state-stranded-in-shadow-overlay.md)), and (2) late child completion after a pipeline resumed could re-suspend the parent, while same-batch reservation deletes sorted before upserts ([PM-012](../postmortems/PM-012-post-resume-reconcile-and-delete-upsert-ordering.md)). In Phase 8, we resolved streaming tool argument snapshot duplication and interleaved tool identity loss across model streaming endpoints ([ADR-0014](../adr/ADR-0014-tool-argument-stream-deduplication-and-self-healing-parser.md)), added state-machine JSON root extraction with self-healing, and circuit-broken transport decoding errors in `LegionAgentHost` with `safeToRetry: false` to stop futile failover loops ([PM-015](../postmortems/PM-015-tool-argument-snapshot-concatenation-and-stream-decoding-loop.md)). In Phase 9, we resolved terminal heredoc deadlocks in non-interactive shell integration through specialist prompt parity (`LEGION_CORE_RULES`), shell-token policy detection, pre-execution interception, and terminal process circuit-breakers ([ADR-0015](../adr/ADR-0015-multi-tier-terminal-heredoc-defense-and-prompt-parity.md), [PM-016](../postmortems/PM-016-terminal-heredoc-deadlock-and-prompt-parity.md)). All are now fixed and covered by 291 passing automated tests.

## 4. Risks and mitigations
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Specialist task execution & runner wiring | Low | Work fails to execute | Resolved in Phase 6 & 7 via `LegionAgentHost`, `LegionPipelineRunner`, and `EngageSwarmHandler` (L2 closed) |
| Operator env var silently overrides a user's UI choice | Medium | Confusion | Documented; UI shows effective values |
| Heuristic picks a sub-optimal specialist | Medium | Wasted effort | Users/code can steer roles; one-click strategy choice |
| Persistence edge cases on real DB | Medium (found & fixed 5; other modules not audited) | Failed or silently dropped saves | Real-DB tests; triage playbook; audit open item L12 |
| Single-process locking assumption | Low | Only if multi-process execution is introduced | Documented; revisit then |
| Regression to default behaviour | Low | High | Off-path test; defaults asserted in tests |

## 5. Decisions we need from you
1. **Go/No-go for internal dogfood** with Legion enabled by default and Review/Defer opt-in.
2. **Review streaming progress cards** (`formatLegionProgressMessage`) and conductor tool ergonomics (`engage_swarm`).
3. **Telemetry:** do we track specialist outcomes (success, failover, escalation) to tune routing?
4. **Release gate:** require the manual smoke test (PB-07) before any external release?

## 6. How to turn it on, and off
- **On:** pick a preset in Settings, or set `lumi.agentSwarm.enabled`. Operators: `LUMI_AGENT_SWARM_ENABLED=1`.
- **Off / rollback:** choose *Standard (Off)* or unset the switch — instant, no redeploy. Resume any suspended hierarchies first (see [reincorporation §4](../reincorporation.md)).

## 7. What we'd measure
Adoption per preset; review outcomes (accept vs. remediate vs. escalate); specialist failover rate; time-to-suspend; unresolved-failure escalations; any change in baseline task completion (should be none when off).

## 8. What happened along the way (one paragraph)
Fifteen defects were found and fixed during implementation, SQLite verification, and terminal execution hardening (details in [post-mortems](../postmortems/README.md)). One work stream was interrupted by a provider quota limit; its partial output was audited, two earlier fixes it had undone were restored, and unfinished pieces were completed and tested. Lessons were codified in [playbooks](../playbooks/README.md) and the [Maintainers' Handbook](../maintainers/README.md).

## 9. Where to read more
Philosophy → [Paper 1](01-philosophy.md) · Engineering depth → [Paper 3](03-technical-whitepaper.md) · Onboarding → [developers](../onboarding/for-human-developers.md), [maintainers](../onboarding/for-maintainers.md).
