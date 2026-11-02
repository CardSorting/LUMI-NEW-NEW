# ADR-0008 — Deterministic, model-free Legion classification

**Status:** Accepted

## Context
The Legion must "classify … spawn the correct agent and specialist". A model call per delegation adds latency, cost, nondeterminism and a new failure mode — on the hot path of delegation.

## Decision
Classification is pure scoring over (task text + parent focus + referenced/target files + caller preferences/exclusions): weighted keyword groups with diminishing returns, file-pattern affinity, intent alignment, explicit preference, complexity score → strategy → roster size, verifier insertion, file partitioning. Same input ⇒ same roster. See [how-it-works §5.1](../architecture/how-it-works.md).

## Consequences
+ Explainable (each assignment carries `rationale`, `confidence`, signals); testable; free.
− Keyword heuristics can mis-rank unusual phrasing. Mitigation: `preferredRoles` / `excludeRoles`, explicit `strategy`, and per-task overrides.

## Alternatives
- LLM router — rejected for v1 (cost/latency/nondeterminism); can be layered later as an optional re-ranker without changing the manifest contract.

## Evidence
Test: *"classifies tasks across intents, file paths, strategies, and role constraints"*.
