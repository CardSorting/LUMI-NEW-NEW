# agentswarm — Knowledge Base Wiki

> Optional multi-agent orchestration for LUMI: **Critical Completion Review**, **Hierarchical Defer & Resume**, and **The Legion** (specialist agent classification, formation and failover).
> Legion is enabled by default for suitable tasks; Review and Defer remain off by default. Explicit settings can disable Legion. See [PB-03](playbooks/PB-03-add-a-legion-specialist.md) for current runtime limits.

This directory is both the **original specification set** (`agentswarm.md` … `agentswarm4.md`, untouched) and the **engineering wiki** built while implementing it.

## Start here (pick your path)

| You are… | Read this first | Then |
|---|---|---|
| A human developer joining the project | [onboarding/for-human-developers.md](onboarding/for-human-developers.md) | [architecture/how-it-works.md](architecture/how-it-works.md) |
| An AI agent working in this repo | [onboarding/for-agents.md](onboarding/for-agents.md) | [playbooks/](playbooks/README.md) |
| A maintainer / reviewer / release owner | [onboarding/for-maintainers.md](onboarding/for-maintainers.md) | [maintainers/](maintainers/README.md), [adr/](adr/README.md), [postmortems/](postmortems/README.md) |
| A stakeholder who needs the decision summary | [papers/02-stakeholder-handoff.md](papers/02-stakeholder-handoff.md) | [papers/01-philosophy.md](papers/01-philosophy.md) |
| An engineer who wants the full technical argument | [papers/03-technical-whitepaper.md](papers/03-technical-whitepaper.md) | [architecture/data-model.md](architecture/data-model.md) |
| Someone tracking feature history & ongoing changes | [CHANGELOG.md](CHANGELOG.md) | [postmortems/](postmortems/README.md), [adr/](adr/README.md) |
| Someone re-integrating or removing the feature | [reincorporation.md](reincorporation.md) | [playbooks/PB-02-add-a-setting-end-to-end.md](playbooks/PB-02-add-a-setting-end-to-end.md) |

## Map of this wiki

```
agentswarm/
├── README.md                      ← you are here
├── CHANGELOG.md                   ← chronological feature changelog (Phases 1–8, fixes, ADRs, PMs)
├── agentswarm.md … agentswarm4.md ← ORIGINAL SPECS (source of truth for intent; do not edit)
├── glossary.md                    ← every term in one place
├── reincorporation.md             ← how to re-apply / port / cleanly remove the feature
├── papers/
│   ├── 01-philosophy.md           ← why this exists, what it believes
│   ├── 02-stakeholder-handoff.md  ← what was delivered, risks, decisions needed
│   └── 03-technical-whitepaper.md ← full technical design & evidence
├── onboarding/
│   ├── for-human-developers.md    ← 15-minute orientation
│   ├── for-agents.md              ← rules of engagement for AI agents
│   └── for-maintainers.md         ← ownership, review checklist, release gates
├── maintainers/                   ← in-depth zero-to-hero Maintainers' Handbook & SQLite cookbook
│   ├── README.md                  ← structured 4-part learning path
│   ├── 01-system-from-scratch.md  ← zero-prior-knowledge architecture walkthrough
│   ├── 02-codebase-tour.md        ← line-by-line ownership map & invariants
│   ├── 03-operating-handbook.md   ← DB paths, WAL/flush rules, verified SQL queries (Q1–Q8)
│   └── 04-failure-modes-and-drills.md ← mutation proofs (M1–M5) & recovery drills
├── architecture/
│   ├── how-it-works.md            ← inner workings and *why this is possible*
│   ├── data-model.md              ← tables, storage keys, state shapes
│   └── configuration.md           ← every setting, env var, precedence
├── adr/                           ← Architecture Decision Records (0001–0014)
├── postmortems/                   ← blameless post-mortems (PM-001–PM-015)
├── playbooks/                     ← step-by-step operational runbooks (PB-01–PB-08)
└── implementation/
    ├── file-map.md                ← every file touched and what it owns
    └── findings.md                ← what we learned, limits, open questions
```

## The feature in one paragraph

A parent agent can (1) **suspend** itself and its whole child hierarchy at safe execution boundaries and later **resume** exactly where each stream left off (*Hierarchical Defer*); (2) subject a completed task to **one bounded, evidence-based adversarial review** that must end in a decision (*Critical Completion Review*); and (3) **classify** a task and spawn the right **specialist child agents** that run in dependency-ordered stages, hand context forward, fail over once on failure, and report a synthesized result (*The Legion*). With [ADR-0012](adr/ADR-0012-automatic-legion-default.md) and [ADR-0013](adr/ADR-0013-orchestrator-conductor-tool-and-streaming-progress.md), the parent model acts as the **Orchestrator Conductor**: Legion runs automatically on suitable tasks, and the conductor can explicitly dispatch specialist teams via `engage_swarm` with auto-approval, stream real-time progress cards into the chat feed, and plan milestone roles in Plan Mode. With [ADR-0014](adr/ADR-0014-tool-argument-stream-deduplication-and-self-healing-parser.md), streaming provider transports slice tool argument snapshots and map interleaved tool identities, `StreamResponseHandler` self-heals identical duplicate JSON roots, and `LegionAgentHost` circuit-breaks transport decoding errors with `safeToRetry: false`. All swarm state persists through the existing SQLite buffer (`BufferedDbPool`) — no new queue, engine or mailbox.

## Status of this documentation

- Written against the active working tree. Check `git status` and `git log` before assuming it is merged.
- Verified at authoring time: type-check (root + `webview-ui`), Biome lint on touched files (1,765 files checked with 0 errors), 190 backend unit tests passing (covering Auxiliary, Legion Host, Tool Adapter, Task Legion, Engage Swarm Handler, ToolSet Discovery, Guarded Streams, State Keys, Codex Streaming deduplication, and StreamResponseHandler self-healing), and 7 webview unit tests passing.
- **Not verified:** behaviour inside a live VS Code extension host with real remote model network drops. See [implementation/findings.md](implementation/findings.md#known-limits-and-open-questions).

## Conventions

- Paths are relative to the repo root (`/Users/bozoegg/Downloads/LUMI`) unless stated.
- "Stream" = an independent agent execution context (row in `agent_streams`). "Parent/child" = `parentId` link.
- Claims in this wiki are tagged **Verified** (backed by a test or command you can re-run) or **Unverified** (design intent or reasoning only).

