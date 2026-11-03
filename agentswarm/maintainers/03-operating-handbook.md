# 03 — Day-2 Operating & SQLite Inspection Handbook

When you are operating or debugging Agent Swarm & The Legion on a developer machine or user report, **the SQLite database on disk is the ultimate source of truth**. This guide shows you exactly where the database lives, how `BufferedDbPool` writes to it, what log prefixes to grep, and **8 empirically verified `sqlite3` queries (`Q1`–`Q8`)** you can copy-paste to inspect any hierarchy, barrier, review, or Legion formation.

---

## 1. Where the SQLite Database Lives on Disk

In `src/core/controller/index.ts` (lines 199–203) and `src/infrastructure/db/Config.ts`:
- **Inside VS Code (Production / Extension Development Host):**
  `Controller` initializes the database at:
  ```text
  <context.storageUri || context.globalStorageUri>/joyzoning.sqlite
  ```
  Typical OS paths for VS Code `workspaceStorage` / `globalStorage`:
  - **macOS:** `~/Library/Application Support/Code/User/workspaceStorage/<workspace-hash>/lumi.lumi/joyzoning.sqlite` (or under `globalStorage/lumi.lumi/joyzoning.sqlite` if no workspace folder is open).
  - **Linux:** `~/.config/Code/User/workspaceStorage/<workspace-hash>/lumi.lumi/joyzoning.sqlite`
  - **Windows:** `%APPDATA%\Code\User\workspaceStorage\<workspace-hash>\lumi.lumi\joyzoning.sqlite`
- **Standalone CLI / Unit Tests (when `setDbPath` was not called):**
  Defaults to `<process.cwd()>/dietcode.db`.

### Find the active database file on macOS/Linux in one command
```bash
find ~/Library/Application\ Support/Code/User -name "joyzoning.sqlite" -exec ls -lh {} + 2>/dev/null
```

### SQLite Runtime Pragmas & Automatic Corruption Recovery (`Config.ts`)
- Every connection opens with:
  - `PRAGMA journal_mode = WAL;` (Write-Ahead Logging — creates `joyzoning.sqlite-wal` and `joyzoning.sqlite-shm` alongside the main file; **you can safely run read-only `sqlite3` queries while the extension is running**).
  - `PRAGMA synchronous = NORMAL;`
  - `PRAGMA foreign_keys = ON;` (Enforces `agent_tasks.streamId -> agent_streams.id` and `agent_memory.streamId -> agent_streams.id` with `ON DELETE CASCADE`).
- **Corruption auto-recovery:** If `better-sqlite3` detects a malformed database on startup (`SQLITE_CORRUPT` / `database disk image is malformed`), `Config.ts` automatically renames `joyzoning.sqlite` (and its `-wal`/`-shm` files) to `joyzoning.sqlite.corrupt.<unix_ms_timestamp>` and initializes a fresh database. Look for `.corrupt.*` files in the storage directory if a user reports sudden state loss.

---

## 2. Understanding `BufferedDbPool` Timing & Ordering

When inspecting the database or reading code, keep three `BufferedDbPool` (`src/infrastructure/db/BufferedDbPool.ts`) mechanics in mind:

1. **1-Second Flush Timer (`this.flushInterval`):**
   Direct writes (`dbPool.push(op)` / `dbPool.pushBatch(ops)` with no `agentId`) sit in `this.activeBuffer` for up to **1,000 ms** before flushing to SQLite, unless `await dbPool.flush()` is called explicitly.
2. **5-Minute Shadow Overlay Expiration (`cleanupShadows`):**
   Agent-scoped writes (`dbPool.push(op, agentId)`) sit in `this.agentShadows.get(agentId)`. A background timer runs every **30,000 ms** (`cleanupShadows`) and **permanently deletes** any shadow overlay that has not been touched for **5 minutes (`300,000 ms`)** (`[DbPool] Cleaned up expired shadow buffer for inactive agent: <id>`).
3. **Flush Sort Order (`flush()`):**
   When `flush()` drains `this.activeBuffer`, it sorts all buffered operations by:
   1. `TABLE_FK_ORDER` (`users:0`, `projects:1`, `tasks:2`, `task_steps:3`, `logs:4`, `agent_streams:5`, `agent_tasks:6`, `agent_memory:7`)
   2. `LAYER_PRIORITY` (`domain:0`, `infrastructure:1`, `ui:2`, `plumbing:3`)
   3. `table` name (`a.table.localeCompare(b.table)`)
   4. `op.type` alphabetically (`"delete"` < `"insert"` < `"update"` < `"upsert"`)

> [!WARNING]
> **The Same-Batch `delete` vs. `upsert` Trap ([PM-012](../postmortems/PM-012-post-resume-reconcile-and-delete-upsert-ordering.md)):**
> Because `"delete"` sorts alphabetically before `"upsert"`, if you queue an `upsert` and a `delete` for the exact same `(table, layer, key)` inside the same un-flushed 1-second batch, `flush()` will execute `DELETE` first and `INSERT ... ON CONFLICT DO UPDATE` second — leaving the deleted row on disk! Always call `await dbPool.flush()` before queueing a `delete` for a row that may have been upserted in the same tick (as `Orchestrator.releaseFiles` and `releaseAllReservations` do).

