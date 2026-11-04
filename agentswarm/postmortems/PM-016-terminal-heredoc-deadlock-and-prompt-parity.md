# PM-016 — Terminal Heredoc Shell Integration Deadlock and Specialist Prompt Parity Drift

| Field | Value |
|---|---|
| Incident date | 2026-11-04 |
| Severity | High (terminal process freeze; shell integration deadlock; file reservation and workspace state tracking bypass) |
| Affected components | `src/core/task/legion/LegionAgentHost.ts`, `src/integrations/terminal/heredocPolicy.ts`, `src/core/task/tools/handlers/ExecuteCommandToolHandler.ts`, `src/core/policy/UniversalGuard.ts`, `src/core/policy/FluidPolicyEngine.ts`, `src/core/task/tools/ToolValidator.ts`, `src/hosts/vscode/terminal/VscodeTerminalProcess.ts`, `src/hosts/vscode/terminal/VscodeTerminalManager.ts` |
| First failing test | `src/integrations/terminal/__tests__/heredocPolicy.test.ts`, `src/core/task/legion/__tests__/LegionAgentHost.test.ts`, `src/core/task/tools/handlers/__tests__/ExecuteCommandToolHandler.approval.test.ts`, `src/hosts/vscode/terminal/VscodeTerminalProcess.test.ts`, `src/core/policy/__tests__/FluidPolicyEngine.execution.test.ts` |
| Fixed in | `src/core/task/legion/LegionAgentHost.ts`, `src/integrations/terminal/heredocPolicy.ts`, `src/core/task/tools/handlers/ExecuteCommandToolHandler.ts`, `src/core/policy/UniversalGuard.ts`, `src/core/policy/FluidPolicyEngine.ts`, `src/core/task/tools/ToolValidator.ts`, `src/hosts/vscode/terminal/VscodeTerminalProcess.ts`, `src/hosts/vscode/terminal/VscodeTerminalManager.ts` |
| Related ADRs | [ADR-0012](../adr/ADR-0012-automatic-legion-default.md), [ADR-0013](../adr/ADR-0013-orchestrator-conductor-tool-and-streaming-progress.md), [ADR-0015](../adr/ADR-0015-multi-tier-terminal-heredoc-defense-and-prompt-parity.md) |

---

## 1. Summary

During autonomous execution loops, specialist agents (e.g. `VANGUARD-IMPL`, `CENTURION-ARCH`) and parent conductors tasked with multi-file scaffolding or file creation frequently issued composite terminal commands using multiline shell heredocs:
```bash
cat > game.c <<'EOF'
#include <stdio.h>
int main() { return 0; }
EOF
cat > Makefile <<'EOF'
all: game
EOF
make clean all test
```
When submitted to `execute_command`, these commands caused the extension to hang indefinitely. In VS Code, terminal shell integration (`vscode.window.onDidEndTerminalShellExecution`) requires commands to run in non-interactive sessions without standard input. When interactive heredoc syntax was received, the terminal shell integration waited indefinitely for interactive EOF / stdin input, deadlocking the command execution handler. No output was returned, no exit code was produced, and the entire agent conversation froze.

Additionally, when heredocs did run in unmonitored environments, they directly modified files on disk, completely bypassing LUMI's workspace change observers (`StabilityMonitor`, `SessionBuffer`, dirty file trackers) and Legion file reservation locks (`assigned_files`).

## 2. Root Cause

1. **Specialist Prompt Asymmetry:** The conductor system prompt prohibited interactive commands, but `LegionAgentHost` injected only a minimal system prompt for specialists, lacking explicit instructions forbidding terminal heredoc file creation (`cat <<'EOF'`, `tee`, `echo >`) and mandating `write_to_file`.
2. **Missing Pre-Execution Interception:** `ExecuteCommandToolHandler`, `UniversalGuard`, and `FluidPolicyEngine` allowed heredoc commands to pass through to command approval and execution without inspecting shell tokens for file redirection.
3. **Approval Prompt UI Blocking:** Commands flagged for approval caused interactive UI confirmation prompts before pre-flight checks could evaluate them, interrupting autonomous specialist flow.
4. **Shell Integration Lack of Circuit-Breaker:** `VscodeTerminalProcess` dispatched multiline heredoc commands directly into VS Code's `terminal.shellIntegration.executeCommand`, which has no stdin stream and deadlocks on multiline heredocs.
5. **Complex Shell Syntax Edge Cases:** Heredocs appear in diverse syntax forms: before/after delimiters (`cat > file << 'EOF'`, `cat << 'EOF' > file`), piped (`cat << 'EOF' | sudo tee file`), tab-indented (`<<-EOF`), with quotes around filenames, and chained across compound commands (`&&`, `;`, `\n`). Simple substring searches failed or caused false positives on arithmetic bitwise shifts (`$((a << 2))`).

