import type { ChangedFile } from "./explainChangesShared"

/** Parse complete lines so network chunk boundaries cannot become comment boundaries. */
export class ExplanationStreamParser {
	private buffer = ""
	private file?: ChangedFile
	private line?: number
	private inComment = false
	private count = 0
	private readonly absoluteFiles = new Map<string, ChangedFile>()
	private readonly relativeFiles = new Map<string, ChangedFile | undefined>()

	constructor(
		files: ChangedFile[],
		private readonly callbacks: {
			start: (filePath: string, startLine: number, endLine: number) => void
			chunk: (text: string) => void
			end: () => void
		},
	) {
		for (const file of files) {
			this.absoluteFiles.set(this.normalize(file.absolutePath), file)
			const relative = this.normalize(file.relativePath)
			this.relativeFiles.set(relative, this.relativeFiles.has(relative) ? undefined : file)
		}
	}

	get commentCount(): number {
		return this.count
	}

	push(text: string): void {
		this.buffer += text
		let newline = this.buffer.indexOf("\n")
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, "")
			this.buffer = this.buffer.slice(newline + 1)
			this.processLine(line, "\n")
			newline = this.buffer.indexOf("\n")
		}
	}

	finish(): number {
		if (this.buffer) this.processLine(this.buffer.replace(/\r$/, ""), "")
		this.buffer = ""
		this.endComment()
		return this.count
	}

	private normalize(path: string): string {
		return path.replace(/\\/g, "/")
	}

	private endComment(): void {
		if (this.inComment) {
			this.inComment = false
			this.callbacks.end()
		}
		this.line = undefined
	}

	private processLine(line: string, ending: string): void {
		const marker = line.trim()
		if (marker.startsWith("@@@ FILE:")) {
			this.endComment()
			const path = this.normalize(marker.slice("@@@ FILE:".length).trim())
			this.file = this.absoluteFiles.get(path) ?? this.relativeFiles.get(path)
			return
		}
		if (marker.startsWith("@@@ LINE:")) {
			this.endComment()
			const value = marker.slice("@@@ LINE:".length).trim()
			const lineNumber = Number(value)
			const lineCount = this.file?.after.split("\n").length ?? 0
			if (this.file && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(lineNumber) && lineNumber < lineCount) {
				this.line = lineNumber
			}
			return
		}
		if (marker.startsWith("@@@")) {
			this.endComment()
			this.file = undefined
			return
		}
		if (!this.file || this.line === undefined) return
		if (!this.inComment) {
			if (!marker) return
			this.inComment = true
			this.count++
			this.callbacks.start(this.file.absolutePath, this.line, this.line)
		}
		this.callbacks.chunk(line + ending)
	}
}
