/**
 * Terminal command execution shared by the VS Code extension runtime.
 */

// Export command orchestrator (shared logic)
export { findLastIndex } from "@shared/array"
// Export unified command executor
export { CommandExecutor } from "./CommandExecutor"
export { orchestrateCommandExecution } from "./CommandOrchestrator"
export type { HeredocRedirectionDetection } from "./heredocPolicy"
export { detectHeredocFileRedirection, findTopLevelHeredocs, isMultilineHeredocCommand } from "./heredocPolicy"

// Export all types from types.ts
export type {
	// Command Executor types
	AskResponse,
	CommandExecutionOptions,
	CommandExecutionResult,
	CommandExecutionSnapshot,
	CommandExecutorCallbacks,
	CommandExecutorConfig,
	FullCommandExecutorConfig,
	// Terminal types
	ITerminal,
	ITerminalManager,
	ITerminalProcess,
	ITerminalProcessResult,
	// Command Orchestrator types
	OrchestrationOptions,
	OrchestrationResult,
	TerminalInfo,
	TerminalProcessEvents,
	TerminalProcessResultPromise,
} from "./types"
