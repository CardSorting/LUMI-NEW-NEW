import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { DietCodeDefaultTool } from "@/shared/tools"
import { executor } from "../../../ActionExecutor"
import { TaskState } from "../../../TaskState"
import type { TaskConfig } from "../../types/TaskConfig"
import { createUIHelpers } from "../../types/UIHelpers"
import { ToolHookUtils } from "../../utils/ToolHookUtils"
import { AccessMcpResourceHandler } from "../AccessMcpResourceHandler"
import { UseMcpToolHandler } from "../UseMcpToolHandler"

describe("MCP saved server trust", () => {
	afterEach(() => sinon.restore())
	for (const resource of [false, true]) {
		it(`reuses trust during both preview and ${resource ? "resource" : "tool"} execution`, async () => {
			sinon.stub(ToolHookUtils, "runPreToolUseIfEnabled").resolves()
			sinon.stub(executor, "execute").callsFake(async (_id, action) => action(new AbortController().signal))
			const ask = sinon.stub().rejects(new Error("trusted server must not prompt"))
			const operation = sinon
				.stub()
				.resolves(
					resource
						? { contents: [{ text: "resource contents" }] }
						: { content: [{ type: "text", text: "tool result" }] },
				)
			const config = {
				ulid: "test",
				taskState: new TaskState(),
				api: { getModel: () => ({ id: "test", info: {} }) },
				callbacks: {
					ask,
					say: sinon.stub().resolves(),
					shouldAutoApproveTool: () => false,
					removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
				},
				services: {
					stateManager: {
						getTrustedMcpServers: () => ["docs"],
						getApiConfiguration: () => ({}),
						getGlobalSettingsKey: () => "act",
					},
					mcpHub: { connections: [], getPendingNotifications: () => [], callTool: operation, readResource: operation },
				},
			} as unknown as TaskConfig
			const handler = resource ? new AccessMcpResourceHandler() : new UseMcpToolHandler()
			const block = {
				type: "tool_use" as const,
				name: resource ? DietCodeDefaultTool.MCP_ACCESS : DietCodeDefaultTool.MCP_USE,
				params: { server_name: "docs", tool_name: "search", uri: "docs://guide", arguments: "{}" },
				partial: true,
			}
			await handler.handlePartialBlock(block, createUIHelpers(config))
			assert.match(
				String(await handler.execute(config, { ...block, partial: false })),
				resource ? /resource contents/ : /tool result/,
			)
			sinon.assert.notCalled(ask)
			sinon.assert.calledOnce(operation)
		})
	}
})
