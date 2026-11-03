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
import * as pathUtils from "@/utils/path"
import { createLegionToolAdapter } from "../LegionToolAdapter"

describe("LegionToolAdapter", () => {
	afterEach(() => sinon.restore())
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
				getExecutionState: (id?: string) =>
					id
						? { status: active ? "background" : observedStatus, execution_id: id }
						: {
								commands: { active: active ? [{ owner, execution_id: "command-1" }] : [], recent: [] },
								actions: { active: [], recent: [] },
								coverage: { commands: "available" },
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

	it("cleans up uncertain commands if executeCommandTool throws during launch", async () => {
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
			observedStatus = "completed"
			expect(adapter.getPendingWork?.()).to.equal(undefined)
		} finally {
			ToolExecutorCoordinator.prototype.execute = original
		}
	})

	it("dispatches cancellation to cancelRunningCommandTool on parentSignal or dispose", async () => {
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
		sinon.assert.calledOnce(cancelRunningCommandTool)
		adapter.dispose?.()
		sinon.assert.calledTwice(cancelRunningCommandTool)
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

	it("prunes expired or untracked commands when getExecutionState throws", async () => {
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
			expect(adapter.getPendingWork?.()).to.equal(undefined)
		} finally {
			ToolExecutorCoordinator.prototype.execute = original
		}
	})

	it("settles unresolved commands when getExecutionState returns nested action or command status", async () => {
		let currentStatus = "running"
		const base = {
			cwd: process.cwd(),
			taskState: new TaskState(),
			services: { dietcodeIgnoreController: { validateAccess: () => true } },
			callbacks: {
				executeCommandTool: async () => [false, "ok", { status: "running", executionId: "nested-cmd" }],
				getExecutionState: (id?: string) => {
					if (id === "nested-cmd") {
						return { action: { status: currentStatus }, command: undefined }
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
			expect(adapter.getPendingWork?.()).to.equal(undefined)
		} finally {
			ToolExecutorCoordinator.prototype.execute = original
		}
	})
})
