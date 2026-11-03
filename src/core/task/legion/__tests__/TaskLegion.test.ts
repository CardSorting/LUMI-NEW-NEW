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

	it("allows test project objectives and tactical strikes to trigger legion even with low complexity", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true, legionStrategy: "adaptive" })
		const classify = sinon.stub(orchestrator, "classifyTaskForLegion").returns({
			appliedStrategy: "tactical_strike",
			recommendedStrategy: "tactical_strike",
			complexityScore: 2.1,
			formationRoster: [
				{
					assignmentId: "assign-1",
					role: "legion_verifier",
					title: "Verification Specialist",
					codename: "VERIFIER",
					subagentType: "verifier" as any,
					confidence: 0.9,
					score: 0.9,
					rationale: "Verify code",
					focusObjective: "Run test project",
					assignedFiles: [],
					executionOrder: "parallel",
					recommendedDeferBoundary: "safe_boundary",
				},
			],
			primaryIntent: "TEST" as any,
		} as any)
		const task = Object.assign(Object.create(Task.prototype), {
			taskState: new TaskState(),
			legionObjective: "run test project",
			legionAttempted: false,
			taskId: "task-test-proj",
		})
		// With low complexity (2.1) and roster length 1, a generic objective would return early,
		// but "run test project" is recognized as an explicit test/swarm objective.
		await task.maybeRunAutomaticLegion("", { mode: "act" }, true)
		sinon.assert.calledOnce(classify)
		expect(task.legionAttempted).to.equal(true)
	})

	it("falls back to user prompt in conversation history when legionObjective is undefined", async () => {
		setAgentSwarmConfigOverride({ enabled: true, legionEnabled: true, legionStrategy: "adaptive" })
		const classify = sinon.stub(orchestrator, "classifyTaskForLegion").returns({
			appliedStrategy: "tactical_strike",
			recommendedStrategy: "tactical_strike",
			complexityScore: 4.0,
			formationRoster: [
				{
					assignmentId: "assign-1",
					role: "legion_implementer",
					title: "Implementer",
					codename: "DEV",
					subagentType: "implementer" as any,
					confidence: 0.9,
					score: 0.9,
					rationale: "Implement feature",
					focusObjective: "Run test suite",
					assignedFiles: [],
					executionOrder: "parallel",
					recommendedDeferBoundary: "safe_boundary",
				},
			],
			primaryIntent: "FEATURE" as any,
		} as any)
		const task = Object.assign(Object.create(Task.prototype), {
			taskState: new TaskState(),
			legionObjective: undefined,
			legionAttempted: false,
			taskId: "task-history-fallback",
			messageStateHandler: {
				getApiConversationHistory: () => [
					{
						role: "user",
						content: "Execute test project suite and verify output",
					},
				],
			},
		})
		await task.maybeRunAutomaticLegion("", { mode: "act" }, true)
		sinon.assert.calledOnce(classify)
		expect(task.legionAttempted).to.equal(true)
	})

	it("formats multi-agent progress cards with readable stages and specialist badges", async () => {
		const { formatLegionProgressMessage } = await import("@/infrastructure/ai/LegionPipelineRunner")
		const stageMsg = formatLegionProgressMessage({
			stage: "leadAndRecon",
			status: "stage_started",
		})
		expect(stageMsg).to.include("Stage 1: Lead & Reconnaissance")
		expect(stageMsg).to.include("The Legion")

		const memberStartMsg = formatLegionProgressMessage({
			stage: "parallelExecution",
			status: "member_started",
			member: {
				streamId: "stream-test-1",
				assignment: {
					role: "legion_implementer",
					codename: "DEV-ONE",
					title: "Implementer",
					focusObjective: "Implement reactive feature component",
				},
			} as any,
		})
		expect(memberStartMsg).to.include("DEV-ONE")
		expect(memberStartMsg).to.include("Implementer (Feature Implementation)")
		expect(memberStartMsg).to.include("Implement reactive feature component")

		const completedMsg = formatLegionProgressMessage({
			stage: "verificationAndHardening",
			status: "member_completed",
			member: {
				streamId: "stream-test-2",
				assignment: { role: "legion_verifier", codename: "ADA" },
			} as any,
		})
		expect(completedMsg).to.include("Specialist Complete")
		expect(completedMsg).to.include("ADA")

		const failoverMsg = formatLegionProgressMessage({
			stage: "parallelExecution",
			status: "member_rerouted",
			member: {
				streamId: "stream-test-3",
				assignment: { role: "legion_hardener", codename: "AEGIS" },
			} as any,
		})
		expect(failoverMsg).to.include("Specialist Failover")
		expect(failoverMsg).to.include("AEGIS")

		const finishedMsg = formatLegionProgressMessage({
			stage: "synthesis",
			status: "formation_completed",
		})
		expect(finishedMsg).to.include("Mission Accomplished")
	})

	it("resets legionAttempted when user confirms resume without new text", async () => {
		const task = Object.assign(Object.create(Task.prototype), {
			taskState: new TaskState(),
			legionAttempted: true,
			legionObjective: "Existing test task",
		})
		await task.handleWebviewAskResponse("yesButtonClicked")
		expect(task.legionAttempted).to.equal(false)
	})

	it("allows tactical strike specialist execution when complexity is below 3.2", async () => {
		setAgentSwarmConfigOverride({ legionEnabled: true, enabled: false, legionStrategy: "adaptive" })
		const classify = sinon.stub(orchestrator, "classifyTaskForLegion").returns({
			complexityScore: 2.4,
			appliedStrategy: "tactical_strike",
			formationRoster: [
				{
					role: "legion_implementer",
					title: "Tactical Specialist",
					codename: "TACTICAL",
					subagentType: "worker",
					assignedFiles: ["src/index.ts"],
					focusObjective: "Quick targeted patch",
					executionOrder: "parallel",
					recommendedDeferBoundary: "safe_boundary",
				},
			],
			primaryIntent: "FEATURE" as any,
		} as any)
		const task = Object.assign(Object.create(Task.prototype), {
			taskState: new TaskState(),
			legionObjective: "Quick targeted patch",
			legionAttempted: false,
			taskId: "task-tactical",
			messageStateHandler: {
				getApiConversationHistory: () => [],
				getDietCodeMessages: () => [],
			},
			toolExecutor: {
				asToolConfig: sinon.stub().resolves({}),
			},
		})
		await task.maybeRunAutomaticLegion("", { mode: "act" }, true)
		sinon.assert.calledOnce(classify)
		expect(task.legionAttempted).to.equal(true)
	})

	it("safely handles absent messageStateHandler in hasUnansweredAsk without throwing", () => {
		const task = Object.assign(Object.create(Task.prototype), {
			messageStateHandler: undefined,
		})
		expect((task as any).hasUnansweredAsk()).to.equal(false)
	})

	it("auto-approves engage_swarm tool via AutoApprove shouldAutoApproveToolWithPath", async () => {
		const { AutoApprove } = await import("@/core/task/tools/autoApprove")
		const { DietCodeDefaultTool } = await import("@shared/tools")
		const mockStateManager = {
			getTrustedTools: () => [],
			getGlobalSettingsKey: () => false,
			getTrustedCommands: () => [],
			getTrustedMcpServers: () => [],
		}
		const autoApprove = new AutoApprove(mockStateManager as any)
		const approved = await autoApprove.shouldAutoApproveToolWithPath(DietCodeDefaultTool.ENGAGE_SWARM, undefined)
		expect(approved).to.equal(true)
	})

	it("bypasses automatic legion formation when task complexity is below 3.2 and not explicit or tactical", async () => {
		setAgentSwarmConfigOverride({ legionEnabled: true, enabled: false, legionStrategy: "adaptive" })
		const classify = sinon.stub(orchestrator, "classifyTaskForLegion").returns({
			complexityScore: 2.1,
			appliedStrategy: "balanced_squad",
			formationRoster: [
				{
					role: "legion_implementer",
					title: "Implementer",
					codename: "DEV",
					subagentType: "worker",
					assignedFiles: [],
					focusObjective: "Simple question",
					executionOrder: "parallel",
					recommendedDeferBoundary: "safe_boundary",
				},
			],
			primaryIntent: "GENERAL" as any,
		} as any)
		const task = Object.assign(Object.create(Task.prototype), {
			taskState: new TaskState(),
			legionObjective: "How do I print a hello world in python?",
			legionAttempted: false,
			taskId: "task-simple",
			messageStateHandler: {
				getApiConversationHistory: () => [],
				getDietCodeMessages: () => [],
			},
			toolExecutor: {
				asToolConfig: sinon.stub().resolves({}),
			},
		})
		await task.maybeRunAutomaticLegion("", { mode: "act" }, true)
		sinon.assert.calledOnce(classify)
		// Should not form a team and should not set legionContext
		expect(task.legionContext).to.equal(undefined)
	})
})
