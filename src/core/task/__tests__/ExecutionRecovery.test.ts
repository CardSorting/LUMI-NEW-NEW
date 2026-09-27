import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { EventEmitter, once } from "node:events"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { FileEditProvider } from "@/integrations/editor/FileEditProvider"
import { canonicalFilePath, withFileMutation } from "@/integrations/editor/FileMutationCoordinator"
import { CommandExecutor } from "@/integrations/terminal/CommandExecutor"
import { CommandRuntimeRegistry } from "@/integrations/terminal/CommandRuntime"
import type { CommandExecutorCallbacks, ITerminalManager, TerminalProcessResultPromise } from "@/integrations/terminal/types"
import type { DietCodeMessage } from "@/shared/ExtensionMessage"
import { parseSubagentStatusPayload } from "@/shared/subagents"
import { DietCodeDefaultTool } from "@/shared/tools"
import { ActionExecutionRegistry } from "../ActionExecutionRegistry"
import { ActionExecutor } from "../ActionExecutor"
import { ExecutionRecoveryStore, executionFingerprint } from "../ExecutionRecovery"
import { reconcileCommandExecutions } from "../reconcileCommandExecutions"
import { reconcileHelperExecutions } from "../reconcileHelperExecutions"
import { TaskState } from "../TaskState"
import { ToolExecutor } from "../ToolExecutor"
import { UseSubagentsToolHandler } from "../tools/handlers/SubagentToolHandler"
import type { TaskConfig } from "../tools/types/TaskConfig"

