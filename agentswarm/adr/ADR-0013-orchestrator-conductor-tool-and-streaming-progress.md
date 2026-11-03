# ADR-0013 — Orchestrator Conductor Tool, Progress Streaming, Auto-Approval & Hardened Gating

## Context

With [ADR-0012](ADR-0012-automatic-legion-default.md), Legion was enabled by default for automatic formation on suitable act-mode tasks. However, in practice, several integration gaps and coordination limitations emerged between the parent orchestrator LLM and The Legion:

1. **Lack of Explicit Conductor Tool:** The parent agent could only trigger Legion implicitly during `Task.startTask` / `maybeRunAutomaticLegion`. Once running or in subsequent turns/sub-milestones, the parent agent had no explicit tool to dispatch specialists or re-engage the swarm for targeted sub-tasks, test runs, or architectural investigations.
2. **Conductor Role Ambiguity:** The parent model prompt lacked explicit instruction on its role as the overall orchestrator/conductor, including how to plan specialist roles in Plan Mode and how to command them in Act Mode.
3. **Approval Bottlenecks:** When a conductor attempts to deploy a specialist swarm, requiring interactive user approval for the tool call creates disruptive friction for an autonomous multi-agent hierarchy.
4. **Opaque Multi-Agent Progress:** When specialists were running across stages (`leadAndRecon`, `parallelExecution`, `verificationAndHardening`), the user saw little or no feedback in the chat stream until the entire pipeline synthesized its final handoff.
5. **Overly Restrictive Complexity Gating:** Tasks requiring targeted tactical strikes (e.g. single-specialist targeted bug fix) or test suite execution in a test project were blocked from automatic Legion formation because the classifier scored them below the 3.2 complexity floor or with a single specialist.
6. **Context Fragility & Missing Hand-off Hooks:** When tasks started with file attachments, `legionObjective` was stripped. When a specialist agent completed its assignment, it required a reliable `attempt_completion` tool even if the provider's standard system toolset did not include or properly expose it.
7. **Indiscriminate Specialist Failover:** When a specialist failed, the pipeline attempted automatic failover even when the failure was caused by structural issues (exhausted token budgets, disallowed tools, dirty unfinished command processes) that could not be safely retried.

## Decisions

1. **Explicit Conductor Tool (`engage_swarm`):**
   - Added `engage_swarm` to `DietCodeDefaultTool` and registered it in `DietCodeToolSet`.
   - Gated dynamically: available when `agentSwarmLegionEnabled || agentSwarmEnabled` and `!context.isTesting` (preserving snapshot stability during unit tests).
   - Parameters: `objective` (required string), `strategy` (optional enum: `adaptive`, `tactical_strike`, `balanced_squad`, `full_legion`, `verification_heavy`), `preferred_roles` (optional string or array of specialist roles), and `max_specialists` (clamped 1..8).
   - Translates tool specifications into the active provider's native tool definition format (`DietCodeToolSet.getNativeConverter`).

2. **Auto-Approval of Swarm Engagement:**
   - Added `DietCodeDefaultTool.ENGAGE_SWARM` to `AutoApprove.shouldAutoApproveToolWithPath` in `src/core/task/tools/autoApprove.ts`.
   - Dispatching the swarm is always auto-approved, preventing unnecessary interactive prompts while preserving full child-operation permission sandboxing in `LegionToolAdapter`.

3. **Orchestrator Conductor Prompt Integration:**
   - Injected `# 🐝 AGENT SWARM & THE LEGION — Orchestrator Conductor` into `src/core/prompts/system-prompt/components/joy_zoning.ts` whenever Swarm or Legion is enabled.
   - Updated `src/core/prompts/system-prompt/components/capabilities.ts` to expose `{{SWARM_CAPABILITIES}}`.
   - Updated `src/core/prompts/system-prompt/components/act_vs_plan_mode.ts` to guide role mapping in Plan Mode and execution delegation via `engage_swarm` in Act Mode.

4. **Streaming Progress Cards (`formatLegionProgressMessage`):**
   - Added structured progress callbacks in `LegionPipelineRunner` (`onProgress`).
   - `formatLegionProgressMessage` formats stage transitions, active specialist badges, completion confirmations, failure alerts, failovers, and final handoffs into readable markdown cards emitted directly to the chat stream.

5. **Hardened Gating & Fallback Resilience:**
   - Preserved `legionObjective` in `Task.startTask` when files are attached (only multimodal images bypass automatic delegation).
   - Added conversation history fallback in `maybeRunAutomaticLegion` if `this.legionObjective` is not explicitly cached.
   - Relaxed complexity floor: tasks with `complexityScore < 3.2` or fewer than 2 roster members are permitted if the applied strategy is `tactical_strike`, or if the prompt explicitly mentions test projects or swarm/legion keywords.
   - Fallback `attempt_completion` injection: ensures specialists always have an isolated, single-parameter (`result`) completion tool.
   - Injected remaining token and cost budgets into `LegionAgentHost` (`maxTokens`, `maxCost`), stopping runaway specialist consumption.
   - Categorized `safeToRetry` failover: only failures without lingering operations, dirty processes, or structural violations initiate failover rerouting (`orchestrator.failoverLegionSpecialist`).

## Consequences

- **Conductor Agency:** The parent model can now dynamically organize multi-specialist sprints on demand at any point in a conversation, rather than relying exclusively on an initial automatic formation.
- **Observability:** Users receive real-time, badge-annotated progress as specialists transition across stages and complete work.
- **Robustness:** Budgets are respected, un-retryable failures halt cleanly without wasteful churn, and tactical targeted tasks execute without false complexity rejections.
- **Safety:** Specialists remain isolated behind `LegionAgentHost` and `LegionToolAdapter`, and handoffs are returned to the conductor as unverified data to be inspected and verified.
