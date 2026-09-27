import { strict as assert } from "node:assert"
import { before, describe, it } from "mocha"
import { parseAssistantMessageV2 } from "@/core/assistant-message/parse-assistant-message"
import { ModelFamily } from "@/shared/prompts"
import { DietCodeDefaultTool } from "@/shared/tools"
import { DietCodeToolSet } from "../registry/DietCodeToolSet"
import { toolSpecInputSchema } from "../spec"
import { registerDietCodeToolSets } from "../tools/init"
import type { PromptVariant, SystemPromptContext } from "../types"

describe("command observation tool contract", () => {
	before(() => registerDietCodeToolSets())
	it("exposes an observation companion exactly once for every model family with shell access", () => {
		for (const family of Object.values(ModelFamily)) {
			const variant = { family, tools: [DietCodeDefaultTool.BASH] } as unknown as PromptVariant
			const tools = DietCodeToolSet.getEnabledTools(variant, {} as SystemPromptContext)
			assert.equal(tools.filter((tool) => tool.id === DietCodeDefaultTool.READ_COMMAND_OUTPUT).length, 1, family)
			assert.equal(tools.filter((tool) => tool.id === DietCodeDefaultTool.GET_EXECUTION_STATE).length, 1, family)
			const fallback = DietCodeToolSet.getToolsForVariantWithFallback(family, [
				DietCodeDefaultTool.BASH,
				DietCodeDefaultTool.READ_COMMAND_OUTPUT,
			])
			assert.equal(fallback.filter((tool) => tool.id === DietCodeDefaultTool.READ_COMMAND_OUTPUT).length, 1)
			assert.equal(fallback.filter((tool) => tool.id === DietCodeDefaultTool.GET_EXECUTION_STATE).length, 1)
		}
	})
	it("provides inventory with MCP authority without granting shell execution", () => {
		const tools = DietCodeToolSet.getToolsForVariantWithFallback(ModelFamily.GENERIC, [DietCodeDefaultTool.MCP_USE])
		assert.deepEqual(
			tools.map((tool) => tool.id),
			[DietCodeDefaultTool.MCP_USE, DietCodeDefaultTool.GET_EXECUTION_STATE],
		)
		const tool = DietCodeToolSet.getToolByNameWithFallback(DietCodeDefaultTool.GET_EXECUTION_STATE, ModelFamily.GENERIC)!
		assert.deepEqual(toolSpecInputSchema(tool.config, {} as SystemPromptContext).input_schema.required, [])
		const [block] = parseAssistantMessageV2(
			"<get_execution_state><execution_id>action-1</execution_id></get_execution_state>",
		)
		assert.equal(block.type, "tool_use")
		if (block.type !== "tool_use") throw new Error("Expected tool call")
		assert.equal(block.name, DietCodeDefaultTool.GET_EXECUTION_STATE)
		assert.deepEqual(block.params, { execution_id: "action-1" })
	})
	it("does not expand a toolset without command authority", () => {
		const tools = DietCodeToolSet.getToolsForVariantWithFallback(ModelFamily.GENERIC, [DietCodeDefaultTool.FILE_READ])
		assert.deepEqual(
			tools.map((tool) => tool.id),
			[DietCodeDefaultTool.FILE_READ],
		)
	})
	it("provides an execution ID schema and parses the same handle in XML tool calls", () => {
		const tool = DietCodeToolSet.getToolByNameWithFallback(DietCodeDefaultTool.READ_COMMAND_OUTPUT, ModelFamily.GENERIC)!
		const schema = toolSpecInputSchema(tool.config, {} as SystemPromptContext)
		assert.deepEqual(schema.input_schema.required, ["execution_id"])
		assert.equal((schema.input_schema.properties as Record<string, { type: string }>).timeout.type, "number")
		const [block] = parseAssistantMessageV2(
			"<read_command_output><execution_id>run-1</execution_id><timeout>0</timeout></read_command_output>",
		)
		assert.equal(block.type, "tool_use")
		if (block.type !== "tool_use") throw new Error("Expected tool call")
		assert.equal(block.name, DietCodeDefaultTool.READ_COMMAND_OUTPUT)
		assert.deepEqual(block.params, { execution_id: "run-1", timeout: "0" })
		assert.equal(block.partial, false)
	})
})
