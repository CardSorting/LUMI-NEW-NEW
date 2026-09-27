import { isUtf8 } from "node:buffer"
import { randomUUID } from "node:crypto"
import * as path from "node:path"
import { workspaceResolver } from "@core/workspace"
import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { getCwd } from "@utils/path"
import * as fs from "fs/promises"
import * as iconv from "iconv-lite"
import { detectEncoding } from "../misc/extract-text"
import { canonicalFilePath, withFileMutation } from "./FileMutationCoordinator"

/**
 * A file-system-based implementation of DiffViewProvider that performs direct file operations
 * without visual editor integration. This provider uses the Node.js fs package to handle
 * file edits in-memory and then writes them to disk.
 *
 * Visual operations like scrolling are implemented as no-ops since there is no UI component.
 * This makes it suitable for headless or non-interactive environments.
 */
export class FileEditProvider extends DiffViewProvider {
	private documentContent?: string
	private originalBytes?: Buffer
	private committed = false
	private requestedPath?: string

	constructor(
		private readonly cwd?: string,
		private readonly signal?: AbortSignal,
		private readonly assertAuthority?: () => void,
	) {
		super()
	}

	override showFile(_absolutePath: string): Promise<void> {
		// No-op: No visual editor to show the file
		return Promise.resolve()
	}

	protected async openDiffEditor(): Promise<void> {
		// No-op: No visual editor to open in a file-system-only provider
		// The file content is already loaded in the base class's open() method
		this.documentContent = this.originalContent || ""
	}

