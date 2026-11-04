# Post-Mortem PM-017 — Terminal File Dump, Specialist Token Budget Starvation & Conductor Fallback Drift

**Incident Date:** 2026-11-04  
**Severity:** High (Autonomous Loop Breakdown, Terminal Output Flooding & Specialist Starvation)  
**Affected Subsystems:** `src/core/task/legion/LegionAgentHost.ts`, `src/integrations/terminal/terminalFileReadPolicy.ts`, `src/hosts/vscode/terminal/VscodeTerminalProcess.ts`, `src/core/prompts/system-prompt/`, `src/core/task/tools/handlers/UseSkillToolHandler.ts`  
**Related ADRs:** [ADR-0012](../adr/ADR-0012-automatic-legion-default.md), [ADR-0015](../adr/ADR-0015-multi-tier-terminal-heredoc-defense-and-prompt-parity.md), [ADR-0016](../adr/ADR-0016-terminal-file-read-defense-budget-starvation-and-conductor-prompt-parity.md)

---

## 1. Summary

In autonomous development tasks (documented in `runlog.md`), the user observed:
> *"the agent kept triggering the responses directly in the terminal here is the current updated status of the run log /Users/bozoegg/Downloads/LUMI/runlog.md"*

Investigation of `runlog.md` revealed a cascade failure:
1. Specialists (`VANGUARD-IMPL` and `KEEPER-STATE`) were terminated prematurely after only 5–6 turns with the error:
   ```
   Specialist team budget exhausted. Specialist operations attempted: execute_command, write_to_file, write_to_file...
   ```
2. Following this premature exhaustion, Legion handed control back to the parent conductor.
3. The parent conductor executed `cat /Users/bozoegg/.agents/skills/impeccable/reference/craft-floor.md` followed by compound file inspection commands:
   ```bash
   find . -maxdepth 3 -type f -print; printf '\n--- main ---\n'; cat src/main.c; printf '\n--- game ---\n'; cat src/game.c; printf '\n--- header ---\n'; cat src/game.h
   ```
4. These commands executed via `execute_command`, popping up and dumping hundreds of lines of reference text and source code directly into the user's interactive terminal (`bozoegg@MacBookPro galaga %`).

---

## 2. Root Cause Analysis

### A. Cumulative Token Starvation in `LegionAgentHost`
In `LegionAgentHost.ts`:
```ts
const budgetExceeded = () =>
    this.usedTokens >= (this.options.maxTokens ?? 100_000) ||
    (this.options.maxCost !== undefined && this.reportedCost >= this.options.maxCost)
```
When `options.maxTokens` was not set, it defaulted to `100_000`.
Modern LLMs transmit complete conversation context on every turn (`chunk.inputTokens`). With system context and file contents totaling ~15k tokens per request:
- Turn 1: 16k
- Turn 2: 34k
- Turn 3: 53k
- Turn 4: 73k
- Turn 5: 94k
- Turn 6: 116k $\rightarrow$ **Budget Exhausted**
The specialist was stopped mid-scaffolding, and the next specialist (`KEEPER-STATE`) failed immediately on turn 0 because `usedTokens` was already $> 100,000$.

### B. Prompt Parity Asymmetry Between Conductor and Specialists
While Phase 9 ([ADR-0015](../adr/ADR-0015-multi-tier-terminal-heredoc-defense-and-prompt-parity.md)) introduced `LEGION_CORE_RULES` into child specialists, parent conductor system prompts (`rules.ts`, `editing_files.ts`, `execute_command.ts`) had no equivalent rules forbidding terminal `cat`/`head`/`tail` dumps or heredocs. When Legion failed over to the conductor, the conductor had no guidance against terminal file inspection.

### C. Skill Tool Instruction Ambiguity
`UseSkillToolHandler.ts` concluded skill loading with:
```ts
You may access other files in the skill directory at: ${skillContent.path.replace(/SKILL\.md$/, "")}
```
This instructed the model that additional files exist at a filesystem path without stating that they must be accessed via `read_file`, prompting the model to use terminal `cat`.

### D. Missing Terminal File Read Circuit-Breaker
`ExecuteCommandToolHandler.ts`, `UniversalGuard.ts`, `FluidPolicyEngine.ts`, `ToolValidator.ts`, and `VscodeTerminalProcess.ts` had guards for heredoc file writes, but lacked detection and interception for terminal file reads (`cat`, `head`, `tail`, `more`, `less`).

---

## 3. Corrective Actions

1. **`terminalFileReadPolicy.ts`:** Created policy engine to parse compound shell statements and detect terminal file reads with support for whitelisted system probes and streaming flags.
2. **Pre-Execution Interception:** Wired `detectTerminalFileRead` into `ExecuteCommandToolHandler`, `UniversalGuard`, `FluidPolicyEngine`, and `ToolValidator`. Suppressed premature UI asks and redirected agents to `read_file`.
3. **Terminal Process Circuit-Breaker:** Wired immediate rejection in `VscodeTerminalProcess.ts` to block terminal file reads unconditionally before shell integration or managed fallback.
4. **Budget Starvation Resolution:** Removed the default 100,000 token ceiling in `LegionAgentHost.ts`, enforcing token limits only when `this.options.maxTokens !== undefined`.
5. **Conductor-Specialist Prompt Parity:**
   - Injected file reading and heredoc prohibitions into `rules.ts` and `editing_files.ts`.
   - Updated `execute_command.ts` specifications across all model variants.
   - Updated `LEGION_CORE_RULES` in `LegionAgentHost.ts` with File Reading & Inspection Rules.
   - Updated `UseSkillToolHandler.ts` to mandate `read_file` for skill files.

---

## 4. Verification

- All 37 unit tests in `terminalFileReadPolicy.test.ts` pass (including double-quoted command substitutions, stderr redirection, explicit fd 0 redirection, escaped here-strings, xargs/find-exec unwrapping, and subshell wrappers).
- All 29 unit tests in `ExecuteCommandToolHandler.approval.test.ts` pass.
- All 15 unit tests in `VscodeTerminalProcess.test.ts` pass.
- All 22 unit tests in `LegionAgentHost.test.ts` pass.
- All 14 unit tests in `completionAudit.test.ts` pass.
- Full suite of 203 terminal, policy, legion, and approval tests pass (331ms).
- Zero TypeScript errors (`npm run check-types`).
- Zero Biome lint errors (`npm run lint`).