---

## 3. Log Prefixes to Grep in Extension Host Output

When viewing the **LUMI** output channel or Extension Host console logs, filter by these exact prefixes:

| Prefix | Source File | What It Logs |
|---|---|---|
| `[HierarchicalDefer]` | `HierarchicalDeferCoordinator.ts` | Hierarchy suspension requests, child acknowledgements, barrier releases, failure reconciliations, and resume completions |
| `[CriticalCompletionReview]` | `CriticalCompletionReview.ts` | Review cycle start, finding classification counts, 4-way decision (`ACCEPT`, `ACCEPT_WITH_NOTE`, `REMEDIATE`, `ESCALATE`), corrective task IDs |
| `[LegionCoordinator]` | `LegionCoordinator.ts` | Task classification scores, formation creation, stage promotions, file reservation conflicts, specialist failover reroutes, and synthesis reports |
| `[EngageSwarm]` | `EngageSwarmHandler.ts` | Conductor tool invocations, parameter extraction, pipeline completion, and handoff synthesis |
| `[LegionPipelineRunner]` | `LegionPipelineRunner.ts` | Stage transitions, ready specialist claims, durable barriers, and failover dispatches |
| `[Task]` | `src/core/task/index.ts` | Automatic Legion gating decisions, specialist operation evidence, and usage accounting |
| `[Orchestrator]` | `Orchestrator.ts` | Stream creation/completion/failure, task dispatch blocks on suspended streams, reservation releases |
| `[DbPool]` | `BufferedDbPool.ts` | Shadow commit/rollback, expired shadow cleanup, and any SQLite transaction error on `flush()` |
| `[Config]` | `src/infrastructure/db/Config.ts` | SQLite initialization path, WAL mode confirmation, or `.corrupt.<timestamp>` recovery |

---

## 4. The Verified SQLite Inspection Cookbook (`Q1`–`Q8`)

Every query below has been **empirically tested against a real SQLite database** initialized with LUMI's schema and populated through `AgentOrchestrator`. Set `DB=/path/to/joyzoning.sqlite` in your terminal:

```bash
DB="/path/to/joyzoning.sqlite"
```

### `Q1` — Inspect all agent streams and their hierarchy tree
```bash
sqlite3 -header -column "$DB" "
SELECT
  id AS stream_id,
  COALESCE(parentId, '(root)') AS parent_id,
  status,
  datetime(createdAt / 1000, 'unixepoch') AS created_utc
FROM agent_streams
ORDER BY createdAt ASC;
"
```
**Sample Output:**
```text
stream_id   parent_id   status      created_utc
----------  ----------  ----------  -------------------
root-1      (root)      active      2026-11-02 23:18:10
child-1     root-1      completed   2026-11-02 23:18:10
legion-s1   root-1      completed   2026-11-02 23:18:11
legion-s2   root-1      active      2026-11-02 23:18:11
```

---

### `Q2` — Inspect per-stream suspension state & `acceptingNewWork` gate
Use this when a stream refuses `dispatchTask` / `spawnSubAgent` or seems stuck waiting on children.
```bash
sqlite3 -header -column "$DB" "
SELECT
  streamId,
  json_extract(value, '$.state') AS suspend_state,
  json_extract(value, '$.acceptingNewWork') AS accepting_work,
  json_extract(value, '$.boundary') AS boundary,
  json_array_length(COALESCE(json_extract(value, '$.pendingChildAckIds'), '[]')) AS pending_children,
  json_array_length(COALESCE(json_extract(value, '$.acknowledgedChildIds'), '[]')) AS acked_children,
  json_extract(value, '$.pipelineId') AS pipeline_id
FROM agent_memory
WHERE key = 'defer_agent_status';
"
```
**Sample Output:**
```text
streamId    suspend_state  accepting_work  boundary        pending_children  acked_children  pipeline_id
----------  -------------  --------------  --------------  ----------------  --------------  -----------
root-1      resumed        1               safe_boundary   0                 1               pipe-1
child-1     resumed        1               safe_boundary   0                 0               pipe-1
```
- **Interpretation:** `accepting_work = 0` (`false`) means `ensureStreamAcceptingWork` will block new tasks. If `suspend_state = 'waiting_for_children'` and `pending_children > 0`, run `Q3` to see which child stream ID has not acknowledged.

---

### `Q3` — Inspect pipeline suspension barriers (`deferred_pipeline_status`)
```bash
sqlite3 -header -column "$DB" "
SELECT
  streamId AS root_stream,
  json_extract(value, '$.pipelineId') AS pipeline_id,
  json_extract(value, '$.phase') AS phase,
  json_extract(value, '$.pendingChildStreamIds') AS pending_child_ids,
  json_extract(value, '$.suspendedStreamIds') AS suspended_ids,
  json_extract(value, '$.suspendedAt') AS suspended_at
FROM agent_memory
WHERE key = 'deferred_pipeline_status';
"
```
**Sample Output:**
```text
root_stream  pipeline_id  phase    pending_child_ids  suspended_ids  suspended_at
-----------  -----------  -------  -----------------  -------------  -------------
root-1       pipe-1       resumed  []                 ["child-1"]    1793661490512
```

