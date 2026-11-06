# PB-06 — Triage SQLite flush errors

| Error                                                                    | Likely cause                                                                                                                             | Check                                                                      | Fix                                                                        |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `FOREIGN KEY constraint failed`                                          | A dependent row flushed before its parent. Almost always an `agent_streams` insert pushed **with an `agentId`** (shadow buffer) — PM-001 | `grep -n "push(" … ` for `agent_streams` inserts; is there a 2nd argument? | Remove the agent id; confirm `TABLE_FK_ORDER` includes the tables involved |
| `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint` | `agent_memory` upsert without `conflictTarget`                                                                                           | Writer missing `conflictTarget: ["streamId","key"]`                        | Add it plus `where` (PM-002)                                               |
| `table agent_tasks has no column named …`                                | Inserted a non-column (e.g. `subagent_type`)                                                                                             | Compare with the table definition                                          | Move into `metadata` JSON                                                  |
| Child reads can't see parent/child state until much later                | Write is trapped in a shadow overlay                                                                                                     | Was `push(op, agentId)` used? Is the reader passing the same id?           | Use direct write (ADR-0010) or `commitWork(agentId)`                       |
| Duplicate buffered memory rows                                           | upsert `where`/`conflictTarget` missing                                                                                                  | In-memory `pkMatch`                                                        | Same as PM-002                                                             |

| Row never appears in SQLite although the code "wrote" it; non-overlay readers see stale state | Write stranded in a shadow overlay (e.g. issued after `commitWork(x)` with agent id `x`) — PM-011 | `grep -n "commitWork" <file>` then check later `push/pushBatch` calls for an agent id; inspect the real file with `sqlite3` (see [operating handbook](../maintainers/03-operating-handbook.md)) | Drop the agent id (direct write) |
| `ShadowCommitError: Transaction shadow <agentId> was retained after commit failed` | `executeTransactionWork` or `commitWork` failed during commit (e.g. blocked by earlier flush failure or shutdown) — ADR-0019 | Check `dbPool.hasFailedFlush()` or pool status | Fix the underlying flush failure, then call `await dbPool.commitWork(agentId)`, or if rolling back, call `await dbPool.clearShadow(agentId)` |
| `Database shutdown blocked: transaction shadows need commit or explicit rollback` | `dbPool.stop()` called while uncommitted transaction shadows or retained failed commit shadows exist in memory | Inspect `agentShadows.size` or `retainedCommitShadows` | Ensure every transaction shadow calls `commitWork` or `clearShadow` before shutdown |

## Audit command (find agent-scoped writes)

```bash
grep -rn "dbPool.push\(Batch\)\?(" src --include='*.ts' -A12 | grep -n "streamId,$\|childStreamId,$\|agentId,$"
```
Review each hit: is the overlay ever committed, and does anyone need to read this row without the id?

## Reproduce

Copy the real-SQLite test pattern (section 5): point `setDbPath` at a temp file, run the failing operation, call `await dbPool.flush()` after each step, `dbPool.stop()` + delete the temp files in `finally`.
