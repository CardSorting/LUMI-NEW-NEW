import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import sinon from "sinon"
import { ToolProgressTracker } from "@/core/task/ToolProgressTracker"
import { ApplyPatchHandler } from "@/core/task/tools/handlers/ApplyPatchHandler"
import type { ToolValidator } from "@/core/task/tools/ToolValidator"
import type { TaskConfig } from "@/core/task/tools/types/TaskConfig"
import { DietCodeDefaultTool } from "@/shared/tools"
import { invalidateRoadmapWorkspaceCache } from "../RoadmapCache"
import { evaluateRoadmapCompletionBlock } from "../RoadmapCompletionGate"
import { setRoadmapConfigOverride } from "../RoadmapConfig"
import { readRoadmapDocument, roadmapRevision } from "../RoadmapDocument"
import { handleExternalRoadmapChange } from "../RoadmapFileWatcher"
import { isQuarantinedWorkspace } from "../RoadmapGateCatalog"
import { preflightRoadmapWrite, resolveRoadmapWritePath, validateRoadmapWriteTarget } from "../RoadmapNativeBridge"
import {
	clearLastError,
	emitProgress,
	lastErrorPath,
	progressJsonlPath,
	readCurrentProgress,
	readLastError,
	readProgressTail,
	recordLastError,
} from "../RoadmapProgress"
import { BOOTSTRAP_PLACEHOLDER_PHRASES, bootstrapSkeleton } from "../RoadmapSchema"
import { RoadmapService } from "../RoadmapService"
import { sessionBrief } from "../RoadmapSession"
import { mergeSteeringFields } from "../RoadmapSteeringContext"
import { journalRoadmapToolCall } from "../RoadmapToolJournal"

function completeRoadmap(): string {
	let content = bootstrapSkeleton({})
	for (const phrase of BOOTSTRAP_PLACEHOLDER_PHRASES) content = content.replaceAll(phrase, "Confirmed project direction.")
	return content
}

