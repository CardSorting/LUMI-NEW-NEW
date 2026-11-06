# ADR-0020 — Legion Handoff Sanitization, Two-Phase Formation Reservations & Unsettled State Reconciliation

## Context

As LUMI's multi-agent Legion coordinator handles high-concurrency tasks, streaming progress, and autonomous specialist execution, three critical boundary failure modes were identified:

1. **Handoff XML Injection & Truncation Corruption:**
   Specialist completion summaries are embedded into parent prompts and downstream specialist assignments using `<specialist_handoff>` XML tags. If untrusted specialist reports contained raw `<` or `>` characters, or exceeded context window budgets, the resulting XML structure broke model parsing. Splitting multi-byte UTF-16 surrogate pairs during truncation also caused decoding corruptions.
2. **Concurrent Formation Token Races:**
   When multiple asynchronous events or automated triggers attempted to form a Legion team simultaneously, race conditions occurred where two parallel coordinator loops spawned competing specialist teams for the same parent stream.
3. **Unconfirmed Specialist Host Halts & Settlement Failures:**
   If a specialist execution host stopped unexpectedly without confirming whether work completed or failed (e.g. host rejection, timeout, or lost connection), or if SQLite persistence threw an error during `completeStream` or `failStream`, the runner previously marked the stream as `failed` or proceeded blindly. Downstream specialists then operated on absent or corrupt state.
4. **Skills Catalog Injection & Hang Risks:**
   Specialist prompts dynamically loaded available skills. If skill files were large, invalid, or contained adversarial instructions in their descriptions, specialists could be misled. Furthermore, synchronous or uninterruptible skill directory scanning could hang if disk I/O stalled.

---

## Decisions

1. **Surrogate-Safe Handoff Sanitization (`LegionHandoff.ts`):**
   - Implemented `formatLegionHandoffText(text: string, maxBytes = 12_000): string`:
     - Escapes untrusted text: `&` $\rightarrow$ `&amp;`, `<` $\rightarrow$ `&lt;`, `>` $\rightarrow$ `&gt;`.
     - Caps encoded UTF-8 byte size to `maxBytes` (default 12 KB).
     - Uses binary search to find the maximum substring whose escaped representation plus truncation notice fits within `maxBytes`.
     - Protects UTF-16 surrogate pairs: if truncation falls on a high surrogate (`/[\uD800-\uDBFF]/`), steps back by one code unit to avoid split surrogate corruption.
   - Implemented `legionHandoffStatus(status: string): string`:
     - Enforces regex `^[a-z_]{1,40}$`, falling back to `"unknown"`.

2. **Two-Phase Formation Reservations & Dispatch Tokens:**
   - Implemented two-phase token reservation in `LegionCoordinator.ts` and `LegionExecutionReceipt.ts`:
     - `acquireFormationReservation(parentStreamId)`: acquires an exclusive in-memory reservation before formation starts; verified via `hasOutstandingFormationReservation`.
     - `acquireAutomaticFormationToken(parentStreamId, objective)`: persistent SQLite check ensuring only one automatic formation runs per parent stream objective.
     - `acquireFormationDispatchToken(parentStreamId, formationId)`: guarantees only one pipeline driver runs for an active formation.
     - `acquireDispatchToken(streamId)`: ensures no specialist is claimed or executed more than once.

3. **`needs_reconciliation` State Machine Transition:**
   - In `LegionPipelineRunner.ts`, when a specialist host stops without confirming execution termination or when SQLite settlement fails:
     - The runner returns `{ status: "needs_reconciliation", detail: ... }`.
     - The member is **not** flipped to `failed` or `completed`; it remains in `running` status.
     - Prevents futile failover rerouting or duplicate work until a human or coordinator inspects persisted evidence.

4. **Skills System Hardening & Catalog Sanitization (`skills.ts`, `LegionAgentHost.ts`):**
   - Added `AbortSignal` across all skill functions (`discoverSkills`, `scanSkillsDirectory`, `loadSkillMetadata`, `getSkillContent`). Scans abort promptly on task cancellation.
   - Skills system prompt framing: explicitly warns that skill catalog descriptions are untrusted catalog data, not instructions.
   - Skill catalog bounding: descriptions truncated to 1,000 characters in conductor prompts, and to 300 characters (max 50 skills) in `LegionAgentHost.formatAvailableSkills`.
   - `UseSkillToolHandler`: verifies frontmatter integrity (`name`, `description`) on use; if metadata changed or is invalid, returns an explicit error directing rediscovery.

---

## Consequences

### Positive

- Specialist handoff XML payloads are well-formed, size-capped, and free of surrogate corruption.
- Multi-trigger races cannot spawn duplicate specialist teams.
- Unsettled or crashed specialists require explicit reconciliation rather than silently failing downstream stages.
- Skill loading is fully abortable and resistant to catalog prompt injection.

### Negative / Trade-offs

- Pipelines encountering settlement failures halt in `needs_reconciliation` and require intervention or explicit task restart.
- Handoff reports exceeding 12 KB are truncated with a disclaimer notice.

---

## Evidence

- **Auxiliary & Concurrency Suite:** `src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts` Section 8:
  - `settles a claimed specialist when cancellation occurs during progress reporting`
  - `requires reconciliation if pre-start cancellation cannot be recorded`
  - `requires reconciliation when cancellation interrupts tool initialization`
  - `requires reconciliation when a specialist completed/failed result cannot be settled`
  - `flushes a full Legion lifecycle with multi-worker claim races to real SQLite`
- **Host & Adapter Suite:** `src/core/task/legion/__tests__/LegionAgentHost.test.ts`, `LegionToolAdapter.test.ts`.
- **Skills Suite:** `src/core/context/instructions/user-instructions/__tests__/skills.test.ts`.
