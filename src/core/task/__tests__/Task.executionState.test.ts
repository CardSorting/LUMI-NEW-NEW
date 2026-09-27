import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import { describe, it } from "mocha"
import type { StateManager } from "../../storage/StateManager"
import { executor } from "../ActionExecutor"
import { type ExecutionState, formatExecutionState, getExecutionAuthority } from "../ExecutionState"
import { Task } from "../index"

describe("shared task execution state", () => {
	it("shows linked commands once and limits action lookup to its owning task", () => {
		const ulid = randomUUID()
		const command = executor.executions.claim(ulid, { kind: "command", input: "build", label: "build", owner: "helper:one" })
		const resource = executor.executions.claim(ulid, { kind: "mcp_resource", input: "docs", label: "docs" })
		try {
			const commands = {
				active: [
					{
						execution_id: "command-id",
						action_id: command.snapshot.execution_id,
						owner: "helper:one",
						terminal_id: 1,
						command: "build",
						cwd: "/workspace",
						status: "running",
						output_preview: "building",
					},
				],
				recent: [],
			}
			const task = Object.assign(Object.create(Task.prototype), {
				ulid,
				commandExecutor: {
					getExecutionInventory: () => commands,
					getExecutionSummary: (id: string) =>
						commands.active.find((command) => command.execution_id === id || command.action_id === id),
				},
			}) as Task
			const state = task.getExecutionState() as ExecutionState
			assert.deepEqual(state.commands, commands)
			assert.deepEqual(
				state.actions.active.map((action) => action.execution_id),
				[resource.snapshot.execution_id],
			)
			executor.executions.finish(command, "completed", "Foreground wait ended")
			const linked = task.getExecutionState(command.snapshot.execution_id)
			assert.ok("action" in linked)
			assert.equal(linked.action.owner, "helper:one")
			assert.equal(linked.action.status, "completed")
			assert.equal(linked.command.status, "running")
			assert.equal(linked.command.execution_id, "command-id")
			assert.match(linked.detail, /does not prove command completion/)
			const foreign = Object.assign(Object.create(Task.prototype), { ulid: randomUUID() }) as Task
			assert.throws(() => foreign.getExecutionState(resource.snapshot.execution_id), /not tracked/)
			assert.deepEqual(task.getExecutionState("command-id"), commands.active[0])
			assert.equal(state.coverage?.commands, "available")
			assert.equal(state.coverage?.scope, "task_in_current_extension_host")
			executor.executions.finish(resource, "completed", "Read once")
			assert.equal((task.getExecutionState() as ExecutionState).actions.recent[0].result_preview, "Read once")
		} finally {
			executor.executions.finish(command, "completed", "done")
			executor.executions.finish(resource, "completed", "done")
		}
	})
	it("distinguishes unavailable command observation from an empty healthy inventory", () => {
		const task = Object.assign(Object.create(Task.prototype), {
			ulid: randomUUID(),
			commandExecutor: {
				getExecutionInventory() {
					throw new Error("terminal disconnected")
				},
			},
		}) as Task
		const state = task.getExecutionState() as ExecutionState
		assert.equal(state.coverage?.commands, "unavailable")
		assert.deepEqual(state.commands.active, [])
		assert.deepEqual(state.queues, [])
	})
	it("keeps action inspection available when terminal observation fails", () => {
		const ulid = randomUUID()
		const resource = executor.executions.claim(ulid, { kind: "mcp_resource", input: "docs", label: "docs" })
		try {
			const task = Object.assign(Object.create(Task.prototype), {
				ulid,
				commandExecutor: {
					getExecutionSummary() {
						throw new Error("terminal disconnected")
					},
				},
			}) as Task
			assert.deepEqual(task.getExecutionState(resource.snapshot.execution_id), resource.snapshot)
		} finally {
			executor.executions.finish(resource, "completed", "done")
		}
	})
	it("retains command lookup when the separate foreground receipt has expired", () => {
		const snapshot = { execution_id: "command-id", action_id: "old-action", status: "background" }
		const task = Object.assign(Object.create(Task.prototype), {
			ulid: randomUUID(),
			commandExecutor: {
				getExecutionSummary: (id: string) => (id === "old-action" || id === "command-id" ? snapshot : undefined),
			},
		}) as Task
		assert.deepEqual(task.getExecutionState("old-action"), snapshot)
		assert.deepEqual(task.getExecutionState("command-id"), snapshot)
		assert.throws(() => task.getExecutionState("foreign-id"), /not tracked/)
	})
	it("keeps failed command admission visible when no terminal was created", () => {
		const ulid = randomUUID()
		const command = executor.executions.claim(ulid, { kind: "command", input: "build", label: "build" })
		executor.executions.finish(command, "not_started", "Execution queue expired before dispatch")
		const task = Object.assign(Object.create(Task.prototype), {
			ulid,
			commandExecutor: { getExecutionInventory: () => ({ active: [], recent: [] }) },
		}) as Task
		const state = task.getExecutionState() as ExecutionState
		assert.equal(state.actions.recent[0].execution_id, command.snapshot.execution_id)
		assert.equal(state.actions.recent[0].status, "not_started")
		assert.match(state.actions.recent[0].result_preview!, /queue expired/)
	})
	it("preserves foreground evidence during a terminal outage without declaring a command expired", () => {
		const ulid = randomUUID()
		const command = executor.executions.claim(ulid, { kind: "command", input: "build", label: "build" })
		executor.executions.finish(command, "completed", "Foreground wait ended; command is running")
		const task = Object.assign(Object.create(Task.prototype), {
			ulid,
			commandExecutor: {
				getExecutionSummary() {
					throw new Error("host offline")
				},
				getExecutionInventory() {
					throw new Error("host offline")
				},
			},
		}) as Task
		const result = task.getExecutionState(command.snapshot.execution_id)
		assert.ok("execution_id" in result)
		assert.match(result.detail!, /last recorded observation/)
		assert.match(result.detail!, /unavailable/)
		assert.equal((task.getExecutionState() as ExecutionState).actions.recent[0].execution_id, command.snapshot.execution_id)
		assert.throws(() => task.getExecutionState("native-command-id"), /observation is unavailable/)
	})
	it("reports current approval settings without mutating them or pretending unavailable settings are grants", () => {
		const actions = { readFiles: true, editFiles: false, executeAllCommands: false }
		let automatic = false
		const state = {
			getGlobalSettingsKey: (key: string) => {
				const settings: Record<string, unknown> = {
					mode: "act",
					autoApprovalSettings: { actions },
					yoloModeToggled: automatic,
				}
				return settings[key]
			},
			getTrustedCommands: () => ["npm test"],
			getTrustedMcpServers: () => Array.from({ length: 14 }, (_, i) => `server-${i}`),
		} as unknown as StateManager
		const first = getExecutionAuthority(state)!
		assert.equal(first.automatic_approval, false)
		assert.deepEqual(first.auto_approved_actions, actions)
		assert.equal(first.trusted_command_count, 1)
		assert.equal(first.trusted_mcp_servers.length, 12)
		assert.equal(first.omitted_trusted_mcp_servers, 2)
		first.auto_approved_actions.editFiles = true
		assert.equal(actions.editFiles, false)
		automatic = true
		assert.equal(getExecutionAuthority(state)?.automatic_approval, true)
		assert.equal(getExecutionAuthority(undefined), undefined)
	})
	it("bounds automatic action context and explicitly reports omitted active work", () => {
		const action = {
			execution_id: "id",
			kind: "helper" as const,
			label: "work",
			owner: "helper:one",
			status: "queued" as const,
		}
		const state: ExecutionState = {
			commands: { active: [], recent: [] },
			actions: { active: Array.from({ length: 30 }, (_, i) => ({ ...action, execution_id: `id-${i}` })), recent: [] },
		}
		const context = formatExecutionState(state)
		assert.ok(context.includes('"active_actions":6'))
		assert.ok(context.includes("get_execution_state"))
		assert.ok(!context.includes('"id-24"'))
		assert.equal(state.actions.active.length, 30)
		assert.equal(formatExecutionState(state), context)
	})
})
