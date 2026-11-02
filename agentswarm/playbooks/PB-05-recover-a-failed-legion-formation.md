# PB-05 — Recover a failed Legion formation

## Inspect
```ts
const progress = await orchestrator.getLegionStageProgression(parentId)   // stage statuses, hasFailures, ready members
const manifest = await orchestrator.recallLastLegionFormation(parentId)   // members + status + attempts
const report   = await orchestrator.synthesizeLegionExecutionReport(parentId) // markdown for humans
```

## Cases
| Situation | What happened | Action |
|---|---|---|
| Member `rerouted`, replacement `pending`/`running` | Automatic failover (attempt 2) | Nothing — let it run |
| Member `failed`, no replacement, Legion enabled | Failover budget exhausted (2 attempts per slot) — `rerouteFailedLegionSpecialist` will now refuse | Escalate to the coordinator: read `failureReason`, fix the underlying cause, then start a **new** formation with `formLegion` using narrowed `targetFiles` |
| Member `failed`, Legion **disabled** for parent | Automatic failover skipped by design | Call `rerouteFailedLegionSpecialist(parentId, failedStreamId)` once |
| Reroute threw "not accepting new work" | Parent is deferred/suspending | `resumePipeline(parentId)` then reroute (remedial formation does this automatically) |
| Formation `partial_failure`, later stages never start | A failed slot blocks downstream stages (intentional) | Resolve the failed slot (above) |

## Verify
`progress.hasFailures === false`, `manifest.status === "completed"` (or `active` with ready members), and a synthesis report exists.

## Never
- Don't re-run `completeStream` on a failed stream to "fix" it — terminal states are final.
- Don't hand-edit `legion_formation:*` records; use the APIs (they hold the formation lock).
