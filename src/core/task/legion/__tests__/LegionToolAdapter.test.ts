import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApiHandler } from "@core/api"
import type { StateManager } from "@core/storage/StateManager"
import { executor } from "@core/task/ActionExecutor"
import { TaskState } from "@core/task/TaskState"
import { AutoApprove } from "@core/task/tools/autoApprove"
import { ToolExecutorCoordinator } from "@core/task/tools/ToolExecutorCoordinator"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import { ToolHookUtils } from "@core/task/tools/utils/ToolHookUtils"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { expect } from "chai"
import sinon from "sinon"
import * as operationReceipts from "@/infrastructure/ai/LegionExecutionReceipt"
import * as pathUtils from "@/utils/path"
import { LegionAgentHost } from "../LegionAgentHost"
import { createLegionToolAdapter } from "../LegionToolAdapter"

describe("LegionToolAdapter", () => {
	afterEach(() => sinon.restore())

	it("blocks completion when a returned operation's durable receipt cannot be settled", async () => {
		const receipt = { tool: "read_file", paths: ["a.ts"], status: "started" as const, startedAt: Date.now() }
		sinon.stub(operationReceipts, "beginLegionOperation").resolves(receipt)
		sinon.stub(operationReceipts, "finishLegionOperation").rejects(new Error("storage unavailable"))
		sinon.stub(ToolExecutorCoordinator.prototype, "execute").resolves("file contents")
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			callbacks: {},
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
		} as unknown as TaskConfig
		const adapter = createLegionToolAdapter(base, {} as ApiHandler, [], "specialist")
		expect(await adapter.execute("read_file", { path: "a.ts" }, new AbortController().signal, "call-1")).to.equal(
			"file contents",
		)
		expect(adapter.getPendingWork?.()).to.include("durable receipt is unconfirmed")
		adapter.dispose?.()
	})

	it("does not dispatch when receipt creation fails and keeps its outcome unconfirmed", async () => {
		sinon.stub(operationReceipts, "beginLegionOperation").rejects(new Error("receipt unavailable"))
		const execute = sinon.stub(ToolExecutorCoordinator.prototype, "execute").resolves("done")
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			callbacks: {},
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
		} as unknown as TaskConfig
		const adapter = createLegionToolAdapter(base, {} as ApiHandler, [], "specialist")
		try {
			await adapter.execute("read_file", { path: "a.ts" }, new AbortController().signal, "call-1")
			expect.fail("expected receipt failure")
		} catch (error) {
			expect((error as Error).message).to.equal("receipt unavailable")
		}
		sinon.assert.notCalled(execute)
		expect(adapter.getPendingWork?.()).to.include("unconfirmed")
		adapter.dispose?.()
	})

	it("keeps a thrown operation unresolved even when its uncertain receipt is recorded", async () => {
		const receipt = { tool: "read_file", paths: [], status: "started" as const, startedAt: Date.now() }
		sinon.stub(operationReceipts, "beginLegionOperation").resolves(receipt)
		const finish = sinon.stub(operationReceipts, "finishLegionOperation").resolves()
		sinon.stub(ToolExecutorCoordinator.prototype, "execute").rejects(new Error("execution lost"))
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			callbacks: {},
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
		} as unknown as TaskConfig
		const adapter = createLegionToolAdapter(base, {} as ApiHandler, [], "specialist")
		try {
			await adapter.execute("read_file", { path: "a.ts" }, new AbortController().signal, "call-1")
			expect.fail("expected execution failure")
		} catch (error) {
			expect((error as Error).message).to.equal("execution lost")
		}
		sinon.assert.calledWith(finish, "specialist", "call-1", receipt, "uncertain")
		expect(adapter.getPendingWork?.()).to.include("unconfirmed")
		adapter.dispose?.()
	})

	it("settles a returned operation after its receipt is saved", async () => {
		const receipt = { tool: "read_file", paths: [], status: "started" as const, startedAt: Date.now() }
		sinon.stub(operationReceipts, "beginLegionOperation").resolves(receipt)
		sinon.stub(operationReceipts, "finishLegionOperation").resolves()
		sinon.stub(ToolExecutorCoordinator.prototype, "execute").resolves("done")
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			callbacks: {},
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
		} as unknown as TaskConfig
		const adapter = createLegionToolAdapter(base, {} as ApiHandler, [], "specialist")
		await adapter.execute("read_file", { path: "a.ts" }, new AbortController().signal, "call-1")
		expect(adapter.getPendingWork?.()).to.equal(undefined)
		adapter.dispose?.()
	})

	it("tracks owned non-command actions without blocking on sibling actions", async () => {
		let owner = ""
		let ownedActive = true
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			callbacks: {
				getExecutionState: () => ({
					commands: { active: [], recent: [] },
					actions: {
						active: [
							{ owner: "legion:sibling", execution_id: "sibling-action" },
							...(ownedActive ? [{ owner, execution_id: "owned-action" }] : []),
						],
						recent: [],
					},
				}),
			},
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
		} as unknown as TaskConfig
		sinon.stub(ToolExecutorCoordinator.prototype, "execute").callsFake(async (config) => {
			owner = config.executionOwner!
			return "returned while action is still settling"
		})
		const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
		await adapter.execute("write_to_file", { path: "a.ts", content: "work" }, new AbortController().signal)
		expect(adapter.getPendingWork?.()).to.include("owned-action").and.not.include("sibling-action")
		ownedActive = false
		expect(adapter.getPendingWork?.()).to.equal(undefined)
		adapter.dispose?.()
	})

	it("blocks completion on commands inherited by a resumed specialist", () => {
		const commands = {
			active: [{ owner: "legion:resumed", execution_id: "running", status: "running" }],
			recent: [
				{ owner: "legion:resumed", execution_id: "uncertain", status: "unconfirmed" },
				{ owner: "legion:sibling", execution_id: "sibling", status: "unknown" },
				{ owner: "legion:resumed", execution_id: "finished", status: "completed" },
			],
		}
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			callbacks: { getExecutionState: () => ({ commands, actions: { active: [], recent: [] } }) },
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
		} as unknown as TaskConfig
		const adapter = createLegionToolAdapter(base, {} as ApiHandler, [], "resumed")
		expect(adapter.getPendingWork?.()).to.include("running").and.include("uncertain").and.not.include("sibling")
		commands.active = []
		commands.recent = commands.recent.filter((entry) => entry.status === "completed")
		expect(adapter.getPendingWork?.()).to.equal(undefined)
		adapter.dispose?.()
	})

	it("keeps file-write status unresolved when action inventory is unavailable", async () => {
		let inventoryAvailable = false
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			callbacks: {
				getExecutionState: () => (inventoryAvailable ? { actions: { active: [], recent: [] } } : undefined),
			},
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
		} as unknown as TaskConfig
		sinon.stub(ToolExecutorCoordinator.prototype, "execute").resolves("returned")
		const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
		expect(adapter.getPendingWork?.()).to.equal(undefined)
		await adapter.execute("write_to_file", { path: "a.ts", content: "work" }, new AbortController().signal)
		expect(adapter.getPendingWork?.()).to.include("action status is unavailable")
		inventoryAvailable = true
		expect(adapter.getPendingWork?.()).to.equal(undefined)
		adapter.dispose?.()
	})

	it("blocks completion for an owned recovered action even when no live action remains", async () => {
		let owner = ""
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			callbacks: {
				getExecutionState: () => ({
					actions: { active: [], recent: [], unresolved: [{ owner, execution_id: "recovered-write" }] },
				}),
			},
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
		} as unknown as TaskConfig
		sinon.stub(ToolExecutorCoordinator.prototype, "execute").callsFake(async (config) => {
			owner = config.executionOwner!
			return "returned"
		})
		const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
		await adapter.execute("write_to_file", { path: "a.ts", content: "work" }, new AbortController().signal)
		expect(adapter.getPendingWork?.()).to.include("recovered-write")
		adapter.dispose?.()
	})

	it("does not accept completion while an owned non-command action is active", async () => {
		let owner = ""
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			callbacks: {
				getExecutionState: () => ({ actions: { active: [{ owner, execution_id: "write-action" }], recent: [] } }),
			},
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
		} as unknown as TaskConfig
		sinon.stub(ToolExecutorCoordinator.prototype, "execute").callsFake(async (config) => {
			owner = config.executionOwner!
			return "action submitted"
		})
		let turn = 0
		const api = {
			createMessage: () =>
				(async function* () {
					const call =
						turn++ === 0
							? { id: "write-1", name: "write_to_file", arguments: '{"path":"a.ts","content":"x"}' }
							: { id: "finish-1", name: "attempt_completion", arguments: '{"result":"done"}' }
					yield { type: "tool_calls", tool_call: { function: call } }
				})(),
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => createLegionToolAdapter(base, api, []),
			availableSkills: "no skills",
			maxTurns: 2,
		})
		const result = await host.execute({ assignment: { title: "Specialist", focusObjective: "Write a file" } } as any, {
			handoff: [],
			signal: new AbortController().signal,
		})
		expect(result.status).to.equal("unresolved")
		if (result.status === "unresolved") expect(result.reason).to.include("write-action")
	})

	it("prevents a specialist from completing after a receipt write fails", async () => {
		const receipt = { tool: "read_file", paths: [], status: "started" as const, startedAt: Date.now() }
		sinon.stub(operationReceipts, "beginLegionOperation").resolves(receipt)
		sinon.stub(operationReceipts, "finishLegionOperation").rejects(new Error("storage unavailable"))
		sinon.stub(ToolExecutorCoordinator.prototype, "execute").resolves("done")
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			callbacks: {},
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
		} as unknown as TaskConfig
		let turn = 0
		const api = {
			createMessage: () =>
				(async function* () {
					const call =
						turn++ === 0
							? { id: "read-1", name: "read_file", arguments: '{"path":"a.ts"}' }
							: { id: "finish-1", name: "attempt_completion", arguments: '{"result":"all done"}' }
					yield { type: "tool_calls", tool_call: { function: call } }
				})(),
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => createLegionToolAdapter(base, api, [], "specialist"),
			availableSkills: "no skills",
			maxTurns: 2,
		})
		const result = await host.execute({ assignment: { title: "Specialist", focusObjective: "Read a file" } } as any, {
			handoff: [],
			signal: new AbortController().signal,
		})
		expect(result.status).to.equal("unresolved")
		if (result.status === "unresolved") expect(result.reason).to.include("durable receipt is unconfirmed")
	})
	it("writes through the real handler and propagates edit evidence to the parent", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "lumi-legion-handler-"))
		sinon.stub(pathUtils, "isLocatedInWorkspace").resolves(true)
		sinon.stub(ToolHookUtils, "runPreToolUseIfEnabled").resolves()
		const parent = new TaskState()
		const base = {
			cwd,
			ulid: cwd,
			taskState: parent,
			mode: "act",
			autoApprovalSettings: { enableNotifications: false },
			callbacks: {
				shouldAutoApproveToolWithPath: async () => true,
				ask: async () => ({ response: "yesButtonClicked" }),
				say: async () => undefined,
				removeLastPartialMessageIfExistsWithType: async () => {},
			},
			services: {
				dietcodeIgnoreController: { validateAccess: () => true },
				fileContextTracker: { markFileAsEditedByDietCode: () => {}, trackFileContext: async () => {} },
				stateManager: { getApiConfiguration: () => ({ actModeApiProvider: "test" }), getGlobalSettingsKey: () => "act" },
			},
		} as unknown as TaskConfig
		const api = { getModel: () => ({ id: "test", info: {} }) } as unknown as ApiHandler
		try {
			const adapter = createLegionToolAdapter(base, api, [])
			const output = await adapter.execute(
				"write_to_file",
				{ path: "sample.txt", content: "specialist work" },
				new AbortController().signal,
			)
			expect(output).to.include("successfully saved")
			expect(await readFile(join(cwd, "sample.txt"), "utf8")).to.equal("specialist work")
			expect(parent.didEditFile).to.equal(true)
			expect(parent.workspaceRevision).to.equal(1)
			base.callbacks.shouldAutoApproveToolWithPath = async () => false
			base.callbacks.ask = async () => ({ response: "noButtonClicked" })
			const denied = createLegionToolAdapter(base, api, [])
			let failure = ""
			try {
				await denied.execute(
					"write_to_file",
					{ path: "denied.txt", content: "must not be written" },
					new AbortController().signal,
				)
			} catch (error) {
				failure = String(error)
			}
			expect(failure).to.include("was denied")
			expect(
				await readFile(join(cwd, "denied.txt"), "utf8").then(
					() => false,
					() => true,
				),
			).to.equal(true)
			expect(parent.workspaceRevision).to.equal(1)
		} finally {
			await rm(cwd, { recursive: true, force: true })
		}
	})
	it("uses isolated task state and preserves the parent's approval callbacks", async () => {
		const parentState = new TaskState()
		const callbacks = {} as TaskConfig["callbacks"]
		const base = {
			cwd: process.cwd(),
			taskState: parentState,
			callbacks,
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			universalGuard: { guardPreExecution: async () => ({ success: true }) },
		} as unknown as TaskConfig
		const original = ToolExecutorCoordinator.prototype.execute
		let received: TaskConfig | undefined
		ToolExecutorCoordinator.prototype.execute = async (config) => {
			received = config
			return "observed"
		}
		try {
			const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
			expect(await adapter.execute("read_file", { path: "a.ts" }, new AbortController().signal)).to.equal("observed")
			expect(received?.taskState).not.to.equal(parentState)
			expect(received?.callbacks.ask).to.equal(callbacks.ask)
		} finally {
			ToolExecutorCoordinator.prototype.execute = original
		}
	})

	it("does not dispatch disallowed or policy-denied operations", async () => {
		let invoked = false
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			universalGuard: { guardPreExecution: async () => ({ success: false, error: "policy" }) },
		} as unknown as TaskConfig
		const original = ToolExecutorCoordinator.prototype.execute
		ToolExecutorCoordinator.prototype.execute = async () => {
			invoked = true
			return ""
		}
		try {
			const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
			expect(await adapter.execute("read_file", { path: "a" }, new AbortController().signal)).to.include("policy")
			try {
				await adapter.execute("use_mcp_tool", {}, new AbortController().signal)
				expect.fail("should reject")
			} catch (error) {
				expect(String(error)).to.include("unavailable")
			}
			expect(invoked).to.equal(false)
		} finally {
			ToolExecutorCoordinator.prototype.execute = original
		}
	})

	it("tracks specialist command ownership and keeps cancellation attached after a foreground return", async () => {
		let owner = ""
		let commandSignal: AbortSignal | undefined
		let active = true
		let observedStatus = "completed"
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: {
				executeCommandTool: async (
					_command: string,
					_timeout: unknown,
					options: { owner: string; signal: AbortSignal },
				) => {
					owner = options.owner
					commandSignal = options.signal
					return [false, "background", { status: "background", executionId: "command-1" }]
				},
				getExecutionState: (id?: string) => {
					if (id && observedStatus === "unavailable") throw new Error("receipt expired")
					return id
						? { status: active ? "background" : observedStatus, execution_id: id }
						: {
								commands: { active: active ? [{ owner, execution_id: "command-1" }] : [], recent: [] },
								actions: { active: [], recent: [] },
								coverage: { commands: "available" },
							}
				},
			},
		} as unknown as TaskConfig
		const original = ToolExecutorCoordinator.prototype.execute
		ToolExecutorCoordinator.prototype.execute = async (config) => {
			await config.callbacks.executeCommandTool("npm test", 1, { owner: config.executionOwner })
			return "running"
		}
		try {
			const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
			const controller = new AbortController()
			await adapter.execute("execute_command", { command: "npm test" }, controller.signal)
			expect(adapter.getPendingWork?.()).to.include("command-1")
			controller.abort()
			expect(commandSignal?.aborted).to.equal(true)
			active = false
			observedStatus = "unconfirmed"
			expect(adapter.getPendingWork?.()).to.include("command-1")
			observedStatus = "completed"
			expect(adapter.getPendingWork?.()).to.equal(undefined)
		} finally {
			ToolExecutorCoordinator.prototype.execute = original
		}
	})

	it("routes commands through the real handler's permission and approval checks", async () => {
		const stateManager = {
			getApiConfiguration: () => ({}),
			getTrustedCommands: () => [],
			getTrustedTools: () => [],
			getGlobalSettingsKey: (key: string) =>
				key === "autoApprovalSettings" ? DEFAULT_AUTO_APPROVAL_SETTINGS : key === "mode" ? "act" : false,
		} as unknown as StateManager
		const ask = sinon.stub().resolves({ response: "noButtonClicked" })
		const executeCommandTool = sinon.stub().resolves([false, "done", { status: "completed", exitCode: 0 }])
		const base = {
			cwd: process.cwd(),
			ulid: "legion-command-test",
			taskState: new TaskState(),
			mode: "act",
			autoApprover: new AutoApprove(stateManager),
			autoApprovalSettings: { ...DEFAULT_AUTO_APPROVAL_SETTINGS, enableNotifications: false },
			services: {
				stateManager,
				dietcodeIgnoreController: { validateAccess: () => true, validateCommand: () => undefined },
				commandPermissionController: { validateCommand: () => ({ allowed: true }) },
			},
			callbacks: {
				ask,
				say: sinon.stub().resolves(),
				removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
				executeCommandTool,
				getExecutionState: () => ({
					commands: { active: [], recent: [] },
					actions: { active: [], recent: [] },
					coverage: { commands: "available" },
				}),
			},
		} as unknown as TaskConfig
		sinon.stub(ToolHookUtils, "runPreToolUseIfEnabled").resolves(true)
		sinon.stub(executor, "execute").callsFake(async (_id, action) => action(new AbortController().signal, "action-1"))
		const adapter = createLegionToolAdapter(base, { getModel: () => ({ id: "test" }) } as unknown as ApiHandler, [])
		let error = ""
		try {
			await adapter.execute(
				"execute_command",
				{ command: "npm test", requires_approval: "true" },
				new AbortController().signal,
			)
		} catch (caught) {
			error = String(caught)
		}
		expect(error).to.include("was denied")
		sinon.assert.calledOnce(ask)
		sinon.assert.notCalled(executeCommandTool)
		ask.resolves({ response: "yesButtonClicked" })
		const approved = createLegionToolAdapter(base, { getModel: () => ({ id: "test" }) } as unknown as ApiHandler, [])
		expect(
			await approved.execute(
				"execute_command",
				{ command: "npm test", requires_approval: "true" },
				new AbortController().signal,
			),
		).to.equal("done")
		sinon.assert.calledOnce(executeCommandTool)
		expect(executeCommandTool.firstCall.args[2].owner).to.match(/^legion:/)
		expect(approved.getPendingWork?.()).to.equal(undefined)
	})

	it("keeps a legacy command without structured status unresolved", async () => {
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: {
				executeCommandTool: async () => [false, "returned"],
				getExecutionState: () => ({ commands: { active: [], recent: [] }, actions: { active: [], recent: [] } }),
			},
		} as unknown as TaskConfig
		const original = ToolExecutorCoordinator.prototype.execute
		ToolExecutorCoordinator.prototype.execute = async (config) => {
			await config.callbacks.executeCommandTool("test", 1)
			return "returned"
		}
		try {
			const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
			await adapter.execute("execute_command", { command: "test" }, new AbortController().signal)
			expect(adapter.getPendingWork?.()).to.include("unconfirmed")
		} finally {
			ToolExecutorCoordinator.prototype.execute = original
		}
	})

	it("aborts specialist commands when base.taskState.abortSignal fires", async () => {
		const parentTaskState = new TaskState()
		let commandSignal: AbortSignal | undefined
		const base = {
			cwd: process.cwd(),
			taskState: parentTaskState,
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: {
				executeCommandTool: async (_cmd: string, _timeout: unknown, options: { signal: AbortSignal }) => {
					commandSignal = options.signal
					return [false, "background", { status: "background", executionId: "cmd-bg" }]
				},
				getExecutionState: () => ({
					commands: { active: [{ owner: "legion:test", execution_id: "cmd-bg" }], recent: [] },
					actions: { active: [], recent: [] },
					coverage: { commands: "available" },
				}),
			},
		} as unknown as TaskConfig
		const original = ToolExecutorCoordinator.prototype.execute
		ToolExecutorCoordinator.prototype.execute = async (config) => {
			await config.callbacks.executeCommandTool("long-run", 1)
			return "started"
		}
		try {
			const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
			await adapter.execute("execute_command", { command: "long-run" }, new AbortController().signal)
			expect(commandSignal?.aborted).to.equal(false)
			parentTaskState.abort = true
			expect(commandSignal?.aborted).to.equal(true)
		} finally {
			ToolExecutorCoordinator.prototype.execute = original
		}
	})

	it("retains an uncertain command when the callback throws without a receipt", async () => {
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: {
				executeCommandTool: async () => {
					throw new Error("Terminal process failed to start")
				},
				getExecutionState: () => ({
					commands: { active: [], recent: [] },
					actions: { active: [], recent: [] },
					coverage: { commands: "available" },
				}),
			},
		} as unknown as TaskConfig
		const original = ToolExecutorCoordinator.prototype.execute
		ToolExecutorCoordinator.prototype.execute = async (config) => {
			await config.callbacks.executeCommandTool("fail-launch", 1)
			return "failed"
		}
		try {
			const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
			let err: Error | undefined
			try {
				await adapter.execute("execute_command", { command: "fail-launch" }, new AbortController().signal)
			} catch (e) {
				err = e as Error
			}
			expect(err?.message).to.include("Terminal process failed to start")
			expect(adapter.getPendingWork?.()).to.include("unconfirmed")
		} finally {
			ToolExecutorCoordinator.prototype.execute = original
		}
	})

	it("uses command notifications to reconcile a rejected callback and early completion", async () => {
		for (const reject of [true, false]) {
			const base = {
				cwd: process.cwd(),
				taskState: new TaskState(),
				services: { dietcodeIgnoreController: { validateAccess: () => true } },
				callbacks: {
					executeCommandTool: async (_command: string, _timeout: unknown, options: any) => {
						options.onStateChange({ executionId: "finished-command", status: "completed" })
						if (reject) throw new Error("response lost")
						return [false, "started", { status: "running", executionId: "finished-command" }]
					},
					getExecutionState: () => ({
						commands: { active: [], recent: [] },
						actions: { active: [], recent: [] },
						coverage: { commands: "available" },
					}),
				},
			} as unknown as TaskConfig
			const original = ToolExecutorCoordinator.prototype.execute
			ToolExecutorCoordinator.prototype.execute = async (config) => {
				await config.callbacks.executeCommandTool("task", 1)
				return "done"
			}
			try {
				const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
				try {
					await adapter.execute("execute_command", { command: "task" }, new AbortController().signal)
				} catch (error) {
					if (!reject) throw error
				}
				expect(adapter.getPendingWork?.()).to.equal(undefined)
			} finally {
				ToolExecutorCoordinator.prototype.execute = original
			}
		}
	})

	it("does not settle a reserved invocation from another command's notification", async () => {
		let notify: ((state: any) => void) | undefined
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: {
				executeCommandTool: async (_command: string, _timeout: unknown, options: any) => {
					notify = options.onStateChange
					notify?.({ executionId: "other", status: "completed" })
					throw new Error("response lost")
				},
				getExecutionState: () => ({ commands: { active: [], recent: [] }, actions: { active: [], recent: [] } }),
			},
		} as unknown as TaskConfig
		sinon.stub(ToolExecutorCoordinator.prototype, "execute").callsFake(async (config) => {
			await config.callbacks.executeCommandTool("test", 1, { actionId: "own" })
			return "done"
		})
		const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
		try {
			await adapter.execute("execute_command", { command: "test" }, new AbortController().signal)
		} catch {}
		expect(adapter.getPendingWork?.()).to.include("unconfirmed")
		notify?.({ executionId: "own", status: "completed" })
		expect(adapter.getPendingWork?.()).to.equal(undefined)
		adapter.dispose?.()
	})

	it("keeps a reserved invocation uncertain when a different command returns a terminal result", async () => {
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: {
				executeCommandTool: async () => [false, "other", { executionId: "other", status: "completed" }],
				getExecutionState: () => ({ commands: { active: [], recent: [] }, actions: { active: [], recent: [] } }),
			},
		} as unknown as TaskConfig
		sinon.stub(ToolExecutorCoordinator.prototype, "execute").callsFake(async (config) => {
			await config.callbacks.executeCommandTool("test", 1, { actionId: "own" })
			return "done"
		})
		const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
		await adapter.execute("execute_command", { command: "test" }, new AbortController().signal)
		expect(adapter.getPendingWork?.()).to.include("unconfirmed")
		adapter.dispose?.()
	})

	it("settles a running notification from the terminal result and ignores a late running update", async () => {
		let notify: ((state: any) => void) | undefined
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: {
				executeCommandTool: async (_command: string, _timeout: unknown, options: any) => {
					notify = options.onStateChange
					notify?.({ executionId: "command-finished", status: "running" })
					return [false, "done", { executionId: "command-finished", status: "completed", exitCode: 0 }]
				},
				getExecutionState: (id?: string) => {
					if (id) throw new Error("old receipt unavailable")
					return {
						commands: { active: [], recent: [] },
						actions: { active: [], recent: [] },
						coverage: { commands: "available" },
					}
				},
			},
		} as unknown as TaskConfig
		sinon.stub(ToolExecutorCoordinator.prototype, "execute").callsFake(async (config) => {
			await config.callbacks.executeCommandTool("test", 1)
			return "done"
		})
		const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
		await adapter.execute("execute_command", { command: "test" }, new AbortController().signal)
		expect(adapter.getPendingWork?.()).to.equal(undefined)
		notify?.({ executionId: "command-finished", status: "running" })
		expect(adapter.getPendingWork?.()).to.equal(undefined)
		adapter.dispose?.()
	})

	it("does not settle a different command ID from a terminal result", async () => {
		let notify: ((state: any) => void) | undefined
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: {
				executeCommandTool: async (_command: string, _timeout: unknown, options: any) => {
					notify = options.onStateChange
					notify?.({ executionId: "still-running", status: "running" })
					return [false, "other result", { executionId: "other-command", status: "completed", exitCode: 0 }]
				},
				getExecutionState: (id?: string) => {
					if (id) throw new Error("observation unavailable")
					return {
						commands: { active: [], recent: [] },
						actions: { active: [], recent: [] },
						coverage: { commands: "available" },
					}
				},
			},
		} as unknown as TaskConfig
		sinon.stub(ToolExecutorCoordinator.prototype, "execute").callsFake(async (config) => {
			await config.callbacks.executeCommandTool("test", 1)
			return "done"
		})
		const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
		await adapter.execute("execute_command", { command: "test" }, new AbortController().signal)
		expect(adapter.getPendingWork?.()).to.include("still-running")
		notify?.({ executionId: "still-running", status: "completed" })
		expect(adapter.getPendingWork?.()).to.equal(undefined)
		adapter.dispose?.()
	})

	it("keeps a known execution unresolved if its callback rejects after dispatch", async () => {
		let notify: ((state: any) => void) | undefined
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: {
				executeCommandTool: async (_command: string, _timeout: unknown, options: any) => {
					notify = options.onStateChange
					notify?.({ executionId: "dispatched-command", status: "running" })
					throw new Error("connection lost")
				},
				getExecutionState: () => ({ commands: { active: [], recent: [] }, actions: { active: [], recent: [] } }),
			},
		} as unknown as TaskConfig
		const original = ToolExecutorCoordinator.prototype.execute
		ToolExecutorCoordinator.prototype.execute = async (config) => {
			await config.callbacks.executeCommandTool("task", 1)
			return "done"
		}
		try {
			const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
			try {
				await adapter.execute("execute_command", { command: "task" }, new AbortController().signal)
			} catch (error) {
				expect((error as Error).message).to.equal("connection lost")
			}
			expect(adapter.getPendingWork?.()).to.include("dispatched-command")
			notify?.({ executionId: "dispatched-command", status: "completed" })
			expect(adapter.getPendingWork?.()).to.equal(undefined)
		} finally {
			ToolExecutorCoordinator.prototype.execute = original
		}
	})

	it("removes settled command IDs from internal unresolved tracking once completed", async () => {
		let observedStatus = "running"
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: {
				executeCommandTool: async () => [false, "ok", { status: "running", executionId: "tracked-cmd" }],
				getExecutionState: (id?: string) =>
					id
						? { status: observedStatus, execution_id: id }
						: {
								commands: { active: [], recent: [] },
								actions: { active: [], recent: [] },
								coverage: { commands: "available" },
							},
			},
		} as unknown as TaskConfig
		const original = ToolExecutorCoordinator.prototype.execute
		ToolExecutorCoordinator.prototype.execute = async (config) => {
			await config.callbacks.executeCommandTool("task", 1)
			return "done"
		}
		try {
			const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
			await adapter.execute("execute_command", { command: "task" }, new AbortController().signal)
			expect(adapter.getPendingWork?.()).to.include("tracked-cmd")
			observedStatus = "unavailable"
			expect(adapter.getPendingWork?.()).to.include("tracked-cmd")
			observedStatus = "completed"
			expect(adapter.getPendingWork?.()).to.equal(undefined)
		} finally {
			ToolExecutorCoordinator.prototype.execute = original
		}
	})

	it("requires a matching command identity before accepting an inspected terminal result", async () => {
		let returnedId = "other"
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: {
				executeCommandTool: async () => [false, "running", { status: "running", executionId: "own" }],
				getExecutionState: (id?: string) =>
					id
						? {
								action: { execution_id: "own", status: "completed" },
								command: { execution_id: returnedId, status: "completed" },
							}
						: { commands: { active: [], recent: [] }, actions: { active: [], recent: [] } },
			},
		} as unknown as TaskConfig
		sinon.stub(ToolExecutorCoordinator.prototype, "execute").callsFake(async (config) => {
			await config.callbacks.executeCommandTool("test", 1)
			return "done"
		})
		const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
		await adapter.execute("execute_command", { command: "test" }, new AbortController().signal)
		expect(adapter.getPendingWork?.()).to.include("own")
		returnedId = "own"
		expect(adapter.getPendingWork?.()).to.equal(undefined)
		adapter.dispose?.()
	})

	it("reconciles a terminal output receipt through an action ID without trusting mismatched receipts", async () => {
		let matching = false
		let read!: (id: string) => Promise<unknown>
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: {
				executeCommandTool: async () => [false, "running", { status: "running", executionId: "run" }],
				readCommandOutput: async () => ({
					execution_id: "run",
					action_id: matching ? "action" : "other",
					status: "completed",
				}),
				getExecutionState: (id?: string) => {
					if (id) throw new Error("inspection unavailable")
					return { commands: { active: [], recent: [] }, actions: { active: [], recent: [] } }
				},
			},
		} as unknown as TaskConfig
		sinon.stub(ToolExecutorCoordinator.prototype, "execute").callsFake(async (config) => {
			read = (id) => config.callbacks.readCommandOutput!(id, 0)
			await config.callbacks.executeCommandTool("test", 1)
			return "done"
		})
		const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
		await adapter.execute("execute_command", { command: "test" }, new AbortController().signal)
		await read("action")
		expect(adapter.getPendingWork?.()).to.include("run")
		matching = true
		await read("action")
		expect(adapter.getPendingWork?.()).to.equal(undefined)
		adapter.dispose?.()
	})

	it("does not invoke task-wide cancellation on specialist abort or disposal", async () => {
		const cancelRunningCommandTool = sinon.stub().resolves(true)
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: { cancelRunningCommandTool },
		} as unknown as TaskConfig
		const parentCtrl = new AbortController()
		const adapter = createLegionToolAdapter(base, {} as ApiHandler, [], "stream-1", parentCtrl.signal)
		sinon.assert.notCalled(cancelRunningCommandTool)
		parentCtrl.abort()
		sinon.assert.notCalled(cancelRunningCommandTool)
		adapter.dispose?.()
		sinon.assert.notCalled(cancelRunningCommandTool)
		const nextController = new AbortController()
		const next = createLegionToolAdapter(base, {} as ApiHandler, [], "stream-2", nextController.signal)
		next.dispose?.()
		nextController.abort()
		sinon.assert.notCalled(cancelRunningCommandTool)
	})

	it("aborts only the specialist's own detached command", async () => {
		const signals = new Map<string, AbortSignal>()
		const cancelAll = sinon.stub().resolves(true)
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: {
				cancelRunningCommandTool: cancelAll,
				executeCommandTool: async (command: string, _timeout: unknown, options: { signal: AbortSignal }) => {
					signals.set(command, options.signal)
					return [false, "running", { status: "background", executionId: command }]
				},
			},
		} as unknown as TaskConfig
		sinon.stub(ToolExecutorCoordinator.prototype, "execute").callsFake(async (config, block) => {
			await config.callbacks.executeCommandTool(block.params.command!, 1)
			return "running"
		})
		const firstController = new AbortController()
		const secondController = new AbortController()
		const first = createLegionToolAdapter(base, {} as ApiHandler, [], undefined, firstController.signal)
		const second = createLegionToolAdapter(base, {} as ApiHandler, [], undefined, secondController.signal)
		await first.execute("execute_command", { command: "first" }, new AbortController().signal)
		await second.execute("execute_command", { command: "second" }, new AbortController().signal)
		firstController.abort()
		expect(signals.get("first")?.aborted).to.equal(true)
		expect(signals.get("second")?.aborted).to.equal(false)
		sinon.assert.notCalled(cancelAll)
		first.dispose?.()
		second.dispose?.()
	})

	it("settles unresolved commands immediately when onStateChange reports terminal status", async () => {
		let capturedOnStateChange: ((state: any) => void) | undefined
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: {
				executeCommandTool: async (_cmd: string, _timeout: unknown, options: any) => {
					capturedOnStateChange = options?.onStateChange
					return [false, "started", { status: "running", executionId: "async-cmd-1" }]
				},
				getExecutionState: () => ({
					commands: { active: [], recent: [] },
					actions: { active: [], recent: [] },
					coverage: { commands: "available" },
				}),
			},
		} as unknown as TaskConfig
		const original = ToolExecutorCoordinator.prototype.execute
		ToolExecutorCoordinator.prototype.execute = async (config) => {
			await config.callbacks.executeCommandTool("async-job", 1, { onStateChange: sinon.stub() })
			return "started"
		}
		try {
			const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
			await adapter.execute("execute_command", { command: "async-job" }, new AbortController().signal)
			expect(adapter.getPendingWork?.()).to.include("async-cmd-1")
			capturedOnStateChange?.({ executionId: "async-cmd-1", status: "completed" })
			expect(adapter.getPendingWork?.()).to.equal(undefined)
		} finally {
			ToolExecutorCoordinator.prototype.execute = original
		}
	})

	it("retains expired or untracked commands as unresolved when observation fails", async () => {
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: {
				executeCommandTool: async () => [false, "ok", { status: "running", executionId: "expired-cmd" }],
				getExecutionState: (id?: string) => {
					if (id === "expired-cmd") throw new Error("Execution ID is not tracked by this task or has expired")
					return {
						commands: { active: [], recent: [] },
						actions: { active: [], recent: [] },
						coverage: { commands: "available" },
					}
				},
			},
		} as unknown as TaskConfig
		const original = ToolExecutorCoordinator.prototype.execute
		ToolExecutorCoordinator.prototype.execute = async (config) => {
			await config.callbacks.executeCommandTool("task", 1)
			return "done"
		}
		try {
			const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
			await adapter.execute("execute_command", { command: "task" }, new AbortController().signal)
			expect(adapter.getPendingWork?.()).to.include("expired-cmd")
		} finally {
			ToolExecutorCoordinator.prototype.execute = original
		}
	})

	it("requires terminal evidence rather than an action-only completion for a command", async () => {
		let currentStatus = "running"
		let commandStatus = "running"
		let commandId: string | undefined
		let observation: "nested-action" | "direct-action" | "command" = "nested-action"
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: {
				executeCommandTool: async () => [false, "ok", { status: "running", executionId: "nested-cmd" }],
				getExecutionState: (id?: string) => {
					if (id === "nested-cmd") {
						if (observation === "direct-action") return { kind: "command", status: currentStatus }
						return {
							action: { status: currentStatus },
							command: observation === "command" ? { status: commandStatus, execution_id: commandId } : undefined,
						}
					}
					return {
						commands: { active: [], recent: [] },
						actions: { active: [], recent: [] },
						coverage: { commands: "available" },
					}
				},
			},
		} as unknown as TaskConfig
		const original = ToolExecutorCoordinator.prototype.execute
		ToolExecutorCoordinator.prototype.execute = async (config) => {
			await config.callbacks.executeCommandTool("nested-task", 1)
			return "done"
		}
		try {
			const adapter = createLegionToolAdapter(base, {} as ApiHandler, [])
			await adapter.execute("execute_command", { command: "nested-task" }, new AbortController().signal)
			expect(adapter.getPendingWork?.()).to.include("nested-cmd")
			currentStatus = "completed"
			expect(adapter.getPendingWork?.()).to.include("nested-cmd")
			observation = "direct-action"
			expect(adapter.getPendingWork?.()).to.include("nested-cmd")
			observation = "command"
			expect(adapter.getPendingWork?.()).to.include("nested-cmd")
			commandStatus = "completed"
			expect(adapter.getPendingWork?.()).to.include("nested-cmd")
			commandId = "nested-cmd"
			expect(adapter.getPendingWork?.()).to.equal(undefined)
		} finally {
			ToolExecutorCoordinator.prototype.execute = original
		}
	})
})
