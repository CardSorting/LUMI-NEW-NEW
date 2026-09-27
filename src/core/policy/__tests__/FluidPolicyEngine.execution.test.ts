import { strict as assert } from "node:assert"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { describe, it } from "mocha"
import sinon from "sinon"
import { DietCodeDefaultTool } from "@/shared/tools"
import { FluidPolicyEngine } from "../FluidPolicyEngine"

describe("execution policy observations", () => {
	function fixture(strict = false) {
		return Object.assign(Object.create(FluidPolicyEngine.prototype), {
			mode: "plan",
			cwd: "/workspace",
			stateManager: { getGlobalSettingsKey: (key: string) => key === "strictPlanModeEnabled" && strict },
			envIntegrity: { validateEnvironment: sinon.stub().resolves({ success: true }) },
			sessionFiles: new Map(),
			spiderEngine: { setSessionBuffer: sinon.stub(), updateNode: sinon.stub(), getViolations: () => [] },
			stabilityMonitor: { recordWrite: sinon.stub(), recordRead: sinon.stub() },
			stalenessTracker: { recordRead: sinon.stub().resolves() },
			garbageCollector: { sweep: sinon.stub().rejects(new Error("implicit repair must not run")) },
			normalize: (value: string) => value,
		})
	}
	it("allows normal planning commands without architectural prerequisites when reviews are off", async () => {
		const engine = fixture()
		const result = await engine.validatePreExecution({ name: DietCodeDefaultTool.BASH, params: { command: "git status" } })
		assert.equal(result.success, true)
		sinon.assert.calledOnce(engine.envIntegrity.validateEnvironment)
		sinon.assert.notCalled(engine.garbageCollector.sweep)
	})
	it("enforces explicitly enabled Strict Plan mode", async () => {
		const engine = fixture(true)
		const result = await engine.validatePreExecution({ name: DietCodeDefaultTool.BASH, params: { command: "npm test" } })
		assert.equal(result.success, false)
		assert.match(result.error, /Strict Plan mode/)
		sinon.assert.notCalled(engine.envIntegrity.validateEnvironment)
	})
	it("keeps reads available in Strict Plan mode without source-audit requirements", async () => {
		const engine = fixture(true)
		assert.equal(
			(await engine.validatePreExecution({ name: DietCodeDefaultTool.FILE_READ, params: { path: "a.ts" } })).success,
			true,
		)
		assert.equal(await engine.onRead("a.ts", "original contents"), "original contents")
		sinon.assert.calledOnce(engine.stalenessTracker.recordRead)
	})
	it("records a completed write without running cleanup or rewriting the file", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "lumi-observation-"))
		try {
			const engine = fixture()
			engine.cwd = dir
			const content = "export const answer = 42\n"
			await writeFile(path.join(dir, "a.ts"), content)
			assert.equal(
				(await engine.validatePostExecution({ name: DietCodeDefaultTool.FILE_EDIT, params: { path: "a.ts" } }, "saved"))
					.success,
				true,
			)
			assert.equal(await readFile(path.join(dir, "a.ts"), "utf8"), content)
			assert.equal(engine.sessionFiles.get(path.join(dir, "a.ts")), content)
			sinon.assert.calledOnce(engine.stabilityMonitor.recordWrite)
			sinon.assert.notCalled(engine.garbageCollector.sweep)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
