import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import * as vscode from "vscode"
import { CommandExecutor } from "@/integrations/terminal/CommandExecutor"
import { CommandRuntimeRegistry } from "@/integrations/terminal/CommandRuntime"
import type { CommandExecutorCallbacks, TerminalInfo } from "@/integrations/terminal/types"
import { ManagedTerminal } from "./ManagedTerminal"
import { VscodeTerminalManager } from "./VscodeTerminalManager"
import { VscodeTerminalProcess } from "./VscodeTerminalProcess"
import { TerminalRegistry } from "./VscodeTerminalRegistry"

const hostEvents = new EventEmitter()

function terminal(stream?: AsyncIterable<string>, complete = true) {
	const execution = {
		read: async function* () {
			yield* stream!
			if (complete) hostEvents.emit("end", { terminal: target, execution, exitCode: 0 })
		},
	}
	const target = {
		dispose: sinon.spy(() => hostEvents.emit("close", target)),
		sendText: sinon.spy(),
		shellIntegration: stream ? { executeCommand: sinon.stub().returns(execution) } : undefined,
	} as unknown as vscode.Terminal & { dispose: sinon.SinonSpy; sendText: sinon.SinonSpy }
	return target
}
function manager() {
	return Object.assign(Object.create(VscodeTerminalManager.prototype), {
		processes: new Map(),
		terminalIds: new Set([1]),
		shellIntegrationTimeout: 100,
	}) as VscodeTerminalManager
}

