import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import { COMPLETION_RESULT_MAX_LENGTH, MAX_COMPLETION_GATE_BLOCK_COUNT } from "@shared/audit/gatePolicy"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import sinon from "sinon"
import { setRoadmapConfigOverride } from "@/services/roadmap/RoadmapConfig"
import { RoadmapService } from "@/services/roadmap/RoadmapService"
import { TaskState } from "../../TaskState"
import {
	COMPLETION_PREFLIGHT_STAGES,
	classifyCompletionPreflightReason,
	recordCompletionGateBlockEvent,
	recordCompletionPreflightFailure,
	retireRoadmapCompletionState,
	validateCompletionResultQuality,
} from "../attemptCompletionUtils"
import {
	evaluateCompletionGateReadiness,
	evaluateCompletionGateReadinessAsync,
	PREFLIGHT_STAGE_RUNNERS,
	runCompletionGateFlow,
	runCompletionPreflightChecks,
} from "../completionGatePipeline"
import type { TaskConfig } from "../types/TaskConfig"

const VALID_RESULT =
	"Implemented retry logic with exponential backoff across the completion gate pipeline. " +
	"All unit tests pass and the handler now wraps errors consistently."

function configWithState(taskState: TaskState): TaskConfig {
	return {
		taskState,
		focusChainSettings: { enabled: false },
		messageState: {
			getDietCodeMessages: () => [],
		},
	} as unknown as TaskConfig
}

