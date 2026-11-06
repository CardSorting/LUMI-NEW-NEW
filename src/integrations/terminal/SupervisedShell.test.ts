import { strict as assert } from "node:assert"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { SupervisedShell } from "./SupervisedShell"
import type { TerminalCompletionDetails } from "./types"

describe("supervised shell transport", function () {
	this.timeout(10_000)
	const running: SupervisedShell[] = []
	afterEach(async () => {
		sinon.restore()
		await Promise.all(running.splice(0).map((shell) => shell.terminate()))
	})
	function run(command: string, cwd = tmpdir(), shell = "/bin/sh") {
		const execution = new SupervisedShell()
		running.push(execution)
		let output = ""
		const done = new Promise<TerminalCompletionDetails>((resolve, reject) =>
			execution.start({
				cwd,
				shell,
				command,
				onData: (text) => {
					output += text
				},
				onComplete: resolve,
				onError: reject,
			}),
		)
		return { execution, done, output: () => output }
	}
	it("preserves the command, cwd, Unicode, stdout and stderr and reports a nonzero exit", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "lumi shell & quotes "))
		try {
			const command = run("printf '%s\\n' \"$PWD\" '工具 &amp; <tag>' && printf error >&2; exit 7", cwd)
			assert.equal((await command.done).exitCode, 7)
			assert.ok(command.output().includes(cwd))
			assert.ok(command.output().includes("工具 &amp; <tag>"))
			assert.ok(command.output().includes("error"))
		} finally {
			await rm(cwd, { recursive: true })
		}
	})
	it("reports spawn failures without rerunning or inventing completion", async () => {
		const command = run("printf must-not-run", tmpdir(), "/missing/lumi-shell")
		await assert.rejects(command.done, /ENOENT/)
		assert.equal(command.output(), "")
	})
	it("keeps ownership after a post-spawn error until the real exit", async () => {
		const execution = new SupervisedShell()
		running.push(execution)
		let observationError = ""
		const done = new Promise<TerminalCompletionDetails>((resolve, reject) =>
			execution.start({
				cwd: tmpdir(),
				shell: "/bin/sh",
				command: "sleep 0.1; exit 7",
				onData: () => {},
				onComplete: resolve,
				onError: reject,
				onObservationError: (error) => {
					observationError = error.message
				},
			}),
		)
		const child = (execution as any).child
		await once(child, "spawn")
		child.emit("error", new Error("observation disrupted"))
		assert.equal(observationError, "observation disrupted")
		child.emit("error", new Error("another error"))
		assert.equal(observationError, "another error")
		assert.equal((await done).exitCode, 7)
	})
	it("survives output stream and observer failures while retaining the exit", async () => {
		const execution = new SupervisedShell()
		running.push(execution)
		const observations: string[] = []
		const done = new Promise<TerminalCompletionDetails>((resolve, reject) =>
			execution.start({
				cwd: tmpdir(),
				shell: "/bin/sh",
				command: "sleep 0.1; printf output; exit 7",
				onData: () => {
					throw new Error("output observer failed")
				},
				onComplete: resolve,
				onError: reject,
				onObservationError: (error) => {
					observations.push(error.message)
					throw new Error("error observer failed")
				},
			}),
		)
		const child = (execution as any).child
		await once(child, "spawn")
		child.stdout.emit("error", new Error("stdout disconnected"))
		child.stderr.emit("error", new Error("stderr disconnected"))
		assert.equal((await done).exitCode, 7)
		assert.deepEqual(observations, ["stdout disconnected", "stderr disconnected", "output observer failed"])
	})
	it("accepts piped input while retaining its connection until exit", async () => {
		const command = run("read value; printf '%s' \"$value\"")
		command.execution.write("input with spaces\n")
		assert.equal((await command.done).exitCode, 0)
		assert.equal(command.output(), "input with spaces")
	})
	it("stops the owned process group even when the shell ignores TERM", async () => {
		let ready!: () => void
		const started = new Promise<void>((resolve) => {
			ready = resolve
		})
		const execution = new SupervisedShell()
		running.push(execution)
		const done = new Promise<TerminalCompletionDetails>((resolve, reject) =>
			execution.start({
				cwd: tmpdir(),
				shell: "/bin/sh",
				command: "trap '' TERM; sleep 30 & printf ready; wait",
				onData: () => ready(),
				onComplete: resolve,
				onError: reject,
			}),
		)
		await started
		await execution.terminate()
		const result = await done
		assert.equal(result.cancelled, true)
		assert.equal(result.signal, "SIGKILL")
	})
	it("honors a stop requested before the child PID becomes available", async () => {
		const command = run("sleep 30")
		const child = (command.execution as any).child
		const pid = child.pid
		child.pid = undefined
		child.once("spawn", () => {
			child.pid = pid
		})
		const stopping = command.execution.terminate()
		await stopping
		const result = await command.done
		assert.equal(result.cancelled, true)
		assert.ok(result.signal)
	})
	if (process.platform !== "win32")
		it("does not report a failed stop as a confirmed cancellation", async () => {
			const command = run("sleep 0.1; exit 7")
			const child = (command.execution as any).child
			await once(child, "spawn")
			const failure = Object.assign(new Error("permission denied"), { code: "EPERM" })
			sinon.stub(process, "kill").throws(failure)
			await assert.rejects(command.execution.terminate(), /permission denied/)
			const result = await command.done
			assert.equal(result.exitCode, 7)
			assert.equal(result.cancelled, false)
		})
	it("does not dispatch an execution twice or after a prelaunch cancellation", async () => {
		const command = run("printf once")
		await command.done
		assert.throws(
			() =>
				command.execution.start({
					cwd: tmpdir(),
					shell: "/bin/sh",
					command: "printf twice",
					onData: () => {},
					onComplete: () => {},
					onError: () => {},
				}),
			/already been dispatched/,
		)
		assert.equal(command.output(), "once")
		const execution = new SupervisedShell()
		await execution.terminate()
		const result = await new Promise<TerminalCompletionDetails>((resolve, reject) =>
			execution.start({
				cwd: tmpdir(),
				shell: "/bin/sh",
				command: "exit 5",
				onData: () => {},
				onComplete: resolve,
				onError: reject,
			}),
		)
		assert.equal(result.cancelled, true)
		assert.equal(result.exitCode, undefined)
	})
})
