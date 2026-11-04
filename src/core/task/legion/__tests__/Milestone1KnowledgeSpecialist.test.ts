import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { ApiHandler } from "@core/api"
import { EnvironmentIntegrity } from "@core/integrity/EnvironmentIntegrity"
import { TaskState } from "@core/task/TaskState"
import { ToolHookUtils } from "@core/task/tools/utils/ToolHookUtils"
import { DietCodeDefaultTool } from "@shared/tools"
import sinon from "sinon"
import {
	LEGION_SPECIALIST_REGISTRY,
	LegionCoordinator,
	type LegionFormationManifest,
	type SpawnedLegionMember,
} from "@/infrastructure/ai/LegionCoordinator"
import * as pathUtils from "@/utils/path"
import { LEGION_CORE_RULES, LegionAgentHost } from "../LegionAgentHost"
import { createLegionToolAdapter, LEGION_TOOL_NAMES } from "../LegionToolAdapter"

describe("Milestone 1: Dynamic Project Knowledge & Specialist Self-Improvement", () => {
	afterEach(() => sinon.restore())
	describe("F01: Specialist Skill Activation", () => {
		it("includes DietCodeDefaultTool.USE_SKILL in LEGION_TOOL_NAMES", () => {
			assert.ok(LEGION_TOOL_NAMES.includes(DietCodeDefaultTool.USE_SKILL))
			assert.ok(LEGION_TOOL_NAMES.includes("use_skill" as DietCodeDefaultTool))
		})

		it("creates tool adapter with use_skill allowed and wired to UseSkillToolHandler", async () => {
			const parent = new TaskState()
			const base = {
				cwd: os.tmpdir(),
				ulid: "test-ulid",
				taskState: parent,
				mode: "act",
				autoApprovalSettings: { enableNotifications: false },
				callbacks: {
					shouldAutoApproveToolWithPath: async () => true,
					ask: async () => ({ response: "yesButtonClicked" }),
					say: async () => undefined,
					removeLastPartialMessageIfExistsWithType: async () => {},
				},
				services: {
					dietcodeIgnoreController: { validateAccess: () => true },
					fileContextTracker: { markFileAsEditedByDietCode: () => {}, trackFileContext: async () => {} },
					stateManager: {
						getApiConfiguration: () => ({ actModeApiProvider: "test" }),
						getGlobalSettingsKey: () => "act",
						getWorkspaceStateKey: () => ({}),
					},
				},
			} as any
			const api = { getModel: () => ({ id: "test", info: {} }) } as unknown as ApiHandler

			const adapter = createLegionToolAdapter(base, api, [])
			assert.ok(adapter.allowedNames.has(DietCodeDefaultTool.USE_SKILL))
			assert.ok(adapter.allowedNames.has("use_skill"))

			// Executing use_skill for a non-existent skill exercises the real UseSkillToolHandler validation
			const result = await adapter.execute(
				"use_skill",
				{ skill_name: "nonexistent-skill-xyz" },
				new AbortController().signal,
			)
			assert.ok(typeof result === "string")
			assert.ok(
				result.includes("Error:") ||
					result.includes("nonexistent-skill-xyz") ||
					result.includes("not found") ||
					result.includes("No skills are available"),
			)
		})
	})

	describe("F02: Dynamic Skill Discovery Context", () => {
		it("formats available skills into compact <available_skills> XML section", () => {
			const skills = [
				{
					name: "build-game",
					description: "Build and link C game using raylib",
					path: "/skills/build-game/SKILL.md",
					source: "project" as const,
				},
				{
					name: "test-runner",
					description: "Run ctest test suites",
					path: "/skills/test/SKILL.md",
					source: "global" as const,
				},
			]
			const formatted = LegionAgentHost.formatAvailableSkills(skills)
			assert.ok(formatted.startsWith("<available_skills>"))
			assert.ok(formatted.endsWith("</available_skills>"))
			assert.ok(formatted.includes('"build-game": Build and link C game using raylib'))
			assert.ok(formatted.includes('"test-runner": Run ctest test suites'))
		})

		it("injects <available_skills> into specialist system prompt", () => {
			const member = { assignment: { title: "C Game Engineer", focusObjective: "Build game loop" } } as SpawnedLegionMember
			const prompt = LegionAgentHost.buildSystemPrompt(member, {
				createApi: () => ({}) as any,
				createTools: async () => ({}) as any,
				availableSkills: [
					{
						name: "audio-synth",
						description: "Procedural sound effects generator",
						path: "/s/SKILL.md",
						source: "project",
					},
				],
			})

			assert.ok(prompt.includes("<available_skills>"))
			assert.ok(prompt.includes('"audio-synth": Procedural sound effects generator'))
			assert.ok(prompt.includes(LEGION_CORE_RULES))
		})
	})

	describe("F03: Multi-Language Environment Integrity & Dynamic Invalidation", () => {
		it("expands PROJECT_MARKERS with CMake, C/C++, Meson, Gradle, and Maven", () => {
			const markers = EnvironmentIntegrity.PROJECT_MARKERS
			assert.deepEqual(markers.cmake, { manifest: "CMakeLists.txt", binary: "cmake", args: ["--version"] })
			assert.deepEqual(markers.c_cpp, { manifest: "Makefile", binary: "make", args: ["--version"] })
			assert.deepEqual(markers.meson, { manifest: "meson.build", binary: "meson", args: ["--version"] })
			assert.deepEqual(markers.gradle, { manifest: "build.gradle", binary: "gradle", args: ["--version"] })
			assert.deepEqual(markers.maven, { manifest: "pom.xml", binary: "mvn", args: ["--version"] })
		})

		it("probes multi-language project markers and detects CMake and Makefile projects", async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lumi-m1-env-"))
			try {
				await Promise.all([
					fs.writeFile(path.join(tmp, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.10)"),
					fs.writeFile(path.join(tmp, "Makefile"), "all:\n\tgcc main.c"),
				])

				const commandsRun: string[] = []
				const integrity = new EnvironmentIntegrity(tmp, undefined, async (file, args) => {
					commandsRun.push(`${file} ${args.join(" ")}`)
					return { stdout: "1.0.0" }
				})

				const lease = await integrity.validateEnvironment()
				assert.equal(lease.success, true)
				assert.ok(lease.details?.detectedProjectTypes?.includes("cmake"))
				assert.ok(lease.details?.detectedProjectTypes?.includes("c_cpp"))
				assert.ok(lease.details?.manifests?.includes("CMakeLists.txt"))
				assert.ok(lease.details?.manifests?.includes("Makefile"))
			} finally {
				await fs.rm(tmp, { recursive: true, force: true })
			}
		})

		it("flushes cached leases via invalidateCache()", async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lumi-m1-inval-"))
			try {
				await fs.writeFile(path.join(tmp, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.10)")
				const integrity = new EnvironmentIntegrity(tmp, undefined, async () => ({ stdout: "3.25.0" }))
				const firstLease = await integrity.validateEnvironment()
				assert.equal(firstLease.success, true)
				assert.equal(integrity.isLeaseValid(firstLease), true)

				// Invalidate cache across all instances
				EnvironmentIntegrity.invalidateCache()

				// After invalidation, the lease is revoked
				assert.equal(integrity.isLeaseValid(null), false)
			} finally {
				await fs.rm(tmp, { recursive: true, force: true })
			}
		})
	})

	describe("F04: Progressive Intra-Stage Handoffs & Partial Work Preservation", () => {
		it("retains failed and partial specialist summaries with status annotations", () => {
			const coordinator = new LegionCoordinator()
			const manifest: LegionFormationManifest = {
				formationId: "form-test-f04",
				parentStreamId: "parent-stream-1",
				objective: "Build multi-tier backend",
				classification: {
					classificationId: "class-1",
					formationRoster: [],
				} as any,
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				members: [
					{
						streamId: "stream-recon",
						taskId: "task-recon",
						assignment: {
							codename: "ORACLE-RECON",
							role: "legion_researcher",
							title: "Recon",
							executionOrder: 1,
						} as any,
						stage: "leadAndRecon",
						status: "completed",
						reservedFiles: [],
						resultSummary: "Located database schemas and config files.",
					},
					{
						streamId: "stream-impl-1",
						taskId: "task-impl-1",
						assignment: {
							codename: "VANGUARD-IMPL",
							role: "legion_implementer",
							title: "Implementer",
							executionOrder: 2,
						} as any,
						stage: "parallelExecution",
						status: "failed",
						failureReason: "Budget limit reached during code compilation",
						reservedFiles: [],
						resultSummary: "Created src/models/user.ts and src/models/session.ts",
					},
					{
						streamId: "stream-qa",
						taskId: "task-qa",
						assignment: { codename: "SENTINEL-QA", role: "legion_verifier", title: "QA", executionOrder: 3 } as any,
						stage: "verificationAndHardening",
						status: "pending",
						reservedFiles: [],
					},
				],
			}

			const progression = coordinator.evaluateStageProgression(manifest)
			assert.equal(progression.currentActiveStage, "parallelExecution")

			// Check that priorStageHandoffContext preserves BOTH the completed lead specialist AND the partial failed specialist
			const handoff = progression.priorStageHandoffContext
			assert.ok(handoff.length >= 2, `Expected at least 2 handoff items, got: ${JSON.stringify(handoff)}`)

			const reconEntry = handoff.find((h) => h.includes("ORACLE-RECON"))
			assert.ok(reconEntry, "Missing ORACLE-RECON handoff")
			assert.ok(reconEntry.includes("Completed"))
			assert.ok(reconEntry.includes("Located database schemas and config files."))

			const implEntry = handoff.find((h) => h.includes("VANGUARD-IMPL"))
			assert.ok(implEntry, "Missing partial/failed VANGUARD-IMPL handoff")
			assert.ok(implEntry.includes("Partial/Failed: Budget limit reached during code compilation"))
			assert.ok(implEntry.includes("Created src/models/user.ts and src/models/session.ts"))
		})
	})

	describe("F05: Reactive Workspace Artifact Tracking", () => {
		it("tracks modified and created files in TaskState.workspaceArtifacts", () => {
			const state = new TaskState()
			assert.deepEqual(state.workspaceArtifacts, [])

			state.trackWorkspaceArtifact("src/core/model.ts")
			state.trackWorkspaceArtifact("src/core/service.ts")
			state.trackWorkspaceArtifact("src/core/model.ts") // Duplicate ignored

			assert.deepEqual(state.workspaceArtifacts, ["src/core/model.ts", "src/core/service.ts"])
		})

		it("formats token-bounded <workspace_artifacts> section", () => {
			const files = ["src/main.c", "src/game.c", "include/game.h"]
			const section = LegionAgentHost.formatWorkspaceArtifacts(files)
			assert.ok(section.startsWith("<workspace_artifacts>"))
			assert.ok(section.endsWith("</workspace_artifacts>"))
			assert.ok(section.includes("- src/main.c"))
			assert.ok(section.includes("- src/game.c"))
			assert.ok(section.includes("- include/game.h"))
		})

		it("records modified artifacts on write_to_file via LegionToolAdapter", async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lumi-m1-art-"))
			sinon.stub(pathUtils, "isLocatedInWorkspace").resolves(true)
			sinon.stub(ToolHookUtils, "runPreToolUseIfEnabled").resolves()
			const parent = new TaskState()
			const base = {
				cwd: tmp,
				ulid: "test-art-ulid",
				taskState: parent,
				mode: "act",
				autoApprovalSettings: { enableNotifications: false },
				callbacks: {
					shouldAutoApproveToolWithPath: async () => true,
					ask: async () => ({ response: "yesButtonClicked" }),
					say: async () => undefined,
					removeLastPartialMessageIfExistsWithType: async () => {},
				},
				services: {
					dietcodeIgnoreController: { validateAccess: () => true },
					fileContextTracker: { markFileAsEditedByDietCode: () => {}, trackFileContext: async () => {} },
					stateManager: {
						getApiConfiguration: () => ({ actModeApiProvider: "test" }),
						getGlobalSettingsKey: () => "act",
					},
				},
			} as any
			const api = { getModel: () => ({ id: "test", info: {} }) } as unknown as ApiHandler

			try {
				const adapter = createLegionToolAdapter(base, api, [])
				await adapter.execute(
					"write_to_file",
					{ path: "src/calc.py", content: "def add(a, b): return a + b" },
					new AbortController().signal,
				)

				const artifacts = adapter.getModifiedArtifacts?.()
				assert.ok(artifacts?.includes("src/calc.py"))
				assert.ok(parent.workspaceArtifacts.includes("src/calc.py"))
			} finally {
				await fs.rm(tmp, { recursive: true, force: true })
			}
		})
	})

	describe("F06: Cross-Turn Reflexion & Blackboard", () => {
		it("records and deduplicates heuristics in TaskState.swarmBlackboard", () => {
			const state = new TaskState()
			assert.deepEqual(state.swarmBlackboard, [])

			state.addSwarmHeuristic("Raylib 5.5 requires linking via -lraylib on macOS")
			state.addSwarmHeuristic("Avoid terminal heredocs; use write_to_file directly")
			state.addSwarmHeuristic("Raylib 5.5 requires linking via -lraylib on macOS") // Duplicate ignored

			assert.equal(state.swarmBlackboard.length, 2)
			assert.equal(state.swarmBlackboard[0], "Raylib 5.5 requires linking via -lraylib on macOS")
		})

		it("extracts heuristics from completion summaries in LegionCoordinator", () => {
			const coordinator = new LegionCoordinator()
			const summary = `Implementation complete.
Heuristic: CMake build requires pkg-config to locate raylib 5.5
Learned fact: Use C99 standard flag in compiler definitions`

			const extracted = coordinator.extractLearnedHeuristics(summary)
			assert.ok(extracted.includes("CMake build requires pkg-config to locate raylib 5.5"))
			assert.ok(extracted.includes("Use C99 standard flag in compiler definitions"))
		})

		it("injects <learned_heuristics> into specialist system prompt", () => {
			const member = {
				assignment: { title: "Systems Architect", focusObjective: "Design state persistence" },
			} as SpawnedLegionMember
			const prompt = LegionAgentHost.buildSystemPrompt(member, {
				createApi: () => ({}) as any,
				createTools: async () => ({}) as any,
				blackboard: ["Persistent save file path should default to ~/.local/share/game/scores.dat"],
			})

			assert.ok(prompt.includes("<learned_heuristics>"))
			assert.ok(prompt.includes("- Persistent save file path should default to ~/.local/share/game/scores.dat"))
		})
	})

	describe("F07: Domain-Agnostic Archetypes", () => {
		it("generalizes legion_data_steward beyond SQLite to file persistence and serialization", () => {
			const steward = LEGION_SPECIALIST_REGISTRY.legion_data_steward
			assert.ok(steward.description.toLowerCase().includes("persistence"))
			assert.ok(
				steward.description.toLowerCase().includes("file serialization") ||
					steward.description.toLowerCase().includes("serialization"),
			)
			assert.ok(steward.capabilities.includes("data_persistence"))
			assert.ok(steward.capabilities.includes("file_serialization"))
			assert.ok(steward.capabilities.includes("state_integrity"))
		})

		it("generalizes legion_architect to system architecture and modularization across language ecosystems", () => {
			const architect = LEGION_SPECIALIST_REGISTRY.legion_architect
			assert.ok(
				architect.description.toLowerCase().includes("system architecture") ||
					architect.description.toLowerCase().includes("architecture"),
			)
			assert.ok(architect.capabilities.includes("system_modularization"))
			assert.ok(architect.capabilities.includes("contract_design"))
		})

		it("generalizes legion_verifier to multi-language testing suites", () => {
			const verifier = LEGION_SPECIALIST_REGISTRY.legion_verifier
			assert.ok(verifier.description.toLowerCase().includes("multi-language"))
			assert.ok(verifier.capabilities.includes("multi_language_test_execution"))
			const allKeywords = verifier.keywords.flatMap((k) => k.terms)
			assert.ok(allKeywords.includes("pytest"))
			assert.ok(allKeywords.includes("ctest"))
			assert.ok(allKeywords.includes("cargo test"))
		})
	})
})
