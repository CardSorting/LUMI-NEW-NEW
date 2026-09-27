import { expect } from "chai"
import sinon from "sinon"
import * as gatePolicy from "@/shared/audit/auditGatePolicyLoader"
import * as audit from "@/shared/audit/completionAudit"
import { DietCodeDefaultTool } from "@/shared/tools"
import { PlanModeRespondHandler } from "../PlanModeRespondHandler"

describe("PlanModeRespondHandler - Exploration Limits", () => {
	let handler: PlanModeRespondHandler
	let mockTaskState: any
	let mockConfig: any
	afterEach(() => sinon.restore())

	beforeEach(() => {
		handler = new PlanModeRespondHandler()
		mockTaskState = {
			currentTurnExplorationCount: 0,
			consecutiveMistakeCount: 0,
		}
		mockConfig = {
			taskState: mockTaskState,
			mode: "plan",
			yoloModeToggled: false,
			callbacks: {
				sayAndCreateMissingParamError: async () => "error",
				say: sinon.stub().resolves(undefined),
				removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(undefined),
				updateFCListFromToolResponse: sinon.stub().resolves(undefined),
				switchToActMode: async () => true,
				switchToPlanMode: async () => false,
			},
			messageState: {
				getApiConversationHistory: () => [],
				getDietCodeMessages: () => [],
				saveDietCodeMessagesAndUpdateHistory: async () => undefined,
			},
		}
	})

	it("should auto-switch to act mode after presenting a finalized plan", async () => {
		const switchToActMode = sinon.stub().resolves(true)
		const say = sinon.stub().resolves(undefined)
		const removeLastPartialMessageIfExistsWithType = sinon.stub().resolves(undefined)
		mockConfig.callbacks.switchToActMode = switchToActMode
		mockConfig.callbacks.say = say
		mockConfig.callbacks.removeLastPartialMessageIfExistsWithType = removeLastPartialMessageIfExistsWithType

		const block = {
			name: DietCodeDefaultTool.PLAN_MODE,
			params: {
				response: "Here is the plan.",
			},
		}

		const result = await handler.execute(mockConfig, block as any)

		expect(removeLastPartialMessageIfExistsWithType.calledOnceWith("say", "plan_summary")).to.equal(true)
		expect(say.calledOnce).to.equal(true)
		expect(say.firstCall.args[0]).to.equal("plan_summary")
		expect(switchToActMode.calledOnce).to.equal(true)
		expect(mockConfig.taskState.didRespondToPlanAskBySwitchingMode).to.equal(true)
		expect(result).to.contain("Planning complete")
	})

	it("should allow needs_more_exploration until threshold (3)", async () => {
		const block = {
			name: DietCodeDefaultTool.PLAN_MODE,
			params: {
				response: "I need to see more.",
				needs_more_exploration: "true",
			},
		}

		// 1st call
		let result = await handler.execute(mockConfig, block as any)
		expect(mockTaskState.currentTurnExplorationCount).to.equal(1)
		expect(result).to.contain("You have indicated that you need more exploration")

		// 2nd call
		result = await handler.execute(mockConfig, block as any)
		expect(mockTaskState.currentTurnExplorationCount).to.equal(2)
		expect(result).to.contain("You have indicated that you need more exploration")

		// 3rd call
		result = await handler.execute(mockConfig, block as any)
		expect(mockTaskState.currentTurnExplorationCount).to.equal(3)
		expect(result).to.contain("You have indicated that you need more exploration")

		// 4th call (threshold exceeded)
		result = await handler.execute(mockConfig, block as any)
		expect(mockTaskState.currentTurnExplorationCount).to.equal(4)
		expect(result).to.contain("Exploration has repeated without a plan")
	})
	it("does not require a scratchpad audit or history scan to leave strict read-only planning", async () => {
		mockConfig.strictPlanModeEnabled = true
		mockConfig.auditCompletionGateEnabled = false
		mockConfig.auditPlanRegressionGateEnabled = false
		mockConfig.universalGuard = { enforceStrategicReviewInPlanMode: sinon.stub().rejects(new Error("obsolete gate")) }
		mockConfig.messageState.getApiConversationHistory = sinon.stub().throws(new Error("unexpected history scan"))
		const runAudit = sinon.stub(audit, "runCompletionAudit").rejects(new Error("unexpected audit"))
		mockTaskState.currentTurnExplorationCount = 3
		const result = await handler.execute(mockConfig, {
			name: DietCodeDefaultTool.PLAN_MODE,
			params: { response: "Fix the parser and run its regression test." },
		} as any)
		expect(result).to.contain("Planning complete")
		expect(mockTaskState.currentTurnExplorationCount).to.equal(0)
		sinon.assert.notCalled(runAudit)
		sinon.assert.notCalled(mockConfig.universalGuard.enforceStrategicReviewInPlanMode)
	})

	it("does not instruct the agent to retry an unchanged failed mode transition", async () => {
		mockConfig.callbacks.switchToActMode = sinon.stub().resolves(false)
		const result = await handler.execute(mockConfig, {
			name: DietCodeDefaultTool.PLAN_MODE,
			params: { response: "Apply the fix." },
		} as any)
		expect(result).to.contain("report the mode transition problem once")
		expect(result).not.to.contain("retry plan_mode_respond")
	})
	it("honors an explicit workspace plan-review policy without making audit availability a handoff gate", async () => {
		mockConfig.auditCompletionGateEnabled = false
		mockConfig.auditPlanRegressionGateEnabled = false
		sinon.stub(gatePolicy, "resolveCompletionGateOptions").resolves({ gateEnabled: true, planRegressionGateEnabled: true })
		const runAudit = sinon.stub(audit, "runCompletionAudit").rejects(new Error("audit unavailable"))
		const result = await handler.execute(mockConfig, {
			name: DietCodeDefaultTool.PLAN_MODE,
			params: { response: "Apply the fix." },
		} as any)
		sinon.assert.calledOnce(runAudit)
		expect(result).to.contain("Planning complete")
	})
})
