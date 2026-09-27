import { DietCodeDefaultTool } from "@shared/tools"
import * as path from "path"
import { invalidateRoadmapWorkspaceCache } from "./RoadmapCache"
import { getRoadmapConfig } from "./RoadmapConfig"
import { assertRoadmapWritableTarget } from "./RoadmapDocument"
import { isQuarantinedWorkspace } from "./RoadmapGateCatalog"

function normalizedPath(raw: unknown): string {
	return String(raw || "")
		.trim()
		.replace(/\\/g, "/")
}

export function isRoadmapFilename(filePath: string): boolean {
	return path.basename(normalizedPath(filePath)).toLowerCase() === "roadmap.md"
}

export function targetsRoadmapFile(toolName: string, args: Record<string, unknown> | undefined): boolean {
	if (!args) return false
	const name = (toolName || "").trim().toLowerCase()
	if (name === DietCodeDefaultTool.FILE_NEW || name === DietCodeDefaultTool.FILE_EDIT) {
		return isRoadmapFilename(normalizedPath(args.path))
	}
	if (name === DietCodeDefaultTool.APPLY_PATCH) {
		return isRoadmapFilename(normalizedPath(args.path))
	}
	if (name === DietCodeDefaultTool.DIETCODE_KERNEL && String(args.action || "").toLowerCase() === "patch") {
		return isRoadmapFilename(normalizedPath(args.path))
	}
	return false
}

export function resolveRoadmapWritePath(
	writePath: string,
	workspace: string,
): { resolved: string | null; error: string | null; expected: string } {
	const ws = path.resolve(workspace)
	const raw = normalizedPath(writePath)
	const expected = path.join(ws, "ROADMAP.md")

	if (!raw) {
		return { resolved: null, error: "missing write path", expected }
	}
	if (!isRoadmapFilename(raw)) {
		return { resolved: null, error: "not a ROADMAP.md write", expected }
	}

	const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ws, raw)
	if (candidate !== expected) {
		return {
			resolved: null,
			error: `ROADMAP.md must live at workspace root: ${expected} (got ${candidate})`,
			expected,
		}
	}

	return { resolved: expected, error: null, expected }
}

export async function validateRoadmapWriteTarget(
	writePath: string,
	workspace: string,
	status?: Record<string, unknown>,
): Promise<{
	ok: boolean
	allowed: boolean
	error?: string
	workspace: string
	roadmap_path?: string
	expected_path: string
	bootstrap_incomplete?: boolean
	bootstrap_placeholder_count?: number
	project_steering_brief?: string
}> {
	const ws = path.resolve(workspace)
	const check = resolveRoadmapWritePath(writePath, ws)
	// Path safety must not depend on optional evidence collection or a healthy roadmap schema.
	const liveStatus = status || {}
	const brief = String(liveStatus.steering_brief || liveStatus.project_identity_line || "")
	const bootstrapInc = liveStatus.bootstrap_complete === false
	if (!check.error) {
		try {
			if (isQuarantinedWorkspace(ws)) throw new Error("Open the project workspace, not an installed extension directory")
			await assertRoadmapWritableTarget(ws)
		} catch (error) {
			check.error = error instanceof Error ? error.message : String(error)
		}
	}

	if (check.error) {
		return {
			ok: false,
			allowed: false,
			error: check.error,
			workspace: ws,
			expected_path: check.expected,
			project_steering_brief: brief,
			bootstrap_incomplete: bootstrapInc,
			bootstrap_placeholder_count: liveStatus.bootstrap_placeholder_count as number | undefined,
		}
	}

	return {
		ok: true,
		allowed: true,
		workspace: ws,
		roadmap_path: check.resolved || check.expected,
		expected_path: check.expected,
		project_steering_brief: brief,
		bootstrap_incomplete: bootstrapInc,
		bootstrap_placeholder_count: liveStatus.bootstrap_placeholder_count as number | undefined,
	}
}

export async function roadmapWriteHint(
	toolName: string,
	args: Record<string, unknown> | undefined,
	workspace: string,
): Promise<Record<string, unknown>> {
	// The write already passed its safety check. A post-write hint must not scan the
	// repository, recheck a changed target, or retroactively reject a successful edit.
	return {
		string_code: "roadmap_write_followup",
		roadmap_mode: "advisory",
		preferred_tool: "roadmap",
		preferred_command: "",
		recovery_suggestion: "No roadmap follow-up is required. Continue or finish the assigned task.",
		suggested_slash_command: "",
		next_action: "",
		source_tool: toolName,
		path: normalizedPath(args?.path),
		workspace: path.resolve(workspace),
		roadmap_path: path.join(path.resolve(workspace), "ROADMAP.md"),
		write_rejected: false,
	}
}

export function mergeRoadmapHintIntoResult(result: unknown, hint: Record<string, unknown>): string {
	let parsed: Record<string, unknown>
	if (typeof result === "object" && result !== null && !Array.isArray(result)) {
		parsed = { ...(result as Record<string, unknown>) }
	} else if (typeof result === "string") {
		try {
			const loaded = JSON.parse(result)
			parsed = typeof loaded === "object" && loaded !== null ? { ...loaded } : { result }
		} catch {
			parsed = { result }
		}
	} else {
		parsed = { result }
	}

	parsed._roadmap_write_hint = hint
	const digest = hint.project_steering_digest
	if (typeof digest === "object" && digest !== null) {
		parsed.project_steering_digest = digest
		const identityLine = (digest as Record<string, unknown>).identity_line
		if (typeof identityLine === "string") {
			parsed.project_identity_line = identityLine
		}
	}
	if (hint.write_rejected) {
		parsed._roadmap_write_rejected = true
		parsed.success = false
		parsed.ok = false
	}
	return JSON.stringify(parsed, null, 2)
}

export function parseRoadmapToolAction(args: Record<string, unknown> | undefined): string {
	if (!args) return ""
	return String(args.action || "")
		.trim()
		.toLowerCase()
}

export async function preflightRoadmapWrite(
	toolName: string,
	args: Record<string, unknown> | undefined,
	workspace: string,
): Promise<{ block: boolean; message?: string }> {
	const cfg = getRoadmapConfig()
	if (!cfg.enabled || !cfg.block_writes_outside_workspace || !targetsRoadmapFile(toolName, args)) {
		return { block: false }
	}

	const check = await validateRoadmapWriteTarget(normalizedPath(args?.path), workspace)
	if (check.allowed) {
		return { block: false }
	}

	return {
		block: true,
		message:
			`ROADMAP write blocked — ${check.error || "path outside project workspace"}. ` + `Expected: ${check.expected_path}.`,
	}
}

export async function afterRoadmapWrite(
	toolName: string,
	args: Record<string, unknown> | undefined,
	workspace: string,
): Promise<void> {
	if (!getRoadmapConfig().enabled || !targetsRoadmapFile(toolName, args)) {
		return
	}
	// Content-addressed diagnostics observe the next revision on demand. Successful
	// writes must not wait on journal storage or state reconciliation.
	invalidateRoadmapWorkspaceCache(workspace)
}

export async function appendRoadmapWriteHint(
	toolName: string,
	args: Record<string, unknown> | undefined,
	workspace: string,
	toolResult: unknown,
): Promise<unknown> {
	const cfg = getRoadmapConfig()
	if (!cfg.enabled || !cfg.nudge_on_roadmap_write || !targetsRoadmapFile(toolName, args)) {
		return toolResult
	}
	const hint = await roadmapWriteHint(toolName, args, workspace)
	return mergeRoadmapHintIntoResult(toolResult, hint)
}
