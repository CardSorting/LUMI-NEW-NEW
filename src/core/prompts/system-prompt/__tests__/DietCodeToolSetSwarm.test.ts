import { expect } from "chai"
import { setAgentSwarmConfigOverride } from "@/infrastructure/ai/AgentSwarmConfig"
import { ModelFamily } from "@/shared/prompts"
import { DietCodeDefaultTool } from "@/shared/tools"
import { DietCodeToolSet } from "../registry/DietCodeToolSet"
import { PromptRegistry } from "../registry/PromptRegistry"
import type { PromptVariant, SystemPromptContext } from "../types"

describe("DietCodeToolSet Swarm Discovery", () => {
	before(() => {
		PromptRegistry.getInstance()
	})

	afterEach(() => {
		setAgentSwarmConfigOverride(null)
	})

	const mockVariant: PromptVariant = {
		id: "generic",
		version: 1,
		tags: ["test"],
		description: "Test variant",
		family: ModelFamily.GENERIC,
		tools: [DietCodeDefaultTool.BASH, DietCodeDefaultTool.FILE_READ],
		baseTemplate: "",
		labels: { use_native_tools: 1 },
		componentOrder: [],
		componentOverrides: {},
		placeholders: {},
		matcher: () => true,
		config: {},
	}

	it("includes engage_swarm in enabled tools when agentSwarmLegionEnabled is true and not in snapshot test mode", () => {
		setAgentSwarmConfigOverride({ legionEnabled: true, enabled: true })
		const context: SystemPromptContext = {
			cwd: "/workspace",
			ide: "VSCode",
			providerInfo: { providerId: "anthropic", model: { id: "claude-3-7-sonnet" } } as any,
			isTesting: false,
		}
		const tools = DietCodeToolSet.getEnabledTools(mockVariant, context)
		const toolIds = tools.map((t) => t.id)
		expect(toolIds).to.include(DietCodeDefaultTool.ENGAGE_SWARM)
	})

	it("excludes engage_swarm from enabled tools when isTesting is true (preserving snapshots)", () => {
		setAgentSwarmConfigOverride({ legionEnabled: true, enabled: true })
		const context: SystemPromptContext = {
			cwd: "/workspace",
			ide: "VSCode",
			providerInfo: { providerId: "anthropic", model: { id: "claude-3-7-sonnet" } } as any,
			isTesting: true,
		}
		const tools = DietCodeToolSet.getEnabledTools(mockVariant, context)
		const toolIds = tools.map((t) => t.id)
		expect(toolIds).to.not.include(DietCodeDefaultTool.ENGAGE_SWARM)
	})

	it("excludes engage_swarm from enabled tools when swarm and legion are disabled", () => {
		setAgentSwarmConfigOverride({ legionEnabled: false, enabled: false })
		const context: SystemPromptContext = {
			cwd: "/workspace",
			ide: "VSCode",
			providerInfo: { providerId: "anthropic", model: { id: "claude-3-7-sonnet" } } as any,
			isTesting: false,
		}
		const tools = DietCodeToolSet.getEnabledTools(mockVariant, context)
		const toolIds = tools.map((t) => t.id)
		expect(toolIds).to.not.include(DietCodeDefaultTool.ENGAGE_SWARM)
	})
})
