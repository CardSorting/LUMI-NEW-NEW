# Glossary

| Term | Meaning |
|---|---|
| **Agent Swarm (auxiliary suite)** | The umbrella for the three optional capabilities below. Master switch: `agentSwarmEnabled`. |
| **Auxiliary** | Opt-in. Default `false`. When off, normal single-agent flows run unchanged with no extra work. |
| **Stream** | An independent agent execution context; one row in `agent_streams` with its own tasks (`agent_tasks`) and memory (`agent_memory`). Streams are never merged. |
| **Coordinator / Parent** | The stream that delegates and owns the rolling roadmap. Does not do delegated work itself. |
| **Rolling roadmap** | `rolling_roadmap_snapshot` on the parent: objective, child assignments, completed/outstanding work, blockers, decisions, next actions, sync status. |
| **Defer** | Cooperative suspension: stop at a safe point, checkpoint, acknowledge, later resume. **Not** cancellation. |
| **Boundary** | *Where* a stream may yield: `before_turn`, `safe_boundary` (default), `immediate`. |
| **Safe boundary** | Let the current atomic operation (tool call) finish, then yield. |
| **Immediate** | Yield now — only if the in-flight operation is idempotent **and** explicitly safe to interrupt. |
| **Suspension barrier** | The parent is not "suspended" until every active descendant has acknowledged. Until then its phase is `waiting_for_children`. |
| **DEFER_REQUEST / DEFER_ACK / RESUME_REQUEST / RESUME_ACK** | Durable control messages stored in each stream's `defer_control_inbox`. |
| **Checkpoint** | `AgentDeferCheckpoint`: turn index, pending tool queue, completed tool receipts, held reservations, roadmap. Completed receipts are never replayed on resume. |
| **`acceptingNewWork`** | Flag on a stream's defer status. `false` while suspending/deferred; `createTask`, `spawnChildStream`, `formLegion` refuse work. |
| **Critical Completion Review** | One bounded adversarial post-completion review ending in `ACCEPT`, `REMEDIATE`, `ESCALATE` or `ACCEPT_WITH_DISCLOSED_LIMITATIONS`. |
| **1+1 bound** | At most 1 initial review per completion event + 1 corrective verification pass. |
| **Finding categories** | Confirmed defects (`demonstrable_defect`, `reproducible_failure`, `unsatisfied_requirement`) vs. risks (`material_risk`, `unverified_assumption`) vs. advisory (`optional_improvement`, `subjective_preference`). Never conflated. |
| **Legion** | The specialist formation engine: classify → form → spawn → stage-gate → fail over → synthesize. |
| **Specialist archetype** | One of 7 roles in `LEGION_SPECIALIST_REGISTRY` (codenames below). |
| **Formation** | One spawned cohort (`LegionFormationManifest`) under one parent. |
| **Formation strategy** | `adaptive`, `tactical_strike`, `balanced_squad`, `full_legion`, `verification_heavy`. |
| **Stage** | `leadAndRecon` → `parallelExecution` → `verificationAndHardening`. A stage starts only when the previous non-empty stage is fully resolved. |
| **Failover** | Re-route a failed specialist's work to one replacement (max 2 attempts per slot), then escalate. |
| **Terminal member state** | `completed`, `failed`, `rerouted`. Final — never flipped by a later event. |
| **Shadow buffer** | Per-agent uncommitted write overlay in `BufferedDbPool` (`push(op, agentId)`). Invisible to other readers until `commitWork`; idle overlays are discarded after 5 minutes. A recurring source of bugs — see PM-001, PM-011. |
| **Layer priority / `TABLE_FK_ORDER`** | Flush ordering in `BufferedDbPool` so parent rows (`agent_streams`) land before dependents. |
| **Orchestrator Conductor** | The parent agent's operational posture when leading The Legion: maps roles to milestones in Plan Mode and commands/supervises execution via `engage_swarm` in Act Mode. |
| **`engage_swarm`** | Native conductor tool allowing the parent agent to explicitly spawn and operate a specialist team for an objective, test suite, or milestone. Auto-approved by default. |
| **Streaming Progress Cards** | Real-time markdown UI cards formatted by `formatLegionProgressMessage` and streamed to chat (stages, active specialists, completions, failures, failovers). |
| **Safe-to-Retry Failover** | Property on `LegionExecutionResult` (`safeToRetry?: boolean`) allowing ADR-0009 failover only for recoverable errors, halting on dirty commands or budget exhaustion. |
| **Fallback Completion Spec** | Isolated `attempt_completion` spec injected into specialist contexts with a single `result: string` parameter. |
| **Tactical Strike Strategy** | Targeted single-specialist formation strategy (`tactical_strike`) that bypasses the 3.2 complexity floor and multi-specialist minimums. |
| **Tool Argument Offset Tracking (`toolCallDelta`)** | Stateful byte/character offset tracking across provider streams (`openai-codex.ts`, `openai-native.ts`, `responses_api_support.ts`). Slices unstreamed suffixes and suppresses duplicate terminal snapshots (`output_item.done`, `function_call_arguments.done`) before chunk emission. |
| **Interleaved Tool Tracking** | Bidirectional lookup maps (`toolCallIdByItemId`, `toolCallNameByItemId`, `toolCallNameByCallId`, `functionCallByItemId`) preserving tool call identities and names across interleaved provider stream chunks. |
| **State-Machine JSON Root Parser (`extractJsonRoots`)** | Character-by-character scanner in `StreamResponseHandler.ts` that tracks nesting depth, string literal quotes, and escapes to extract sequential complete JSON roots and slices from raw stream buffers. |
| **Self-Healing Tool Arguments** | Dual-tier deduplication in `StreamResponseHandler.ts`: stream-time prefix slicing in `processToolUseDelta`, and terminal-time unification in `assertCompleteToolUses` across multiple identical complete JSON roots (`deepEqual`). |
| **`ToolArgumentError`** | Typed diagnostic error with `kind` classification (`incomplete`, `concatenation`, `syntax`, `invalid_format`), retaining `toolName` and `rawInput` for precise triage. |
| **Transport Error Circuit-Breaking** | Catch guard in `LegionAgentHost` (`isTransportError`) returning `safeToRetry: false` on stream decoding, concatenation, or JSON syntax errors, halting futile failovers. |
| **Terminal Heredoc Redirection** | Shell syntax redirecting file input/output via multiline heredocs (`cat <<'EOF' > file`, `tee`). Prohibited in `execute_command` because non-interactive terminal sessions lack stdin, causing interactive shell integration to deadlock. |
| **`LEGION_CORE_RULES` (Prompt Parity)** | System prompt instruction block injected into `LegionAgentHost` specialists establishing 1:1 parity with the conductor, strictly mandating `write_to_file` and forbidding multiline terminal heredocs and stdin redirection. |
| **Shell Token Parser (`findTopLevelHeredocs`)** | Character scanner in `heredocPolicy.ts` that ignores quotes and arithmetic shifts to reliably identify genuine shell heredocs and file redirection targets. |
| **Heredoc Pre-Execution Interception** | Pre-flight audit in `ExecuteCommandToolHandler`, `UniversalGuard`, and `FluidPolicyEngine` that suppresses UI approval prompts and rejects terminal heredoc file writes before process execution. |
| **Shell Integration Circuit-Breaker** | Terminal transport safeguard in `VscodeTerminalProcess.ts` that safely routes multiline heredoc commands to managed fallback or rejects them with an explicit error to prevent VS Code shell integration deadlocks. |

## Specialist codenames

| Codename | Role id | Stage | Default boundary |
|---|---|---|---|
| CENTURION-ARCH | `legion_architect` | Lead & Recon | `before_turn` |
| ORACLE-RECON | `legion_researcher` | Lead & Recon | `immediate` |
| VANGUARD-IMPL | `legion_implementer` | Parallel | `safe_boundary` |
| AESTHETE-UX | `legion_ux_ergonomics` (alias `legion_Trends_ux`) | Parallel | `safe_boundary` |
| AEGIS-HARDEN | `legion_hardener` | Parallel | `safe_boundary` |
| KEEPER-STATE | `legion_data_steward` | Parallel | `safe_boundary` |
| SENTINEL-QA | `legion_verifier` | Verification | `before_turn` |