---

### `Q4` — Inspect deferred vs. active tasks across streams
Confirms that deferred tasks remain `status = 'pending'` with `deferred_state = 'deferred'` rather than being aborted or cancelled.
```bash
sqlite3 -header -column "$DB" "
SELECT
  id AS task_id,
  streamId,
  status,
  json_extract(metadata, '$.deferred_state') AS is_deferred,
  json_extract(metadata, '$.legion_specialist_role') AS legion_role,
  substr(description, 1, 50) AS description
FROM agent_tasks
ORDER BY createdAt ASC;
"
```

---

### `Q5` — Inspect active file reservations (`file_res:*`) and stream liveness
Confirms which files are currently reserved and whether any reservation belongs to a non-active stream.
```bash
sqlite3 -header -column "$DB" "
SELECT
  m.key AS reservation_key,
  m.streamId AS holder_stream,
  s.status AS stream_status,
  json_extract(m.value, '$.filePath') AS file_path,
  datetime(m.updatedAt / 1000, 'unixepoch') AS reserved_utc
FROM agent_memory m
LEFT JOIN agent_streams s ON s.id = m.streamId
WHERE m.key LIKE 'file_res:%';
"
```
- **Expected:** `0 rows` once all streams complete, or only rows where `stream_status = 'active'`. (If you ever see a `completed` stream holding a `file_res:*` row, check [PM-011](../postmortems/PM-011-completion-state-stranded-in-shadow-overlay.md) and [PM-012](../postmortems/PM-012-post-resume-reconcile-and-delete-upsert-ordering.md).)

---

### `Q6` — Inspect Legion formations and stage progress (`legion_formation:*`)
```bash
sqlite3 -header -column "$DB" "
SELECT
  streamId AS parent_stream,
  json_extract(value, '$.formationId') AS formation_id,
  json_extract(value, '$.status') AS status,
  json_array_length(json_extract(value, '$.members')) AS member_count,
  json_extract(value, '$.stageProgression.stages.leadAndRecon.status') AS lead_recon_status,
  json_extract(value, '$.stageProgression.stages.parallelExecution.status') AS parallel_status,
  json_extract(value, '$.stageProgression.stages.verificationAndHardening.status') AS verification_status
FROM agent_memory
WHERE key LIKE 'legion_formation:%';
"
```
**Sample Output:**
```text
parent_stream  formation_id  status     member_count  lead_recon_status  parallel_status  verification_status
-------------  ------------  ---------  ------------  -----------------  ---------------  -------------------
root-1         form-1        completed  3             completed          completed        completed
```

---

### `Q7` — Drill into individual Legion specialist slots inside a formation
```bash
sqlite3 -header -column "$DB" "
SELECT
  m.streamId AS parent_stream,
  json_extract(j.value, '$.assignment.assignmentId') AS assignment_id,
  json_extract(j.value, '$.assignment.role') AS role,
  json_extract(j.value, '$.assignment.codename') AS codename,
  json_extract(j.value, '$.stage') AS stage,
  json_extract(j.value, '$.status') AS member_status,
  json_extract(j.value, '$.streamId') AS child_stream,
  json_extract(j.value, '$.attempt') AS attempt,
  json_extract(j.value, '$.reroutedToStreamId') AS rerouted_to
FROM agent_memory m,
     json_each(json_extract(m.value, '$.members')) j
WHERE m.key LIKE 'legion_formation:%';
"
```
**Sample Output:**
```text
parent_stream  assignment_id       role                codename        stage              member_status  child_stream  attempt  rerouted_to
-------------  ------------------  ------------------  --------------  -----------------  -------------  ------------  -------  -----------
root-1         assign-arch-1       legion_architect    CENTURION-ARCH  leadAndRecon       completed      stream-s1     1        
root-1         assign-impl-1       legion_implementer  VANGUARD-IMPL   parallelExecution  rerouted       stream-s2     1        stream-s3
root-1         assign-impl-1-f1    legion_implementer  VANGUARD-IMPL   parallelExecution  completed      stream-s3     2        
```

---

### `Q8` — Inspect Critical Completion Review cycle history & latest decision
```bash
sqlite3 -header -column "$DB" "
SELECT
  streamId,
  json_extract(value, '$.completionEventId') AS completion_event_id,
  json_extract(value, '$.initialReviewsUsed') AS initial_reviews,
  json_extract(value, '$.correctivePassesUsed') AS corrective_passes,
  json_extract(value, '$.remediationAuthorized') AS remediation_authorized,
  json_extract(value, '$.lastDecision') AS last_decision,
  datetime(json_extract(value, '$.updatedAt') / 1000, 'unixepoch') AS updated_utc
FROM agent_memory
WHERE key LIKE 'critical_review_cycle:%';
"
```

Next: Read **[04 — Failure Modes, War Games & Recovery Drills](04-failure-modes-and-drills.md)** for hands-on drills and mutation proofs of every defensive guard in the system.

