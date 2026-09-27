import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { invalidateRoadmapWorkspaceCache } from "@/services/roadmap/RoadmapCache"
import { setRoadmapConfigOverride } from "@/services/roadmap/RoadmapConfig"
import { BOOTSTRAP_PLACEHOLDER_PHRASES, bootstrapSkeleton } from "@/services/roadmap/RoadmapSchema"
import { DietCodeDefaultTool } from "@/shared/tools"
import { Task } from "../index"
import { TaskState } from "../TaskState"
import { RoadmapToolHandler } from "../tools/handlers/RoadmapToolHandler"
import type { TaskConfig } from "../tools/types/TaskConfig"

describe("roadmap request loop recovery", () => {
	let workspace: string
	let previousSessionDir: string | undefined

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lumi-roadmap-loop-"))
		previousSessionDir = process.env.DIETCODE_SESSION_DIR
		process.env.DIETCODE_SESSION_DIR = path.join(workspace, "session")
		setRoadmapConfigOverride({ enabled: true, progress_enabled: true, evidence_cache_ttl_seconds: 0 })
		let roadmap = bootstrapSkeleton({})
		for (const phrase of BOOTSTRAP_PLACEHOLDER_PHRASES) roadmap = roadmap.replaceAll(phrase, "Project direction recorded.")
		await fs.writeFile(path.join(workspace, "ROADMAP.md"), roadmap)
	})

	afterEach(async () => {
		sinon.restore()
		setRoadmapConfigOverride(null)
		invalidateRoadmapWorkspaceCache(workspace)
		if (previousSessionDir === undefined) delete process.env.DIETCODE_SESSION_DIR
		else process.env.DIETCODE_SESSION_DIR = previousSessionDir
		await fs.rm(workspace, { recursive: true, force: true })
	})

	it("stops repeated real roadmap calls while preserving the last native tool result", async () => {
		const task = Object.assign(Object.create(Task.prototype), {
			taskState: new TaskState(),
			stateManager: { getGlobalSettingsKey: () => 3 },
			saveCheckpointCallback: sinon.stub().resolves(),
			consumeIdleGapFeedbackIfPending: sinon.stub().resolves(null),
			messageStateHandler: { addToApiConversationHistory: sinon.stub().resolves() },
			toolExecutor: { resetSystemPressure: sinon.stub() },
			say: sinon.stub().resolves(),
		})
		const handler = new RoadmapToolHandler()
		const config = { cwd: workspace, taskId: "loop-test" } as TaskConfig
		const actions = [
			"checkpoint",
			"cockpit",
			"progress",
			"watch",
			"validate",
			"explain_gate",
			"explain_stale",
			"apply_bootstrap_fill",
			"guide",
		]
		let calls = 0
		task.makeDietCodeRequest = async () => {
			assert.ok(++calls <= 10, "Repeated views of the same revision must reach the stopping guard")
			const action = actions[(calls - 1) % actions.length]
			const params = { action, context: action === "progress" ? "--timeline" : `Map workspace again ${calls}` }
			const result = await handler.execute(config, {
				type: "tool_use",
				name: DietCodeDefaultTool.ROADMAP,
				params,
				partial: false,
			})
			assert.equal(JSON.parse(result as string).success, true)
			task.taskState.executionProgress.record("roadmap", params, result)
			task.taskState.userMessageContent = [{ type: "tool_result", tool_use_id: `call-${calls}`, content: result }]
			return task.continueAfterToolResponse()
		}
		assert.equal(await task.runRequestLoop([{ type: "text", text: "Build the requested starter" }]), true)
		assert.ok(calls <= 10)
		sinon.assert.calledOnce(task.toolExecutor.resetSystemPressure)
		sinon.assert.calledOnce(task.say)
		assert.match(task.say.firstCall.args[1], /no-progress loop/)
		sinon.assert.calledOnce(task.messageStateHandler.addToApiConversationHistory)
		assert.equal(
			task.messageStateHandler.addToApiConversationHistory.firstCall.args[0].content[0].tool_use_id,
			`call-${calls}`,
		)
	})
})
