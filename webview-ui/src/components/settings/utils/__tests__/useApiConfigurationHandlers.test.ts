import type { ApiConfiguration } from "@shared/api"
import { convertProtoToApiConfiguration } from "@shared/proto-conversions/models/api-configuration-conversion"
import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import { useApiConfigurationHandlers } from "../useApiConfigurationHandlers"

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: vi.fn() }))
vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: { updateApiConfigurationPartial: vi.fn() },
}))

describe("API configuration edits", () => {
	let saved: ApiConfiguration

	beforeEach(() => {
		vi.clearAllMocks()
		saved = {
			planModeApiProvider: "openrouter",
			actModeApiProvider: "openrouter",
			openRouterApiKey: "original-key",
		}
		vi.mocked(useExtensionState).mockReturnValue({
			apiConfiguration: { ...saved },
			planActSeparateModelsSetting: false,
		} as ReturnType<typeof useExtensionState>)
		vi.mocked(ModelsServiceClient.updateApiConfigurationPartial).mockImplementation(async (request) => {
			if (!request.apiConfiguration) throw new Error("Missing configuration")
			const converted = convertProtoToApiConfiguration(request.apiConfiguration)
			for (const field of request.updateMask) {
				;(saved as Record<string, unknown>)[field] = (converted as Record<string, unknown>)[field]
			}
			return {}
		})
	})

	it("does not restore an old provider when a delayed field edit uses an earlier render", async () => {
		const { result } = renderHook(useApiConfigurationHandlers)
		const delayedKeyEdit = result.current.handleFieldChange
		await result.current.handleModeFieldChange(
			{ plan: "planModeApiProvider", act: "actModeApiProvider" },
			"openai-codex",
			"act",
		)
		await delayedKeyEdit("openRouterApiKey", "new-key")

		expect(saved).toMatchObject({
			planModeApiProvider: "openai-codex",
			actModeApiProvider: "openai-codex",
			openRouterApiKey: "new-key",
		})
		expect(ModelsServiceClient.updateApiConfigurationPartial).toHaveBeenLastCalledWith(
			expect.objectContaining({ updateMask: ["openRouterApiKey"] }),
		)
	})

	it("updates only the selected mode when plan and act use separate models", async () => {
		vi.mocked(useExtensionState).mockReturnValue({
			apiConfiguration: saved,
			planActSeparateModelsSetting: true,
		} as ReturnType<typeof useExtensionState>)
		const { result } = renderHook(useApiConfigurationHandlers)
		await result.current.handleModeFieldChange(
			{ plan: "planModeApiProvider", act: "actModeApiProvider" },
			"openai-codex",
			"act",
		)
		expect(saved.planModeApiProvider).toBe("openrouter")
		expect(saved.actModeApiProvider).toBe("openai-codex")
	})

	it("keeps change handlers stable across unrelated extension state updates", () => {
		const { result, rerender } = renderHook(useApiConfigurationHandlers)
		const previous = result.current
		rerender()
		expect(result.current.handleFieldChange).toBe(previous.handleFieldChange)
		expect(result.current.handleFieldsChange).toBe(previous.handleFieldsChange)
		expect(result.current.handleModeFieldChange).toBe(previous.handleModeFieldChange)
		expect(result.current.handleModeFieldsChange).toBe(previous.handleModeFieldsChange)
	})
})
