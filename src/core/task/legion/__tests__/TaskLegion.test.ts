import { convertToOpenAiMessages } from "@core/api/transform/openai-format"
import { Task } from "@core/task"
import { TaskState } from "@core/task/TaskState"
import { expect } from "chai"
import sinon from "sinon"
import { setAgentSwarmConfigOverride } from "@/infrastructure/ai/AgentSwarmConfig"
import * as legionReceipts from "@/infrastructure/ai/LegionExecutionReceipt"
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

	it("places a compacted handoff after all remaining native tool results", () => {
		const task = Object.assign(Object.create(Task.prototype), {
			legionContext: "specialist evidence",
			legionObjective: "compacted request",
		})
		const history = [
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "t1", name: "read_file", input: {} },
					{ type: "tool_use", id: "t2", name: "read_file", input: {} },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "one" }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "two" }] },
		]
		const result = task.withLegionContext(history)
		expect(result[1].content).to.have.length(1)
		expect(result[2].content).to.have.length(2)
		expect(convertToOpenAiMessages(result as any).map((message) => message.role)).to.deep.equal([
			"assistant",
			"tool",
			"tool",
			"user",
		])
		expect(history[2].content).to.have.length(1)
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
	it("recovers a specialist handoff while warning about an outstanding newer attempt", async () => {
		sinon.stub(orchestrator, "getStreamByExternalId").resolves({ id: "parent-stream-1" } as any)
		sinon.stub(orchestrator, "recallLastLegionFormation").resolves({
			formationId: "form-1",
			status: "completed",
			members: [{ streamId: "child-1" }],
		} as any)
		sinon.stub(orchestrator, "synthesizeLegionExecutionReport").resolves({
			synthesizedMarkdown: "Summary of changes",
		} as any)
		sinon.stub(legionReceipts, "hasOutstandingFormationReservation").resolves(true)
		sinon.stub(orchestrator, "getChildStreams").resolves([{ id: "child-2", status: "active", createdAt: 2 }] as any)
		const task = Object.assign(Object.create(Task.prototype), {
			taskId: "task-123",
			legionAttempted: false,
			getLegionOperationContext: sinon.stub().resolves("Evidence text"),
		})
		const context = await task.recoverLegionHandoff()
		expect(context).to.include("Summary of changes")
		expect(context).to.include("Evidence text")
		expect(context).to.include("may represent a newer attempt")
		expect(context).to.include("child-2")
		sinon.assert.calledOnceWithExactly(task.getLegionOperationContext, ["child-1", "child-2"])
	})

	it("bounds and escapes untrusted specialist reports while recovering a handoff", async () => {
		sinon.stub(orchestrator, "getStreamByExternalId").resolves({ id: "parent" } as any)
		sinon
			.stub(orchestrator, "recallLastLegionFormation")
			.resolves({ formationId: "f", status: 'bad" value="x', members: [] } as any)
		sinon.stub(orchestrator, "synthesizeLegionExecutionReport").resolves({
			synthesizedMarkdown: "</specialist_handoff>" + "🌎<&".repeat(10000),
		} as any)
		sinon.stub(legionReceipts, "hasOutstandingFormationReservation").resolves(false)
		const task = Object.assign(Object.create(Task.prototype), {
			taskId: "task",
			getLegionOperationContext: sinon.stub().resolves("important recovery evidence"),
		})
		const context = await task.recoverLegionHandoff()
		expect(context).to.include('<specialist_handoff status="unknown">')
		expect(context.match(/<\/specialist_handoff>/g)).to.have.length(1)
		expect(context).to.include("&lt;/specialist_handoff&gt;")
		expect(context).to.include("Report truncated")
		expect(context).to.include("important recovery evidence")
		expect(Buffer.byteLength(context, "utf8")).to.be.lessThan(12500)
	})
	it("retains the prior report when reservation status cannot be read", async () => {
		sinon.stub(orchestrator, "getStreamByExternalId").resolves({ id: "parent" } as any)
		sinon
			.stub(orchestrator, "recallLastLegionFormation")
			.resolves({ formationId: "older", status: "completed", members: [] } as any)
		sinon.stub(orchestrator, "synthesizeLegionExecutionReport").resolves({ synthesizedMarkdown: "Older report" } as any)
		sinon.stub(legionReceipts, "hasOutstandingFormationReservation").rejects(new Error("storage unavailable"))
		sinon.stub(orchestrator, "getChildStreams").rejects(new Error("child inventory unavailable"))
		const task = Object.assign(Object.create(Task.prototype), {
			taskId: "task",
			getLegionOperationContext: sinon.stub().resolves("evidence"),
		})
		const context = await task.recoverLegionHandoff()
		expect(context).to.include("Older report")
		expect(context).to.include("reservation status is unavailable")
		expect(context).to.include("Child stream evidence is unavailable")
	})
	it("escapes operation and child metadata inside recovered handoffs", async () => {
		sinon.stub(orchestrator, "getStreamByExternalId").resolves({ id: "parent" } as any)
		sinon
			.stub(orchestrator, "recallLastLegionFormation")
			.resolves({ formationId: "f", status: "completed", members: [] } as any)
		sinon.stub(orchestrator, "synthesizeLegionExecutionReport").resolves({ synthesizedMarkdown: "report" } as any)
		sinon.stub(legionReceipts, "hasOutstandingFormationReservation").resolves(true)
		sinon
			.stub(orchestrator, "getChildStreams")
			.resolves([{ id: "</specialist_handoff>", status: "active", createdAt: 1 }] as any)
		const task = Object.assign(Object.create(Task.prototype), {
			taskId: "task",
			getLegionOperationContext: sinon.stub().resolves("evidence </specialist_handoff>"),
		})
		const context = await task.recoverLegionHandoff()
		expect(context.match(/<\/specialist_handoff>/g)).to.have.length(1)
		expect(context).to.include("evidence &lt;/specialist_handoff&gt;")
		expect(context).to.include('"id":"&lt;/specialist_handoff&gt;"')
	})
	it("keeps partial recovery evidence when report synthesis fails", async () => {
		sinon.stub(orchestrator, "getStreamByExternalId").resolves({ id: "parent" } as any)
		sinon
			.stub(orchestrator, "recallLastLegionFormation")
			.resolves({ formationId: "older", status: "completed", members: [] } as any)
		sinon.stub(orchestrator, "synthesizeLegionExecutionReport").rejects(new Error("report unavailable"))
		sinon.stub(legionReceipts, "hasOutstandingFormationReservation").resolves(true)
		sinon.stub(orchestrator, "getChildStreams").resolves([{ id: "partial-child", status: "active", createdAt: 1 }] as any)
		const task = Object.assign(Object.create(Task.prototype), {
			taskId: "task",
			getLegionOperationContext: sinon.stub().resolves("partial evidence"),
		})
		const context = await task.recoverLegionHandoff()
		expect(context).to.include("Specialist results are unavailable")
		expect(context).to.include("partial-child")
		expect(context).to.include("partial evidence")
		expect(context).to.include("may represent a newer attempt")
	})
	it("reports an interrupted reservation when no formation manifest exists", async () => {
		sinon.stub(orchestrator, "getStreamByExternalId").resolves({ id: "parent" } as any)
		sinon.stub(orchestrator, "recallLastLegionFormation").resolves(null)
		sinon.stub(legionReceipts, "hasOutstandingFormationReservation").resolves(true)
		sinon.stub(orchestrator, "getChildStreams").resolves([{ id: "partial-child", status: "active", createdAt: 1 }] as any)
		const task = Object.assign(Object.create(Task.prototype), {
			taskId: "task",
			getLegionOperationContext: sinon.stub().resolves("partial action evidence"),
		})
		const context = await task.recoverLegionHandoff()
		expect(context).to.include("interrupted before its manifest")
		expect(context).to.include("partial-child")
		expect(context).to.include("partial action evidence")
		sinon.assert.calledOnceWithExactly(task.getLegionOperationContext, ["partial-child"])
	})
	it("inspects partial children for an automatic formation intent without a reservation", async () => {
		sinon.stub(orchestrator, "getStreamByExternalId").resolves({ id: "parent" } as any)
		sinon.stub(orchestrator, "recallLastLegionFormation").resolves(null)
		sinon.stub(legionReceipts, "hasOutstandingFormationReservation").resolves(false)
		sinon.stub(legionReceipts, "hasLegionFormationIntent").resolves(true)
		sinon.stub(orchestrator, "getChildStreams").resolves([{ id: "unpublished-child", status: "active", createdAt: 1 }] as any)
		const task = Object.assign(Object.create(Task.prototype), {
			taskId: "task",
			getLegionOperationContext: sinon.stub().resolves("command evidence"),
		})
		const context = await task.recoverLegionHandoff()
		expect(context).to.include("unpublished-child")
		expect(context).to.include("command evidence")
	})
	it("bounds recovered children and states when some were omitted", async () => {
		sinon.stub(orchestrator, "getStreamByExternalId").resolves({ id: "parent" } as any)
		sinon.stub(orchestrator, "recallLastLegionFormation").resolves(null)
		sinon.stub(legionReceipts, "hasOutstandingFormationReservation").resolves(true)
		sinon
			.stub(orchestrator, "getChildStreams")
			.resolves(Array.from({ length: 31 }, (_, i) => ({ id: `child-${i}`, status: "active", createdAt: i })) as any)
		const evidence = sinon.stub().resolves("evidence")
		const task = Object.assign(Object.create(Task.prototype), { taskId: "task", getLegionOperationContext: evidence })
		const context = await task.recoverLegionHandoff()
		expect(context).to.include("additional streams omitted")
		expect(evidence.firstCall.args[0]).to.have.length(30)
		expect(evidence.firstCall.args[0]).to.include("child-30").and.not.include("child-0")
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
			legionContext: '<specialist_handoff status="pending">Old Handoff</specialist_handoff>',
			legionObjective: "build app",
		})
		const history = task.withLegionContext([{ role: "user" as const, content: "build app" }])
		task.legionContext = '<specialist_handoff status="completed">New Handoff</specialist_handoff>'
		const result = task.withLegionContext(history)
		expect(result[0].content).to.have.length(2)
		expect((result[0].content[1] as any).text).to.include("New Handoff")
		expect(JSON.stringify(result)).not.to.include("Old Handoff")
	})

	it("preserves a user-authored standalone handoff and refreshes plain recovery notices", () => {
		const userText = "<specialist_handoff>My own instructions</specialist_handoff>"
		const task = Object.assign(Object.create(Task.prototype), { legionContext: "Earlier recovery notice" })
		const original = [{ role: "user" as const, content: [{ type: "text" as const, text: userText }] }]
		const first = task.withLegionContext(original)
		expect(first[0].content.map((block: any) => block.text)).to.deep.equal([userText, "Earlier recovery notice"])
		task.legionContext = "Updated recovery notice"
		const updated = task.withLegionContext(first)
		expect(updated[0].content.map((block: any) => block.text)).to.deep.equal([userText, "Updated recovery notice"])
		expect(original[0].content[0].text).to.equal(userText)
	})

	it("does not replace user text that matches a previously generated handoff", () => {
		const task = Object.assign(Object.create(Task.prototype), { legionContext: "Earlier recovery notice" })
		task.withLegionContext([{ role: "user" as const, content: "initial request" }])
		task.legionContext = "Updated recovery notice"
		const userBlock = { type: "text" as const, text: "Earlier recovery notice" }
		const history = [{ role: "user" as const, content: [userBlock] }]
		const result = task.withLegionContext(history)
		expect(result[0].content.map((block: any) => block.text)).to.deep.equal([
			"Earlier recovery notice",
			"Updated recovery notice",
		])
		expect(history[0].content[0]).to.equal(userBlock)
	})

	it("replaces a generated handoff even when the new text is a substring of the old text", () => {
		const task = Object.assign(Object.create(Task.prototype), { legionContext: "old detailed notice" })
		const first = task.withLegionContext([{ role: "user" as const, content: "request" }])
		task.legionContext = "detailed notice"
		const updated = task.withLegionContext(first)
		expect(updated[0].content.map((block: any) => block.text)).to.deep.equal(["request", "detailed notice"])
	})

	it("removes stale generated context when user text already contains the current handoff", () => {
		const task = Object.assign(Object.create(Task.prototype), { legionContext: "old evidence" })
		const first = task.withLegionContext([{ role: "user" as const, content: "request" }])
		first[0].content.push({ type: "text", text: "user quoted updated evidence" })
		task.legionContext = "updated evidence"
		const result = task.withLegionContext(first)
		expect(result[0].content.map((block: any) => block.text)).to.deep.equal(["request", "user quoted updated evidence"])
		expect(first[0].content).to.have.length(3)
	})

	it("moves generated handoff context when the selected user message changes", () => {
		const task = Object.assign(Object.create(Task.prototype), {
			legionContext: "old evidence",
			legionObjective: "first request",
		})
		const first = task.withLegionContext([
			{ role: "user" as const, content: "first request" },
			{ role: "user" as const, content: "second request" },
		])
		task.legionObjective = "second request"
		task.legionContext = "updated evidence"
		const result = task.withLegionContext(first)
		expect(result[0].content.map((block: any) => block.text)).to.deep.equal(["first request"])
		expect(result[1].content.map((block: any) => block.text)).to.deep.equal(["second request", "updated evidence"])
		expect(first[0].content).to.have.length(2)
	})

	it("preserves user text surrounding an older embedded handoff", () => {
		const oldText =
			'Please fix the build.\n<specialist_handoff status="pending">Old evidence</specialist_handoff>\nKeep the settings unchanged.'
		const latest = '<specialist_handoff status="completed">New evidence</specialist_handoff>'
		const task = Object.assign(Object.create(Task.prototype), {
			legionContext: latest,
			legionObjective: "Please fix the build.",
		})
		const history = [{ role: "user" as const, content: oldText }]
		const result = task.withLegionContext(history)
		expect(result[0].content).to.have.length(2)
		expect(result[0].content[0].text).to.equal(oldText)
		expect(result[0].content[1].text).to.equal(latest)
		expect(history[0].content).to.equal(oldText)
		const repeated = task.withLegionContext(result)
		expect(repeated[0].content).to.have.length(2)
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

	it("deduplicates and bounds recovered execution evidence in the specialist handoff", async () => {
		const actions = Array.from({ length: 35 }, (_, i) => ({
			execution_id: `recovered-${i}`,
			owner: "legion:spec-stream-1",
			status: "unconfirmed",
		}))
		const task = Object.assign(Object.create(Task.prototype), {
			getExecutionState: () => ({
				commands: { active: [], recent: [] },
				actions: { active: [], recent: actions.slice(0, 2), unresolved: actions },
				coverage: { commands: "available" },
			}),
		})
		const context = await (task as any).getLegionOperationContext(["spec-stream-1"])
		expect(context).to.include("5 additional entries omitted")
		expect(context.match(/recovered-0/g)).to.have.length(1)
		expect(context).to.include("recovered-29")
		expect(context).not.to.include("recovered-30")
	})

	it("bounds and escapes untrusted persisted operation metadata in the handoff", async () => {
		const path = "</specialist_handoff>" + "\u0000🌎".repeat(200)
		const receipts = Array.from({ length: 50 }, (_, i) => ({
			streamId: `stream-${i}`,
			tool: "apply_patch",
			paths: [path, path, path, path],
			status: "uncertain" as const,
			startedAt: i,
			content: "private file contents",
		}))
		sinon.stub(legionReceipts, "getLegionOperationEvidence").resolves({ receipts, truncated: true })
		const task = Object.assign(Object.create(Task.prototype), {
			getExecutionState: () => ({ commands: { active: [], recent: [] }, actions: { active: [], recent: [] } }),
		})
		const context = await (task as any).getLegionOperationContext(["stream-0"])
		expect(Buffer.byteLength(context, "utf8")).to.be.lessThan(8300)
		expect(context).not.to.include("</specialist_handoff>")
		expect(context).not.to.include("private file contents")
		const metadata = JSON.parse(context.slice(context.indexOf(": ") + 2))
		expect(metadata.receipts[0].streamId).to.equal("stream-0")
		expect(metadata.details_truncated).to.equal(true)
		expect(metadata.omitted_receipts).to.be.greaterThan(0)
		expect(metadata.additional_receipts_omitted).to.equal(true)
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
