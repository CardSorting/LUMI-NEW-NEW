import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import * as hooks from "@/core/hooks/hooks-utils"
import type { StateManager } from "@/core/storage/StateManager"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@/shared/AutoApprovalSettings"
import * as auditGatePolicy from "@/shared/audit/auditGatePolicyLoader"
import type { DietCodeMessage } from "@/shared/ExtensionMessage"
import { DietCodeDefaultTool } from "@/shared/tools"
import { executor } from "../../../ActionExecutor"
import { TaskState } from "../../../TaskState"
import * as completion from "../../attemptCompletionUtils"
import { AutoApprove } from "../../autoApprove"
import * as pipeline from "../../completionGatePipeline"
import type { ToolValidator } from "../../ToolValidator"
import type { TaskConfig } from "../../types/TaskConfig"
import { ToolHookUtils } from "../../utils/ToolHookUtils"
import { AttemptCompletionHandler } from "../AttemptCompletionHandler"
import { ExecuteCommandToolHandler } from "../ExecuteCommandToolHandler"

describe("completion command execution", () => {
	afterEach(() => sinon.restore())
	function fixture(allowed = true, trusted = true, mockPreflight = true) {
		sinon.stub(hooks, "getHooksEnabledSafe").returns(false)
		const proactiveGuidance = sinon.stub(completion, "shouldEmitProactiveCompletionGuidance").returns(false)
		const readinessHint = sinon.stub(completion, "shouldEmitPreflightReadinessHint").returns(false)
		if (mockPreflight) sinon.stub(pipeline, "runCompletionPreflightChecks").resolves(null)
		const auditGate = sinon.stub(pipeline, "evaluateCompletionAuditGate").resolves({ status: "skipped" })
		sinon.stub(ToolHookUtils, "runPreToolUseIfEnabled").resolves()
		sinon.stub(executor, "execute").callsFake(async (_id, action) => action(new AbortController().signal))
		const commandHandler = new ExecuteCommandToolHandler({
			validateCommand: () => ({ ok: true }),
		} as unknown as ToolValidator)
		const state = {
			getApiConfiguration: () => ({}),
			getTrustedCommands: () => (trusted ? ["npm test"] : []),
			getTrustedTools: () => [],
			getGlobalSettingsKey: (key: string) =>
				key === "autoApprovalSettings" ? DEFAULT_AUTO_APPROVAL_SETTINGS : key === "mode" ? "act" : false,
		} as unknown as StateManager
		const callbacks = {
			ask: sinon
				.stub()
				.callsFake(async (kind) => ({ response: kind === "completion_result" ? "yesButtonClicked" : "noButtonClicked" })),
			say: sinon.stub().resolves(),
			removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
			executeCommandTool: sinon.stub().resolves([false, "tests passed"]),
			saveCheckpoint: sinon.stub().resolves(),
			doesLatestTaskCompletionHaveNewChanges: sinon.stub().resolves(false),
			updateFCListFromToolResponse: sinon.stub().resolves(),
		}
		const config = {
			cwd: "/workspace",
			ulid: "test",
			taskId: "test",
			taskState: new TaskState(),
			mode: "act",
			api: { getModel: () => ({ id: "test" }) },
			messageState: { getDietCodeMessages: () => [] },
			services: {
				stateManager: state,
				browserSession: { closeBrowser: sinon.stub().resolves() },
				commandPermissionController: { validateCommand: () => ({ allowed, reason: "policy denied" }) },
			},
			autoApprover: new AutoApprove(state),
			autoApprovalSettings: { ...DEFAULT_AUTO_APPROVAL_SETTINGS, enableNotifications: false },
			focusChainSettings: { enabled: true },
			coordinator: { getHandler: () => commandHandler },
			callbacks,
		} as unknown as TaskConfig
		const block = {
			type: "tool_use" as const,
			name: DietCodeDefaultTool.ATTEMPT,
			params: { result: "The requested work is complete.", command: "npm test" },
			partial: false,
		}
		return { handler: new AttemptCompletionHandler(), config, callbacks, block, proactiveGuidance, readinessHint, auditGate }
	}
	it("reuses saved command trust and executes before publishing completion", async () => {
		const { handler, config, callbacks, block } = fixture()
		assert.match(String(await handler.execute(config, block)), /Result: Done/)
		sinon.assert.calledOnce(callbacks.executeCommandTool)
		sinon.assert.calledOnce(config.services.browserSession.closeBrowser as sinon.SinonStub)
		assert.deepEqual(
			callbacks.ask.getCalls().map((call) => call.args[0]),
			["completion_result"],
		)
		const completionMessage = callbacks.say.getCalls().find((call) => call.args[0] === "completion_result")!
		assert.ok(callbacks.executeCommandTool.firstCall.calledBefore(completionMessage))
	})
	for (const newEvidence of [false, true]) {
		it(
			newEvidence
				? "records the demo command's observed successful exit"
				: "does not reuse successful command evidence from an earlier attempt",
			async () => {
				const { handler, config, callbacks, block } = fixture()
				const commandMessage: DietCodeMessage = {
					ts: 1,
					type: "say",
					say: "command",
					text: "npm test",
					commandExecution: { status: "completed", exitCode: 0 },
				}
				const messages = newEvidence ? [] : [commandMessage]
				config.messageState.getDietCodeMessages = () => messages
				if (newEvidence)
					callbacks.executeCommandTool.callsFake(async () => {
						messages.push(commandMessage)
						return [false, "tests passed", commandMessage.commandExecution]
					})
				assert.match(String(await handler.execute(config, block)), /Result: Done/)
				const completionMessage = callbacks.say.getCalls().find((call) => call.args[0] === "completion_result")!
				assert.equal(
					completionMessage.args[6].checks.find((check: { id: string }) => check.id === "demo").status,
					newEvidence ? "passed" : "unverified",
				)
			},
		)
	}
	it("shows readable notices after an incomplete focus chain is completed", async () => {
		const { handler, config, callbacks, block, readinessHint, auditGate } = fixture(true, true, false)
		readinessHint.callThrough()
		auditGate.resetBehavior()
		auditGate.callThrough()
		const clock = sinon.useFakeTimers({ now: Date.now() })
		config.taskState.currentFocusChainChecklist = "- [x] Implement change\n- [ ] Verify regression"
		block.params.command = ""

		const blockedResult = String(await handler.execute(config, block))
		assert.match(blockedResult, /focus chain has 1 incomplete item/)
		assert.match(blockedResult, /<completion_gate_envelope/)
		assert.equal(config.taskState.lastCompletionBlockReason, "focus_chain_incomplete")
		let reasonAtCompletion: string | undefined = config.taskState.lastCompletionBlockReason
		callbacks.say.callsFake(async (kind) => {
			if (kind === "completion_result") reasonAtCompletion = config.taskState.lastCompletionBlockReason
		})
		config.taskState.currentFocusChainChecklist = "- [x] Implement change\n- [x] Verify regression"
		clock.tick(3000)
		assert.match(String(await handler.execute(config, block)), /Result: Done/)

		const notices = callbacks.say.getCalls().filter((call) => call.args[0] === "info")
		assert.equal(notices.length, 1)
		for (const notice of notices) assert.doesNotMatch(notice.args[1], /<\/?(?:completion_gate\w*|stage)\b/)
		const completionMessages = callbacks.say.getCalls().filter((call) => call.args[0] === "completion_result")
		assert.equal(completionMessages.length, 1)
		assert.equal(completionMessages[0].args[1], block.params.result)
		assert.equal(completionMessages[0].args[6].priorBlocks, 1)
		assert.equal(completionMessages[0].args[6].checks[0].status, "passed")
		assert.equal(completionMessages[0].args[6].checks[1].status, "not_run")
		assert.equal(reasonAtCompletion, undefined)
	})
	it("removes rejected drafts without removing completed results or intervening notices", async () => {
		const { handler, config, block } = fixture(true, true, false)
		const completed: DietCodeMessage = { ts: 1, type: "say", say: "completion_result", text: "Earlier result" }
		const notice: DietCodeMessage = { ts: 3, type: "say", say: "info", text: "Checking" }
		let messages: DietCodeMessage[] = [
			completed,
			{ ts: 2, type: "say", say: "completion_result", partial: true, text: "Draft" },
			notice,
		]
		config.messageState.getDietCodeMessages = () => messages
		config.messageState.setDietCodeMessages = (value) => {
			messages = value
		}
		config.messageState.saveDietCodeMessagesAndUpdateHistory = sinon.stub().resolves()
		config.taskState.currentFocusChainChecklist = "- [ ] Verify regression"
		assert.match(String(await handler.execute(config, block)), /focus chain has 1 incomplete item/)
		assert.deepEqual(messages, [completed, notice])
	})
	it("renders audit readiness and the passing score as text while retaining internal diagnostics", async () => {
		const { handler, config, callbacks, block, readinessHint, auditGate } = fixture()
		readinessHint.callThrough()
		config.auditCompletionGateEnabled = true
		config.taskState.lastAdvisoryAudit = { hardening_score: 20, violations: ["test_warning"] }
		const gateOptions = { gateEnabled: true, scoreThreshold: 80 }
		sinon.stub(auditGatePolicy, "resolveCompletionGateOptions").resolves(gateOptions)
		auditGate.resolves({
			status: "passed",
			auditMetadata: { hardening_score: 91, violations: [] },
			gateDecision: { blocked: false, score: 91, effectiveThreshold: 80, grade: undefined, reasons: [] },
			gateOptions,
			policyProvenance: { source: "extension", workspacePolicyApplied: false, overriddenFields: [] },
		})
		let internalEnvelope: string | undefined
		callbacks.say.callsFake(async (kind) => {
			if (kind === "completion_result") internalEnvelope = config.taskState.completionGateObservabilityEnvelope
		})
		assert.match(String(await handler.execute(config, block)), /Result: Done/)
		const notices = callbacks.say.getCalls().filter((call) => call.args[0] === "info")
		assert.match(notices[0].args[1], /Pre-Completion Quality Gate/)
		for (const notice of notices) assert.doesNotMatch(notice.args[1], /<\/?(?:completion_gate\w*|pre_completion_checklist)\b/)
		assert.equal(notices.length, 1)
		assert.match(internalEnvelope ?? "", /<completion_gate_envelope/)
		assert.match(internalEnvelope ?? "", /passed="true"/)
		const result = callbacks.say.getCalls().find((call) => call.args[0] === "completion_result")!
		assert.equal(
			result.args[6].checks.find((check: { id: string }) => check.id === "audit").detail,
			"Score 91/100 · policy threshold 80.",
		)
		assert.ok(callbacks.executeCommandTool.firstCall.calledBefore(result))
	})
	it("keeps structured recovery details out of proactive chat notices", async () => {
		const { handler, config, callbacks, block, proactiveGuidance } = fixture(true, true, false)
		proactiveGuidance.returns(true)
		completion.recordCompletionGateBlockEvent(config, "focus_chain_incomplete")
		config.taskState.currentFocusChainChecklist = "- [ ] Verify regression"
		block.params.command = ""
		assert.match(String(await handler.execute(config, block)), /focus chain has 1 incomplete item/)
		const notices = callbacks.say.getCalls().filter((call) => call.args[0] === "info")
		assert.match(notices[0].args[1], /focus chain/)
		for (const notice of notices) assert.doesNotMatch(notice.args[1], /<\/?completion_gate\w*\b/)
	})
	for (const result of ["Fixed.", "Verified the requested fix.\n- [x] Regression test passed"]) {
		it(`publishes ${result.includes("[x]") ? "a completed checklist" : "a concise result"} through real preflight without duplicating a completed focus chain`, async () => {
			const { handler, config, callbacks, block, readinessHint } = fixture(true, true, false)
			readinessHint.callThrough()
			config.taskState.currentFocusChainChecklist = "- [x] Implement change\n- [x] Verify regression"
			block.params = { result, command: "" }
			assert.match(String(await handler.execute(config, block)), /Result: Done/)
			const completionMessages = callbacks.say.getCalls().filter((call) => call.args[0] === "completion_result")
			assert.equal(completionMessages.length, 1)
			assert.equal(completionMessages[0].args[1], result)
			assert.equal(callbacks.say.getCalls().filter((call) => call.args[0] === "info").length, 0)
			assert.equal(config.taskState.completionGateBlockCount ?? 0, 0)
			sinon.assert.notCalled(callbacks.executeCommandTool)
			assert.deepEqual(
				callbacks.ask.getCalls().map((call) => call.args[0]),
				["completion_result"],
			)
		})
	}
	for (const trusted of [true, false]) {
		it(
			trusted ? "honors command policy before completion" : "does not publish completion after command approval is denied",
			async () => {
				const { handler, config, callbacks, block } = fixture(!trusted, trusted)
				completion.recordCompletionGateBlockEvent(config, "focus_chain_incomplete")
				assert.match(String(await handler.execute(config, block)), /denied/)
				sinon.assert.notCalled(callbacks.executeCommandTool)
				sinon.assert.notCalled(config.services.browserSession.closeBrowser as sinon.SinonStub)
				assert.equal(
					callbacks.say.getCalls().some((call) => call.args[0] === "completion_result"),
					false,
				)
				assert.equal(
					callbacks.ask.getCalls().some((call) => call.args[0] === "completion_result"),
					false,
				)
				assert.equal(
					callbacks.say.getCalls().some((call) => String(call.args[1]).includes("Completion checks passed")),
					false,
				)
			},
		)
	}
	it("retains completion after optional bookkeeping fails without replaying the command", async () => {
		const { handler, config, callbacks, block } = fixture()
		callbacks.saveCheckpoint.rejects(new Error("snapshot unavailable"))
		callbacks.doesLatestTaskCompletionHaveNewChanges.rejects(new Error("diff unavailable"))
		callbacks.updateFCListFromToolResponse.rejects(new Error("checklist unavailable"))
		assert.match(String(await handler.execute(config, block)), /Result: Done/)
		sinon.assert.calledOnce(callbacks.executeCommandTool)
		assert.deepEqual(
			callbacks.ask.getCalls().map((call) => call.args[0]),
			["completion_result"],
		)
	})
})
