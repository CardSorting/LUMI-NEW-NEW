import assert from "node:assert/strict"
import { EventEmitter } from "events"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { orchestrateCommandExecution } from "./CommandOrchestrator"
import type {
	CommandExecutorCallbacks,
	ITerminalManager,
	ITerminalProcess,
	OrchestrationResult,
	TerminalCompletionDetails,
	TerminalProcessEvents,
	TerminalProcessResultPromise,
} from "./types"

class FakeTerminalProcess extends EventEmitter<TerminalProcessEvents> implements ITerminalProcess {
	isHot = false
	waitForShellIntegration = false
	private readonly promise: Promise<void>
	private resolvePromise!: () => void
	private rejectPromise!: (error: Error) => void

	constructor() {
		super()
		this.promise = new Promise<void>((resolve, reject) => {
			this.resolvePromise = resolve
			this.rejectPromise = reject
		})
	}

	continue(): void {
		this.emit("continue")
		this.resolvePromise()
	}

	getUnretrievedOutput(): string {
		return ""
	}

	getCompletionDetails(): TerminalCompletionDetails {
		return {}
	}

	complete(details?: TerminalCompletionDetails): void {
		this.emit("completed", details)
		this.emit("continue")
		this.resolvePromise()
	}

	fail(error: Error): void {
		this.emit("error", error)
		this.rejectPromise(error)
	}

	asResultPromise(): TerminalProcessResultPromise {
		const processWithPromise = this as unknown as FakeTerminalProcess & Partial<TerminalProcessResultPromise>
		processWithPromise.then = this.promise.then.bind(this.promise)
		processWithPromise.catch = this.promise.catch.bind(this.promise)
		processWithPromise.finally = this.promise.finally.bind(this.promise)
		return processWithPromise as TerminalProcessResultPromise
	}
}

function createCallbacks(): CommandExecutorCallbacks {
	return {
		say: async () => undefined,
		ask: async () => ({ response: "messageResponse" }),
		updateBackgroundCommandState: () => {},
		updateDietCodeMessage: async () => {},
		getDietCodeMessages: () => [],
		addToUserMessageContent: () => {},
	}
}

function createTerminalManager(): ITerminalManager {
	return {
		processOutput: (outputLines: string[]) => outputLines.join("\n"),
	} as ITerminalManager
}

describe("CommandOrchestrator exit status messaging", () => {
	it("reports non-zero exit codes as command failures", async () => {
		const process = new FakeTerminalProcess()
		const orchestrationPromise = orchestrateCommandExecution(
			process.asResultPromise(),
			createTerminalManager(),
			createCallbacks(),
			{ command: "false" },
		)

		process.complete({ exitCode: 2, signal: null })
		const result: OrchestrationResult = await orchestrationPromise

		assert.equal(result.completed, true)
		assert.equal(result.exitCode, 2)
		assert.match(result.result as string, /^Command failed with exit code 2\./)
	})

	it("reports successful command completion with explicit exit code", async () => {
		const process = new FakeTerminalProcess()
		const orchestrationPromise = orchestrateCommandExecution(
			process.asResultPromise(),
			createTerminalManager(),
			createCallbacks(),
			{ command: "echo ok" },
		)

		process.complete({ exitCode: 0, signal: null })
		const result: OrchestrationResult = await orchestrationPromise

		assert.equal(result.completed, true)
		assert.equal(result.exitCode, 0)
		assert.match(result.result as string, /^Command executed successfully \(exit code 0\)\./)
	})
})

