# Changelog

## [26.5.0] - 2026-11-05

### Added

- **Dynamic Project Knowledge & Swarm Blackboard (`LegionKnowledge.ts`):** Specialist agents now accumulate workspace-scoped heuristics in a durable `agent_knowledge` store (SHA-256 workspace digest, 30-day TTL, 20-item cap). Heuristics propagate forward across formation stages and subsequent formations via a `swarmBlackboard`, accelerating complex multi-stage tasks. All observations are screened through `CREDENTIAL_PATTERNS` (GitHub, OpenAI, Anthropic, AWS, GCP, Slack, JWT, URL basic-auth, query secrets) before persisting.
- **Agent Self-Improvement & Skills Hardening (`skills.ts`, `UseSkillToolHandler.ts`):** Skill discovery and loading now support `AbortSignal` for immediate cancellation. System prompts frame skill catalog content as untrusted external data. Specialist skill catalogs are size-capped to prevent prompt bloat. `UseSkillToolHandler` includes recovery guidance when skills are unavailable.
- **Workspace Environment Integrity (`EnvironmentIntegrity.ts`):** Deterministic SHA-256 manifest fingerprints computed from `size`, `mtimeMs`, and `ctimeMs` across project markers (`package.json`, `Cargo.toml`) and version manifests (`.nvmrc`, `pyproject.toml`, `rust-toolchain`, etc.). Leases are invalidated reactively whenever `ApplyPatchHandler`, `WriteToFileToolHandler`, or `disk.ts` modifies a tracked manifest file. A `WeakRef` instance registry prevents extension-host memory leaks, and a generational counter retries concurrent fingerprint probes automatically. PATH shadowing detection warns when `process.execPath` and PATH-resolved Node binaries diverge.
- **Legion Handoff Sanitization (`LegionHandoff.ts`):** `formatLegionHandoffText` XML-escapes `<` and `>`, performs binary-search UTF-8 truncation capped at 12 KB, and guards against midpoint splitting of UTF-16 surrogate pairs. Status fields are validated via `legionHandoffStatus` (`^[a-z_]{1,40}$`), falling back to `"unknown"`.
- **Two-Phase Formation Reservations (`LegionCoordinator.ts`):** `acquireFormationReservation` and `acquireAutomaticFormationToken` prevent duplicate parallel team formations across concurrent triggers. Formation dispatch tokens are atomically verified against real SQLite before proceeding.
- **Unsettled State Reconciliation (`LegionPipelineRunner.ts`):** When specialist host termination or SQLite settlement cannot be confirmed, the pipeline transitions to `needs_reconciliation`, keeping members in `running` status and preventing duplicate failovers or corrupt stage transitions.

### Changed

- **Terminal Supervision (`SupervisedShell.ts`, `CommandExecutor.ts`):** Post-spawn stream errors are now isolated via `onObservationError` — they are logged without falsely marking the child process as terminated. `stop()` ensures the child has spawned before issuing OS cancellation signals (`taskkill /T /F` on Windows, process group `kill -TERM`/`-KILL` on POSIX) and clears `stopPromise` on failure to allow retries. View epoch fencing in `CommandExecutor` prevents background output readers from publishing into replacement chat views after task switches. Replayed execution IDs preserve the original message row and mark the new row `not_started`.
- **Strict Command Outcome Semantics (`commandOutcome.ts`):** Only an observed `exitCode === 0` denotes `completed`; non-zero exit codes denote `failed`; missing exit codes without signals remain `unconfirmed`. Unconfirmed commands retain semantic execution fences in `ActionExecutionRegistry` until explicitly reconciled, preventing concurrent duplicate dispatches.
- **BufferedDbPool Hardening (`BufferedDbPool.ts`):** Throws typed `ShadowCommitError` when transaction shadow commits fail, retaining uncommitted shadows in memory. `stop()` rejects shutdown while uncommitted shadows exist. Added SQLite column affinity matching (`text`, `numeric`, `blob`) and SQLite value comparison ordering (NULL < number < text < blob) to buffered reads. Overhauled predicate evaluation supports `IS`, `IS NOT`, `LIKE`, `>`, `<`, `>=`, `<=`, `IN`, `!=`, `=`. Added `flushFailure` latching to prevent cascading flush loops. `pruneExpiredAgentKnowledge` atomically cleans expired `agent_knowledge` records with flush-barrier and mutex coordination.
- **Action Execution Registry (`ActionExecutionRegistry.ts`):** Surfaces `unresolved_commands` and `unresolved_actions` with priority ordering. `commandObserved` tracking prevents delayed foreground snapshots from clearing lost-outcome evidence. Added `specialistUsageUnverified` flag to `TaskState`.

### Fixed

- File reservation race: two-phase reservations (`acquireFormationReservation`, `acquireAutomaticFormationToken`, `acquireFormationDispatchToken`) resolve the previously open check-then-act race where concurrent `formLegion` calls could both pass the active-holder check for the same file (L11).
- Specialist budget starvation: token limits are now only enforced when `options.maxTokens` is explicitly set, removing the arbitrary 100k cumulative token ceiling that starved multi-turn specialist teams after 5–6 turns.

### Tests

- `npm run test:swarm`: **455 passing** across Agent Swarm, Legion Host, Tool Handlers, Terminal, and Policy suites.
- `npm run test:execution`: **465 passing** (reliability runner) + **32 passing** webview tests.
- Multi-process concurrency proofs in `AgentSwarmAuxiliary.test.ts` spawn concurrent real Node worker processes against a real SQLite database.
- `npm run check-types`: 0 TypeScript errors (root + `webview-ui`).
- `npm run lint`: 0 errors, 0 warnings across 2,201 files.

---

## [22.0.0] - 2026-09-27

- Persist command and helper execution identities, completed results, and partial evidence across extension-host restarts. Unfinished commands without a live execution handle remain explicitly unknown and are never automatically replayed.
- Reconcile helper batches and status rows by identity without duplicate work. Cancelled and retired helpers cannot regain authority or execute queued file writes after recovery.
- Supervise fallback shell execution, retain command ownership when tasks reopen, and normalize escaped shell operators before dispatch.
- Serialize file saves, reject stale writes, preserve committed partial results, and isolate optional tracking and UI failures from execution outcomes.
- Add regression coverage for restart recovery, helper deduplication and cancellation, shell lifecycle, and concurrent file mutations.

See [command and helper execution reliability](docs/architecture/command-helper-execution.md) for restart semantics and platform boundaries.
