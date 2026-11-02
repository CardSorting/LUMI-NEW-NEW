# PB-03 — Add a Legion specialist archetype

## Steps
1. `AgentSwarmConfig.ts`: add the role id to `LegionSpecialistRole` (and `CanonicalLegionSpecialistRole`; extend `normalizeLegionSpecialistRole` if there are aliases).
2. `LegionCoordinator.ts`: add a `LEGION_SPECIALIST_REGISTRY` entry — `title`, unique `codename`, `subagentType` (`worker`/`verifier`/`researcher`), `capabilities`, `preferredLayers`, `defaultExecutionBoundary`, weighted `keywords`, `filePatterns`.
3. **Stage:** execution order comes from `classifyTaskForLegion` (`lead` for architect/researcher, `sequential_after_workers` for verifier, `parallel` otherwise). If your role needs a different stage, change that mapping **and** `getStageForExecutionOrder`, then update the stage tests.
4. If it should receive remediation work, check `recommendRemediationSpecialist` still picks sensibly.
5. UI: add it to `LEGION_SPECIALIST_ARCHETYPES` in `FeatureSettingsSection.tsx` with the right `stage`.
6. Tests: extend *"classifies tasks across intents, file paths, strategies, and role constraints"*; add a formation test using `preferredRoles`/`excludeRoles` for determinism.

## Gotchas
- Keywords are matched as word-prefix (`\bterm`); no leading spaces in terms.
- Codenames must be unique (roster de-duplicates by codename).
- Weight keywords carefully — a broad term (`state`, `system`) will pull your role into unrelated tasks.

## Verify
Section 7 and 8 tests pass; classification of a few representative prompts matches intent.