describe("CommandOrchestrator lifecycle", () => {
	afterEach(() => sinon.restore())
	it("bounds a silent manual wait and a stuck output prompt without cancelling or relaunching the command", async () => {
		const clock = sinon.useFakeTimers()
		for (const withOutput of [false, true]) {
			const process = new FakeTerminalProcess()
			const callbacks = { ...createCallbacks(), ask: sinon.stub().returns(new Promise(() => {})) }
			const pending = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), callbacks, {
				command: "server",
			})
			if (withOutput) process.emit("line", "waiting for input")
			await clock.tickAsync(30_000)
			assert.equal((await pending).completed, false)
			assert.equal(callbacks.ask.callCount, withOutput ? 1 : 0)
			process.complete({ exitCode: 0 })
		}
		assert.equal(clock.countTimers(), 0)
	})
	it("reports a late observation failure on the owning row without interrupting a newer conversation", async () => {
		const clock = sinon.useFakeTimers()
		const process = new FakeTerminalProcess()
		const update = sinon.stub().resolves()
		const say = sinon.stub().resolves()
		const messages = [{ ts: 1, say: "command", text: "server" }]
		const callbacks = { ...createCallbacks(), updateDietCodeMessage: update, say, getDietCodeMessages: () => messages }
		const pending = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), callbacks, {
			command: "server",
			timeoutSeconds: 1,
		})
		assert.equal(update.lastCall.args[1].commandExecution.status, "running")
		await clock.tickAsync(1000)
		await pending
		assert.equal(update.lastCall.args[1].commandExecution.status, "background")
		messages.push({ ts: 2, say: "command", text: "other work" })
		process.emit("no_shell_integration")
		assert.equal(update.lastCall.args[0], 0)
		assert.equal(update.lastCall.args[1].commandExecution.status, "unknown")
		sinon.assert.notCalled(say)
		process.complete({ exitCode: 9 })
		assert.deepEqual(update.lastCall.args[1].commandExecution, {
			status: "failed",
			exitCode: 9,
			signal: undefined,
			terminalClosed: undefined,
		})
		assert.equal(process.listenerCount("no_shell_integration"), 0)
	})
	it("does not turn terminal closure into success or discard a known exit code", async () => {
		for (const exitCode of [undefined, 7]) {
			const process = new FakeTerminalProcess()
			const pending = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), createCallbacks(), {
				command: "test",
			})
			process.complete({ terminalClosed: true, exitCode })
			const result = await pending
			assert.match(
				String(result.result),
				exitCode === undefined ? /Terminal closed.*not reported/ : /failed with exit code 7/,
			)
			assert.doesNotMatch(String(result.result), /successfully/)
		}
	})
	it("finishes without opening an output prompt when completion precedes the display flush", async () => {
		const process = new FakeTerminalProcess()
		let asks = 0
		const callbacks = {
			...createCallbacks(),
			ask: async () => {
				asks++
				return { response: "yesButtonClicked" }
			},
		}
		const pending = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), callbacks, {
			command: "test",
		})
		process.emit("line", "done")
		process.complete({ exitCode: 0 })
		assert.match(String((await pending).result), /done/)
		assert.equal(asks, 0)
	})

	it("serializes output prompts and ignores a stale reply after completion", async () => {
		const process = new FakeTerminalProcess()
		let asks = 0
		let reply!: (value: { response: string }) => void
		const callbacks = {
			...createCallbacks(),
			ask: () => {
				asks++
				return new Promise<{ response: string }>((resolve) => {
					reply = resolve
				})
			},
		}
		const pending = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), callbacks, {
			command: "test",
		})
		for (let i = 0; i < 80; i++) process.emit("line", `line ${i}`)
		assert.equal(asks, 1)
		process.complete({ exitCode: 0 })
		const result = await pending
		assert.equal(result.outputLines.length, 80)
		assert.equal(result.userRejected, false)
		let continued = 0
		process.on("continue", () => continued++)
		reply({ response: "noButtonClicked" })
		await Promise.resolve()
		assert.equal(continued, 0)
		assert.equal(process.listenerCount("line"), 0)
		assert.equal(process.listenerCount("completed"), 0)
	})

	it("preserves command results when the display rejects or never settles", async () => {
		for (const hangs of [false, true]) {
			const process = new FakeTerminalProcess()
			let calls = 0
			const callbacks = {
				...createCallbacks(),
				say: () => {
					calls++
					return hangs ? new Promise<undefined>(() => {}) : Promise.reject(new Error("webview unavailable"))
				},
			}
			const pending = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), callbacks, {
				command: "test",
				interactive: false,
			})
			for (let i = 0; i < 80; i++) process.emit("line", `line ${i}`)
			process.complete({ exitCode: 0 })
			assert.equal((await pending).outputLines.length, 80)
			assert.ok(calls <= 2, "slow display should not accumulate one promise per output chunk")
		}
	})

	it("continues an already authorized command once when its output prompt fails", async () => {
		const process = new FakeTerminalProcess()
		let asks = 0
		const callbacks = {
			...createCallbacks(),
			ask: async () => {
				asks++
				throw new Error("output view lost")
			},
		}
		const pending = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), callbacks, {
			command: "server",
		})
		for (let i = 0; i < 80; i++) process.emit("line", `line ${i}`)
		const result = await pending
		assert.equal(result.completed, false)
		assert.equal(asks, 1)
		assert.match(String(result.result), /Do not launch it again/)
		process.complete({ exitCode: 0 })
	})

	it("updates the initiating command row when a newer command row exists", async () => {
		const process = new FakeTerminalProcess()
		const messages = [{ ts: 1, say: "command", text: "first" }]
		let updated = -1
		const callbacks = {
			...createCallbacks(),
			getDietCodeMessages: () => messages,
			updateDietCodeMessage: async (index: number) => {
				updated = index
			},
		}
		const pending = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), callbacks, {
			command: "first",
		})
		messages.push({ ts: 2, say: "command", text: "second" })
		process.complete({ exitCode: 0 })
		await pending
		assert.equal(updated, 0)
	})

	it("rejects from a terminal error event without waiting for a broken process promise", async () => {
		const process = new FakeTerminalProcess()
		const pending = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), createCallbacks(), {
			command: "broken",
			timeoutSeconds: 300,
		})
		process.emit("error", new Error("launch failed"))
		await assert.rejects(pending, /launch failed/)
		assert.equal(process.listenerCount("line"), 0)
		assert.equal(process.listenerCount("completed"), 0)
		assert.equal(process.listenerCount("no_shell_integration"), 0)
	})
	it("cleans up timers on failures and detached waits while retaining actual completion ownership", async () => {
		const clock = sinon.useFakeTimers()
		const failed = new FakeTerminalProcess()
		const failure = orchestrateCommandExecution(failed.asResultPromise(), createTerminalManager(), createCallbacks(), {
			command: "broken",
			timeoutSeconds: 300,
		})
		const rejected = assert.rejects(failure, /failed/)
		failed.fail(new Error("failed"))
		await clock.tickAsync(0)
		await rejected
		assert.equal(clock.countTimers(), 0)

		const background = new FakeTerminalProcess()
		const pending = orchestrateCommandExecution(background.asResultPromise(), createTerminalManager(), createCallbacks(), {
			command: "server",
			timeoutSeconds: 1,
			interactive: false,
		})
		background.emit("line", "server ready")
		await clock.tickAsync(1100)
		assert.equal((await pending).completed, false)
		assert.equal(clock.countTimers(), 0)
		assert.equal(background.listenerCount("line"), 0)
		assert.equal(background.listenerCount("completed"), 1)
		background.complete({ exitCode: 0 })
		assert.equal(background.listenerCount("completed"), 0)
	})
})
