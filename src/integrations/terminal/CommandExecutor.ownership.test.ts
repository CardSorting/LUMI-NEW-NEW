import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { CommandExecutor } from "./CommandExecutor"
import { CommandOutputCollector } from "./CommandOutputCollector"
import type { CommandExecutorCallbacks, ITerminalManager, TerminalCompletionDetails, TerminalProcessResultPromise } from "./types"

function fakeProcess() {
	const events = new EventEmitter()
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	const complete = (details: TerminalCompletionDetails = { exitCode: 0 }) => {
		events.emit("completed", details)
		resolve()
	}
	const process = Object.assign(events, {
		then: promise.then.bind(promise),
		catch: promise.catch.bind(promise),
		finally: promise.finally.bind(promise),
		continue: sinon.spy(resolve),
		terminate: sinon.spy(complete),
		complete,
		getOutputSnapshot: sinon.stub().returns("captured output"),
		getUnretrievedOutput: sinon.stub().returns("unread output"),
	})
	return process
}

describe("terminal command ownership", () => {
	afterEach(() => sinon.restore())
	function fixture() {
		const processes: ReturnType<typeof fakeProcess>[] = []
		const terminals: { id: number; busy: boolean; terminal: { show: sinon.SinonSpy } }[] = []
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
					terminal = { id: terminals.length + 1, busy: false, terminal: { show: sinon.spy() } }
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
	it("exposes foreground, background, and recent owned commands without consuming their output", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes } = fixture()
		const pending = executor.execute("build", 1, {
			suppressUserInteraction: true,
			actionId: "action-id",
			owner: "helper:one",
		})
		await clock.tickAsync(0)
		processes[0].getOutputSnapshot.returns("x".repeat(2000))
		const foreground = executor.getExecutionInventory()
		assert.equal(foreground.active.length, 1)
		assert.equal(foreground.active[0].owner, "helper:one")
		assert.equal(foreground.active[0].action_id, "action-id")
		assert.ok(foreground.active[0].output_preview.length <= 600)
		assert.equal(foreground.active[0].output_truncated, true)
		assert.equal(foreground.active[0].command_truncated, false)
		assert.deepEqual(executor.getExecutionSummary("action-id"), foreground.active[0])
		assert.equal("output" in foreground.active[0], false)
		await clock.tickAsync(1000)
		const id = (await pending)[2]!.executionId!
		assert.equal(executor.getExecutionInventory().active[0].execution_id, id)
		assert.equal(executor.getExecutionInventory().active[0].status, "background")
		processes[0].complete()
		assert.equal(executor.getExecutionInventory().active.length, 0)
		assert.equal(executor.getExecutionInventory().recent[0].execution_id, id)
		assert.equal(executor.getExecutionSummary("action-id")?.execution_id, id)
		assert.deepEqual(executor.getExecutionSummary(id), executor.getExecutionSummary("action-id"))
		sinon.assert.notCalled(processes[0].getUnretrievedOutput)
	})
	it("reads the same helper run after a timeout and retains its receipt after terminal reuse", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes, manager, callbacks } = fixture()
		const pending = executor.execute("build", 1, { suppressUserInteraction: true })
		await clock.tickAsync(1000)
		const result = await pending
		const id = result[2]!.executionId!
		assert.match(String(result[1]), new RegExp(id))
		assert.equal(result[2]!.status, "background")
		const read = executor.readCommandOutput(id, 30)
		await clock.tickAsync(2000)
		processes[0].getOutputSnapshot.returns("finished output")
		processes[0].complete({ exitCode: 7 })
		const snapshot = await read
		assert.equal(snapshot.status, "failed")
		assert.equal(snapshot.exit_code, 7)
		assert.equal(snapshot.output, "finished output")
		const next = executor.execute("other work", 1, { suppressUserInteraction: true })
		await clock.tickAsync(0)
		assert.deepEqual(await executor.readCommandOutput(id, 30), snapshot)
		sinon.assert.calledTwice(manager.runCommand as sinon.SinonStub)
		sinon.assert.notCalled(processes[0].getUnretrievedOutput)
		sinon.assert.notCalled(callbacks.updateDietCodeMessage as sinon.SinonStub)
		processes[1].complete()
		await next
		assert.equal(clock.countTimers(), 0)
	})
	it("bounds repeated observations and cancels only a reader, leaving the command owned", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes, manager } = fixture()
		const pending = executor.execute("quiet server", 1, { interactive: false })
		await clock.tickAsync(1000)
		const id = (await pending)[2]!.executionId!
		const controller = new AbortController()
		const cancelled = assert.rejects(executor.readCommandOutput(id, 30, controller.signal), /reader cancelled/)
		const read = executor.readCommandOutput(id, Number.MAX_VALUE)
		controller.abort(new Error("reader cancelled"))
		await cancelled
		await clock.tickAsync(30_000)
		assert.equal((await read).status, "background")
		for (let i = 0; i < 20; i++) {
			const next = executor.readCommandOutput(id, 0.001)
			await clock.tickAsync(1)
			assert.equal((await next).output, "captured output")
		}
		assert.equal(clock.countTimers(), 0)
		const waiting = Array.from({ length: 16 }, () => executor.readCommandOutput(id, 1))
		await assert.rejects(executor.readCommandOutput(id, 1), /Too many concurrent waits/)
		assert.equal((await executor.readCommandOutput(id, 0)).status, "background")
		await clock.tickAsync(1000)
		await Promise.all(waiting)
		assert.equal(clock.countTimers(), 0)
		sinon.assert.calledOnce(manager.runCommand as sinon.SinonStub)
		sinon.assert.notCalled(processes[0].terminate)
		assert.equal(executor.hasActiveBackgroundCommand(), true)
		processes[0].complete()
	})
	it("retains bounded receipts, rejects expired and cross-task IDs, and never falls back to a terminal ID", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes, manager } = fixture()
		const ids: string[] = []
		for (let i = 0; i < 65; i++) {
			const pending = executor.execute(`run ${i}`, 1, { suppressUserInteraction: true })
			await clock.tickAsync(0)
			processes[i].getOutputSnapshot.returns("x".repeat(100_000))
			processes[i].complete()
			ids.push((await pending)[2]!.executionId!)
		}
		for (const id of [ids[0], "1", "missing"]) await assert.rejects(executor.readCommandOutput(id, 0), /not tracked/)
		const latest = await executor.readCommandOutput(ids[64], 0)
		assert.equal(executor.getExecutionSummary(ids[0]), undefined)
		assert.equal(
			executor.getExecutionSummary(ids[1])?.execution_id,
			ids[1],
			"ID lookup must include retained receipts older than the eight recent summaries",
		)
		assert.ok(latest.output.length <= 64_000)
		assert.match(latest.output, /truncated/)
		await assert.rejects(fixture().executor.readCommandOutput(ids[64], 0), /not tracked/)
		assert.equal((manager.runCommand as sinon.SinonStub).callCount, 65)
		assert.equal(clock.countTimers(), 0)
	})
	it("preserves completion metadata when output capture fails and refreshes the original row", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes, callbacks } = fixture()
		callbacks.getDietCodeMessages = () => [{ ts: 1, say: "command", text: "test" }]
		const pending = executor.execute("test", 1, { interactive: false })
		await clock.tickAsync(0)
		processes[0].getOutputSnapshot.throws(new Error("host disconnected"))
		processes[0].complete({ terminalClosed: true })
		const id = (await pending)[2]!.executionId!
		const snapshot = await executor.readCommandOutput(id, 0)
		assert.equal(snapshot.exit_code, undefined)
		assert.equal(snapshot.terminal_closed, true)
		assert.match(snapshot.output, /unavailable/)
		const update = (callbacks.updateDietCodeMessage as sinon.SinonStub).lastCall
		assert.equal(update.args[0], 0)
		assert.equal(update.args[1].commandOutput, snapshot.output)
		assert.equal(update.args[1].commandExecution.executionId, id)
	})
	it("releases readers on process failure and retains the failed receipt", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes } = fixture()
		const pending = executor.execute("broken", 1, { interactive: false })
		await clock.tickAsync(1000)
		const id = (await pending)[2]!.executionId!
		const read = executor.readCommandOutput(id, 30)
		processes[0].emit("error", new Error("terminal failed"))
		const snapshot = await read
		assert.equal(snapshot.status, "failed")
		assert.equal(snapshot.detail, "terminal failed")
		assert.deepEqual(await executor.readCommandOutput(id, 0), snapshot)
		assert.equal(executor.hasActiveBackgroundCommand(), false)
		assert.equal(clock.countTimers(), 0)
	})
	it("keeps captured-log links and incomplete-capture warnings when refreshing command output", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes, callbacks } = fixture()
		callbacks.getDietCodeMessages = () => [{ ts: 1, say: "command", text: "build" }]
		const logFilePath = "/tmp/captured-command.log"
		const getSnapshot = sinon.stub(CommandOutputCollector.prototype, "getSnapshot")
		for (const logNotice of [
			`Full captured output saved to: ${logFilePath}`,
			"Log flush timed out; some output may be missing.",
		]) {
			getSnapshot.returns({ lines: ["captured"], logFilePath, logNotice })
			const pending = executor.execute("build", 1, { interactive: false })
			await clock.tickAsync(0)
			processes.at(-1)!.complete()
			const id = (await pending)[2]!.executionId!
			const snapshot = await executor.readCommandOutput(id, 0)
			assert.equal(snapshot.log_file_path, logFilePath)
			assert.equal(snapshot.log_notice, logNotice)
			assert.equal(
				(callbacks.updateDietCodeMessage as sinon.SinonStub).lastCall.args[1].commandOutput,
				`captured output\n${logNotice}`,
			)
		}
	})
	it("rejects an already cancelled reader without cancelling or waiting for a command", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes } = fixture()
		const pending = executor.execute("server", 1, { interactive: false })
		await clock.tickAsync(1000)
		const id = (await pending)[2]!.executionId!
		const controller = new AbortController()
		controller.abort()
		await assert.rejects(executor.readCommandOutput(id, 30, controller.signal), { name: "AbortError" })
		assert.equal(clock.countTimers(), 0)
		sinon.assert.notCalled(processes[0].terminate)
		processes[0].complete()
	})
	it("targets one run and rejects stale controls after its terminal is reused", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes, terminals, callbacks } = fixture()
		const rows = [
			{ ts: 1, say: "command", text: "first" },
			{ ts: 2, say: "command", text: "second" },
		]
		callbacks.getDietCodeMessages = () => rows
		const one = executor.execute("first", 1, { commandMessageTs: 1 })
		const two = executor.execute("second", 1, { commandMessageTs: 2 })
		await clock.tickAsync(1000)
		await Promise.all([one, two])
		const updates = callbacks.updateDietCodeMessage as sinon.SinonStub
		const firstId = updates.getCalls().find((call) => call.args[0] === 0)!.args[1].commandExecution.executionId
		const secondId = updates.getCalls().find((call) => call.args[0] === 1)!.args[1].commandExecution.executionId
		assert.notEqual(firstId, secondId)
		terminals.forEach((terminal) => terminal.terminal.show.resetHistory())
		executor.controlCommand(firstId, "show")
		sinon.assert.calledOnce(terminals[0].terminal.show)
		sinon.assert.notCalled(terminals[1].terminal.show)
		executor.controlCommand(firstId, "stop")
		await clock.tickAsync(0)
		sinon.assert.calledOnce(processes[0].terminate)
		sinon.assert.notCalled(processes[1].terminate)
		const next = executor.execute("new occupant", 1, { commandMessageTs: null })
		await clock.tickAsync(0)
		assert.equal(terminals.length, 2)
		assert.throws(() => executor.controlCommand(firstId, "stop"), /no longer tracked/)
		assert.throws(() => executor.controlCommand(firstId, "show"), /no longer tracked/)
		sinon.assert.notCalled(processes[2].terminate)
		processes[1].complete()
		processes[2].complete()
		await next
	})
	it("surfaces stop failure and retries it only on an explicit command control", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes, callbacks } = fixture()
		callbacks.getDietCodeMessages = () => [{ ts: 1, say: "command", text: "stubborn" }]
		const pending = executor.execute("stubborn", 1)
		await clock.tickAsync(0)
		const terminate = sinon.stub<[], void>().onFirstCall().rejects(new Error("host unavailable"))
		terminate.onSecondCall().callsFake(processes[0].complete)
		processes[0].terminate = terminate
		assert.equal(await executor.cancelBackgroundCommand(), true)
		await clock.tickAsync(0)
		await pending
		const updates = callbacks.updateDietCodeMessage as sinon.SinonStub
		const execution = updates.lastCall.args[1].commandExecution
		assert.equal(execution.status, "stop_failed")
		assert.match(executor.getBackgroundCommandSummary()!, /stop failed/)
		assert.equal(await executor.cancelBackgroundCommand(), true)
		await clock.tickAsync(5000)
		sinon.assert.calledOnce(terminate)
		executor.controlCommand(execution.executionId, "stop")
		await clock.tickAsync(0)
		sinon.assert.calledTwice(terminate)
		assert.equal(executor.hasActiveBackgroundCommand(), false)
		assert.equal(updates.lastCall.args[1].commandExecution.status, "completed")
	})
	it("does not wait for cancellation presentation or repeat an unconfirmed stop", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes, callbacks } = fixture()
		callbacks.getDietCodeMessages = () => [
			{ ts: 1, say: "command" },
			{ ts: 2, ask: "command_output", text: "busy" },
		]
		;(callbacks.updateDietCodeMessage as sinon.SinonStub).returns(new Promise(() => {}))
		const pending = executor.execute("stubborn", 1)
		await clock.tickAsync(0)
		processes[0].terminate = sinon.spy(() => new Promise<void>(() => {})) as never
		assert.equal(await executor.cancelBackgroundCommand(), true)
		await clock.tickAsync(0)
		await pending
		assert.equal(await executor.cancelBackgroundCommand(), true)
		sinon.assert.calledOnce(processes[0].terminate)
		assert.equal((callbacks.updateBackgroundCommandState as sinon.SinonSpy).lastCall.args[0], true)
		processes[0].complete()
	})
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
	it("does not duplicate an active command but allows it again after actual completion", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes, manager } = fixture()
		const first = executor.execute("server", 1, { interactive: false })
		await clock.tickAsync(1000)
		await first
		assert.match(String((await executor.execute("server", 1))[1]), /no duplicate was started/)
		sinon.assert.calledOnce(manager.runCommand as sinon.SinonStub)
		processes[0].complete()
		const second = executor.execute("server", 1)
		await clock.tickAsync(0)
		processes[1].complete()
		await second
		sinon.assert.calledTwice(manager.runCommand as sinon.SinonStub)
	})
	it("treats working directories literally and scopes duplicates to their directory", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, manager, processes } = fixture()
		const cwd = '/workspace/odd "name" $(literal) `text`'
		const first = executor.execute("cd /workspace && pwd", 1, { cwd })
		await clock.tickAsync(0)
		sinon.assert.calledWithExactly(manager.getOrCreateTerminal as sinon.SinonStub, cwd)
		assert.equal((manager.runCommand as sinon.SinonStub).firstCall.args[1], "cd /workspace && pwd")
		const second = executor.execute("cd /workspace && pwd", 1, { cwd: "/another" })
		await clock.tickAsync(0)
		processes.forEach((process) => process.complete())
		await Promise.all([first, second])
		sinon.assert.calledTwice(manager.runCommand as sinon.SinonStub)
	})
	it("bounds failed terminal acquisition and lets the next independent command launch", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, manager, processes } = fixture()
		const create = manager.getOrCreateTerminal as sinon.SinonStub
		let late!: (value: unknown) => void
		create.onFirstCall().returns(
			new Promise((resolve) => {
				late = resolve
			}),
		)
		const failed = assert.rejects(executor.execute("never started", undefined), /terminal creation timed out/)
		await clock.tickAsync(15_000)
		await failed
		const next = executor.execute("next", 1)
		await clock.tickAsync(0)
		processes[0].complete()
		await next
		late({ id: 99, terminal: { show: sinon.spy() } })
		await clock.tickAsync(0)
		sinon.assert.calledOnce(manager.runCommand as sinon.SinonStub)
	})
	it("releases cancelled waits even when terminate never settles, retaining ownership", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes } = fixture()
		const controller = new AbortController()
		const pending = executor.execute("stubborn", undefined, { signal: controller.signal })
		await clock.tickAsync(0)
		processes[0].terminate = sinon.spy(() => new Promise<void>(() => {})) as never
		controller.abort()
		await clock.tickAsync(0)
		const result = await pending
		assert.equal(result[0], true)
		assert.match(String(result[1]), /termination has not been confirmed/)
		assert.equal(executor.hasActiveBackgroundCommand(), true)
		assert.match(String((await executor.execute("stubborn", 1))[1]), /no duplicate/)
		processes[0].complete()
		assert.equal(executor.hasActiveBackgroundCommand(), false)
	})
	it("reports quiet background completions once even if the terminal has no further output", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes } = fixture()
		const pending = executor.execute("quiet", 1, { interactive: false })
		await clock.tickAsync(1000)
		await pending
		processes[0].complete()
		assert.match(executor.takeBackgroundCompletions()!, /quiet.*exit code 0/)
		assert.equal(executor.takeBackgroundCompletions(), undefined)
	})
	it("does not update an older command row when this command's display was unavailable", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes, callbacks } = fixture()
		callbacks.getDietCodeMessages = () => [{ ts: 1, say: "command", text: "previous" }]
		const pending = executor.execute("current", 1, { commandMessageTs: null, interactive: false })
		await clock.tickAsync(0)
		processes[0].complete()
		await pending
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
	it("bounds active command fanout and permits more work once a command actually exits", async () => {
		const clock = sinon.useFakeTimers()
		const { executor, processes, manager } = fixture()
		const pending = Array.from({ length: 12 }, (_, index) => executor.execute(`server ${index}`, 1, { interactive: false }))
		await clock.tickAsync(1000)
		await Promise.all(pending)
		await assert.rejects(executor.execute("overflow", 1), /12 commands are already active/)
		assert.equal((manager.runCommand as sinon.SinonStub).callCount, 12)
		processes.forEach((process) => process.complete())
		const next = executor.execute("next", 1)
		await clock.tickAsync(0)
		processes.at(-1)!.complete()
		await next
		assert.equal((manager.runCommand as sinon.SinonStub).callCount, 13)
	})
})
