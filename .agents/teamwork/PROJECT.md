# Project: agentswarm-resilience-and-dynamic-learning

## Architecture

LUMI's multi-agent swarm (`agentswarm` / `The Legion`) provides hierarchical delegation, specialist isolation, and cooperative execution over an underlying SQLite `BufferedDbPool` and VS Code Extension Host environment.
The architecture spans four core planes:

1. **Context & Dynamic Knowledge Plane**: Dynamic project discovery, artifact tracking (`workspace_artifacts`), manifest change invalidation (`EnvironmentIntegrity`), token-bounded context injection, and specialist skill enablement (`use_skill`, `LEGION_TOOL_NAMES`).
2. **Execution & Lifecycle Plane**: Multi-stage specialist coordination (`LegionCoordinator`, `LegionPipelineRunner`), progressive handoffs, partial work preservation, abort signal cancellation, and startup lease reconciliation.
3. **Storage & Persistence Plane**: Causal operation ordering (`BufferedDbPool.opSeq`), non-retryable error reporting, lifecycle-bound shadow overlays, and multi-reservation conflict detection (`selectWhere`).
4. **Workspace, Governance & Ergonomics Plane**: Automated CI guardrails (`docs:check-*`), Phase 10 documentation synchronization, repository hygiene, and dedicated swarm test runners (`test:swarm`).

---

## Feature Inventory

Every feature from the Survey phase is enumerated below with its assigned milestone:

| #   | Feature                                           | Description                                                                                                                                                                 | Milestone | Source              |
| --- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------- |
| F01 | Specialist Skill Activation                       | Allow specialists to invoke installed skills by adding `use_skill` to `LEGION_TOOL_NAMES` and wiring `UseSkillToolHandler` in `LegionToolAdapter`.                          | M1        | Survey (Explorer 1) |
| F02 | Dynamic Skill Discovery Context                   | Inject discovered project skills into `LegionAgentHost` initial conversation context.                                                                                       | M1        | Survey (Explorer 1) |
| F03 | Multi-Language Environment Integrity              | Expand `EnvironmentIntegrity.ts` `PROJECT_MARKERS` to support CMake, C/C++ Makefile, Meson, Gradle, and Maven; add dynamic cache invalidation on manifest writes.           | M1        | Survey (Explorer 1) |
| F04 | Progressive Intra-Stage Handoffs                  | Preserve partial work and failure summaries in `priorStageHandoffContext` (`LegionCoordinator.ts`), forward sibling handoffs in Stage 2.                                    | M1        | Survey (Explorer 1) |
| F05 | Reactive Workspace Artifact Tracking              | Track created/modified files in `LegionToolAdapter` / `WriteToFileToolHandler` and inject token-bounded `<workspace_artifacts>` into context.                               | M1        | Survey (Explorer 1) |
| F06 | Cross-Turn Reflexion & Blackboard                 | Wire `TaskState.swarmBlackboard` to `agent_streams.sharedMemoryLayer` / `agent_knowledge` for cross-turn learning and heuristic injection.                                  | M1        | Survey (Explorer 1) |
| F07 | Domain-Agnostic Archetype Adaptation              | Decouple specialist role descriptions in `LEGION_SPECIALIST_REGISTRY` from LUMI-specific stack keywords.                                                                    | M1        | Survey (Explorer 1) |
| F08 | Fix CI Readme Version Breakages                   | Update `README.md` version badges and citations from 26.0.0 to 26.4.0 so `npm run docs:check-root-readme` and `docs:check-readme-metrics` pass cleanly.                     | M2        | Survey (Explorer 2) |
| F09 | Phase 10 Knowledgebase Synchronization            | Update `agentswarm/README.md`, `maintainers/README.md`, `file-map.md`, `reincorporation.md`, and `PB-07` with ADR-0016, PM-017, terminalFileReadPolicy, and 332 test count. | M2        | Survey (Explorer 2) |
| F10 | Monorepo Hygiene & Dead File Removal              | Delete tracked 0-byte and obsolete log/script files (`0`, `biome_errors.txt`, `build_output*.txt`, `rename_*.txt`, `grounding.txt`, `changelogv3.md`), curate `knip.json`.  | M2        | Survey (Explorer 2) |
| F11 | Developer Ergonomics (`test:swarm` & doc checker) | Add `npm run test:swarm` to `package.json` for rapid 2-second swarm verification; add `scripts/check-agentswarm-docs.mjs` for automated doc link verification.              | M2        | Survey (Explorer 2) |
| F12 | Causal Ordering in `BufferedDbPool`               | Replace type-string sorting in `BufferedDbPool.flush()` with monotonic `opSeq` to prevent same-batch write resurrection.                                                    | M3        | Survey (Explorer 3) |
| F13 | Non-Retryable Flush Error Reporting               | Add structured error logging and promise rejection for non-retryable SQLite errors in `BufferedDbPool.flush()` to eliminate silent data loss.                               | M3        | Survey (Explorer 3) |
| F14 | Lifecycle-Bound Shadow Buffers                    | Eliminate arbitrary 5-minute wall-clock shadow eviction in `BufferedDbPool.cleanupShadows` for active stream IDs.                                                           | M3        | Survey (Explorer 3) |
| F15 | Non-Unique Key Collision Fix                      | Replace `selectOne` with `selectWhere` in `Orchestrator.ts:807` and `1257` to detect active file reservations across multiple stream rows (PM-008).                         | M3        | Survey (Explorer 3) |
| F16 | Abort Cancellation Sentinel                       | Return `{ status: "cancelled", safeToRetry: false }` on `AbortError` in `LegionAgentHost.ts` to prevent runaway automatic failover.                                         | M3        | Survey (Explorer 3) |
| F17 | Review-Completion Gate Decoupling                 | Do not increment `consecutiveMistakeCount` when `criticalReviewReport.decision === "REMEDIATE"` in `AttemptCompletionHandler.ts`.                                           | M3        | Survey (Explorer 3) |
| F18 | Orphaned Stream Startup Reconciliation            | Implement startup reconciliation in `Orchestrator.initialize()` to automatically mark stale active streams as failed on extension restart.                                  | M3        | Survey (Explorer 3) |
| F19 | Comprehensive Regression & Verification Suite     | Add automated unit tests covering all patched failure modes (causal sequence, non-retryable flush errors, `selectWhere` collisions, abort cancellation, skill invocation).  | M4        | Survey (All)        |

