import * as fs from "node:fs"
import { DietCodeTempManager } from "@services/temp"
import { MAX_BYTES_BEFORE_FILE, MAX_FULL_OUTPUT_SIZE, MAX_LINES_BEFORE_FILE, SUMMARY_LINES_TO_KEEP } from "./constants"

const MAX_LOG_BYTES = 16 * 1024 * 1024
const MAX_DISPLAY_LINE_CHARS = 16 * 1024
const LOG_FLUSH_TIMEOUT_MS = 1000

function displayLine(line: string): string {
	return line.length <= MAX_DISPLAY_LINE_CHARS
		? line
		: `${line.slice(0, MAX_DISPLAY_LINE_CHARS / 2)} … (line truncated) … ${line.slice(-MAX_DISPLAY_LINE_CHARS / 2)}`
}

/** Capture output synchronously; slow UI and disk cannot reorder lines or grow memory without bound. */
export class CommandOutputCollector {
	private lines: string[] = []
	private first: string[] = []
	private last: string[] = []
	private totalLines = 0
	private totalBytes = 0
	private logBytes = 0
	private summarized = false
	private stream?: fs.WriteStream
	private logPath?: string
	private logProblem?: string
	private finishing?: Promise<void>

	append(line: string): void {
		if (this.finishing) return
		this.totalLines++
		this.totalBytes += Buffer.byteLength(line, "utf8")
		if (!this.summarized && (this.lines.length >= MAX_LINES_BEFORE_FILE || this.totalBytes >= MAX_BYTES_BEFORE_FILE)) {
			this.summarized = true
			this.first = this.lines.slice(0, SUMMARY_LINES_TO_KEEP).map(displayLine)
			this.last = this.lines.slice(SUMMARY_LINES_TO_KEEP).slice(-SUMMARY_LINES_TO_KEEP).map(displayLine)
			try {
				this.logPath = DietCodeTempManager.createTempFilePath("large-output")
				this.stream = fs.createWriteStream(this.logPath, { flags: "wx" })
				this.stream.on("error", (error) => {
					this.logProblem = `Log unavailable: ${error.message}`
				})
				if (this.lines.length) this.writeLog(`${this.lines.join("\n")}\n`)
			} catch (error) {
				this.logProblem = `Log unavailable: ${error instanceof Error ? error.message : String(error)}`
			}
			this.lines = []
		}
		if (this.summarized) {
			this.writeLog(`${line}\n`)
			if (this.first.length < SUMMARY_LINES_TO_KEEP) this.first.push(displayLine(line))
			else {
				this.last.push(displayLine(line))
				if (this.last.length > SUMMARY_LINES_TO_KEEP) this.last.shift()
			}
		} else this.lines.push(line)
	}

	private writeLog(text: string): void {
		if (!this.stream || this.logProblem) return
		if (this.stream.writableLength > MAX_FULL_OUTPUT_SIZE) {
			this.logProblem = "Log truncated because disk output could not keep up; the command continues."
			return
		}
		const remaining = MAX_LOG_BYTES - this.logBytes
		const data = Buffer.from(text, "utf8")
		try {
			this.stream.write(data.subarray(0, remaining))
			this.logBytes += Math.min(data.length, remaining)
			if (data.length > remaining) this.logProblem = "Log reached its 16 MB limit; the command continues."
		} catch (error) {
			this.logProblem = `Log unavailable: ${error instanceof Error ? error.message : String(error)}`
		}
	}

	getSnapshot(): { lines: string[]; logFilePath?: string; logNotice?: string } {
		if (!this.summarized) return { lines: this.lines.map(displayLine) }
		const omitted = Math.max(0, this.totalLines - this.first.length - this.last.length)
		return {
			lines: [
				...this.first,
				...(omitted > 0 ? [`\n... (${omitted} lines omitted from this summary) ...\n`] : []),
				...this.last,
			],
			logFilePath: this.logPath,
			logNotice: this.logProblem ?? `Full captured output saved to: ${this.logPath}`,
		}
	}

	finish(): Promise<void> {
		if (this.finishing) return this.finishing
		const stream = this.stream
		this.finishing = new Promise<void>((resolve) => {
			if (!stream || stream.closed || stream.destroyed) {
				resolve()
				return
			}
			let timer: NodeJS.Timeout | undefined
			const done = () => {
				if (timer) clearTimeout(timer)
				stream.off("finish", done)
				stream.off("close", done)
				stream.off("error", done)
				resolve()
			}
			stream.once("finish", done)
			stream.once("close", done)
			stream.once("error", done)
			timer = setTimeout(() => {
				this.logProblem = "Log flush timed out; some output may be missing."
				stream.destroy()
				done()
			}, LOG_FLUSH_TIMEOUT_MS)
			try {
				stream.end()
			} catch (error) {
				this.logProblem = `Log flush failed: ${String(error)}`
				done()
			}
		})
		return this.finishing
	}
}
