# ADR-0016 — Terminal File Read Defense, Specialist Token Budget Starvation Resolution & Full Conductor-Specialist Prompt Parity

## Context

In multi-agent autonomous execution loops under LUMI's Agent Swarm and The Legion ([ADR-0012](ADR-0012-automatic-legion-default.md), [ADR-0013](ADR-0013-orchestrator-conductor-tool-and-streaming-progress.md), [ADR-0015](ADR-0015-multi-tier-terminal-heredoc-defense-and-prompt-parity.md)), users reported that agents repeatedly executed commands directly in the terminal to inspect file contents and display prompt/source outputs.

A deep audit of `/Users/bozoegg/Downloads/LUMI/runlog.md` uncovered three compounding architectural root causes across host execution, agent budgeting, and prompt systems:

1. **Terminal File Dump Anti-Pattern:**
   Models frequently invoked `execute_command` using terminal commands (`cat`, `head`, `tail`, `more`, `less`, and compound pipelines like `find . -maxdepth 3 -type f -print; printf '\n--- main ---\n'; cat src/main.c; ...`) to view file contents instead of invoking `read_file` or `list_files`. Because `execute_command` calls `terminalInfo.terminal.show()`, the entire content of reference files and project source code dumped directly into the user's interactive terminal window, flooding the user session with hundreds of lines of code.

2. **Specialist Token Budget Starvation in Multi-Turn Loops:**
   In `src/core/task/legion/LegionAgentHost.ts`, `budgetExceeded()` enforced a hardcoded fallback limit:
   ```ts
   const budgetExceeded = () =>
       this.usedTokens >= (this.options.maxTokens ?? 100_000) ||
       (this.options.maxCost !== undefined && this.reportedCost >= this.options.maxCost)
   ```
   When `maxTokens` was not set on the parent task state (defaulting `options.maxTokens` to `undefined`), `budgetExceeded` fell back to `100_000` tokens.
   However, modern foundation models (Claude 3.5 Sonnet, GPT-4o) transmit ~15,000–20,000 prompt tokens *per turn* in multi-tool conversations. `usedTokens` accumulates input tokens, output tokens, and cache tokens on every turn:
   - Turn 1: ~16,000 tokens
   - Turn 2: ~34,000 tokens
   - Turn 3: ~53,000 tokens
   - Turn 4: ~73,000 tokens
   - Turn 5: ~94,000 tokens
   - Turn 6: ~116,000 tokens $\rightarrow$ **Exceeded 100,000 token budget!**
   This prematurely aborted `VANGUARD-IMPL` mid-scaffolding after only 5 operations and killed subsequent specialists (e.g. `KEEPER-STATE`) on turn 0 with `Specialist team budget exhausted`.

3. **Conductor vs Specialist Prompt Divergence:**
   While [ADR-0015](ADR-0015-multi-tier-terminal-heredoc-defense-and-prompt-parity.md) injected `LEGION_CORE_RULES` into child specialists, parent conductor system prompts (`rules.ts`, `editing_files.ts`, `execute_command.ts`) contained NO explicit prohibitions against reading files via terminal `cat` or creating files via heredocs. When Legion specialists were starved of budget, control returned to the unconstrained parent conductor, which immediately resumed terminal `cat` file dumping.
   Furthermore, `UseSkillToolHandler.ts` provided an ambiguous completion message (`"You may access other files in the skill directory at: ..."`) without specifying `read_file`, prompting conductors to run `cat <skill-path>` in the terminal.

---

## Decisions

