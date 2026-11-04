# ADR-0015 — Multi-Tier Terminal Heredoc Defense, Specialist Prompt Parity & Shell Integration Circuit-Breaking

## Context

In multi-agent systems and autonomous coding loops under LUMI's Agent Swarm and The Legion ([ADR-0012](ADR-0012-automatic-legion-default.md), [ADR-0013](ADR-0013-orchestrator-conductor-tool-and-streaming-progress.md)), specialist child agents execute tasks autonomously via native tool loops in `LegionAgentHost`. When assigned file creation, refactoring, or multi-file scaffolding tasks, models frequently attempt to write code files through terminal commands using shell heredoc constructs (e.g. `cat <<'EOF' > game.c`, `cat > Makefile << 'EOF'`, `tee`, or `cat << 'EOF' | sudo tee file.txt`).

This pattern caused catastrophic failures across multiple subsystem layers:

1. **Shell Integration Deadlock:**
   VS Code terminal execution relies on shell integration (`vscode.window.onDidEndTerminalShellExecution` and `terminal.shellIntegration.executeCommand`). Terminal sessions spawned by VS Code are non-interactive without a standard terminal stdin input stream. When a command containing a multiline heredoc (`cat <<'EOF' > file`) is fed through interactive shell integration, the shell blocks waiting for interactive EOF or stream termination on standard input. The terminal process never emits an exit code or completion event, hanging the tool execution loop indefinitely and deadlocking the agent.

2. **File Tracking & Reservation Bypass:**
   LUMI enforces structured workspace state tracking (`StabilityMonitor`, `SessionBuffer`, `SpiderEngine`, and Legion file reservations). When files are written directly via shell heredocs, file system tracking, dirty revision counters, and file reservation boundaries are completely bypassed. Other specialists or the parent conductor cannot verify receipts or changes through the structured `completedToolReceipts` mechanisms.

3. **Specialist Prompt Divergence (Asymmetry):**
   While parent conductor system prompts prohibited interactive terminal file creation, specialist agent system prompts assembled by `LegionAgentHost` only contained a generic instruction (`"Complete only the assigned scope using the available tools..."`). Specialists lacked explicit instructions prohibiting heredoc file creation and mandating `write_to_file` and `replace_in_file`.

4. **UI Approval Prompt Freeze:**
   When an autonomous specialist or conductor generated a heredoc command requiring approval, the command approval handler (`ExecuteCommandToolHandler.ts`) attempted to ask the user or stream partial prompts, breaking autonomous execution flow before pre-flight guards evaluated the command.

5. **Fragile Shell Token Parsing:**
   Naive string checks (such as `cmd.includes("<<")`) produce false positives on bitwise shift arithmetic expressions (`$((a << 2))`), command-line flags, or commit messages containing `<<`. Conversely, naive regexes miss edge cases such as tab-indented delimiters (`<<-EOF`), quoted file names (`cat > "my file.txt" << 'EOF'`), unspaced syntax (`cat>game.c <<'EOF'`), chained heredocs across multiple commands, or piped heredocs (`cat << 'EOF' | sudo tee file`).

## Decisions

1. **Tier 1: Specialist Prompt Parity (`LEGION_CORE_RULES` in `LegionAgentHost.ts`):**
   - Exported `LEGION_CORE_RULES` in `src/core/task/legion/LegionAgentHost.ts`:
     ```ts
     export const LEGION_CORE_RULES = `File Creation & Modification Rules:
     - When you want to create a file or overwrite its entire contents, use the write_to_file tool directly with the full content.
     - When you want to modify parts of an existing file, use replace_in_file or write_to_file.
     - You are STRICTLY FORBIDDEN from using execute_command with multiline heredocs (such as cat <<'EOF', cat > file, tee, or echo >) or stdin piping to create or write files. All file creations and edits must be performed using write_to_file or replace_in_file.
     - Terminal commands run in non-interactive sessions without stdin. Interactive stdin redirection, heredocs, and terminal file piping will deadlock shell integration and freeze the session.

     Command Execution Guidelines:
     - Use execute_command exclusively for non-interactive tasks: build scripts, compilation, running tests, linters, and environment checks.
     - Always prefer non-interactive flags (e.g. '--no-pager', '-y', '--non-interactive') and never run interactive commands that wait for user or stdin input.
     - Do not chain massive multiline scripts or interactive heredocs in execute_command.`
     ```
   - Injected `${LEGION_CORE_RULES}` into every specialist agent system prompt upon execution, establishing 1:1 parity with conductor guidelines.