describe("completionGatePipeline", () => {
	let taskState: TaskState
	let tmpDir = ""

	beforeEach(async () => {
		taskState = new TaskState()
		setRoadmapConfigOverride({ enabled: false })
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "completion-gate-"))
	})

	afterEach(async () => {
		sinon.restore()
		setRoadmapConfigOverride(null)
		if (tmpDir) {
			await fs.rm(tmpDir, { recursive: true, force: true })
		}
	})

	it("fail-fast circuit breaker before quality checks", async () => {
		taskState.completionGateBlockCount = MAX_COMPLETION_GATE_BLOCK_COUNT
		const error = await runCompletionPreflightChecks(configWithState(taskState), { result: VALID_RESULT }, "Test", {
			validateQuality: validateCompletionResultQuality,
			onFailure: recordCompletionPreflightFailure,
		})
		should.exist(error)
		if (error === null) {
			throw new Error("expected circuit breaker error")
		}
		error.should.containEql("maximum completion gate retries")
		error.should.containEql("<completion_gate_recovery")
	})

	it("reopens completion after workspace progress without requiring checkpoints or a new task", async () => {
		const config = configWithState(taskState)
		for (let i = 0; i < MAX_COMPLETION_GATE_BLOCK_COUNT; i++)
			recordCompletionGateBlockEvent(config, "audit_gate", { result: VALID_RESULT })
		const checks = { validateQuality: validateCompletionResultQuality, onFailure: recordCompletionPreflightFailure }
		should.exist(await runCompletionPreflightChecks(config, { result: VALID_RESULT }, "Test", checks))
		taskState.workspaceRevision++
		const historyLength = taskState.completionGateBlockHistory?.length
		// Readiness stays non-mutating but reflects that a fresh evaluation is available.
		evaluateCompletionGateReadiness(config, { result: VALID_RESULT }).should.be.empty()
		taskState.completionGateBlockCount!.should.equal(MAX_COMPLETION_GATE_BLOCK_COUNT)
		should.not.exist(await runCompletionPreflightChecks(config, { result: VALID_RESULT }, "Test", checks))
		taskState.completionGateBlockCount!.should.equal(0)
		taskState.completionGateBlockHistory!.length.should.equal(historyLength)
	})

	it("rejects non-demo commands like echo in preflight", async () => {
		const error = await runCompletionPreflightChecks(
			configWithState(taskState),
			{ result: VALID_RESULT, command: "echo hello world" },
			"Test",
			{
				validateQuality: validateCompletionResultQuality,
				onFailure: recordCompletionPreflightFailure,
			},
		)
		should.exist(error)
		if (error === null) {
			throw new Error("expected demo command error")
		}
		error.should.containEql("demo command")
		error.should.containEql('reason="invalid_demo_command"')
	})

	it("rejects result summaries exceeding max length in preflight", async () => {
		const tooLong = "x".repeat(COMPLETION_RESULT_MAX_LENGTH + 1)
		const error = await runCompletionPreflightChecks(configWithState(taskState), { result: tooLong }, "Test", {
			validateQuality: validateCompletionResultQuality,
			onFailure: recordCompletionPreflightFailure,
		})
		should.exist(error)
		if (error === null) {
			throw new Error("expected max length error")
		}
		error.should.containEql("exceeds maximum length")
		error.should.containEql('reason="result_too_long"')
	})

	it("increments block count on preflight quality failure", async () => {
		const error = await runCompletionPreflightChecks(configWithState(taskState), { result: "   " }, "Test", {
			validateQuality: validateCompletionResultQuality,
			onFailure: recordCompletionPreflightFailure,
		})
		should.exist(error)
		if (error === null) {
			throw new Error("expected preflight quality failure")
		}
		;(taskState.completionGateBlockCount ?? 0).should.equal(1)
		taskState.lastCompletionBlockReason?.should.equal("empty_result")
		;(taskState.completionAttemptCount ?? 0).should.equal(1)
		error.should.containEql("<completion_gate_envelope")
	})

	it("runCompletionGateFlow passes when audit gate is disabled", async () => {
		const flow = await runCompletionGateFlow(configWithState(taskState), { result: VALID_RESULT }, "Test")
		flow.status.should.equal("passed")
	})

	it("lets a helper hand off with parent audit and roadmap checks enabled", async () => {
		setRoadmapConfigOverride({ enabled: true, block_kanban_on_invalid_schema: true })
		await fs.writeFile(path.join(tmpDir, "ROADMAP.md"), "# Incomplete roadmap")
		const flow = await runCompletionGateFlow(
			{
				...configWithState(taskState),
				cwd: tmpDir,
				isSubagentExecution: true,
				auditCompletionGateEnabled: true,
			},
			{ result: VALID_RESULT },
			"Test",
		)
		flow.status.should.equal("passed")
	})

	it("allows helper corrections immediately without contradictory cooldown blocks", async () => {
		const config = { ...configWithState(taskState), isSubagentExecution: true }
		const first = await runCompletionGateFlow(config, { result: "" }, "Test")
		first.status.should.equal("blocked")
		const second = await runCompletionGateFlow(config, { result: VALID_RESULT }, "Test")
		second.status.should.equal("passed")
	})

	it("preflight registry stages align with COMPLETION_PREFLIGHT_STAGES order", () => {
		const registryStages = PREFLIGHT_STAGE_RUNNERS.map((runner) => runner.stage)
		const expectedSlice = COMPLETION_PREFLIGHT_STAGES.slice(
			COMPLETION_PREFLIGHT_STAGES.indexOf("quality"),
			COMPLETION_PREFLIGHT_STAGES.indexOf("audit"),
		)
		registryStages.should.deepEqual(Array.from(expectedSlice))
	})

	it("evaluateCompletionGateReadiness returns dry-run issues without mutating state", () => {
		const issues = evaluateCompletionGateReadiness(configWithState(taskState), { result: "   " })
		issues.length.should.be.greaterThan(0)
		issues[0].stage.should.equal("quality")
		;(taskState.completionGateBlockCount ?? 0).should.equal(0)
	})

	it("readiness and completion never evaluate roadmap, even with all legacy gates enabled and unavailable diagnostics", async () => {
		setRoadmapConfigOverride({
			enabled: true,
			block_kanban_on_invalid_schema: true,
			block_kanban_on_validation_pending: true,
			block_kanban_on_bootstrap_incomplete: true,
			fail_closed_completion_gates: true,
		})
		const status = sinon.stub(RoadmapService.prototype, "getOperationalStatus").callsFake(() => new Promise(() => {}))
		await fs.mkdir(path.join(tmpDir, ".dietcode"), { recursive: true })
		await fs.writeFile(
			path.join(tmpDir, ".dietcode", "roadmap-state.json"),
			JSON.stringify({ validation_pending: true }),
			"utf8",
		)
		await fs.writeFile(path.join(tmpDir, "ROADMAP.md"), "# Roadmap\n", "utf8")

		const issues = await evaluateCompletionGateReadinessAsync({ ...configWithState(taskState), cwd: tmpDir } as TaskConfig, {
			result: VALID_RESULT,
		})
		issues.should.be.empty()
		const flow = await runCompletionGateFlow({ ...configWithState(taskState), cwd: tmpDir }, { result: VALID_RESULT }, "Test")
		flow.status.should.equal("passed")
		status.callCount.should.equal(0)
		;(taskState.completionGateBlockCount ?? 0).should.equal(0)
		taskState.consecutiveMistakeCount.should.equal(0)
	})

	it("retires roadmap-only retry storms without requiring edits or mutating readiness state", async () => {
		taskState.completionGateBlockCount = MAX_COMPLETION_GATE_BLOCK_COUNT
		taskState.lastCompletionBlockReason = "circuit_breaker"
		taskState.completionGateBlockHistory = Array.from({ length: MAX_COMPLETION_GATE_BLOCK_COUNT }, (_, index) => ({
			reason: index === 0 ? "roadmap_gate" : "duplicate_submission",
			stage: index === 0 ? "roadmap" : "duplicate",
			at: 100 + index,
			soft: false,
			blockCount: index + 1,
		}))
		const config = configWithState(taskState)
		evaluateCompletionGateReadiness(config, { result: VALID_RESULT }).should.be.empty()
		taskState.completionGateBlockCount.should.equal(MAX_COMPLETION_GATE_BLOCK_COUNT)
		const flow = await runCompletionGateFlow(config, { result: VALID_RESULT }, "Test")
		flow.status.should.equal("passed")
		taskState.completionGateBlockCount!.should.equal(0)
		taskState.completionGateBlockHistory!.should.be.empty()
	})

	it("migration preserves independent audit failures and cannot recreate roadmap pressure", () => {
		taskState.completionGateBlockCount = 2
		taskState.lastCompletionBlockReason = "audit_gate"
		taskState.completionGateBlockHistory = [
			{ reason: "roadmap_gate", stage: "roadmap", at: 1, soft: false, blockCount: 1 },
			{ reason: "audit_gate", stage: "audit", at: 2, soft: false, blockCount: 2 },
		]
		const config = configWithState(taskState)
		retireRoadmapCompletionState(config)
		taskState.completionGateBlockCount.should.equal(1)
		taskState.lastCompletionBlockReason.should.equal("audit_gate")
		recordCompletionGateBlockEvent(config, "roadmap_gate").should.equal(1)
		taskState.completionGateBlockHistory!.length.should.equal(1)
		classifyCompletionPreflightReason("hardening audit evaluation failed for roadmap code").should.equal("audit_error")
	})

	it("evaluateCompletionGateReadinessAsync skips roadmap when disabled", async () => {
		const issues = await evaluateCompletionGateReadinessAsync({ ...configWithState(taskState), cwd: tmpDir } as TaskConfig, {
			result: VALID_RESULT,
		})
		issues.some((issue) => issue.stage === "roadmap").should.be.false()
	})
})
