# ADR-0018 — Workspace Environment Integrity, Manifest Fingerprinting & Reactive Invalidation

## Context

In complex multi-agent execution sessions, agents frequently modify configuration manifests (e.g. `package.json`, `.nvmrc`, `pyproject.toml`, `setup.py`, `Cargo.toml`, `build.gradle.kts`). Such changes directly affect available toolchains, installed dependencies, and execution runtimes.

Prior to this decision, the environment integrity system had critical shortcomings:

1. **Stale Environment Leases:** The `EnvironmentIntegrity` class issued an L0/L1 lease that remained valid for 1 hour regardless of filesystem edits. If an agent modified dependencies or Node version manifests, subsequent command executions continued using stale probe conclusions.
2. **Probing Overhead:** Re-probing toolchains (spawning `node -v`, `git --version`, etc.) on every single tool invocation caused severe latency.
3. **Validation Race Conditions:** Multi-file edits (such as patch applications touching multiple files simultaneously) could cause partial or interleaved reads during environment validation probes.
4. **Toolchain PATH Shadowing:** System PATH differences between the extension host process (`process.execPath`) and the shell PATH could result in silent version divergence without warning the user or model.

---

## Decisions

1. **Deterministic Manifest Fingerprinting:**
   - Implemented `EnvironmentIntegrity.getManifestFingerprint()`:
     - Aggregates all project markers (`package.json`, `Cargo.toml`, `Pipfile`, `pom.xml`, etc.) and version manifests (`.nvmrc`, `.node-version`, `.python-version`, `pyproject.toml`, `setup.py`, `rust-toolchain`, `build.gradle.kts`, `.tool-versions`).
     - Gathers deterministic file stats (`size`, `mtimeMs`, `ctimeMs`, or `:missing` if absent) and computes a SHA-256 fingerprint.
   - An environment lease is valid if and only if `cachedLease.manifestFingerprint === currentFingerprint`.

2. **Reactive Cache Invalidation via Manifest Interception:**
   - Added `EnvironmentIntegrity.isManifest(filePath: string): boolean` matching basenames against all recognized project and version manifests.
   - Wired invalidation directly into file mutation points:
     - `ApplyPatchHandler.ts`: calls `if (EnvironmentIntegrity.isManifest(path)) EnvironmentIntegrity.invalidateCache()`.
     - `WriteToFileToolHandler.ts`: calls `if (EnvironmentIntegrity.isManifest(relPath)) EnvironmentIntegrity.invalidateCache()`.
     - `src/core/storage/disk.ts`: calls cache invalidation on relevant message and storage writes.
   - Track workspace artifacts on task state (`taskState.trackWorkspaceArtifact(path)`) on every manifest write.

3. **WeakRef Registry & Generational Concurrency Protection:**
   - Registered `EnvironmentIntegrity` instances using `WeakRef<EnvironmentIntegrity>` in `activeInstances`, preventing memory leaks while ensuring global cache invalidation sweeps reach all live workspaces.
   - Added `generation` counter to each instance. If a manifest edit occurs during an active validation probe (`this.generation !== generation`), the probe aborts and retries (up to 3 attempts) before returning a settle failure.

4. **Canonical Toolchain Shadowing Detection:**
   - Compares the canonical `fs.realpath` of `process.execPath` against the resolved PATH Node binary (`details.toolchain.node.path`).
   - If realpaths differ, emits a prominent shadowing alert: `⚠️ INTEGRITY: Active Node binary differs from PATH Node`.

---

## Consequences

### Positive

- Environment changes are detected instantly when manifest files are edited.
- Zero overhead for non-manifest file edits (`.ts`, `.py`, `.md`).
- Concurrent edits during probes settle cleanly via generational retries.
- WeakRef storage eliminates extension host memory leaks.

### Negative / Trade-offs

- File system `stat` calls across manifest files are performed on lease checks.
- Rapid un-settled edits can trigger retries up to the 3-attempt limit.

---

## Evidence

- **Unit Tests:** `src/core/integrity/__tests__/EnvironmentIntegrity.test.ts`:
  - `invalidates lease on manifest change`
  - `detects PATH shadowing between active node and PATH node`
  - `handles generational race conditions during concurrent probes`
  - `isManifest correctly identifies version manifests and project markers`
- **Tool Handler Verification:** `ApplyPatchHandler.execution.test.ts`, `WriteToFileToolHandler.execution.test.ts`.
