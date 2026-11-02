# ADR-0011 — Keep `legion_Trends_ux` as a legacy alias of `legion_ux_ergonomics`

**Status:** Accepted

## Context
An early role id (`legion_Trends_ux`) was mis-named (mixed case, wrong word). Callers and persisted data may already reference it.

## Decision
`legion_ux_ergonomics` is canonical; `legion_Trends_ux` remains accepted and is normalized (`normalizeLegionSpecialistRole`). They share one codename (`AESTHETE-UX`) and are de-duplicated in `listSpecialistDescriptors()`. The settings UI shows the canonical id.

## Consequences
+ Backward compatible. − Two ids for one role until a migration window passes.

## Alternatives
- Hard rename — rejected (breaks stored manifests/callers).
