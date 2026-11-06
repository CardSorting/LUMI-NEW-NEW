# ADR-0017 — Dynamic Project Knowledge, Scoped Blackboard Sharing & Credential Sanitization

## Context

In multi-agent and multi-stage autonomous workflows under LUMI's Agent Swarm and The Legion ([ADR-0008](ADR-0008-deterministic-legion-classification.md), [ADR-0009](ADR-0009-legion-lifecycle-dag-failover-terminal-states.md), [ADR-0012](ADR-0012-automatic-legion-default.md)), specialists routinely discover critical workspace heuristics during lead recon and implementation (e.g. build scripts, testing flags, directory structures, migration caveats).

Prior to this decision, several architectural limitations existed:

1. **Ephemeral Stage Knowledge:** Observations gathered by early specialists (e.g. `legion_researcher` or `legion_architect`) evaporated when their individual streams completed. Subsequent execution and verification specialists (`legion_implementer`, `legion_verifier`) were forced to rediscover the same workspace properties from scratch.
2. **Cross-Workspace Bleeding:** Heuristics learned in one project could inadvertently leak into unrelated projects opened in the IDE if stored in un-scoped global memory.
3. **Credential & Secret Leakage:** Specialists inspecting config files (`.env`, `package.json`, credentials) frequently captured sensitive strings. Passing unsanitized blackboard observations forward into prompt contexts risked leaking API keys, personal access tokens, and passwords into model completions and persistent databases.
4. **Unbounded Storage Growth:** Heuristics stored indefinitely caused database bloat and degraded prompt token budgets over time.

---

## Decisions

1. **Workspace-Scoped Knowledge Isolation (`LegionKnowledge.ts`):**
   - Observations are isolated by workspace directory using a cryptographic SHA-256 digest:

     ```ts
     export function legionWorkspaceScope(cwd: string): string {
         return createHash("sha256").update(path.resolve(cwd)).digest("hex")
     }
     ```
   - All knowledge entries are tagged with `workspaceScope` inside their JSON metadata and marked `unverified: true` to prevent unvalidated observations from being treated as authoritative system instructions.

2. **Durable Knowledge Storage in `agent_knowledge`:**
   - Observations are persisted in the existing `agent_knowledge` table via `BufferedDbPool` under `type = "legion_workspace_heuristic"`.
   - Each observation is assigned an immutable 30-day expiration window (`LEGION_KNOWLEDGE_TTL_MS = 30 * 24 * 60 * 60 * 1000`).
   - Querying workspace knowledge (`recallLegionKnowledge(scope)`) sorts entries by `createdAt` descending, caps returned items at `MAX_ITEMS = 20`, and filters by active TTL (`expiresAt > Date.now()`).

3. **Multi-Tier Credential & Injection Sanitization:**
   - `isReusableLegionObservation(value: string)` enforces strict validation before storing or sharing any observation:
     - String length bounded between 1 and 500 characters.
     - Single-line only: newlines (`\r`, `\n`) and ASCII control characters (`char code <= 0x1f`) are strictly rejected.
     - Prohibits sensitive keywords: `password`, `secret`, `api_key`, `access_token`, `bearer`, `private_key`.
     - Scans against `CREDENTIAL_PATTERNS` regex suite covering GitHub tokens (`ghp_`, `github_pat_`), OpenAI/Anthropic keys (`sk-proj-`, `sk-ant-`), AWS access keys (`AKIA`, `ASIA`), Google API keys (`AIza`), Slack tokens (`xoxb-`), JWT strings (`eyJ...`), URL basic authentication (`user:pass@host`), and query parameter credentials (`?token=`, `&key=`).
   - Non-compliant items are discarded without throwing, protecting the execution loop.

4. **Dynamic Swarm Blackboard & Stage Handoff Continuity:**
   - Completed specialist summaries are parsed for `Heuristic:` annotations and accumulated in `manifest.swarmBlackboard` and `priorStageHandoffContext`.
   - Handoff context is injected into downstream specialist prompts, ensuring later stages (e.g. QA, hardening) immediately receive sanitized findings from earlier stages.
   - When a new Legion formation is spawned for the same parent or workspace, matching scoped blackboard observations are automatically seeded into the new formation manifest.

5. **Atomic Expiration Pruning:**
   - `BufferedDbPool.pruneExpiredAgentKnowledge(type, now)` flushes pending writes and acquires flush and state mutexes, safely removing expired entries without racing in-flight buffered writes or leaving dangling knowledge edges.

---

## Consequences

### Positive

- Specialists inherit verified workspace conventions without redundant inspection turns.
- Credential leak vectors are closed: secrets cannot enter blackboard contexts or long-term storage.
- Workspace boundaries are mathematically strict: projects never share heuristics.
- Expired observations are automatically pruned after 30 days.

### Negative / Trade-offs

- Legitimate observations containing false-positive credential-like substrings (e.g. hashes or base64 IDs) are excluded from the blackboard.
- Storage operations require database flush synchronization.

---

## Evidence

- **Unit & Concurrency Tests:** `src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts` Section 5 & 8:
  - `passes completed observations to later stages and persists scoped knowledge for later tasks`
  - `rejects common credential shapes from reusable knowledge without dropping ordinary observations`
  - `only carries prior blackboard observations across matching workspace scopes`
  - `does not revive expired observations from an old formation`
  - `pruneExpiredAgentKnowledge` concurrency and renewal assertions against real SQLite.
- **Specialist Suite:** `src/core/task/legion/__tests__/Milestone1KnowledgeSpecialist.test.ts`.