describe("execution recovery across extension-host restarts", () => {
	let directory: string
	const identity = { taskId: "task", ulid: "stable-task-identity", cwd: "/workspace" }
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "lumi-restart-"))
	})
	afterEach(() => {
		sinon.restore()
		rmSync(directory, { recursive: true, force: true })
	})
	const store = () => new ExecutionRecoveryStore(directory, identity)
	const helperIdentity = (owner: string) => ({ kind: "helper" as const, input: { prompt: owner }, label: owner, owner })

	for (const phase of ["active", "completed"])
		it(`recovers ${phase} evidence after the actual producing host process is killed`, async function () {
			this.timeout(15000)
			const bootstrap = `
			const { ExecutionRecoveryStore } = require('./src/core/task/ExecutionRecovery.ts');
			const { SupervisedShell } = require('./src/integrations/terminal/SupervisedShell.ts');
			const store = new ExecutionRecoveryStore(process.argv[1], { taskId: 'task', ulid: 'stable-task-identity', cwd: '/workspace' });
			const shell = new SupervisedShell();
			let output = '';
			const save = (status, exit_code) => store.put('real-run', { kind: 'command', transport: { kind: 'supervised', shell: '/bin/sh' }, snapshot: { execution_id: 'real-run', command: 'real shell', cwd: '/workspace', status, exit_code, output } });
			shell.start({ cwd: process.cwd(), shell: '/bin/sh', command: process.argv[2] === 'active' ? "printf 'persisted output\\n'; sleep 1" : "printf 'persisted output\\n'",
				onData: data => { output += data; save('background'); if (process.argv[2] === 'active') process.send('saved'); },
				onComplete: details => { save('completed', details.exitCode); if (process.argv[2] === 'completed') process.send('saved'); },
				onError: error => { throw error; }
			});
		`
			const child = spawn(
				process.execPath,
				["-r", "ts-node/register", "-r", "tsconfig-paths/register", "-e", bootstrap, directory, phase],
				{
					env: { ...process.env, TS_NODE_PROJECT: "./tsconfig.unit-test.json" },
					stdio: ["ignore", "ignore", "pipe", "ipc"],
				},
			)
			let errors = ""
			child.stderr?.on("data", (data) => {
				errors = (errors + data).slice(-4000)
			})
			try {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error(`Host did not persist its receipt: ${errors}`)), 10000)
					child.once("message", () => {
						clearTimeout(timer)
						resolve()
					})
					child.once("exit", (code) => {
						clearTimeout(timer)
						reject(new Error(`Host exited before the crash test (${code}): ${errors}`))
					})
					child.once("error", (error) => {
						clearTimeout(timer)
						reject(error)
					})
				})
				const ended = once(child, "exit")
				child.kill("SIGKILL")
				await ended
				const reopened = commandHost()
				const saved = await reopened.executor.readCommandOutput("real-run")
				assert.equal(saved.status, phase === "active" ? "unknown" : "completed")
				assert.equal(saved.output, "persisted output\n")
				assert.equal(saved.recovery?.authority, "none")
				sinon.assert.notCalled(reopened.manager.getOrCreateTerminal as sinon.SinonStub)
			} finally {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
			}
		})

	function commandHost() {
		const runtime = new CommandRuntimeRegistry().get(identity.taskId, identity.ulid)
		runtime.enableRecovery(directory, identity.cwd)
		const events = new EventEmitter()
		let resolve!: () => void
		const pending = new Promise<void>((done) => {
			resolve = done
		})
		const process = Object.assign(events, {
			then: pending.then.bind(pending),
			catch: pending.catch.bind(pending),
			finally: pending.finally.bind(pending),
			continue: resolve,
			terminate: sinon.stub(),
			getOutputSnapshot: () => "partial output α\n",
			getUnretrievedOutput: () => "",
		}) as unknown as TerminalProcessResultPromise
		const manager = {
			getOrCreateTerminal: sinon
				.stub()
				.resolves({ id: 17, shellPath: "/bin/zsh", terminal: { name: "native shell", show() {} } }),
			runCommand: sinon.stub().returns(process),
			processOutput: (lines: string[]) => lines.join("\n"),
		} as unknown as ITerminalManager
		const callbacks = {
			say: sinon.stub().resolves(),
			ask: sinon.stub().returns(new Promise(() => {})),
			updateBackgroundCommandState: sinon.stub(),
			updateDietCodeMessage: sinon.stub().returns(new Promise(() => {})),
			getDietCodeMessages: () => [{ ts: 4, say: "command", text: "build" }],
			addToUserMessageContent: sinon.stub(),
		} as unknown as CommandExecutorCallbacks
		const executor = new CommandExecutor(
			{ ...identity, terminalExecutionMode: "vscodeTerminal", terminalManager: manager },
			callbacks,
			runtime,
		)
		const complete = (exitCode: number) => {
			events.emit("completed", { exitCode })
			resolve()
		}
		return { runtime, process, manager, executor, complete }
	}

	it("active task → restart → reopen restores correlation and partial output, without a launch or controls", async () => {
		const clock = sinon.useFakeTimers()
		const original = commandHost()
		const pending = original.executor.execute("build", 1, { actionId: "run-1", owner: "helper:one", commandMessageTs: 4 })
		await clock.tickAsync(1000)
		await pending
		const metadata = original.runtime.recovery!.get("command", "run-1")!
		assert.equal(metadata.transport.shell, "/bin/zsh")
		assert.equal(metadata.snapshot.cwd, identity.cwd)
		const reopened = commandHost()
		const result = await reopened.executor.readCommandOutput("run-1", 30)
		assert.equal(result.status, "unknown")
		assert.equal(result.recovery?.authority, "none")
		assert.equal(result.terminal_id, undefined)
		assert.equal(result.output, "partial output α\n")
		assert.equal(reopened.runtime.activeProcesses.size, 0)
		assert.throws(() => reopened.executor.controlCommand("run-1", "stop"), /no longer|not.*active|not.*tracked/i)
		await reopened.executor.execute("build", 1, { actionId: "run-1" })
		await reopened.executor.execute("build", 1, { actionId: "other-delivery" })
		sinon.assert.notCalled(reopened.manager.getOrCreateTerminal as sinon.SinonStub)
		sinon.assert.notCalled(reopened.manager.runCommand as sinon.SinonStub)
		const row: DietCodeMessage = {
			ts: 4,
			type: "say",
			say: "command",
			text: "build",
			commandExecution: { status: "background", executionId: "run-1", taskId: identity.taskId, terminalId: 17 },
		}
		const messages = reconcileCommandExecutions([row], (id) => reopened.executor.getExecutionSnapshot(id))
		assert.equal(messages.length, 1)
		assert.equal(messages[0].commandExecution?.executionId, "run-1")
		assert.equal(messages[0].commandExecution?.recovery?.authority, "none")
		// A late callback from a replaced owner cannot rewrite the durable evidence.
		const before = readFileSync(join(directory, `command-${executionFingerprint("run-1")}.json`), "utf8")
		original.complete(0)
		assert.equal(readFileSync(join(directory, `command-${executionFingerprint("run-1")}.json`), "utf8"), before)
	})

	for (const exitCode of [0, 7])
		it(`completed task → restart → reopen preserves the observed exit ${exitCode}`, async () => {
			const clock = sinon.useFakeTimers()
			const original = commandHost()
			const pending = original.executor.execute("build", 1, { actionId: "finished" })
			await clock.tickAsync(0)
			original.complete(exitCode)
			await pending
			const reopened = commandHost()
			const result = await reopened.executor.readCommandOutput("finished", 30)
			assert.equal(result.status, exitCode === 0 ? "completed" : "failed")
			assert.equal(result.exit_code, exitCode)
			assert.equal(result.output, "partial output α\n")
			await reopened.executor.execute("build", 1, { actionId: "finished" })
			sinon.assert.notCalled(reopened.manager.runCommand as sinon.SinonStub)
		})

	it("cancelled helper → restart retains its handoff and cannot regain authority", () => {
		const first = new ActionExecutionRegistry()
		first.attachRecovery(identity.ulid, store())
		const entry = first.claim(identity.ulid, helperIdentity("helper:cancelled"))
		first.finish(entry, "cancelled", {
			filesModified: ["saved.ts"],
			pendingCommandIds: ["shell-1"],
			result: "partial implementation",
		})
		const recovery = store()
		const second = new ActionExecutionRegistry()
		second.attachRecovery(identity.ulid, recovery)
		const restored = second.get(identity.ulid, entry.snapshot.execution_id)!
		assert.equal(restored.status, "cancelled")
		assert.deepEqual(restored.helper_handoff?.files_modified, ["saved.ts"])
		assert.deepEqual(restored.helper_handoff?.pending_command_ids, ["shell-1"])
		assert.throws(() => second.claim(identity.ulid, helperIdentity("helper:cancelled")), /no recovered authority/)
		assert.deepEqual(second.list(identity.ulid).active, [])
	})

	it("cancels a durably queued file action before restart and restores no executable queue", async () => {
		const first = new ActionExecutor()
		first.executions.attachRecovery(identity.ulid, store())
		let release!: () => void
		const occupied = new Promise<void>((resolve) => {
			release = resolve
		})
		const blockers = Array.from({ length: 5 }, () => first.execute(identity.ulid, () => occupied, { concurrencyGroup: "fs" }))
		const controller = new AbortController()
		const write = sinon.stub().resolves("saved")
		const pending = first.execute(identity.ulid, write, {
			signal: controller.signal,
			concurrencyGroup: "fs",
			execution: { kind: "file_write", input: { path: "a.ts", content: "A" }, label: "a.ts", owner: "helper:queued" },
		})
		const rejected = assert.rejects(pending, /abort/i)
		const queued = first.executions.list(identity.ulid).active.find((entry) => entry.kind === "file_write")!
		assert.equal(queued.status, "queued")
		controller.abort()
		await rejected
		const recovered = new ActionExecutor()
		recovered.executions.attachRecovery(identity.ulid, store())
		assert.equal(recovered.executions.get(identity.ulid, queued.execution_id)?.status, "not_started")
		assert.deepEqual(recovered.getQueues(identity.ulid), [])
		release()
		await Promise.all(blockers)
		sinon.assert.notCalled(write)
	})

	it("imports legacy history once, preserving IDs without inventing shell metadata", async () => {
		const host = commandHost()
		const rows: DietCodeMessage[] = [
			{
				ts: 5,
				type: "say",
				say: "command",
				text: "old server",
				commandOutput: "last output",
				commandExecution: { status: "background", executionId: "legacy", taskId: identity.taskId, terminalId: 2 },
			},
		]
		host.executor.restoreCommandHistory(rows)
		host.executor.restoreCommandHistory(rows)
		assert.equal(host.runtime.receipts.size, 1)
		const restarted = commandHost()
		const saved = await restarted.executor.readCommandOutput("legacy")
		assert.equal(saved.status, "unknown")
		assert.equal(saved.cwd, "")
		assert.equal(saved.recovery?.observedAt, 5)
		await restarted.executor.execute("old server", 1, { actionId: "new-id" })
		sinon.assert.notCalled(restarted.manager.getOrCreateTerminal as sinon.SinonStub)
	})

	it("retains partial helper evidence when its final failure has no structured handoff", () => {
		const registry = new ActionExecutionRegistry()
		registry.attachRecovery(identity.ulid, store())
		const entry = registry.claim(identity.ulid, helperIdentity("helper:partial"))
		registry.recordHelperEvidence(identity.ulid, entry.snapshot.execution_id, {
			filesModified: ["already-saved.ts"],
			result: "partial result",
		})
		registry.finish(entry, "failed", { error: "connection lost" })
		const restored = new ActionExecutionRegistry()
		restored.attachRecovery(identity.ulid, store())
		assert.deepEqual(restored.get(identity.ulid, entry.snapshot.execution_id)?.helper_handoff?.files_modified, [
			"already-saved.ts",
		])
	})

	for (const cancel of [true, false])
		it(`queued file write → ${cancel ? "cancellation → " : "owner replacement → "}restart never writes`, async () => {
			const first = store()
			const controller = new AbortController()
			const file = join(directory, "queued.txt")
			const provider = new FileEditProvider(directory, controller.signal, () => first.assertCanExecute())
			provider.editType = "create"
			await provider.open("queued.txt")
			await provider.update("must not commit", true)
			let release!: () => void
			let acquired!: () => void
			const started = new Promise<void>((done) => {
				acquired = done
			})
			const lock = withFileMutation(await canonicalFilePath(file), async () => {
				acquired()
				await new Promise<void>((done) => {
					release = done
				})
			})
			await started
			const write = provider.saveChanges()
			const rejected = assert.rejects(write, cancel ? /abort/i : /authority was replaced/)
			if (cancel) controller.abort()
			const recovery = store()
			recovery.assertCanExecute()
			release()
			await Promise.all([lock, rejected])
			assert.throws(() => readFileSync(file), { code: "ENOENT" })
			assert.equal(
				readdirSync(directory).some((name) => name.endsWith(".tmp")),
				false,
			)
		})

	it("multiple concurrent helpers → restart imports evidence and identities without queues or reservations", () => {
		const first = new ActionExecutionRegistry()
		first.attachRecovery(identity.ulid, store())
		const entries = ["helper:a", "helper:b", "helper:c"].map((owner) => first.claim(identity.ulid, helperIdentity(owner)))
		first.update(entries[0], "running")
		first.recordHelperEvidence(identity.ulid, entries[0].snapshot.execution_id, {
			filesModified: ["a.ts"],
			filesViewed: ["input.ts"],
			result: "saved A",
			pendingCommandIds: ["command-a"],
		})
		first.recordHelperEvidence(identity.ulid, entries[0].snapshot.execution_id, { stats: { toolCalls: 2 } })
		first.update(entries[1], "running")
		first.finish(entries[1], "completed", { result: "done B", filesModified: ["b.ts"] })
		const recovered = new ActionExecutor()
		recovered.executions.attachRecovery(identity.ulid, store())
		assert.deepEqual(
			entries.map((entry) => recovered.executions.get(identity.ulid, entry.snapshot.execution_id)?.status),
			["unconfirmed", "completed", "not_started"],
		)
		assert.deepEqual(
			recovered.executions.get(identity.ulid, entries[0].snapshot.execution_id)?.helper_handoff?.files_modified,
			["a.ts"],
		)
		assert.deepEqual(recovered.getQueues(identity.ulid), [])
		assert.throws(
			() => recovered.executions.claim(identity.ulid, { ...helperIdentity("helper:a"), owner: "helper:new" }),
			/No duplicate/,
		)
		// Reimporting into the same runtime does not replace receipts or revive callbacks.
		const recovery = store()
		recovered.executions.attachRecovery(identity.ulid, recovery)
		recovered.executions.attachRecovery(identity.ulid, recovery)
		assert.equal(recovered.executions.list(identity.ulid).recent.length, 3)
	})

	it("duplicate recovered batch deliveries replay the result without helpers or another status row", async () => {
		const block = {
			type: "tool_use" as const,
			name: DietCodeDefaultTool.USE_SUBAGENTS,
			call_id: "batch-1",
			partial: false,
			params: { prompt_1: "implement A" },
		}
		const fingerprint = executionFingerprint([block.name, Object.entries(block.params)])
		const first = store()
		first.put("batch-1", {
			kind: "batch",
			fingerprint,
			result: "saved completed result",
			messageTs: 99,
			status: JSON.stringify({
				batchId: "batch-1",
				status: "running",
				items: [
					{
						id: "helper-a",
						executionId: "action-a",
						prompt: "implement A",
						status: "cancelled",
						filesModified: ["a.ts"],
						result: "saved partial A",
					},
					{
						id: "helper-b",
						executionId: "action-b",
						prompt: "implement B",
						status: "running",
						pendingCommandIds: ["shell-b"],
					},
				],
			}),
		})
		const recovery = store()
		const state = new TaskState()
		state.recovery = recovery
		const config = { taskState: state } as TaskConfig
		const handler = new UseSubagentsToolHandler()
		assert.deepEqual(await Promise.all([handler.execute(config, block), handler.execute(config, block)]), [
			"saved completed result",
			"saved completed result",
		])
		assert.match(
			String(await handler.execute(config, { ...block, params: { prompt_1: "different" } })),
			/different persisted arguments/,
		)
		const rows = reconcileHelperExecutions([], recovery)
		const again = reconcileHelperExecutions(rows, recovery)
		assert.equal(again.length, 1)
		const payload = parseSubagentStatusPayload(again[0].text)!
		assert.deepEqual(
			payload.items.map((item) => [item.id, item.status]),
			[
				["helper-a", "cancelled"],
				["helper-b", "interrupted"],
			],
		)
		assert.deepEqual(payload.items[1].pendingCommandIds, ["shell-b"])
		assert.deepEqual(payload.items[0].filesModified, ["a.ts"])
	})

	it("restores completed helper truth even when its UI row never arrived", () => {
		const first = store()
		const registry = new ActionExecutionRegistry()
		registry.attachRecovery(identity.ulid, first)
		const helper = registry.claim(identity.ulid, helperIdentity("helper:ui-offline"))
		first.put("batch-ui", {
			kind: "batch",
			fingerprint: "intent",
			status: JSON.stringify({
				batchId: "batch-ui",
				status: "running",
				items: [{ id: "card", executionId: helper.snapshot.execution_id, prompt: "save A", status: "running" }],
			}),
		})
		registry.finish(helper, "completed", { result: "saved A", filesModified: ["a.ts"] })
		const recovery = store()
		const restored = new ActionExecutionRegistry()
		restored.attachRecovery(identity.ulid, recovery)
		const completion: DietCodeMessage = {
			ts: Date.now() + 1000,
			type: "ask",
			ask: "completion_result",
			text: "task finished",
		}
		const rows = reconcileHelperExecutions([completion], recovery, (id) => restored.get(identity.ulid, id))
		const payload = parseSubagentStatusPayload(rows[0].text)!
		assert.equal(payload.status, "completed")
		assert.equal(payload.items[0].status, "completed")
		assert.equal(payload.items[0].result, "saved A")
		assert.deepEqual(payload.items[0].filesModified, ["a.ts"])
		assert.equal(rows.at(-1), completion)
		assert.equal(reconcileHelperExecutions(rows, recovery, (id) => restored.get(identity.ulid, id)).length, 2)
	})

	for (const defect of ["malformed", "version", "identity", "outcome", "oversized"] as const)
		it(`rejects ${defect} persisted state explicitly without overwriting it or dispatching`, () => {
			const first = store()
			first.put("saved", {
				kind: "command",
				transport: { kind: "unknown" },
				snapshot: {
					execution_id: "saved",
					command: "build",
					cwd: identity.cwd,
					status: "unknown",
					output: "saved output",
				},
			})
			const file = join(directory, `command-${executionFingerprint("saved")}.json`)
			const value = JSON.parse(readFileSync(file, "utf8"))
			if (defect === "version") value.version = 999
			if (defect === "identity") value.identity.cwd = "/other-workspace"
			if (defect === "outcome") value.record.snapshot.status = "completed"
			writeFileSync(
				file,
				defect === "malformed" ? "{broken" : defect === "oversized" ? "x".repeat(1_048_577) : JSON.stringify(value),
			)
			const before = readFileSync(file, "utf8")
			const recovery = store()
			assert.equal(recovery.report.status, "blocked")
			assert.throws(() => recovery.assertCanExecute(), /persisted recovery state needs reconciliation/)
			assert.equal(readFileSync(file, "utf8"), before)
		})

	it("a stale task manifest cannot import another task's receipts", () => {
		store().put("tool", { kind: "tool", fingerprint: "intent", result: "saved" })
		const recovery = new ExecutionRecoveryStore(directory, { ...identity, ulid: "another-task" })
		assert.equal(recovery.report.status, "blocked")
		assert.equal(recovery.entries("tool").length, 0)
	})

	it("does not infer command success or cancellation when the recorded process no longer exists", async () => {
		const child = spawn(process.execPath, ["-e", "process.stdout.write('before exit');"], {
			stdio: ["ignore", "pipe", "ignore"],
		})
		const first = store()
		first.put("gone", {
			kind: "command",
			transport: { kind: "supervised", shell: process.execPath, processId: child.pid },
			snapshot: {
				execution_id: "gone",
				command: "previous shell",
				cwd: identity.cwd,
				status: "background",
				output: "previously saved output",
			},
		})
		await once(child, "close")
		const reopened = commandHost()
		const result = await reopened.executor.readCommandOutput("gone", 30)
		assert.equal(result.status, "unknown")
		assert.equal(result.exit_code, undefined)
		assert.equal(result.output, "previously saved output")
		assert.equal(result.recovery?.authority, "none")
		sinon.assert.notCalled(reopened.manager.runCommand as sinon.SinonStub)
	})

	it("replayed tool calls and partial previews cannot dispatch an old mutation", async () => {
		const block = {
			type: "tool_use" as const,
			name: DietCodeDefaultTool.FILE_NEW,
			tool_use_id: "write-call",
			partial: false,
			params: { path: "a.ts", content: "A" },
		}
		store().put("write-call", {
			kind: "tool",
			fingerprint: executionFingerprint([block.name, Object.entries(block.params).sort(([a], [b]) => a.localeCompare(b))]),
			result: "saved A",
		})
		const taskState = new TaskState()
		taskState.recovery = store()
		const instance = Object.assign(Object.create(ToolExecutor.prototype), {
			taskState,
			execute: sinon.stub(),
			pushToolResult: sinon.stub(),
		})
		await instance.executeTool({ ...block, partial: true })
		await instance.executeTool(block)
		sinon.assert.notCalled(instance.execute)
		sinon.assert.calledOnceWithExactly(instance.pushToolResult, "saved A", block, false)
	})
})
