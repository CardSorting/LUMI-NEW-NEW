import { getSkillsDirectoriesForScan } from "@core/storage/disk"
import type { SkillContent, SkillMetadata } from "@shared/skills"
import { fileExistsAtPath, isDirectory } from "@utils/fs"
import * as fs from "fs/promises"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { parseYamlFrontmatter } from "./frontmatter"

/** Parse YAML frontmatter from markdown content (shared helper). */
function parseFrontmatter(fileContent: string): { data: Record<string, unknown>; content: string } {
	const result = parseYamlFrontmatter(fileContent)
	if (result.parseError) {
		Logger.warn("Failed to parse YAML frontmatter:", result.parseError)
	}
	return { data: result.data, content: result.body }
}

/**
 * Scan a directory for skill subdirectories containing SKILL.md files.
 */
async function scanSkillsDirectory(
	dirPath: string,
	source: "global" | "project",
	signal?: AbortSignal,
): Promise<SkillMetadata[]> {
	const skills: SkillMetadata[] = []

	signal?.throwIfAborted()
	const exists = await fileExistsAtPath(dirPath)
	signal?.throwIfAborted()
	if (!exists) return skills
	const directory = await isDirectory(dirPath)
	signal?.throwIfAborted()
	if (!directory) {
		return skills
	}

	try {
		const entries = await fs.readdir(dirPath)
		signal?.throwIfAborted()

		for (const entryName of entries) {
			signal?.throwIfAborted()
			const entryPath = path.join(dirPath, entryName)
			const stats = await fs.stat(entryPath).catch(() => null)
			signal?.throwIfAborted()
			if (!stats?.isDirectory()) continue

			const skill = await loadSkillMetadata(entryPath, source, entryName, signal)
			if (skill) {
				skills.push(skill)
			}
		}
	} catch (error: unknown) {
		signal?.throwIfAborted()
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EACCES") {
			Logger.warn(`Permission denied reading skills directory: ${dirPath}`)
		}
	}

	return skills
}

/**
 * Load skill metadata from a skill directory.
 */
async function loadSkillMetadata(
	skillDir: string,
	source: "global" | "project",
	skillName: string,
	signal?: AbortSignal,
): Promise<SkillMetadata | null> {
	const skillMdPath = path.join(skillDir, "SKILL.md")
	signal?.throwIfAborted()
	const exists = await fileExistsAtPath(skillMdPath)
	signal?.throwIfAborted()
	if (!exists) return null

	try {
		const fileContent = signal
			? await fs.readFile(skillMdPath, { encoding: "utf-8", signal })
			: await fs.readFile(skillMdPath, "utf-8")
		signal?.throwIfAborted()
		const { data: frontmatter } = parseFrontmatter(fileContent)

		// Validate required fields
		if (!frontmatter.name || typeof frontmatter.name !== "string") {
			Logger.warn(`Skill at ${skillDir} missing required 'name' field`)
			return null
		}
		if (!frontmatter.description || typeof frontmatter.description !== "string") {
			Logger.warn(`Skill at ${skillDir} missing required 'description' field`)
			return null
		}

		// Name must match directory name per spec
		if (frontmatter.name !== skillName) {
			Logger.warn(`Skill name "${frontmatter.name}" doesn't match directory "${skillName}"`)
			return null
		}

		return {
			name: skillName,
			description: frontmatter.description,
			path: skillMdPath,
			source,
		}
	} catch (error) {
		signal?.throwIfAborted()
		Logger.warn(`Failed to load skill at ${skillDir}:`, error)
		return null
	}
}

/**
 * Discover all skills from global (~/.dietcode/skills) and project directories.
 * Returns skills in order: project skills first, then global skills.
 * Global skills take precedence over project skills with the same name.
 */
export async function discoverSkills(cwd: string, signal?: AbortSignal): Promise<SkillMetadata[]> {
	const skills: SkillMetadata[] = []

	signal?.throwIfAborted()
	const scanDirs = getSkillsDirectoriesForScan(cwd)

	for (const dir of scanDirs) {
		signal?.throwIfAborted()
		const dirSkills = await scanSkillsDirectory(dir.path, dir.source, signal)
		skills.push(...dirSkills)
	}

	signal?.throwIfAborted()
	return skills
}

/**
 * Get available skills with override resolution (global > project).
 */
export function getAvailableSkills(skills: SkillMetadata[]): SkillMetadata[] {
	const seen = new Set<string>()
	const result: SkillMetadata[] = []

	// Iterate backwards: global skills (added last) are seen first and take precedence
	for (let i = skills.length - 1; i >= 0; i--) {
		const skill = skills[i]
		if (!seen.has(skill.name)) {
			seen.add(skill.name)
			result.unshift(skill)
		}
	}

	return result
}

/**
 * Get full skill content including instructions.
 */
export async function getSkillContent(
	skillName: string,
	availableSkills: SkillMetadata[],
	signal?: AbortSignal,
): Promise<SkillContent | null> {
	signal?.throwIfAborted()
	const skill = availableSkills.find((s) => s.name === skillName)
	if (!skill) return null

	try {
		const fileContent = signal
			? await fs.readFile(skill.path, { encoding: "utf-8", signal })
			: await fs.readFile(skill.path, "utf-8")
		signal?.throwIfAborted()
		const { data: frontmatter, content: body } = parseFrontmatter(fileContent)
		if (frontmatter.name !== skillName || typeof frontmatter.description !== "string" || !frontmatter.description) {
			Logger.warn(`Skill ${skillName} changed or has invalid metadata; rediscover skills before use.`)
			return null
		}

		return {
			...skill,
			description: frontmatter.description,
			instructions: body.trim(),
		}
	} catch {
		signal?.throwIfAborted()
		return null
	}
}
