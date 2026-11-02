# ADR-0005 — Bounded 1+1 review with strict finding categories

**Status:** Accepted

## Context
`agentswarm2.md`: criticism must *converge toward a decision*; never conflate defects, risks, unverified assumptions and preferences; never manufacture deficiencies; stop.

## Decision
Seven categories split into three buckets (confirmed defects / risks-and-assumptions / advisory). A claimed defect that is hypothetical or unverified is **downgraded** to `unverified_assumption`. Only confirmed defects can yield `REMEDIATE`. Bounds: 1 initial review per completion event + 1 corrective pass, persisted in `critical_review_cycle:<id>`; a still-failing corrective pass `ESCALATE`s rather than looping. Corrective tasks are merged into the existing roadmap.

## Consequences
+ Predictable termination; reports distinguish verified from unverified (spec §8).
− Review quality depends on the findings supplied/derived; the engine classifies, it does not itself execute an LLM review.

## Alternatives
- Free-form review text — rejected (can't enforce bounds or categories).

## Evidence
Section 2 tests incl. "optional items never trigger REMEDIATE" and bounded 1+1.
