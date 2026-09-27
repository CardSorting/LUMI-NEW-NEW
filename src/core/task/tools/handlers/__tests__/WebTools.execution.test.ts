import { strict as assert } from "node:assert"
import axios from "axios"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { DietCodeEnv } from "@/config"
import { AuthService } from "@/services/auth/AuthService"
import * as envUtils from "@/services/EnvUtils"
import { FeatureFlagsService } from "@/services/feature-flags"
import * as telemetry from "@/services/telemetry"
import { TaskState } from "../../../TaskState"
import type { TaskConfig } from "../../types/TaskConfig"
import { createUIHelpers } from "../../types/UIHelpers"
import { ToolHookUtils } from "../../utils/ToolHookUtils"
import { ToolResultUtils } from "../../utils/ToolResultUtils"
import { isToolFailure } from "../../utils/toolOutcome"
import { WebFetchToolHandler } from "../WebFetchToolHandler"
import { WebSearchToolHandler } from "../WebSearchToolHandler"

describe("web tool execution", () => {
	afterEach(() => sinon.restore())
	function fixture(approval: boolean | [boolean, boolean] = true) {
		sinon.stub(FeatureFlagsService.prototype, "getWebtoolsEnabled").returns(true)
		sinon.stub(DietCodeEnv, "config").returns({ apiBaseUrl: "https://example.com" } as never)
		sinon.stub(AuthService, "getInstance").returns({ getAuthToken: async () => "test-token" } as AuthService)
		sinon.stub(envUtils, "buildDietCodeExtraHeaders").resolves({})
		sinon
			.stub(telemetry, "telemetryService")
			.value({ captureToolUsage: sinon.stub().rejects(new Error("telemetry unavailable")) })
		sinon.stub(ToolHookUtils, "runPreToolUseIfEnabled").resolves()
		const request = sinon.stub(axios, "post").resolves({ data: { data: { result: "page content", results: [] } } })
		const callbacks = {
			shouldAutoApproveTool: () => approval,
			ask: sinon.stub().rejects(new Error("unexpected approval")),
			say: sinon.stub().resolves(),
			removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
		}
		const config = {
			taskState: new TaskState(),
			callbacks,
			ulid: "test",
			api: { getModel: () => ({ id: "test" }) },
			autoApprover: { shouldAutoApproveTool: () => approval },
			services: {
				stateManager: {
					getApiConfiguration: () => ({ actModeApiProvider: "dietcode" }),
					getGlobalSettingsKey: (key: string) => (key === "mode" ? "act" : true),
				},
			},
		} as unknown as TaskConfig
		return { config, request, callbacks }
	}
	for (const Handler of [WebFetchToolHandler, WebSearchToolHandler]) {
		const handler = new Handler()
		const block = {
			type: "tool_use" as const,
			name: handler.name,
			params: { url: "https://example.com", prompt: "Read page", query: "docs" },
			partial: false,
		}
		it(`${handler.name} previews and executes without an approval flicker`, async () => {
			const { config, request, callbacks } = fixture()
			await handler.handlePartialBlock({ ...block, partial: true }, createUIHelpers(config))
			assert.equal(isToolFailure(await handler.execute(config, block)), false)
			sinon.assert.notCalled(callbacks.ask)
			sinon.assert.calledOnce(request)
			assert.equal(request.firstCall.args[2]?.signal, config.taskState.abortSignal)
		})
		it(`${handler.name} preserves explicit denial for a false approval tuple`, async () => {
			const { config, request, callbacks } = fixture([false, false])
			sinon.stub(ToolResultUtils, "askApprovalAndPushFeedback").resolves(false)
			await handler.handlePartialBlock({ ...block, partial: true }, createUIHelpers(config))
			assert.equal(isToolFailure(await handler.execute(config, block)), true)
			sinon.assert.calledOnce(callbacks.ask)
			sinon.assert.notCalled(request)
		})
		it(`${handler.name} cancels in-flight I/O and reports failures as failures`, async () => {
			const { config, request } = fixture()
			request.rejects(new Error("offline"))
			assert.equal(isToolFailure(await handler.execute(config, block)), true)
			request.callsFake(async (_url, _body, options) => {
				const response = new Promise((_, reject) =>
					options!.signal!.addEventListener!("abort", () => reject(new Error("cancelled"))),
				)
				config.taskState.abort = true
				return response
			})
			assert.match(String(await handler.execute(config, block)), /cancelled/)
			request.resetHistory()
			await handler.execute(config, block)
			sinon.assert.notCalled(request)
		})
	}
})
