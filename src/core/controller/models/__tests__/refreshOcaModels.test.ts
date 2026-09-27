import { strict as assert } from "node:assert"
import axios from "axios"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import type { IController } from "@/core/controller/types"
import { HostProvider } from "@/hosts/host-provider"
import { OcaAuthService } from "@/services/auth/oca/OcaAuthService"
import type { ApiConfiguration } from "@/shared/api"
import { StringRequest } from "@/shared/proto/dietcode/common"
import { refreshOcaModels } from "../refreshOcaModels"

describe("OCA model configuration refresh", () => {
	beforeEach(() => {
		sinon.stub(OcaAuthService, "getInstance").returns({ getAuthToken: async () => "test-token" } as OcaAuthService)
		sinon.stub(HostProvider, "window").get(() => ({ showMessage: sinon.stub().resolves() }))
		sinon.stub(HostProvider, "env").get(() => ({ getHostVersion: async () => ({ platform: "test", version: "1" }) }))
	})
	afterEach(() => sinon.restore())

	function controller(apiConfiguration: ApiConfiguration = {}) {
		const setGlobalStateBatch = sinon.stub()
		const value = {
			stateManager: {
				getApiConfiguration: () => apiConfiguration,
				getGlobalSettingsKey: (key: string) => (key === "mode" ? "act" : false),
				setGlobalStateBatch,
			},
			postStateToWebview: sinon.stub().resolves(),
		} as unknown as IController
		return { value, setGlobalStateBatch }
	}

	it("keeps saved selections when no usable models are returned", async () => {
		sinon.stub(axios, "get").resolves({ data: { data: [{ litellm_params: {} }] } })
		const { value, setGlobalStateBatch } = controller({ actModeOcaModelId: "saved-model" })
		const result = await refreshOcaModels(value, StringRequest.create({ value: "https://example.invalid" }))
		assert.match(result.error || "", /No usable/)
		sinon.assert.notCalled(setGlobalStateBatch)
	})

	it("repairs obsolete reasoning choices and persists typed model metadata", async () => {
		sinon.stub(axios, "get").resolves({
			data: {
				data: [
					{
						litellm_params: { model: "model-a" },
						model_info: { is_reasoning_model: true, reasoning_effort_options: ["low", "high"] },
					},
				],
			},
		})
		const { value, setGlobalStateBatch } = controller({
			actModeOcaModelId: "model-a",
			actModeOcaReasoningEffort: "obsolete",
			planModeOcaReasoningEffort: "high",
		})
		await refreshOcaModels(value, StringRequest.create({ value: "https://example.invalid" }))
		sinon.assert.calledOnce(setGlobalStateBatch)
		const updates = setGlobalStateBatch.firstCall.args[0]
		assert.equal(updates.actModeOcaReasoningEffort, "low")
		assert.equal(updates.planModeOcaReasoningEffort, "high")
		assert.equal(updates.actModeOcaModelInfo.modelName, "model-a")
	})
})
