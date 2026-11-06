# Playbooks

Step-by-step runbooks. Each has: **When**, **Steps**, **Verify**, **Rollback/Escalate**.

| ID                                                  | Playbook                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [PB-01](PB-01-enable-or-disable-the-swarm.md)       | Enable / disable the swarm (user, operator, test, per task)                                      |
| [PB-02](PB-02-add-a-setting-end-to-end.md)          | Add a setting end-to-end (proto → UI)                                                            |
| [PB-03](PB-03-add-a-legion-specialist.md)           | Add a Legion specialist archetype                                                                |
| [PB-04](PB-04-diagnose-a-stuck-pipeline.md)         | Diagnose a stuck / never-suspending pipeline, unconfirmed command fence, or needs_reconciliation |
| [PB-05](PB-05-recover-a-failed-legion-formation.md) | Recover a failed Legion formation                                                                |
| [PB-06](PB-06-triage-sqlite-flush-errors.md)        | Triage SQLite flush errors (FK / ON CONFLICT / ShadowCommitError)                                |
| [PB-07](PB-07-release-verification.md)              | Release verification checklist                                                                   |
| [PB-08](PB-08-audit-after-interrupted-work.md)      | Audit after interrupted or delegated work                                                        |
