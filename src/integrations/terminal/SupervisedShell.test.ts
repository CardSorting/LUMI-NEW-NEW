import { strict as assert } from "node:assert"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "mocha"
import { SupervisedShell } from "./SupervisedShell"
import type { TerminalCompletionDetails } from "./types"

describe("supervised shell transport", function () {
	this.timeout(10_000)
	const running: SupervisedShell[] = []
	afterEach(async () => {
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