---

## Milestones

| #   | Name                                                       | Scope                             | Dependencies | Status |
| --- | ---------------------------------------------------------- | --------------------------------- | ------------ | ------ |
| M1  | Dynamic Project Knowledge & Agent Self-Improvement (R1)    | F01, F02, F03, F04, F05, F06, F07 | none         | DONE   |
| M2  | Workspace Audit, Hygiene, CI Fixes & Ergonomics (R2)       | F08, F09, F10, F11                | none         | DONE   |
| M3  | System Failure Modes, Persistence & Durable Hardening (R2) | F12, F13, F14, F15, F16, F17, F18 | none         | DONE   |
| M4  | Final Verification, Regression Testing & Adversarial Audit | F19 + Full Suite Verification     | M1, M2, M3   | DONE   |

---

## Interface Contracts

### M1 ↔ Conductor & Specialists

- `LEGION_TOOL_NAMES`: includes `DietCodeDefaultTool.USE_SKILL`.
- `priorStageHandoffContext`: preserves `m.resultSummary || m.failureReason` with status annotations.
- `EnvironmentIntegrity.PROJECT_MARKERS`: maps `cmake`, `c_cpp`, `meson`, `gradle`, `maven` to manifests and version commands.
- `TaskState.swarmBlackboard`: array of learned project truths propagated to subsequent agent prompts.

### M3 ↔ Storage & Coordination

- `WriteOp`: includes monotonic `opSeq: number`.
- `BufferedDbPool.flush()`: sorts by `(TABLE_FK_ORDER, LAYER_PRIORITY, opSeq)`. Throws/logs on non-retryable errors.
- `Orchestrator.reserveFiles` / `detectFileCollisions`: invokes `selectWhere("agent_memory", ...)` and filters by `activeStreamIds`.
- `LegionAgentHost.runSpecialist`: returns `{ status: "cancelled", safeToRetry: false }` if `signal.aborted || error.name === "AbortError"`.

---

## Code Layout

- `src/core/task/legion/`: Legion host, tool adapter, and test suites.
- `src/infrastructure/ai/`: Orchestrator, LegionCoordinator, LegionPipelineRunner.
- `src/infrastructure/db/`: BufferedDbPool, database layers.
- `src/core/integrity/`: EnvironmentIntegrity.
- `src/core/task/tools/handlers/`: Tool handlers (AttemptCompletion, EngageSwarm).
- `agentswarm/`: Architecture docs, ADRs, post-mortems, maintainer playbooks.
- `scripts/`: CI checks and build utilities.
- `package.json`, `README.md`: Workspace manifest, CI scripts, and documentation.
