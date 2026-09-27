import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import sinon from "sinon"
import { setRoadmapConfigOverride } from "../RoadmapConfig"
import { roadmapRevision } from "../RoadmapDocument"
import { afterRoadmapWrite, appendRoadmapWriteHint } from "../RoadmapNativeBridge"
import { getRoadmapPromptContext, ROADMAP_CONTEXT_BUDGET_MS } from "../RoadmapPromptContext"
import { RoadmapService } from "../RoadmapService"
import { getRoadmapEnvironmentSection } from "../RoadmapSession"

describe("Optional roadmap prompt context", () => {
	let workspace: string
	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-context-"))
		setRoadmapConfigOverride({ enabled: true })
	})
	afterEach(async () => {
		sinon.restore()
		setRoadmapConfigOverride(null)
		await fs.rm(workspace, { recursive: true, force: true })
	})

	it("missing context creates no files and does not bootstrap or diagnose", async () => {
		const status = sinon.stub(RoadmapService.prototype, "getOperationalStatus").throws(new Error("must not diagnose"))
		assert.equal(await getRoadmapPromptContext(workspace), null)
		assert.equal(await getRoadmapEnvironmentSection(workspace), "")
		assert.deepEqual(await fs.readdir(workspace), [])
		assert.equal(status.callCount, 0)
	})

	it("uses the actual content revision, including same-mtime changes and deletion", async () => {
		const target = path.join(workspace, "ROADMAP.md")
		const first = "# One\n## 1. Project Center of Gravity\nBuild one app.\n## 4. Now\nCurrent assignment.\n"
		await fs.writeFile(target, first)
		const before = await fs.stat(target)
		const context = await getRoadmapPromptContext(workspace)
		assert.equal(context?.document_revision, roadmapRevision(first))
		assert.equal(context?.center_of_gravity_excerpt, "Build one app.")
		assert.equal(context?.now_excerpt, "Current assignment.")
		assert.equal(context?.required_action, null)
		const second = first.replace("One", "Two")
		await fs.writeFile(target, second)
		await fs.utimes(target, before.atime, before.mtime)
		assert.equal((await getRoadmapPromptContext(workspace))?.document_revision, roadmapRevision(second))
		await fs.unlink(target)
		assert.equal(await getRoadmapPromptContext(workspace), null)
	})

	it("omits oversized files, directories and symlinks without treating them as absent files to create", async () => {
		const target = path.join(workspace, "ROADMAP.md")
		await fs.writeFile(target, "x".repeat(256 * 1024 + 1))
		assert.equal(await getRoadmapPromptContext(workspace), null)
		await fs.unlink(target)
		await fs.mkdir(target)
		assert.equal(await getRoadmapPromptContext(workspace), null)
		await fs.rmdir(target)
		await fs.writeFile(path.join(workspace, "other.md"), "# Other")
		await fs.symlink("other.md", target)
		assert.equal(await getRoadmapPromptContext(workspace), null)
		assert.equal((await fs.lstat(target)).isSymbolicLink(), true)
	})

	it("discards a document atomically replaced while its old handle is open", async () => {
		const target = path.join(workspace, "ROADMAP.md")
		await fs.writeFile(target, "# Old")
		const open = fs.open.bind(fs)
		const read = sinon.stub(fs, "open").callsFake(async (...args) => {
			const handle = await open(...args)
			await fs.writeFile(path.join(workspace, "replacement.md"), "# New")
			await fs.rename(path.join(workspace, "replacement.md"), target)
			return handle
		})
		assert.equal(await getRoadmapPromptContext(workspace), null)
		read.restore()
		assert.equal((await getRoadmapPromptContext(workspace))?.project_identity_line, "New")
	})

	it("closes an opened handle after read failure and leaves no deadline timer", async () => {
		await fs.writeFile(path.join(workspace, "ROADMAP.md"), "# Context")
		const timer = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const open = fs.open.bind(fs)
		let close: sinon.SinonSpy | undefined
		sinon.stub(fs, "open").callsFake(async (...args) => {
			const handle = await open(...args)
			close = sinon.spy(handle, "close")
			sinon.stub(handle, "read").rejects(new Error("read failed"))
			return handle
		})
		assert.equal(await getRoadmapPromptContext(workspace), null)
		assert.equal(close?.callCount, 1)
		assert.equal(timer.countTimers(), 0)
	})

	it("shares one deadline, suppresses retry storms while stuck, and discards late results", async () => {
		const timer = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		let rejectRead!: (error: Error) => void
		const open = sinon.stub(fs, "open").returns(
			new Promise((_resolve, reject) => {
				rejectRead = reject
			}),
		)
		const first = getRoadmapPromptContext(workspace)
		assert.equal(getRoadmapPromptContext(workspace), first)
		await timer.tickAsync(ROADMAP_CONTEXT_BUDGET_MS)
		assert.equal(await first, null)
		for (let turn = 0; turn < 50; turn++) assert.equal(await getRoadmapPromptContext(workspace), null)
		assert.equal(open.callCount, 1)
		rejectRead(new Error("late read failure"))
		await timer.tickAsync(0)
		assert.equal(timer.countTimers(), 0)
		open.restore()
		timer.restore()
		await fs.writeFile(path.join(workspace, "ROADMAP.md"), "# Recovered")
		assert.equal((await getRoadmapPromptContext(workspace))?.project_identity_line, "Recovered")
	})

	it("caps pending work across workspaces and releases all slots on settlement", async () => {
		const timer = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const rejects: Array<(error: Error) => void> = []
		const open = sinon.stub(fs, "open").callsFake(() => new Promise((_resolve, reject) => rejects.push(reject)))
		const requests = Array.from({ length: 40 }, (_, index) => getRoadmapPromptContext(path.join(workspace, String(index))))
		await timer.tickAsync(ROADMAP_CONTEXT_BUDGET_MS)
		assert.ok((await Promise.all(requests)).every((result) => result === null))
		assert.equal(open.callCount, 16)
		for (const reject of rejects) reject(new Error("late failure"))
		await timer.tickAsync(0)
		assert.equal(timer.countTimers(), 0)
	})

	it("post-write observers do no I/O and never turn completed writes into failures", async () => {
		setRoadmapConfigOverride({ enabled: true, nudge_on_roadmap_write: true })
		const status = sinon.stub(RoadmapService.prototype, "getOperationalStatus").callsFake(() => new Promise(() => {}))
		const read = sinon.stub(fs, "readFile").throws(new Error("storage unavailable"))
		const write = sinon.stub(fs, "writeFile").throws(new Error("storage unavailable"))
		await afterRoadmapWrite("write_to_file", { path: "ROADMAP.md" }, workspace)
		const result = JSON.parse(
			String(await appendRoadmapWriteHint("write_to_file", { path: "ROADMAP.md" }, workspace, { success: true })),
		)
		assert.equal(result.success, true)
		assert.equal(result._roadmap_write_hint.next_action, "")
		assert.equal(result._roadmap_write_hint.write_rejected, false)
		assert.equal(status.callCount + read.callCount + write.callCount, 0)
	})
})
