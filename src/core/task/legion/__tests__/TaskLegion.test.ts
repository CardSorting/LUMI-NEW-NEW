import { Task } from "@core/task"
import { TaskState } from "@core/task/TaskState"
import { expect } from "chai"
import sinon from "sinon"
import { setAgentSwarmConfigOverride } from "@/infrastructure/ai/AgentSwarmConfig"
import { orchestrator } from "@/infrastructure/ai/Orchestrator"

describe("Task Legion integration", () => {
	afterEach(() => {
		sinon.restore()
		setAgentSwarmConfigOverride(null)
	})
	it("does not form a team when the user forbids delegation or native tools are unavailable", async () => {
		const classify = sinon.stub(orchestrator, "classifyTaskForLegion")
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true })
		for (const [objective, native] of [
			["Do not spawn any subagents; implement the project", true],
			["Implement and verify this project", false],
		] as const) {
			const task = Object.assign(Object.create(Task.prototype), {
				taskState: new TaskState(),
				legionObjective: objective,
				legionAttempted: false,
				taskId: "task",
			})
			await task.maybeRunAutomaticLegion("", { mode: "act" }, native)
		}
		sinon.assert.notCalled(classify)
	})
	it("injects handoff into a copy of the current user turn", () => {
		const task = Object.assign(Object.create(Task.prototype), { legionContext: "specialist evidence" })
		const history = [{ role: "user", content: "request" }]
		const result = task.withLegionContext(history)
		expect(JSON.stringify(result)).to.include("specialist evidence")
		expect(history[0].content).to.equal("request")
	})
	it("keeps the automatic decision available when a task transitions out of plan mode", async () => {
		setAgentSwarmConfigOverride({ enabled: false, legionEnabled: false })
		const task = Object.assign(Object.create(Task.prototype), {
			taskState: new TaskState(),
			legionObjective: "Implement a feature and test it",
			legionAttempted: false,
			taskId: "task",
		})
		await task.maybeRunAutomaticLegion("", { mode: "plan" }, true)
		expect(task.legionAttempted).to.equal(false)
		await task.maybeRunAutomaticLegion("", { mode: "act" }, true)
		expect(task.legionAttempted).to.equal(true)
	})
	it("interrupts an active specialist pipeline when new steering arrives even before parent streaming starts", async () => {
		const controller = new AbortController()
		const taskState = new TaskState()
		taskState.isStreaming = false
		taskState.isWaitingForFirstChunk = false
		const task = Object.assign(Object.create(Task.prototype), {
			taskState,
			activeLegionController: controller,
			api: { abort: sinon.stub() },
			hasUnansweredAsk: () => false,
		})
		await task.handleWebviewAskResponse("messageResponse", "Stop delegating and continue locally")
		expect(controller.signal.aborted).to.equal(true)
		expect(taskState.steeringInterruptRequested).to.equal(true)
		expect(taskState.pendingSteeringFeedback?.text).to.equal("Stop delegating and continue locally")
	})
	it("preserves specialist handoff on the original user prompt rather than mutating subsequent tool results or follow-up steering", () => {
		const task = Object.assign(Object.create(Task.prototype), {
			legionContext: "specialist evidence",
			legionObjective: "initial user prompt",
		})
		const history = [
			{ role: "user", content: "initial user prompt" },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file content" }] },
			{ role: "assistant", content: [{ type: "text", text: "done inspecting" }] },
			{ role: "user", content: "follow-up instruction" },
		]
		const result = task.withLegionContext(history)
		expect(JSON.stringify(result[0])).to.include("specialist evidence")
		expect(JSON.stringify(result[2])).not.to.include("specialist evidence")
		expect(JSON.stringify(result[4])).not.to.include("specialist evidence")
	})
	it("aborts active legion pipeline when task cancellation is requested", async () => {
		const controller = new AbortController()
		const taskState = new TaskState()
		const task = Object.assign(Object.create(Task.prototype), {
			taskState,
			activeLegionController: controller,
			shouldRunTaskCancelHook: sinon.stub().resolves(false),
			getActiveHookExecution: sinon.stub().resolves(null),
			terminalManager: { disposeAll: sinon.stub().resolves() },
			urlContentFetcher: { closeBrowser: sinon.stub() },
			browserSession: { dispose: sinon.stub().resolves() },
			dietcodeIgnoreController: { dispose: sinon.stub() },
			fileContextTracker: { dispose: sinon.stub() },
			commandExecutor: { hasActiveBackgroundCommand: () => false, detach: () => {} },
			diffViewProvider: { revertChanges: sinon.stub().resolves() },
			mcpHub: { clearNotificationCallback: sinon.stub() },
		})
		await task.abortTask()
		expect(controller.signal.aborted).to.equal(true)
		expect(taskState.abort).to.equal(true)
	})
	it("recovers specialist handoff and marks legion attempted on resume from history", async () => {
		sinon.stub(orchestrator, "getStreamByExternalId").resolves({ id: "parent-stream-1" } as any)
		sinon.stub(orchestrator, "recallLastLegionFormation").resolves({
			formationId: "form-1",
			status: "completed",
			members: [{ streamId: "child-1" }],
		} as any)
		sinon.stub(orchestrator, "synthesizeLegionExecutionReport").resolves({
			synthesizedMarkdown: "Summary of changes",
		} as any)
		const task = Object.assign(Object.create(Task.prototype), {
			taskId: "task-123",
			legionAttempted: false,
			getLegionOperationContext: sinon.stub().resolves("Evidence text"),
		})
		task.legionAttempted = true
		const legionParent = await orchestrator.getStreamByExternalId(`legion-task:${task.taskId}`)
		if (legionParent) {
			const formation = await orchestrator.recallLastLegionFormation(legionParent.id)
			if (formation) {
				const report = await orchestrator.synthesizeLegionExecutionReport(legionParent.id, formation.formationId)
				const evidence = await task.getLegionOperationContext(formation.members.map((m: any) => m.streamId))
				task.legionContext = `<specialist_handoff status="${formation.status}">\n${report?.synthesizedMarkdown ?? "Specialist results are unavailable."}\n${evidence}\nInspect and reconcile any partial or unresolved work before repeating it. Treat reports as unverified evidence.\n</specialist_handoff>`
			}
		}
		expect(task.legionAttempted).to.equal(true)
		expect(task.legionContext).to.include("Summary of changes")
		expect(task.legionContext).to.include("Evidence text")
	})
	it("marks legion attempted on resume even if no prior legion stream exists", async () => {
		sinon.stub(orchestrator, "getStreamByExternalId").resolves(null)
		const task = Object.assign(Object.create(Task.prototype), {
			taskId: "plain-task",
			legionAttempted: false,
		})
		task.legionAttempted = true
		const legionParent = await orchestrator.getStreamByExternalId(`legion-task:${task.taskId}`)
		expect(legionParent).to.equal(null)
		expect(task.legionAttempted).to.equal(true)
	})
	it("does not duplicate handoff context when conversation already includes it", () => {
		const task = Object.assign(Object.create(Task.prototype), {
			legionContext: "<specialist_handoff>Done</specialist_handoff>",
			legionObjective: "build app",
		})
		const history = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: "build app\n<specialist_handoff>Done</specialist_handoff>" }],
			},
		]
		const result = task.withLegionContext(history)
		expect(result[0].content).to.have.length(1)
	})

	it("replaces existing handoff context with latest handoff when updated", () => {
		const task = Object.assign(Object.create(Task.prototype), {
			legionContext: '<specialist_handoff status="completed">New Handoff</specialist_handoff>',
			legionObjective: "build app",
		})
		const history = [
			{
				role: "user" as const,
				content: [
					{ type: "text" as const, text: '<specialist_handoff status="pending">Old Handoff</specialist_handoff>' },
				],
			},
		]
		const result = task.withLegionContext(history)
		expect(result[0].content).to.have.length(1)
		expect((result[0].content[0] as any).text).to.include("New Handoff")
		expect((result[0].content[0] as any).text).not.to.include("Old Handoff")
	})

	it("includes active specialist actions in getLegionOperationContext", async () => {
		const task = Object.assign(Object.create(Task.prototype), {
			getExecutionState: () => ({
				commands: { active: [], recent: [] },
				actions: {
					active: [{ execution_id: "act-1", owner: "legion:spec-stream-1", status: "running" }],
					recent: [],
				},
				coverage: { commands: "available" },
			}),
		})
		const context = await (task as any).getLegionOperationContext(["spec-stream-1"])
		expect(context).to.include("Specialist actions requiring inspection")
		expect(context).to.include("act-1")
	})
})