	override async open(relPath: string, options?: { displayPath?: string }): Promise<void> {
		this.signal?.throwIfAborted()
		this.assertAuthority?.()
		const editType = this.editType
		await this.reset()
		this.editType = editType
		const resolved = workspaceResolver.resolveWorkspacePath(this.cwd ?? (await getCwd()), relPath, "FileEditProvider.open")
		const requestedPath = typeof resolved === "string" ? resolved : resolved.absolutePath
		this.requestedPath = requestedPath
		// Resolve aliases before locking so two helpers cannot write the same file through different symlinks.
		try {
			this.absolutePath = await fs.realpath(requestedPath)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			this.absolutePath = requestedPath
		}
		this.relPath = options?.displayPath ?? relPath
		try {
			this.originalBytes = await fs.readFile(this.absolutePath)
			if (editType === "create") throw new Error(`File already exists: ${this.relPath}. Read it before editing.`)
			this.fileEncoding = isUtf8(this.originalBytes) ? "utf8" : await detectEncoding(this.originalBytes)
			this.originalContent = iconv.decode(this.originalBytes, this.fileEncoding)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || editType !== "create") throw error
			this.originalBytes = undefined
			this.originalContent = ""
			this.fileEncoding = "utf8"
		}
		this.documentContent = this.originalContent
		this.isEditing = true
		this.committed = false
	}

	protected override async getNewDiagnosticProblems(): Promise<string> {
		return ""
	}

	/** Headless preparation has no disk effects to undo. Never restore stale bytes over another writer. */
	override async revertChanges(): Promise<void> {
		await this.reset()
	}

	async replaceText(
		content: string,
		rangeToReplace: { startLine: number; endLine: number },
		_currentLine: number | undefined,
	): Promise<void> {
		if (this.documentContent === undefined) {
			throw new Error("Document not initialized")
		}

		// Split the document into lines
		const lines = this.documentContent.split("\n")

		// Check if we're replacing to the end of the document
		const replacingToEnd = rangeToReplace.endLine >= lines.length

		// Replace the specified range with the new content
		const newContentLines = content.split("\n")

		// Remove trailing empty line for proper splicing, BUT only when NOT replacing
		// to the end of the document. When replacing to the end, keep the trailing
		// empty string to preserve trailing newlines from the content.
		if (!replacingToEnd && newContentLines[newContentLines.length - 1] === "") {
			newContentLines.pop()
		}

		// Splice the lines array to replace the range
		lines.splice(rangeToReplace.startLine, rangeToReplace.endLine - rangeToReplace.startLine, ...newContentLines)

		// Join the lines back together
		this.documentContent = lines.join("\n")
	}

	protected async scrollEditorToLine(_line: number): Promise<void> {
		// No-op: No visual editor to scroll
	}

	protected async scrollAnimation(_startLine: number, _endLine: number): Promise<void> {
		// No-op: No visual editor to animate
	}

	protected async truncateDocument(lineNumber: number): Promise<void> {
		if (!this.documentContent) {
			return
		}

		// Split the document into lines and keep only up to lineNumber
		const lines = this.documentContent.split("\n")
		if (lineNumber < lines.length) {
			this.documentContent = lines.slice(0, lineNumber).join("\n")
		}
	}

	protected async getDocumentLineCount(): Promise<number> {
		if (!this.documentContent) {
			return 0
		}
		return this.documentContent.split("\n").length
	}

	protected async getDocumentText(): Promise<string | undefined> {
		return this.documentContent
	}

	/**
	 * Public method to get the current document content.
	 * This is exposed for use by tools that need to read the document state.
	 */
	public async getContent(): Promise<string | undefined> {
		return this.getDocumentText()
	}

	protected async saveDocument(): Promise<boolean> {
		if (!this.absolutePath || this.documentContent === undefined) {
			return false
		}
		if (this.committed) return true
		this.signal?.throwIfAborted()
		this.assertAuthority?.()
		const target = this.absolutePath
		const prefix = this.originalBytes?.subarray(0, 3).toString("hex") ?? ""
		const addBOM = prefix === "efbbbf" || prefix.startsWith("fffe") || prefix.startsWith("feff")
		const bytes = iconv.encode(this.documentContent, this.fileEncoding, { addBOM })
		if (iconv.decode(bytes, this.fileEncoding) !== this.documentContent)
			throw new Error(
				`File was not saved: the new content cannot be represented in ${this.fileEncoding}. Convert the file encoding explicitly before applying this edit.`,
			)
		const canonicalPath = await canonicalFilePath(target)
		await withFileMutation(
			canonicalPath,
			async () => {
				this.assertAuthority?.()
				if ((await canonicalFilePath(this.requestedPath!)) !== canonicalPath)
					throw new Error(
						`Edit conflict: ${this.relPath} now resolves to a different file. Read and reconcile it first.`,
					)
				this.signal?.throwIfAborted()
				await fs.mkdir(path.dirname(target), { recursive: true })
				let current: Buffer | undefined
				try {
					current = await fs.readFile(target)
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				}
				if (
					current === undefined
						? this.originalBytes !== undefined
						: this.originalBytes === undefined || !current.equals(this.originalBytes)
				) {
					throw new Error(
						`Edit conflict: ${this.relPath} changed after it was read. No content was overwritten. Read the current file and reconcile the intended change.`,
					)
				}
				const mode = this.originalBytes === undefined ? undefined : (await fs.stat(target)).mode
				const temporary = path.join(path.dirname(target), `.lumi-${randomUUID()}.tmp`)
				try {
					await fs.writeFile(temporary, bytes, { flag: "wx", mode })
					if (mode !== undefined) await fs.chmod(temporary, mode & 0o777)
					// This is the commit boundary. Cancellation after the OS mutation is
					// dispatched cannot undo it; its successful receipt must still return.
					this.signal?.throwIfAborted()
					this.assertAuthority?.()
					if (this.originalBytes === undefined) await fs.link(temporary, target)
					else await fs.rename(temporary, target)
				} finally {
					await fs.rm(temporary, { force: true }).catch(() => {})
				}
				this.committed = true
			},
			this.signal,
		)
		return true
	}

	override async deleteFile(_fileName: string): Promise<void> {
		this.signal?.throwIfAborted()
		this.assertAuthority?.()
		if (!this.absolutePath || !this.isEditing || this.originalBytes === undefined)
			throw new Error("No existing file is prepared for deletion.")
		const target = this.absolutePath
		await withFileMutation(
			target,
			async () => {
				if ((await canonicalFilePath(this.requestedPath!)) !== target)
					throw new Error(`Edit conflict: ${this.relPath} now resolves to a different file.`)
				if (!(await fs.readFile(target)).equals(this.originalBytes!))
					throw new Error(`Edit conflict: ${this.relPath} changed before deletion. Read and reconcile it first.`)
				this.signal?.throwIfAborted()
				this.assertAuthority?.()
				await fs.unlink(this.requestedPath!)
				this.committed = true
				this.isEditing = false
			},
			this.signal,
		)
	}

	protected async closeAllDiffViews(): Promise<void> {
		// No-op: No visual diff views to close
	}

	protected async resetDiffView(): Promise<void> {
		// Clean up the in-memory document content
		this.documentContent = undefined
		this.originalBytes = undefined
		this.committed = false
		this.requestedPath = undefined
	}
}