2. **Tier 2: Shell Token-Aware Policy Parser (`src/integrations/terminal/heredocPolicy.ts`):**
   - Implemented `findTopLevelHeredocs(command: string): TopLevelHeredoc[]`:
     - Scans characters with state tracking for single quotes (`'`), double quotes (`"`), escape backslashes (`\`), and arithmetic expansions (`$((...))` or `((...))`).
     - Accurately ignores `<<` operators inside string literals or bitwise shift arithmetic expressions.
     - Detects delimiter patterns including quoted delimiters (`'EOF'`, `"EOF"`), hyphenated delimiters (`<<-EOF`), and unquoted alphanumeric delimiters.
   - Implemented `detectHeredocFileRedirection(command: string): HeredocRedirectionDetection`:
     - Detects file redirection across all valid shell syntax variations:
       1. Redirection before heredoc: `cat > file << 'EOF'`, `cat >> "file with spaces"`
       2. Tee before heredoc: `tee file << 'EOF'`, `sudo tee -a file`
       3. Redirection on heredoc line: `cat << 'EOF' > file`, `cat << 'EOF' >> "target"`
       4. Piped heredoc: `cat << 'EOF' | sudo tee file`, `cat << 'EOF' | cat > file`
       5. Redirection on delimiter line: `EOF > file`
     - Extracts all target files, filters out `/dev/null`, and returns `{ isHeredocFileWrite: true, targetFiles: string[], reason: string }` with actionable guidance directing the model to `write_to_file`.
   - Implemented `isMultilineHeredocCommand(command: string): boolean`:
     - Identifies any multiline command containing heredoc syntax (including interpreters like `python3 << 'EOF'` or unclosed heredocs) that would deadlock interactive shell integration.

3. **Tier 3: Pre-Execution Interception & Approval Suppression:**
   - **`ExecuteCommandToolHandler.ts`:**
     - Suppresses UI approval prompts before asking:
       `if (shouldAutoApprove || (command && detectHeredocFileRedirection(command).isHeredocFileWrite)) return`
     - Intercepts heredoc file writes before execution, emits `config.callbacks.say("command_permission_denied", reason)`, and returns `formatResponse.toolError(reason)`.
   - **`UniversalGuard.ts` & `FluidPolicyEngine.ts`:**
     - Audits pre-execution in `guardPreExecution` / `validatePreExecution`. Immediately rejects heredoc file redirections with `success: false` and the descriptive guidance.
   - **`ToolValidator.ts`:**
     - Rejects commands attempting heredoc file redirection in `validateExecuteCommandParams`.

4. **Tier 4: Shell Integration Circuit-Breaker (`VscodeTerminalProcess.ts` & `VscodeTerminalManager.ts`):**
   - In `VscodeTerminalProcess.run`:
     - Evaluates `isMultilineHeredocCommand(command)`.
     - If true, bypasses unobservable interactive shell integration. If a managed fallback terminal is available (`fallback()`), dispatches to the managed terminal where the process stream can safely be consumed.
     - If no supervised fallback exists, throws `Error("Command execution blocked: multiline heredoc commands cannot be safely executed via interactive shell integration without deadlocking. Use write_to_file or configure a supervised shell fallback.")`.
   - In `VscodeTerminalManager.ts`:
     - Defers dispatch via fast-path microtask for `isMultilineHeredocCommand(command)`, ensuring listeners attach before execution.

## Consequences

- **Deadlock Immunity:** Terminal sessions in VS Code never deadlock on interactive heredocs.
- **Autonomous Recovery:** When a model attempts a heredoc file write, the command is intercepted cleanly and returns an informative tool error explaining the deadlock risk and directing the model to use `write_to_file` for each file. The agent self-corrects on its next turn.
- **Structured File Tracking:** All file creation and edits flow through `write_to_file` and `replace_in_file`, preserving dirty-buffer tracking, git diff indexing, and file reservation locks.
- **Prompt Parity:** Specialists receive the exact same core constraints as the conductor, preventing prompt drift across hierarchy levels.

## Alternatives Considered

- *Attempting to simulate interactive terminal stdin feeding:* Rejected because VS Code's `terminal.shellIntegration.executeCommand` API provides no guaranteed stdin pipe across disparate platform shells (bash, zsh, pwsh), and simulating PTY keypresses introduces race conditions.
- *Allowing heredocs in background managed terminals:* Partially adopted as a last-resort fallback in `VscodeTerminalProcess`, but blocked at the tool handler layer for file writes because file tracking and tool receipt verification require native file tools.
- *Blind regex blocking of `<<`:* Rejected due to breaking valid commands using bitwise shifts (`$((val << 2))`) or commit messages.

## Evidence

- Verified by unit tests in `src/integrations/terminal/__tests__/heredocPolicy.test.ts` (33 tests covering file redirections, spaces, quotes, chained heredocs, sudo tee, unclosed heredocs, bitwise shifts).
- Verified by unit tests in `src/core/task/legion/__tests__/LegionAgentHost.test.ts` (asserting `LEGION_CORE_RULES` content and system prompt injection).
- Verified by unit tests in `src/core/task/tools/handlers/__tests__/ExecuteCommandToolHandler.approval.test.ts` (asserting pre-approval interception and error message guidance).
- Verified by unit tests in `src/hosts/vscode/terminal/VscodeTerminalProcess.test.ts` (asserting managed terminal fallback and deadlock refusal).
- Verified by unit tests in `src/core/policy/__tests__/FluidPolicyEngine.execution.test.ts` (asserting pre-execution validation rejection).
- Full regression suite green: **291 tests passing** across Agent Swarm, Legion, Terminal, and Policy components, with 0 TypeScript and 0 Biome lint errors.

