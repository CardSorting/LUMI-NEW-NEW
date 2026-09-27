import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { CommandExecutor } from "./CommandExecutor"
import type { CommandExecutorCallbacks, ITerminalManager, TerminalProcessResultPromise } from "./types"

function fakeProcess() {
	const events = new EventEmitter()
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	const complete = () => {
		events.emit("completed", { exitCode: 0 })
		resolve()
	}
	const process = Object.assign(events, {
		then: promise.then.bind(promise),
		catch: promise.catch.bind(promise),
		finally: promise.finally.bind(promise),
		continue: sinon.spy(resolve),
		terminate: sinon.spy(complete),
		complete,
	})
	return process
}

describe("terminal command ownership", () => {
	afterEach(() => sinon.restore())
	function fixture() {
		const processes: ReturnType<typeof fakeProcess>[] = []
		const terminals: { busy: boolean; terminal: { show: sinon.SinonSpy } }[] = []
		const callbacks = {
			say: sinon.stub().resolves(),
			ask: sinon.stub().returns(new Promise(() => {})),
			updateBackgroundCommandState: sinon.spy(),
			updateDietCodeMessage: sinon.stub().resolves(),
			getDietCodeMessages: () => [],
			addToUserMessageContent: sinon.spy(),
		} as unknown as CommandExecutorCallbacks
		const manager = {
			getOrCreateTerminal: sinon.stub().callsFake(async () => {
				let terminal = terminals.find((entry) => !entry.busy)
				if (!terminal) {
					terminal = { busy: false, terminal: { show: sinon.spy() } }
					terminals.push(terminal)
				}
				return terminal
			}),
			runCommand: sinon.stub().callsFake((terminal) => {
				assert.equal(terminal.busy, false, "a running terminal must not be reused")
				terminal.busy = true
				const process = fakeProcess()
				process.once("completed", () => {
					terminal.busy = false
				})
				processes.push(process)
				return process as unknown as TerminalProcessResultPromise
			}),
			processOutput: (lines: string[]) => lines.join("\n"),
		} as unknown as ITerminalManager
		const executor = new CommandExecutor(
			{
				cwd: "/workspace",
				taskId: "task",
				ulid: "task",
				terminalExecutionMode: "vscodeTerminal",
				terminalManager: manager,
			},
			callbacks,
		)
		return { executor, processes, terminals, callbacks, manager }
	}
	it("launches concurrent commands in distinct terminals and cancels only the owning helper", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes, terminals, callbacks } = fixture()
		callbacks.getDietCodeMessages = () => [{ ts: 1, type: "say", say: "command", text: "parent command" }]
		const first = new AbortController()
		const second = new AbortController()
		const one = executor.execute("first", undefined, { signal: first.signal, suppressUserInteraction: true })
		const two = executor.execute("second", undefined, { signal: second.signal, suppressUserInteraction: true })
		await clock.tickAsync(0)
		assert.equal(terminals.length, 2)
		first.abort()
		await clock.tickAsync(60)
		assert.equal((await one)[0], true)
		sinon.assert.calledOnce(processes[0].terminate)
		sinon.assert.notCalled(processes[1].terminate)
		assert.equal((callbacks.updateBackgroundCommandState as sinon.SinonSpy).lastCall.args[0], true)
		processes[1].complete()
		await clock.tickAsync(60)
		assert.equal((await two)[0], false)
		assert.equal((callbacks.updateBackgroundCommandState as sinon.SinonSpy).lastCall.args[0], false)
		assert.ok(terminals.every((entry) => entry.terminal.show.notCalled))
		sinon.assert.notCalled(callbacks.updateDietCodeMessage as sinon.SinonStub)
	})
	it("streams autonomous output without waiting for command-output approval", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes, callbacks } = fixture()
		const pending = executor.execute("build", 300, { interactive: false })
		await clock.tickAsync(0)
		processes[0].emit("line", "building")
		await clock.tickAsync(1000)
		processes[0].complete()
		await clock.tickAsync(60)
		assert.match(String((await pending)[1]), /building/)
		sinon.assert.notCalled(callbacks.ask as sinon.SinonStub)
		sinon.assert.calledWith(callbacks.say as sinon.SinonStub, "command_output", "building")
		assert.equal(clock.countTimers(), 0)
	})
	it("keeps ownership after a timed wait returns and stops that exact background process", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes } = fixture()
		const controller = new AbortController()
		const pending = executor.execute("server", 1, { signal: controller.signal, interactive: false })
		await clock.tickAsync(1100)
		assert.match(String((await pending)[1]), /still running.*Do not launch it again/s)
		assert.equal(executor.hasActiveBackgroundCommand(), true)
		assert.match(executor.getBackgroundCommandSummary()!, /server/)
		controller.abort()
		await clock.tickAsync(0)
		sinon.assert.calledOnce(processes[0].terminate)
		assert.equal(executor.hasActiveBackgroundCommand(), false)
		assert.equal(executor.getBackgroundCommandSummary(), undefined)
	})
	it("rejects a cancelled command before launching it", async () => {
		const { executor, manager } = fixture()
		const controller = new AbortController()
		controller.abort()
		await assert.rejects(executor.execute("cancelled", undefined, { signal: controller.signal }), { name: "AbortError" })
		sinon.assert.notCalled(manager.runCommand as sinon.SinonStub)
	})
})
