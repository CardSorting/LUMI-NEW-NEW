import type { DiffViewProvider } from "@/integrations/editor/DiffViewProvider"

export interface FileOpsResult {
	finalContent?: string
	deleted?: boolean
	newProblemsMessage?: string
	userEdits?: string
	autoFormattingEdits?: string
}

/** Preserve machine-readable mutation evidence when a later step of a patch fails. */
export class PartialPatchError extends Error {
	constructor(
		readonly committedPaths: string[],
		cause: unknown,
	) {
		super(
			`${cause instanceof Error ? cause.message : String(cause)}\nAlready committed: ${committedPaths.join(", ")}. These changes were retained. Read the current files and reconcile the remaining changes; do not repeat the entire patch.`,
			{ cause },
		)
		this.name = "PartialPatchError"
	}
}

/**
 * Utility class for file operations via a DiffViewProvider
 */
export class FileProviderOperations {
	constructor(
		private provider: DiffViewProvider,
		private readonly signal?: AbortSignal,
		private readonly assertAuthority?: () => void,
	) {}

	async openFile(path: string): Promise<void> {
		this.signal?.throwIfAborted()
		this.assertAuthority?.()
		await this.provider.open(path)
	}

	/**
	 * Saves the current changes and returns the result.
	 */
	async saveChanges(): Promise<FileOpsResult> {
		this.signal?.throwIfAborted()
		this.assertAuthority?.()
		const result = await this.provider.saveChanges()
		return result
	}

	/**
	 * Creates a file. If isFinal is false, prepares the creation without saving.
	 * Call saveChanges() after approval when isFinal is false.
	 */
	async createFile(path: string, content: string, isFinal = true): Promise<FileOpsResult | undefined> {
		this.provider.editType = "create"
		await this.openFile(path)
		// Always pass isFinal=true to update() to ensure proper document finalization
		// (extends replacement range to full document, truncates trailing content).
		// The isFinal parameter here only controls whether to save after the update.
		await this.provider.update(content, true)

		if (isFinal) {
			return await this.saveChanges()
		}
		return undefined
	}

	/**
	 * Modifies a file. If isFinal is false, prepares the modification without saving.
	 * Call saveChanges() after approval when isFinal is false.
	 */
	async modifyFile(
		path: string,
		content: string,
		isFinal = true,
		expectedOriginal?: string,
	): Promise<FileOpsResult | undefined> {
		this.provider.editType = "modify"
		await this.openFile(path)
		if (expectedOriginal !== undefined && this.provider.originalContent !== expectedOriginal)
			throw new Error(
				`Edit conflict: ${path} changed while the patch was prepared. Read and reconcile the current contents.`,
			)
		// Always pass isFinal=true to update() to ensure proper document finalization
		// (extends replacement range to full document, truncates trailing content).
		// The isFinal parameter here only controls whether to save after the update.
		await this.provider.update(content, true)

		if (isFinal) {
			return await this.saveChanges()
		}
		return undefined
	}

	/**
	 * Deletes a file. If isFinal is false, prepares the deletion without actually deleting.
	 * Opens the file in the diff view to show it will be deleted.
	 * Call deleteFile() with isFinal=true after approval when isFinal is false.
	 */
	async deleteFile(path: string, isFinal = true, expectedOriginal?: string): Promise<FileOpsResult | undefined> {
		this.provider.editType = "delete"
		await this.openFile(path)
		if (expectedOriginal !== undefined && this.provider.originalContent !== expectedOriginal)
			throw new Error(
				`Edit conflict: ${path} changed while deletion was prepared. Read and reconcile the current contents.`,
			)

		if (isFinal) {
			this.signal?.throwIfAborted()
			this.assertAuthority?.()
			await this.provider.deleteFile(path)
			return undefined
		}
		// Update with empty content to show the file will be deleted
		// Always pass isFinal=true to update() to ensure proper document finalization
		await this.provider.update("", true)
		return undefined
	}

	/**
	 * Moves a file from oldPath to newPath. If isFinal is false, prepares the move without saving.
	 * Call saveChanges() after approval when isFinal is false.
	 */
	async moveFile(oldPath: string, newPath: string, content: string, isFinal = true): Promise<FileOpsResult | undefined> {
		if (isFinal) {
			const result = await this.createFile(newPath, content, isFinal)
			await this.deleteFile(oldPath, isFinal)
			return result
		}
		await this.createFile(newPath, content, isFinal)
		await this.deleteFile(oldPath, isFinal)
		return undefined
	}

	async getFileContent(): Promise<string | undefined> {
		return this.provider.originalContent
	}
}
