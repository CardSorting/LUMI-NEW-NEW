export interface CheckpointDiffFile {
	relativePath: string
	absolutePath: string
	before: string
	after: string
}

/**
 * Common interface for checkpoint managers
 * Allows single-root and multi-root managers to be used interchangeably
 */
export interface ICheckpointManager {
	saveCheckpoint(isAttemptCompletionMessage?: boolean, completionMessageTs?: number): Promise<void>

	restoreCheckpoint(messageTs: number, restoreType: any, offset?: number): Promise<any>

	doesLatestTaskCompletionHaveNewChanges(): Promise<boolean>

	commit(): Promise<string | undefined>

	presentMultifileDiff?(messageTs: number, seeNewChangesSinceLastTaskCompletion: boolean): Promise<void>

	/** Read the same saved diff for review and inline explanations. Reject unavailable snapshots. */
	getCheckpointDiff?(messageTs: number, seeNewChangesSinceLastTaskCompletion: boolean): Promise<CheckpointDiffFile[]>

	// Optional method for multi-root specific initialization
	initialize?(): Promise<void>

	// Optional method for checking and initializing checkpoint tracker
	checkpointTrackerCheckAndInit?(): Promise<any>
}