describe("VS Code command lifecycle", () => {
	beforeEach(() => {
		sinon.stub(vscode.window as any, "onDidEndTerminalShellExecution").value((listener: (event: unknown) => void) => {
			hostEvents.on("end", listener)
			return {
				dispose: () => {
					hostEvents.off("end", listener)
				},
			}
		})
		sinon.stub(vscode.window, "onDidCloseTerminal").callsFake((listener) => {
			hostEvents.on("close", listener)
			return {
				dispose: () => {
					hostEvents.off("close", listener)
				},
			}
		})
	})
	afterEach(() => {
		sinon.restore()
		hostEvents.removeAllListeners()
	})
	it("attaches listeners before dispatch and captures immediate output and completion", async () => {
		const target = terminal(
			(async function* () {
				yield "output\n"
			})(),
		)
		const process = manager().runCommand({ id: 1, terminal: target } as unknown as TerminalInfo, "test")
		const lines: string[] = []
		process.on("line", (line) => lines.push(line))
		let completed = false
		process.once("completed", () => {
			completed = true
		})
		await process
		assert.equal(lines.at(-1), "output")
		assert.equal(completed, true)
	})
	it("captures a host completion emitted synchronously inside executeCommand", async () => {
		const target = terminal(
			(async function* () {
				yield "done\n"
			})(),
			false,
		)
		const execution = {
			read: async function* () {
				yield "done\n"
			},
		}
		;(target.shellIntegration!.executeCommand as sinon.SinonStub).callsFake(() => {
			hostEvents.emit("end", { terminal: target, execution, exitCode: 4 })
			return execution
		})
		const process = manager().runCommand({ id: 1, terminal: target } as unknown as TerminalInfo, "test")
		await process
		assert.equal(process.getCompletionDetails!().exitCode, 4)
	})
	it("accepts late exit-code confirmation after an unknown host event", async () => {
		const clock = sinon.useFakeTimers()
		const target = terminal(
			(async function* () {
				yield "output\n"
			})(),
			false,
		)
		const info = { id: 1, terminal: target, busy: false } as unknown as TerminalInfo
		const process = manager().runCommand(info, "test")
		await clock.tickAsync(0)
		const execution = (target.shellIntegration!.executeCommand as sinon.SinonStub).firstCall.returnValue
		hostEvents.emit("end", { terminal: target, execution })
		await process
		assert.equal(info.busy, true)
		hostEvents.emit("end", { terminal: target, execution, exitCode: 0 })
		await clock.tickAsync(1000)
		assert.equal(info.busy, false)
		assert.equal(process.getCompletionDetails!().exitCode, 0)
	})
	it("does not dispatch unobservable commands without a configured fallback", async () => {
		const target = terminal()
		const process = new VscodeTerminalProcess(target)
		const error = sinon.spy()
		process.on("error", error)
		await process.run(target, "must-not-run")
		sinon.assert.calledOnce(error)
		sinon.assert.notCalled(target.sendText)
		assert.match(error.firstCall.args[0].message, /did not start/)
	})
	it("keeps observation snapshots independent of streamed and environment output cursors", async () => {
		const target = terminal(
			(async function* () {
				yield "first\nsecond\n"
			})(),
		)
		const process = manager().runCommand({ id: 1, terminal: target } as unknown as TerminalInfo, "test")
		process.on("line", () => {})
		await process
		const before = process.getOutputSnapshot!()
		process.getUnretrievedOutput()
		assert.equal(process.getOutputSnapshot!(), before)
		assert.equal(process.getOutputSnapshot!(), "first\nsecond\n")
	})
	it("bounds snapshot history and preserves truncation notices after other readers consume output", async () => {
		const target = terminal(
			(async function* () {
				yield "a".repeat(1_200_000) + "final"
			})(),
		)
		const process = manager().runCommand({ id: 1, terminal: target } as unknown as TerminalInfo, "test")
		await process
		process.getUnretrievedOutput()
		const output = process.getOutputSnapshot!()
		assert.ok(output.length <= 64_000)
		assert.match(output, /Earlier terminal output was truncated/)
		assert.ok(output.endsWith("final"))
		assert.equal(process.getOutputSnapshot!(), output)
	})
	it("rejects a launch failure instead of stranding the foreground promise", async () => {
		const target = terminal((async function* () {})())
		;(target.shellIntegration!.executeCommand as sinon.SinonStub).throws(new Error("shell unavailable"))
		const info = { id: 1, terminal: target, busy: false } as unknown as TerminalInfo
		await assert.rejects(manager().runCommand(info, "test"), /shell unavailable/)
		assert.equal(info.busy, false)
	})
	it("uses a supervised transport when integration is unavailable and never sends untracked text", async () => {
		const target = terminal()
		const info = { id: 1, terminal: target, busy: false, cwd: "/tmp", shellPath: "/bin/sh" } as unknown as TerminalInfo
		const owner = manager()
		const process = owner.runCommand(info, "printf 'supervised output'; exit 7")
		const completed = sinon.spy()
		process.once("completed", completed)
		await process
		assert.equal(info.busy, false)
		sinon.assert.calledOnce(completed)
		sinon.assert.notCalled(target.sendText)
		assert.match(process.getOutputSnapshot!(), /supervised output/)
		assert.equal(process.getCompletionDetails!().exitCode, 7)
		assert.equal((owner as any).processes.get(1), process)
		sinon.assert.calledOnce(target.dispose)
		const next = owner.runCommand(info, "printf reused")
		await next
		assert.match(next.getOutputSnapshot!(), /fresh shell state/)
		assert.ok(next.getOutputSnapshot!().endsWith("reused"))
		info.terminal.dispose()
	})
	it("reconnects a real supervised shell with its stdin, output, and exit receipt intact", async () => {
		const createTerminal = sinon.spy(vscode.window, "createTerminal")
		const managed = new ManagedTerminal("/tmp", "/bin/sh")
		const pty = (createTerminal.lastCall.args[0] as vscode.ExtensionTerminalOptions).pty
		const info = {
			id: 1,
			terminal: managed.terminal,
			managed,
			busy: false,
			cwd: "/tmp",
			shellPath: "/bin/sh",
		} as unknown as TerminalInfo
		const owner = new VscodeTerminalManager()
		sinon.stub(owner, "getOrCreateTerminal").resolves(info)
		const dispatch = sinon.spy(owner, "runCommand")
		const registry = new CommandRuntimeRegistry()
		const callbacks: CommandExecutorCallbacks = {
			say: async () => undefined,
			ask: async () => ({ response: "yesButtonClicked" }),
			getDietCodeMessages: () => [],
			updateDietCodeMessage: async () => {},
			updateBackgroundCommandState: () => {},
			addToUserMessageContent: () => {},
		}
		const config = {
			cwd: "/tmp",
			taskId: "reconnect",
			ulid: "reconnect",
			terminalExecutionMode: "vscodeTerminal" as const,
			terminalManager: owner,
		}
		const first = new CommandExecutor(config, callbacks, registry.get(config.taskId, config.ulid))
		let reopened: CommandExecutor | undefined
		try {
			const result = await first.execute(
				"printf 'ready\\n'; IFS= read -r input; printf 'late:%s\\n' \"$input\"; exit 7",
				0.01,
				{ actionId: "real-reconnect", suppressUserInteraction: true },
			)
			assert.equal(result[2]?.status, "background")
			first.detach()
			await owner.disposeAll()
			const newOwner = new VscodeTerminalManager()
			const newDispatch = sinon.spy(newOwner, "runCommand")
			reopened = new CommandExecutor(
				{ ...config, terminalManager: newOwner },
				callbacks,
				registry.get(config.taskId, config.ulid),
			)
			pty.handleInput!("continued\r")
			const receipt = await reopened.readCommandOutput("real-reconnect", 5)
			assert.equal(receipt.status, "failed")
			assert.equal(receipt.exit_code, 7)
			assert.match(receipt.output, /ready[\r\n]+late:continued/)
			sinon.assert.calledOnce(dispatch)
			sinon.assert.notCalled(newDispatch)
			assert.equal(info.busy, false)
		} finally {
			const current = reopened ?? first
			if (current.getExecutionInventory().active.length) {
				current.controlCommand("real-reconnect", "stop")
				await current.readCommandOutput("real-reconnect", 5)
			}
			current.detach()
			pty.close()
		}
	})
	it("keeps a dispatched command cancellable after its output stream breaks", async () => {
		const target = terminal(
			(async function* () {
				yield "working\n"
				throw new Error("read failed")
			})(),
		)
		const info = { id: 1, terminal: target, busy: false } as unknown as TerminalInfo
		const owner = manager()
		const process = owner.runCommand(info, "server")
		const lines: string[] = []
		process.on("line", (line) => lines.push(line))
		await process
		assert.equal(info.busy, true)
		assert.match(lines.join("\n"), /may still be running/)
		assert.equal(process.isHot, false)
		process.terminate!()
		sinon.assert.calledOnce(target.dispose)
	})
	it("does not dispatch after cancellation during shell integration startup", async () => {
		const clock = sinon.useFakeTimers()
		const target = terminal()
		const process = manager().runCommand({ id: 1, terminal: target } as unknown as TerminalInfo, "never run")
		process.terminate!()
		await process
		await clock.tickAsync(200)
		sinon.assert.notCalled(target.sendText)
		sinon.assert.notCalled(target.dispose)
		assert.equal(clock.countTimers(), 0)
	})
	it("settles cancellation before a reused supervised terminal is dispatched", async () => {
		const target = terminal()
		const managed = { terminal: target, run: sinon.stub() }
		const info = { id: 1, terminal: target, managed, busy: false } as unknown as TerminalInfo
		const process = manager().runCommand(info, "must not run")
		const completed = sinon.spy()
		process.once("completed", completed)
		await process.terminate!()
		await process
		sinon.assert.notCalled(managed.run)
		sinon.assert.calledOnce(completed)
		assert.equal(process.getCompletionDetails!().cancelled, true)
		assert.equal(info.busy, false)
	})
	it("preserves output and completion when individual event observers throw", async () => {
		const target = terminal(
			(async function* () {
				yield "first\nsecond\n"
			})(),
		)
		const process = new VscodeTerminalProcess(target)
		const completed = sinon.spy()
		const continued = sinon.spy()
		const lines: string[] = []
		process.on("line", () => {
			throw new Error("broken display")
		})
		process.on("line", (line) => lines.push(line))
		process.once("completed", () => {
			throw new Error("broken completion display")
		})
		process.once("completed", completed)
		process.once("continue", continued)
		await process.run(target, "test")
		assert.deepEqual(lines, ["first", "second"])
		assert.equal(process.getOutputSnapshot(), "first\nsecond\n")
		sinon.assert.calledOnce(completed)
		sinon.assert.calledOnce(continued)
		assert.equal(process.listenerCount("completed"), 0)
	})
	it("keeps real supervised output and exit ownership when the terminal display breaks", async () => {
		const managed = new ManagedTerminal("/tmp", "/bin/sh")
		managed.terminal.show()
		const display = sinon.stub((managed as any).writeEvent, "fire").throws(new Error("display disconnected"))
		const process = new VscodeTerminalProcess()
		const done = new Promise<void>((resolve) => process.once("completed", () => resolve()))
		process.on("line", async () => {
			throw new Error("async display failed")
		})
		await process.runManaged(managed, "printf captured; exit 7")
		await done
		assert.ok(process.getOutputSnapshot().endsWith("captured"))
		assert.equal(process.getCompletionDetails().exitCode, 7)
		sinon.assert.calledOnce(display)
		managed.terminal.dispose()
	})
	it("cleans up a supervised launch rejection without retaining a hot or busy process", async () => {
		const target = terminal()
		const managed = { terminal: target, run: sinon.stub().throws(new Error("closed during startup")) }
		const info = { id: 1, terminal: target, managed, busy: false } as unknown as TerminalInfo
		const process = manager().runCommand(info, "test")
		await assert.rejects(process, /closed during startup/)
		assert.equal(info.busy, false)
		assert.equal(process.isHot, false)
	})
	it("does not dispatch when a startup notification synchronously cancels the command", async () => {
		const managed = { terminal: terminal(), run: sinon.stub() }
		const process = new VscodeTerminalProcess()
		process.on("line", () => process.terminate())
		await process.runManaged(managed as unknown as ManagedTerminal, "must not run")
		sinon.assert.notCalled(managed.run)
		assert.equal(process.getCompletionDetails().cancelled, true)
	})
	it("uses the matching host execution exit code and drains final output", async () => {
		const clock = sinon.useFakeTimers()
		const target = terminal(
			(async function* () {
				yield "last output\n"
			})(),
			false,
		)
		const process = manager().runCommand({ id: 1, terminal: target, busy: false } as unknown as TerminalInfo, "test")
		const lines: string[] = []
		process.on("line", (line) => lines.push(line))
		await clock.tickAsync(0)
		hostEvents.emit("end", { terminal: target, execution: {}, exitCode: 0 })
		hostEvents.emit("end", {
			terminal: target,
			execution: (target.shellIntegration!.executeCommand as sinon.SinonStub).firstCall.returnValue,
			exitCode: 7,
		})
		await process
		assert.equal(process.getCompletionDetails!().exitCode, 7)
		assert.deepEqual(lines, ["last output"])
		assert.equal(hostEvents.listenerCount("end"), 0)
		assert.equal(hostEvents.listenerCount("close"), 0)
		assert.equal(clock.countTimers(), 0)
	})
	it("finishes within a bounded drain when the host exits but the stream and cleanup hang", async () => {
		const clock = sinon.useFakeTimers()
		const stream = {
			[Symbol.asyncIterator]: () => ({
				next: () => new Promise<IteratorResult<string>>(() => {}),
				return: () => new Promise<IteratorResult<string>>(() => {}),
			}),
		}
		const target = terminal(stream)
		const process = manager().runCommand({ id: 1, terminal: target } as unknown as TerminalInfo, "test")
		await clock.tickAsync(0)
		hostEvents.emit("end", {
			terminal: target,
			execution: (target.shellIntegration!.executeCommand as sinon.SinonStub).firstCall.returnValue,
			exitCode: 0,
		})
		await clock.tickAsync(1000)
		await process
		assert.equal(process.getCompletionDetails!().exitCode, 0)
		assert.equal(clock.countTimers(), 0)
	})
	it("releases a broken read when its terminal closes without inventing a command exit code", async () => {
		const target = terminal({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) })
		const process = manager().runCommand({ id: 1, terminal: target } as unknown as TerminalInfo, "test")
		await Promise.resolve()
		hostEvents.emit("close", target)
		await process
		assert.deepEqual(process.getCompletionDetails!(), { terminalClosed: true, cancelled: false })
	})
	it("preserves Unicode, repeated characters, command text, punctuation, and printed interrupt text", async () => {
		const text = "λλ工具\n\t  indent\n100%\n$HOME\n# comment\n<div>\n^C is text\necho hello\nhello\n"
		const target = terminal(
			(async function* () {
				yield text
			})(),
		)
		const process = new VscodeTerminalProcess(target)
		const lines: string[] = []
		process.on("line", (line) => lines.push(line))
		await process.run(target, "echo hello")
		assert.equal(lines.join("\n") + "\n", text)
		assert.equal(process.getCompletionDetails().signal, undefined)
	})
	it("bounds a no-newline stream without losing its content", async () => {
		const text = "x".repeat(100_000)
		const target = terminal(
			(async function* () {
				yield text
			})(),
		)
		const process = new VscodeTerminalProcess(target)
		const lines: string[] = []
		process.on("line", (line) => lines.push(line))
		await process.run(target, "test")
		assert.equal(lines.join(""), text)
		assert.ok(lines.every((line) => line.length <= 16_384))
	})
	it("refuses to dispatch into an occupied terminal", () => {
		const target = terminal()
		assert.throws(
			() => manager().runCommand({ id: 1, busy: true, terminal: target } as unknown as TerminalInfo, "test"),
			/did not start/,
		)
		sinon.assert.notCalled(target.sendText)
	})
	it("detaches once on EOF without reusing the terminal and accepts late host completion", async () => {
		const clock = sinon.useFakeTimers()
		const target = terminal(
			(async function* () {
				yield "partial output\n"
			})(),
			false,
		)
		const info = { id: 1, terminal: target, busy: false } as unknown as TerminalInfo
		const owner = manager()
		const process = owner.runCommand(info, "test")
		const completed = sinon.spy()
		const unavailable = sinon.spy()
		process.on("completed", completed)
		process.on("no_shell_integration", unavailable)
		await clock.tickAsync(0)
		await clock.tickAsync(1000)
		await process
		sinon.assert.notCalled(completed)
		sinon.assert.calledOnce(unavailable)
		assert.equal(info.busy, true)
		assert.throws(() => owner.runCommand(info, "another"), /busy or closed/)
		hostEvents.emit("end", {
			terminal: target,
			execution: (target.shellIntegration!.executeCommand as sinon.SinonStub).firstCall.returnValue,
			exitCode: 9,
		})
		sinon.assert.calledOnce(completed)
		assert.equal(process.getCompletionDetails!().exitCode, 9)
		assert.equal(info.busy, false)
		assert.equal(clock.countTimers(), 0)
	})
	it("keeps an ambiguous sub-shell end owned and stoppable", async () => {
		const clock = sinon.useFakeTimers()
		const target = terminal((async function* () {})(), false)
		const info = { id: 1, terminal: target, busy: false } as unknown as TerminalInfo
		const process = manager().runCommand(info, "nested shell")
		const completed = sinon.spy()
		process.on("completed", completed)
		await clock.tickAsync(0)
		hostEvents.emit("end", {
			terminal: target,
			execution: (target.shellIntegration!.executeCommand as sinon.SinonStub).firstCall.returnValue,
		})
		await process
		sinon.assert.notCalled(completed)
		assert.equal(info.busy, true)
		process.terminate!()
		sinon.assert.calledOnce(target.dispose)
		sinon.assert.calledOnce(completed)
		assert.equal(process.getCompletionDetails!().cancelled, true)
		assert.equal(clock.countTimers(), 0)
	})
	it("allows a deliberate stop retry after terminal disposal throws", async () => {
		const target = terminal(
			(async function* () {
				throw new Error("stream lost")
			})(),
		)
		const dispose = sinon.stub().onFirstCall().throws(new Error("host unavailable"))
		dispose.onSecondCall().callsFake(() => {
			hostEvents.emit("close", target)
		})
		target.dispose = dispose
		const process = new VscodeTerminalProcess(target)
		await process.run(target, "server")
		assert.throws(() => process.terminate(), /host unavailable/)
		process.terminate()
		sinon.assert.calledTwice(dispose)
		assert.equal(process.getCompletionDetails().cancelled, true)
	})
	it("does not stop sibling terminals or replay completed commands on late cancellation", async () => {
		const first = terminal(
			(async function* () {
				throw new Error("stream lost")
			})(),
		)
		const second = terminal(
			(async function* () {
				yield "done\n"
			})(),
		)
		const one = new VscodeTerminalProcess(first)
		const two = new VscodeTerminalProcess(second)
		await one.run(first, "server")
		await two.run(second, "done")
		one.terminate()
		two.terminate()
		sinon.assert.calledOnce(first.dispose)
		sinon.assert.notCalled(second.dispose)
	})
	it("creates directly in the requested directory without executing a hidden cd command", async () => {
		const target = terminal(
			(async function* () {
				yield "cd failed\n"
			})(),
		)
		Object.assign(target.shellIntegration!, { cwd: { fsPath: "/wrong" } })
		const info = { id: 1, terminal: target, busy: false, shellPath: undefined }
		const fresh = { id: 2, terminal: terminal(), busy: false }
		sinon.stub(TerminalRegistry, "getAllTerminals").returns([info] as never)
		sinon.stub(TerminalRegistry, "createTerminal").returns(fresh as never)
		const owner = manager()
		Object.assign(owner, { terminalReuseEnabled: true, defaultTerminalProfile: "default" })
		const run = sinon.stub(owner, "runCommand").throws(new Error("Terminal acquisition must not execute a command"))
		assert.equal(await owner.getOrCreateTerminal("/expected"), fresh)
		sinon.assert.notCalled(run)
	})
	it("does not reuse idle shells owned by another task", async () => {
		const target = terminal((async function* () {})())
		Object.assign(target.shellIntegration!, { cwd: { fsPath: "/expected" } })
		const foreign = { id: 99, terminal: target, busy: false, shellPath: undefined }
		const fresh = { id: 2, terminal: terminal(), busy: false }
		sinon.stub(TerminalRegistry, "getAllTerminals").returns([foreign] as never)
		sinon.stub(TerminalRegistry, "createTerminal").returns(fresh as never)
		const owner = manager()
		Object.assign(owner, { terminalReuseEnabled: true, defaultTerminalProfile: "default" })
		assert.equal(await owner.getOrCreateTerminal("/expected"), fresh)
	})
})