## 3. The Fix

A 4-tier defense-in-depth architecture was implemented:

1. **Tier 1 — Prompt Parity (`LegionAgentHost.ts`):**
   Defined `LEGION_CORE_RULES` mandating `write_to_file` and `replace_in_file`, strictly forbidding multiline heredocs (`cat <<'EOF'`, `cat > file`, `tee`, `echo >`) and interactive stdin redirection, and explaining that non-interactive terminal sessions deadlock on heredocs. Injected `LEGION_CORE_RULES` into every specialist system prompt.

2. **Tier 2 — Shell Token Policy Parser (`src/integrations/terminal/heredocPolicy.ts`):**
   - Implemented `findTopLevelHeredocs` with character-by-character quote, escape, and arithmetic expression tracking to identify genuine top-level heredocs while ignoring arithmetic shifts and string literals.
   - Implemented `detectHeredocFileRedirection` covering redirections before/after delimiters, piped commands to `tee`/`cat`, quoted paths, and compound statements. Returns actionable guidance directing the agent to use `write_to_file`.
   - Implemented `isMultilineHeredocCommand` to detect any multiline heredoc command that threatens shell integration deadlock.

3. **Tier 3 — Pre-Execution Interception & Approval Suppression:**
   - In `ExecuteCommandToolHandler.ts`, suppressed approval prompts if `detectHeredocFileRedirection(command).isHeredocFileWrite` is true, intercepted the command prior to execution, posted a `command_permission_denied` notice, and returned a descriptive tool error.
   - In `UniversalGuard.ts`, `FluidPolicyEngine.ts`, and `ToolValidator.ts`, validated commands pre-execution and rejected heredoc file writes immediately.

4. **Tier 4 — Shell Integration Circuit-Breaker (`VscodeTerminalProcess.ts` & `VscodeTerminalManager.ts`):**
   - In `VscodeTerminalProcess.run`, evaluated `isMultilineHeredocCommand(command)`. If running under interactive shell integration, safely rerouted to supervised managed terminal fallback or refused execution with an explicit error to prevent deadlock.
   - In `VscodeTerminalManager.ts`, deferred microtask dispatch so listeners attach before dispatch.

## 4. Prevention Now in Place

1. **Policy Parser Unit Tests:** `src/integrations/terminal/__tests__/heredocPolicy.test.ts` (33 unit tests) covers chained heredocs, quoted targets, single/double quotes, bitwise shift expressions, sudo tee, tab-indented syntax, and unclosed heredocs.
2. **Specialist Prompt Parity Tests:** `src/core/task/legion/__tests__/LegionAgentHost.test.ts` asserts that `LEGION_CORE_RULES` is injected into specialist system prompts and contains required mandates and prohibitions.
3. **Approval Interception Tests:** `src/core/task/tools/handlers/__tests__/ExecuteCommandToolHandler.approval.test.ts` verifies that multiline and single-line heredoc file writes are intercepted before asking for user approval and return guidance to use `write_to_file`.
4. **Terminal Process Circuit-Breaker Tests:** `src/hosts/vscode/terminal/VscodeTerminalProcess.test.ts` verifies fallback to managed terminal and safe refusal of unmonitored heredocs without deadlocking.
5. **Policy Pre-Execution Tests:** `src/core/policy/__tests__/FluidPolicyEngine.execution.test.ts` tests rejection during `validatePreExecution`.
6. Full test suite: **291 tests passing** with 0 TypeScript and 0 Biome lint errors.