1. **Tier 1: Terminal File Read Policy Engine (`src/integrations/terminal/terminalFileReadPolicy.ts`):**
   - Implemented `splitTopLevelStatements(command: string): string[]`:
     - Tokenizes and splits compound shell commands by `;`, `\n`, `&&`, and `||`.
     - Normalizes `@workspace:` prefixes.
     - Recursively extracts and splits subshells `(...)`, command substitutions `$()`, and backtick substitutions ` `...` `, handling both unquoted and double-quoted contexts.
   - Implemented `detectTerminalFileRead(command: string): TerminalFileReadDetection`:
     - Inspects commands across utilities: `cat`, `head`, `tail`, `more`, `less`, `tac`, `bat`, `nl`, `fold`, `pr`, `view`, `pg`, `most`.
     - Unwraps common execution prefixes: `sudo`, `doas`, `nohup`, `time`, `exec`, `builtin`, `command` (with flags), `env` (with flags and `KEY=VAL` assignments), `xargs` (identifying file reader subcommands), and `find -exec`/`find -execdir` subcommands.
     - Unwraps subshell script invocations (`bash -c`, `sh -c`, `zsh -c`) and recursively inspects nested scripts.
     - Accurately differentiates standard error redirection (`2> /dev/null`, `2>&1`, `>&2`) from stdout redirection (`>`, `1>`, `&>`), ensuring `cat file 2> /dev/null` is detected and blocked rather than slipping past detection.
     - Robust pipeline analysis: permits real stream processing/filtering (`cat file | grep ...`, `cat file | wc -l`, `cat file | jq ...`), while intercepting terminal dumping pipelines (`cat file | cat`, `cat file | more`, `cat file | less`, `cat file | head`, `cat file | tail`, `cat file | tee`, `echo foo | cat file`).
     - Detects interactive stdin deadlock traps (e.g. `cat > file` with no input files or pipe) while correctly distinguishing file targets from redirection operators (`cat < file`, `cat <file`, and `cat 0< file` report `file` without `<` or `0`).
     - Properly extracts quoted targets with escaped characters (`cat <<< "hello \"world\""` and `cat < "file with \"quotes\".txt"`).
     - Supports naked zsh/shell input redirection `< file.txt`.
     - Allows whitelisted system info targets (`/proc/*`, `/sys/*`, `/etc/os-release`, etc.), here-strings (`cat <<< "string"`), and non-blocking streaming (`tail -f`).
     - Returns actionable error guidance directing models to `read_file` or `list_files`.
   - Implemented `isTerminalFileReadCommand(command: string): boolean`:
     - Fast boolean check for dispatch conditions.

2. **Tier 2: Universal Pre-Execution Interception & Fast-Path Routing:**
   - **`ExecuteCommandToolHandler.ts`:**
     - Suppresses premature user approval asks in `handlePartialBlock` when terminal file reads are detected.
     - Intercepts terminal file reads in `execute()` before approval or execution, logs `command_permission_denied`, and returns tool error directing the agent to `read_file`.
   - **`UniversalGuard.ts` & `FluidPolicyEngine.ts`:**
     - Blocks terminal file reads across all pre-execution policy checks.
   - **`ToolValidator.ts`:**
     - Validates commands against terminal file reading before permission controllers run.
   - **`VscodeTerminalProcess.ts`:**
     - Rejects any terminal file read command unconditionally before dispatch in both unmanaged `run()` and supervised `runManaged()`, emitting an explicit error without falling back to managed terminal.
   - **`VscodeTerminalManager.ts`:**
     - Added `isTerminalFileReadCommand` to the microtask fast-path queue to prevent shell integration deferral hangs.

3. **Tier 3: Specialist Token Budget Starvation Resolution:**
   - Updated `budgetExceeded` in `src/core/task/legion/LegionAgentHost.ts`:
     ```ts
     const budgetExceeded = () =>
         (this.options.maxTokens !== undefined && this.usedTokens >= this.options.maxTokens) ||
         (this.options.maxCost !== undefined && this.reportedCost >= this.options.maxCost)
     ```
   - Only enforces a token limit when an explicit budget is configured on the task. Removed the arbitrary 100,000 cumulative fallback token ceiling that starved specialist teams.

4. **Tier 4: Conductor-Specialist Prompt Parity & Skill Tool Guidance:**
   - Updated `LEGION_CORE_RULES` in `LegionAgentHost.ts` with File Reading & Inspection Rules strictly forbidding terminal file reads and mandating `read_file` and `list_files`.
   - Updated `rules.ts` to mandate `read_file`/`list_files` and `write_to_file`/`replace_in_file`, strictly prohibiting terminal `cat`/`head`/`tail` dumps and heredoc file writing.
   - Updated `editing_files.ts` to prohibit terminal heredocs and terminal file reading.
   - Updated `execute_command.ts` specifications across all model variants (`GENERIC`, `NATIVE_GPT_5`, `NATIVE_NEXT_GEN`, `GEMINI_3`) warning against terminal file reads and heredoc file writes.
   - Updated `UseSkillToolHandler.ts` to explicitly instruct agents: `"You may access other files in the skill directory using the read_file tool at: ..."`.

---

## Consequences

- Terminal window is completely protected from massive file text dumping.
- Autonomous specialist teams run their full assigned scope up to 24 turns without premature budget starvation.
- Conductors and specialists share identical strict rules prohibiting terminal file reads and heredoc file writes.
- Shell integration remains responsive, observable, and free of stdin deadlocks.

