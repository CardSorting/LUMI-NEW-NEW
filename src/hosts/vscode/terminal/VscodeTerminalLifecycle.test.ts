import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import type * as vscode from "vscode"
import type { TerminalInfo } from "@/integrations/terminal/types"
import { VscodeTerminalManager } from "./VscodeTerminalManager"
import { VscodeTerminalProcess } from "./VscodeTerminalProcess"
import { TerminalRegistry } from "./VscodeTerminalRegistry"

function terminal(stream?: AsyncIterable<string>) {
	return {
		dispose: sinon.spy(),
		sendText: sinon.spy(),
		shellIntegration: stream ? { executeCommand: sinon.stub().returns({ read: () => stream }) } : undefined,
	} as unknown as vscode.Terminal & { dispose: sinon.SinonSpy; sendText: sinon.SinonSpy }
}
function manager() {
	return Object.assign(Object.create(VscodeTerminalManager.prototype), {
		processes: new Map(),
		terminalIds: new Set([1]),
		shellIntegrationTimeout: 100,
	}) as VscodeTerminalManager
}

describe("VS Code command lifecycle", () => {
	afterEach(() => sinon.restore())
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
	it("rejects a launch failure instead of stranding the foreground promise", async () => {
		const target = terminal((async function* () {})())
		;(target.shellIntegration!.executeCommand as sinon.SinonStub).throws(new Error("shell unavailable"))
		const info = { id: 1, terminal: target, busy: false } as unknown as TerminalInfo
		await assert.rejects(manager().runCommand(info, "test"), /shell unavailable/)
		assert.equal(info.busy, false)
	})
	it("releases unknown completion without declaring success or dropping cancellation ownership", async () => {
		const clock = sinon.useFakeTimers()
		const target = terminal()
		const info = { id: 1, terminal: target, busy: false } as unknown as TerminalInfo
		const owner = manager()
		const process = owner.runCommand(info, "server")
		const completed = sinon.spy()
		process.once("completed", completed)
		await clock.tickAsync(200)
		await process
		assert.equal(info.busy, true)
		sinon.assert.notCalled(completed)
		sinon.assert.calledOnceWithExactly(target.sendText, "server", true)
		assert.equal((owner as any).processes.get(1), process)
		process.terminate!()
		sinon.assert.calledOnce(target.dispose)
		sinon.assert.calledOnce(completed)
		assert.equal(process.getCompletionDetails!().signal, "SIGTERM")
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
		sinon.assert.calledOnce(target.dispose)
		assert.equal(clock.countTimers(), 0)
	})
	it("does not stop sibling terminals or replay completed commands on late cancellation", async () => {
		const first = terminal()
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
})
