import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@/shared/AutoApprovalSettings"
import { DietCodeDefaultTool } from "@/shared/tools"
import { AutoApprove, shouldAutoApproveMcp } from "../autoApprove"
import type { TaskConfig } from "../types/TaskConfig"

describe("configured autonomous authority", () => {
	for (const setting of ["yoloModeToggled", "autoApproveAllToggled"]) {
		it(`covers every registered tool with ${setting}`, () => {
			const approver = new AutoApprove({
				getTrustedTools: () => [],
				getGlobalSettingsKey: (key: string) =>
					key === setting || (key === "autoApprovalSettings" ? DEFAULT_AUTO_APPROVAL_SETTINGS : false),
			} as never)
			for (const name of Object.values(DietCodeDefaultTool)) {
				const decision = approver.shouldAutoApproveTool(name)
				assert.equal(Array.isArray(decision) ? decision.every(Boolean) : decision, true, name)
			}
		})
	}
	it("shares saved MCP server trust without authorizing another server", () => {
		const config = {
			callbacks: { shouldAutoApproveTool: () => false },
			services: {
				stateManager: { getTrustedMcpServers: () => ["trusted"] },
				mcpHub: { connections: [] },
			},
		} as unknown as TaskConfig
		for (const tool of [DietCodeDefaultTool.MCP_USE, DietCodeDefaultTool.MCP_ACCESS]) {
			assert.equal(shouldAutoApproveMcp(config, tool, "trusted"), true)
			assert.equal(shouldAutoApproveMcp(config, tool, "untrusted"), false)
		}
	})
	it("honors exact per-tool MCP approval and normalizes false tuples", () => {
		const config = {
			callbacks: { shouldAutoApproveTool: () => [false, false] },
			services: {
				stateManager: { getTrustedMcpServers: () => [] },
				mcpHub: { connections: [{ server: { name: "docs", tools: [{ name: "search", autoApprove: true }] } }] },
			},
		} as unknown as TaskConfig
		assert.equal(shouldAutoApproveMcp(config, DietCodeDefaultTool.MCP_USE, "docs", "search"), true)
		assert.equal(shouldAutoApproveMcp(config, DietCodeDefaultTool.MCP_USE, "docs", "write"), false)
		assert.equal(shouldAutoApproveMcp(config, DietCodeDefaultTool.MCP_ACCESS, "docs"), false)
	})
})