describe("Roadmap resilience", () => {
	let workspace: string
	let scratch: string
	let previousSession: string | undefined
	let service: RoadmapService

	beforeEach(async () => {
		scratch = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-resilience-"))
		workspace = path.join(scratch, "project")
		await fs.mkdir(workspace)
		previousSession = process.env.DIETCODE_SESSION_DIR
		process.env.DIETCODE_SESSION_DIR = path.join(scratch, "session")
		setRoadmapConfigOverride({ enabled: true, progress_enabled: true, evidence_cache_ttl_seconds: 60 })
		service = new RoadmapService()
		await fs.writeFile(path.join(workspace, "ROADMAP.md"), completeRoadmap())
	})

	afterEach(async () => {
		sinon.restore()
		setRoadmapConfigOverride(null)
		invalidateRoadmapWorkspaceCache(workspace)
		if (previousSession === undefined) delete process.env.DIETCODE_SESSION_DIR
		else process.env.DIETCODE_SESSION_DIR = previousSession
		await fs.rm(scratch, { recursive: true, force: true })
	})

	it("validates once per content revision, without renewing timestamps on repeated checks", async () => {
		await service.getOperationalStatus(workspace, "", "light")
		const before = await fs.readFile(service.getStatePath(workspace), "utf8")
		await service.validateRoadmap(workspace)
		await service.getOperationalStatus(workspace, "", "light")
		assert.equal(await fs.readFile(service.getStatePath(workspace), "utf8"), before)
		const state = await service.readState(workspace)
		assert.equal(state.validated_revision, (await readRoadmapDocument(workspace)).revision)
		assert.equal(state.validation_pending, false)
	})

	it("detects changed contents with identical mtime and no watcher event", async () => {
		setRoadmapConfigOverride({ block_kanban_on_invalid_schema: true })
		const target = path.join(workspace, "ROADMAP.md")
		await service.getOperationalStatus(workspace, "", "light")
		const stat = await fs.stat(target)
		await fs.writeFile(target, "# Invalid replacement\n")
		await fs.utimes(target, stat.atime, stat.mtime)
		const current = await service.getOperationalStatus(workspace, "", "light")
		assert.equal(current.schema_valid, false)
		assert.equal(current.completion_ready, true)
		assert.equal(current.required_action, null)
		assert.ok(current.advisory_actions.some((item: { id: string }) => item.id === "schema_valid"))
	})

	it("retired gate settings cannot turn cached evidence or session briefs into prerequisites", async () => {
		await fs.writeFile(path.join(workspace, "ROADMAP.md"), "# Invalid\n")
		const advisory = await service.getOperationalStatus(workspace, "", "light")
		assert.equal(advisory.agent_next_call, "")
		assert.equal(advisory.required_action, null)
		assert.ok(advisory.advisory_actions.some((item: Record<string, unknown>) => item.id === "schema_valid"))
		assert.equal((await sessionBrief(workspace))?.completion_ready, true)
		setRoadmapConfigOverride({ block_kanban_on_invalid_schema: true })
		const required = await service.getOperationalStatus(workspace, "", "light")
		assert.equal(required.completion_ready, true)
		assert.equal((await sessionBrief(workspace))?.completion_ready, true)
		setRoadmapConfigOverride({ block_kanban_on_invalid_schema: false })
		assert.equal((await evaluateRoadmapCompletionBlock(workspace, required)).blocked, false)
	})

	it("coalesces duplicate and delayed watcher notifications after validation", async () => {
		await service.validateRoadmap(workspace)
		const before = await fs.readFile(service.getStatePath(workspace), "utf8")
		await Promise.all(Array.from({ length: 12 }, () => handleExternalRoadmapChange(workspace)))
		assert.equal(await fs.readFile(service.getStatePath(workspace), "utf8"), before)
	})

	it("completion never reconciles roadmap state; explicit diagnostics check current content", async () => {
		setRoadmapConfigOverride({ block_kanban_on_validation_pending: true })
		await service.validateRoadmap(workspace)
		await fs.appendFile(path.join(workspace, "ROADMAP.md"), "\nConfirmed implementation result.\n")
		await handleExternalRoadmapChange(workspace)
		assert.equal((await service.readState(workspace)).validation_pending, true)
		assert.equal((await evaluateRoadmapCompletionBlock(workspace)).blocked, false)
		assert.equal((await service.readState(workspace)).validation_pending, true)
		await service.getOperationalStatus(workspace)
		assert.equal((await service.readState(workspace)).validation_pending, false)
	})

	it("does not lose independent state updates under concurrency", async () => {
		await Promise.all(Array.from({ length: 20 }, (_, index) => service.writeState(workspace, { [`field_${index}`]: index })))
		const state = await service.readState(workspace)
		for (let index = 0; index < 20; index++) assert.equal(state[`field_${index}`], index)
		assert.equal(
			(await fs.readdir(path.dirname(service.getStatePath(workspace)))).filter((name) => name.endsWith(".tmp")).length,
			0,
		)
	})

	it("validates actual content even when the derived state cache cannot be persisted", async () => {
		await fs.mkdir(service.getStatePath(workspace), { recursive: true })
		setRoadmapConfigOverride({ block_kanban_on_validation_pending: true, block_kanban_on_invalid_schema: true })
		const status = await service.getOperationalStatus(workspace, "", "light")
		assert.equal(status.schema_valid, true)
		assert.equal(status.completion_ready, true)
		assert.equal(status.workspace_state._write_failed, true)
	})

	it("retries once if content changes during evidence collection, without certifying the old revision", async () => {
		const original = service.gatherEvidence.bind(service)
		const gather = sinon.stub(service, "gatherEvidence").callsFake(async (...args) => {
			const evidence = await original(...args)
			if (gather.callCount === 1) await fs.writeFile(path.join(workspace, "ROADMAP.md"), "# Changed mid-check\n")
			return evidence
		})
		const status = await service.getOperationalStatus(workspace, "", "light")
		assert.equal(gather.callCount, 2)
		assert.equal(status.schema_valid, false)
		assert.equal(status.progress_evidence.document_revision, roadmapRevision("# Changed mid-check\n"))
	})

	it("bounds reconciliation when another writer keeps changing the document", async () => {
		const original = service.gatherEvidence.bind(service)
		const gather = sinon.stub(service, "gatherEvidence").callsFake(async (...args) => {
			const evidence = await original(...args)
			await fs.writeFile(path.join(workspace, "ROADMAP.md"), `# Concurrent edit ${gather.callCount}\n`)
			return evidence
		})
		await assert.rejects(service.getOperationalStatus(workspace, "", "light"), /changing during validation/)
		assert.equal(gather.callCount, 2)
	})

	it("does not treat deleted or unreadable documents as a valid cached roadmap", async () => {
		await service.validateRoadmap(workspace)
		await fs.unlink(path.join(workspace, "ROADMAP.md"))
		await handleExternalRoadmapChange(workspace)
		const missing = await service.getOperationalStatus(workspace, "", "light")
		assert.equal(missing.roadmap_exists, false)
		assert.equal(missing.progress_evidence.document_revision, "missing")
		await fs.mkdir(path.join(workspace, "ROADMAP.md"))
		await assert.rejects(service.getOperationalStatus(workspace, "", "light"))
	})

	it("all status views share one stable progress observation", async () => {
		const tracker = new ToolProgressTracker()
		const calls = [
			() => service.getOperationalStatus(workspace),
			() => service.checkpointBrief(workspace),
			() => service.buildCockpit(workspace),
			() => service.getProgressSnapshot(workspace),
			() => service.getWatchReport(workspace),
			() => service.explainGate(workspace),
			() => service.explainStale(workspace),
			() => service.applyBootstrapFillBrief(workspace, "write"),
			() => service.validateRoadmap(workspace),
		]
		let first: unknown
		let outcome = ""
		for (const call of calls) {
			const result = await call()
			first ??= result.progress_evidence
			assert.deepEqual(result.progress_evidence, first)
			assert.equal(result.agent_next_call, "")
			tracker.record("roadmap", { action: result.action }, result)
			outcome = tracker.finishTurn()
		}
		assert.equal(outcome, "handoff")
		await fs.appendFile(path.join(workspace, "ROADMAP.md"), "\nNew confirmed result.\n")
		tracker.record("roadmap", {}, await service.getOperationalStatus(workspace))
		assert.equal(tracker.finishTurn(), "continue")
	})

	it("keeps terminal navigation terminal when merging steering fields", () => {
		assert.equal(
			mergeSteeringFields({ agent_next_call: "" }, { agent_next_call: "roadmap(action='guide')" }).agent_next_call,
			"",
		)
	})

	it("scopes progress and errors to the exact workspace", async () => {
		const other = path.join(scratch, "other")
		await emitProgress("roadmap.guide", { workspace, action: "guide" })
		await recordLastError({ workspace: other, action: "validate", message: "Other project's error" })
		assert.equal((await readCurrentProgress(workspace))?.workspace, workspace)
		assert.equal(await readCurrentProgress(other), null)
		assert.equal(await readLastError(workspace), null)
		assert.equal((await readLastError(other))?.message, "Other project's error")
		assert.notEqual(lastErrorPath(workspace), lastErrorPath(other))
	})

	it("does not resurrect a resolved error, but exposes a new failure even in the same millisecond", async () => {
		sinon.useFakeTimers({ now: new Date("2026-09-27T12:00:00Z"), toFake: ["Date"] })
		await emitProgress("roadmap.validated", { workspace, action: "validate", success: false, payload: { valid: false } })
		assert.equal((await readLastError(workspace))?.string_code, "validate.failed")
		await clearLastError(workspace, "validate")
		assert.equal(await readLastError(workspace), null)
		await emitProgress("roadmap.validated", { workspace, action: "validate", success: false, payload: { valid: false } })
		assert.equal((await readLastError(workspace))?.string_code, "validate.failed")
	})

	it("normal mutation and successful validation do not appear as outstanding errors", async () => {
		await emitProgress("roadmap.validated", { workspace, action: "validate", success: false, payload: { valid: false } })
		await emitProgress("roadmap.validated", { workspace, action: "validate", success: true, payload: { valid: true } })
		await emitProgress("roadmap.file_mutated", { workspace, action: "file_mutated", success: true })
		assert.equal(await readLastError(workspace), null)
	})

	it("successful validation does not clear an unrelated write error", async () => {
		await recordLastError({ workspace, action: "apply_bootstrap_fill", message: "Write denied" })
		await service.validateRoadmap(workspace)
		assert.equal((await readLastError(workspace))?.message, "Write denied")
	})

	it("resolves a transient read error after that operation succeeds", async () => {
		await recordLastError({ workspace, action: "guide", message: "Temporarily unreadable" })
		const result = await service.getOperationalStatus(workspace)
		await journalRoadmapToolCall("guide", workspace, result)
		assert.equal(await readLastError(workspace), null)
	})

	it("reports optional doctor findings without declaring the diagnostic operation failed", async () => {
		const result = await service.runDoctor(workspace)
		assert.equal(result.success, true)
		assert.equal(result.healthy, false) // This fixture intentionally has no optional installed skill.
		assert.equal(result.required_action, null)
		assert.equal(result.agent_next_call, "")
	})

	it("schema findings are successful observations, not runtime failures or new error journal entries", async () => {
		await recordLastError({ workspace, action: "validate", message: "Prior read failed" })
		await fs.writeFile(path.join(workspace, "ROADMAP.md"), "# Incomplete document\n")
		const result = await service.validateRoadmap(workspace)
		assert.equal(result.success, true)
		assert.equal(result.validation.valid, false)
		assert.ok(result.validation.issues.length > 0)
		await journalRoadmapToolCall("validate", workspace, result)
		assert.equal(await readLastError(workspace), null)
		assert.equal(result.required_action, null)
		assert.equal(result.agent_next_call, "")
	})

	it("keeps valid events around a torn journal record and handles a zero limit", async () => {
		await emitProgress("roadmap.guide", { workspace, action: "guide" })
		await fs.appendFile(progressJsonlPath(workspace), "{broken\n")
		await emitProgress("roadmap.watch", { workspace, action: "watch" })
		assert.equal((await readProgressTail(20, workspace)).length, 2)
		assert.deepEqual(await readProgressTail(0, workspace), [])
	})

	it("does not fail a tool when diagnostic storage is unavailable", async () => {
		const blocked = path.join(scratch, "not-a-directory")
		await fs.writeFile(blocked, "occupied")
		process.env.DIETCODE_SESSION_DIR = blocked
		assert.equal((await emitProgress("roadmap.guide", { workspace, action: "guide" })).persisted, false)
		assert.equal((await service.getOperationalStatus(workspace)).success, true)
	})

	it("rejects nested, differently cased and symlink roadmap targets without invoking diagnostics", async () => {
		for (const name of ["docs/ROADMAP.md", "roadmap.md", "../ROADMAP.md"])
			assert.ok(resolveRoadmapWritePath(name, workspace).error)
		assert.equal((await preflightRoadmapWrite("write_to_file", { path: "../RoAdMaP.md" }, workspace)).block, true)
		const outside = path.join(scratch, "outside.md")
		await fs.writeFile(outside, "preserve")
		await fs.unlink(path.join(workspace, "ROADMAP.md"))
		await fs.symlink(outside, path.join(workspace, "ROADMAP.md"))
		assert.equal((await validateRoadmapWriteTarget("ROADMAP.md", workspace)).allowed, false)
		assert.equal((await preflightRoadmapWrite("write_to_file", { path: "ROADMAP.md" }, workspace)).block, true)
		assert.equal(await fs.readFile(outside, "utf8"), "preserve")
	})

	it("does not quarantine ordinary projects whose names contain plugin keywords", () => {
		assert.equal(isQuarantinedWorkspace("/projects/dietcode-plugin-tools"), false)
		assert.equal(isQuarantinedWorkspace("/projects/.vscode/extensions-demo"), false)
		assert.equal(isQuarantinedWorkspace("/users/me/.vscode/extensions/vendor.extension"), true)
	})

	it("checks embedded multi-file patch targets before saving any changes", async () => {
		const provider = {
			isEditing: false,
			reset: sinon.stub().resolves(),
			revertChanges: sinon.stub().resolves(),
			saveChanges: sinon.stub().resolves(),
		}
		const handler = new ApplyPatchHandler({
			checkDietCodeIgnorePath: sinon.stub().resolves({ ok: true }),
		} as unknown as ToolValidator)
		const config = {
			cwd: workspace,
			taskState: { consecutiveMistakeCount: 0 },
			services: { diffViewProvider: provider },
		} as unknown as TaskConfig
		await assert.rejects(
			handler.execute(config, {
				type: "tool_use",
				name: DietCodeDefaultTool.APPLY_PATCH,
				partial: false,
				params: {
					input: "*** Begin Patch\n*** Add File: harmless.txt\n+allowed\n*** Add File: docs/RoAdMaP.md\n+disallowed\n*** End Patch",
				},
			}),
			/ROADMAP.md must live at workspace root/,
		)
		sinon.assert.notCalled(provider.saveChanges)
		await assert.rejects(fs.access(path.join(workspace, "harmless.txt")))
	})

	it("preserves a file created by another writer during bootstrap", async () => {
		await fs.unlink(path.join(workspace, "ROADMAP.md"))
		const original = service.gatherEvidence.bind(service)
		sinon.stub(service, "gatherEvidence").callsFake(async (...args) => {
			const evidence = await original(...args)
			await fs.writeFile(path.join(workspace, "ROADMAP.md"), "User created this during bootstrap")
			return evidence
		})
		assert.equal(await service.autoBootstrapIfNeeded(workspace), null)
		assert.equal(await fs.readFile(path.join(workspace, "ROADMAP.md"), "utf8"), "User created this during bootstrap")
	})

	it("preserves concurrent user edits instead of writing an outdated autofill draft", async () => {
		await fs.writeFile(path.join(workspace, "ROADMAP.md"), bootstrapSkeleton({}))
		sinon.stub(service, "applyBootstrapFillDraft").returns({ applied_count: 1, preview_text: "outdated draft" })
		const original = service.gatherEvidence.bind(service)
		sinon.stub(service, "gatherEvidence").callsFake(async (...args) => {
			const evidence = await original(...args)
			await fs.writeFile(path.join(workspace, "ROADMAP.md"), "User changed this during evidence collection")
			return evidence
		})
		const result = await service.writeBootstrapAutofill(workspace, false)
		assert.equal(result.conflict, true)
		assert.equal(result.written, false)
		assert.equal(
			await fs.readFile(path.join(workspace, "ROADMAP.md"), "utf8"),
			"User changed this during evidence collection",
		)
	})

	it("does not interpret prose about autofill as an instruction to write", async () => {
		const write = sinon.spy(service, "writeBootstrapAutofill")
		await service.checkpointBrief(workspace, "Do not apply autofill write; explain its behavior")
		assert.equal(write.callCount, 0)
	})

	it("validates calendar dates and separates age, project activity, and schema health", () => {
		sinon.useFakeTimers({ now: new Date("2026-09-27T12:00:00Z"), toFake: ["Date"] })
		assert.equal(service.assessFreshness("2026-02-30", [], true, 7, []).reason, "invalid_date")
		assert.equal(service.assessFreshness("2026-12-01", [], true, 7, []).reason, "future_checkpoint_date")
		assert.equal(service.assessFreshness("2026-01-01", [], true, 7, []).stale, false)
		assert.equal(service.assessFreshness("2026-01-01", [], true, 7, [], false).reason, "activity_unknown")
		assert.equal(service.assessFreshness("2026-01-01", ["commit"], true, 7, ["commit"]).stale, true)
		assert.equal(service.assessFreshness("2026-09-27", [], false, 7, []).stale, false)
	})
})
