import * as assert from "assert"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import {
	evaluateRoadmapCompletionBlock,
	failClosedCompletionMessage,
	requireFreshCheckpointBeforeComplete,
} from "../RoadmapCompletionGate"
import { DEFAULT_ROADMAP_CONFIG, setRoadmapConfigOverride } from "../RoadmapConfig"

describe("RoadmapCompletionGate", () => {
	let tmpDir = ""

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-completion-"))
		setRoadmapConfigOverride({
			...DEFAULT_ROADMAP_CONFIG,
			enabled: true,
			block_kanban_on_invalid_schema: true,
			block_kanban_on_validation_pending: true,
		})
	})

	afterEach(async () => {
		setRoadmapConfigOverride(null)
		if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("honors disabled validation blocking even when pending state is supplied", async () => {
		setRoadmapConfigOverride({ block_kanban_on_validation_pending: false })
		const result = await evaluateRoadmapCompletionBlock(tmpDir, { validation_pending: true, kanban_complete_allowed: true })
		assert.strictEqual(result.blocked, false)
	})

	it("allows completion when roadmap disabled", async () => {
		setRoadmapConfigOverride({ enabled: false })
		const block = await evaluateRoadmapCompletionBlock(tmpDir)
		assert.strictEqual(block.blocked, false)
	})

	it("ignores pending state and retired blocking settings without modifying the document", async () => {
		await fs.mkdir(path.join(tmpDir, ".dietcode"), { recursive: true })
		await fs.writeFile(
			path.join(tmpDir, ".dietcode", "roadmap-state.json"),
			JSON.stringify({ validation_pending: true }),
			"utf8",
		)
		await fs.writeFile(path.join(tmpDir, "ROADMAP.md"), "# Roadmap\n", "utf8")

		const block = await evaluateRoadmapCompletionBlock(tmpDir)
		assert.strictEqual(block.blocked, false)
		assert.strictEqual(await fs.readFile(path.join(tmpDir, "ROADMAP.md"), "utf8"), "# Roadmap\n")
	})

	it("legacy checkpoint prerequisite is inert", async () => {
		await fs.mkdir(path.join(tmpDir, ".dietcode"), { recursive: true })
		await fs.writeFile(
			path.join(tmpDir, ".dietcode", "roadmap-state.json"),
			JSON.stringify({ validation_pending: true }),
			"utf8",
		)
		await fs.writeFile(path.join(tmpDir, "ROADMAP.md"), "# Roadmap\n", "utf8")

		const msg = await requireFreshCheckpointBeforeComplete(tmpDir)
		assert.strictEqual(msg, null)
	})

	it("legacy unavailable-context notice does not send agents into diagnostic loops", () => {
		assert.match(failClosedCompletionMessage(), /Continue scoped work/)
		assert.doesNotMatch(failClosedCompletionMessage(), /Run|blocked|doctor/)
	})
})

describe("RoadmapLifecycle", () => {
	it("legacy lifecycle APIs never install skills, create roadmaps, or write diagnostics", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-lifecycle-"))
		try {
			await fs.writeFile(path.join(tmpDir, "README.md"), "# Lifecycle Test\n", "utf8")
			setRoadmapConfigOverride({ enabled: true, auto_bootstrap: true, auto_install_skills: true })
			const { initRoadmapSession, finalizeRoadmapSession } = await import("../RoadmapLifecycle")
			const result = await initRoadmapSession(tmpDir, "task-test-1")
			assert.ok(result)
			assert.strictEqual(result.workspace, tmpDir)
			assert.strictEqual(result.roadmap_mode, "advisory")
			await finalizeRoadmapSession(tmpDir, "task-test-1")
			assert.deepStrictEqual(await fs.readdir(tmpDir), ["README.md"])
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true })
			setRoadmapConfigOverride(null)
		}
	})
})
