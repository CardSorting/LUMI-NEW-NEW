# ADR-0012 — Automatic Legion formation by default

## Decision

Legion defaults on so the runtime can assess a task and form a specialist team without the user selecting roles or enabling a separate mode. The existing Legion setting remains an opt-out. Explicit environment, workspace, user, agent, task and runtime settings retain their existing precedence. The master switch still enables all auxiliary capabilities when on; to disable Legion while the master is on, turn the master off and reassert the desired individual switches.

Critical Completion Review and Hierarchical Defer remain off by default. This supersedes [ADR-0001](ADR-0001-auxiliary-off-by-default.md) only for Legion. Disabling Legion must prevent automatic formation and execution.

## Consequences and limits

Automatic delegation can incur additional model usage. It is subject to the task's permissions, configured budgets, explicit user restrictions and runtime support. Current eligibility is limited to act mode, native tools and tasks without attachments; classification is heuristic. Specialist execution is serialized. Some providers, restart recovery and a full live task flow still require verification; consult [PB-03](../playbooks/PB-03-add-a-legion-specialist.md) before relying on those paths.
