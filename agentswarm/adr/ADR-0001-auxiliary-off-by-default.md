# ADR-0001 — Auxiliary, off by default, zero overhead when off

**Status:** Accepted

## Context
`agentswarm2.md` §1 requires Critical Completion Review to default to *Disabled* and to leave "normal completion and reporting behaviour" untouched when off. LUMI's single-agent path is the product's core; a new capability must not tax or destabilise it.

## Decision
All three capabilities (Review, Defer, Legion) are opt-in. Every default is `false` (`safe_boundary`/`adaptive`/`1`/`1`/`4` for tunables). Each entry point checks the resolved feature state first and returns immediately — `runReview` returns `ACCEPT, executed:false`; `deferPipeline`/`deferAgent` return `deferred:false`; `formAndSpawnLegion` returns `formed:false`. Non-Legion streams cost one profile lookup in `settleLegionSpecialist`.

## Consequences
+ Safe rollout; trivially reversible; the off-path has a regression test.
− Every new code path needs a toggle check and an "off" test.
− One extra memory lookup per stream completion even when Legion is unused (accepted: tiny, and avoids a global flag read race).

## Alternatives
- Always-on with a "light" mode — rejected: violates the spec and risks regressions.
- Separate extension/plugin — rejected: needs access to `Orchestrator`/`BufferedDbPool` internals.

## Evidence
Test: *"is disabled by default and does not alter normal completion or defer flows"*. `state-keys.test.ts` asserts defaults.
