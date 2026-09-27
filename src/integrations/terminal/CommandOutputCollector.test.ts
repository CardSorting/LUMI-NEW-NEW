import { strict as assert } from "node:assert"
import fs from "node:fs"
import { readFile, unlink } from "node:fs/promises"
import { Writable } from "node:stream"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { CommandOutputCollector } from "./CommandOutputCollector"

describe("command output capture", () => {
	afterEach(() => sinon.restore())
	it("captures a synchronous burst in order, closes the log, and returns a bounded summary", async () => {
		const output = new CommandOutputCollector()
		const expected = Array.from({ length: 1500 }, (_, i) => `line ${i}`)
		for (const line of expected) output.append(line)
		await output.finish()
		const snapshot = output.getSnapshot()
		try {
			assert.equal(await readFile(snapshot.logFilePath!, "utf8"), `${expected.join("\n")}\n`)
			assert.equal(snapshot.lines.length, 201)
			assert.equal(snapshot.lines[0], "line 0")
			assert.equal(snapshot.lines.at(-1), "line 1499")
			assert.match(snapshot.logNotice!, /Full captured output/)
		} finally {
			await unlink(snapshot.logFilePath!)
		}
	})
	it("preserves first and latest output if disk logging fails", async () => {
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				callback(new Error("disk full"))
			},
		})
		sinon.stub(fs, "createWriteStream").returns(stream as fs.WriteStream)
		const output = new CommandOutputCollector()
		for (let i = 0; i < 1500; i++) output.append(`line ${i}`)
		await output.finish()
		const snapshot = output.getSnapshot()
		assert.match(snapshot.logNotice!, /disk full/)
		assert.equal(snapshot.lines[0], "line 0")
		assert.equal(snapshot.lines.at(-1), "line 1499")
	})
	it("bounds a hung disk flush and continues retaining a useful summary", async () => {
		const clock = sinon.useFakeTimers()
		const stream = new Writable({ write() {} })
		sinon.stub(fs, "createWriteStream").returns(stream as fs.WriteStream)
		const output = new CommandOutputCollector()
		for (let i = 0; i < 1100; i++) output.append(`line ${i}`)
		const done = output.finish()
		await clock.tickAsync(1000)
		await done
		assert.match(output.getSnapshot().logNotice!, /timed out/)
		assert.equal(stream.destroyed, true)
		assert.equal(clock.countTimers(), 0)
	})
	it("caps disk backpressure and oversized lines without losing the latest output", async () => {
		const stream = new Writable({ write() {} })
		sinon.stub(fs, "createWriteStream").returns(stream as fs.WriteStream)
		const output = new CommandOutputCollector()
		for (let i = 0; i < 30; i++) output.append(`line ${i} ${"x".repeat(100_000)}`)
		output.append("last line")
		const snapshot = output.getSnapshot()
		assert.match(snapshot.logNotice!, /could not keep up/)
		assert.ok(stream.writableLength < 1_200_000)
		assert.ok(snapshot.lines.every((line) => line.length < 17_000))
		assert.equal(snapshot.lines.at(-1), "last line")
		stream.destroy()
		await output.finish()
	})
	it("limits the log without stopping capture of the latest command state", async () => {
		let written = 0
		const stream = new Writable({
			write(chunk, _encoding, callback) {
				written += chunk.length
				callback()
			},
		})
		sinon.stub(fs, "createWriteStream").returns(stream as fs.WriteStream)
		const output = new CommandOutputCollector()
		for (let i = 0; i < 600; i++) output.append("x".repeat(32 * 1024))
		output.append("finished")
		await output.finish()
		assert.equal(written, 16 * 1024 * 1024)
		assert.match(output.getSnapshot().logNotice!, /16 MB limit/)
		assert.equal(output.getSnapshot().lines.at(-1), "finished")
	})
})
