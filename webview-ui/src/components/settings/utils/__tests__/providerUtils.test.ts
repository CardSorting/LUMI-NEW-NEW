import type { ApiConfiguration, OpenAiCompatibleModelInfo } from "@shared/api"
import { describe, expect, it } from "vitest"
import { getModeSpecificFields } from "../providerUtils"

describe("provider mode settings", () => {
	it("preserves distinct saved model selections and capabilities in each mode", () => {
		const info: OpenAiCompatibleModelInfo = { contextWindow: 8192, supportsTools: false, systemRole: "developer" }
		const config: ApiConfiguration = {
			planModeOpenAiModelId: "planner",
			actModeOpenAiModelId: "coder",
			planModeOpenAiModelInfo: info,
			planModeOllamaModelId: "local-plan",
			actModeOllamaModelId: "local-act",
			planModeAwsBedrockCustomSelected: false,
			actModeAwsBedrockCustomSelected: true,
			planModeVsCodeLmModelSelector: { vendor: "vendor", family: "planner" },
		}
		expect(getModeSpecificFields(config, "plan")).toMatchObject({
			openAiModelId: "planner",
			openAiModelInfo: info,
			ollamaModelId: "local-plan",
			awsBedrockCustomSelected: false,
			vsCodeLmModelSelector: { vendor: "vendor", family: "planner" },
		})
		expect(getModeSpecificFields(config, "act")).toMatchObject({
			openAiModelId: "coder",
			openAiModelInfo: undefined,
			ollamaModelId: "local-act",
			awsBedrockCustomSelected: true,
		})
	})

	it("keeps missing configuration empty without inventing a provider selection", () => {
		expect(Object.values(getModeSpecificFields(undefined, "act")).every((value) => value === undefined)).toBe(true)
	})
})
