import { act, fireEvent, render, screen } from "@testing-library/react"
import type { InputHTMLAttributes } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useExtensionState } from "@/context/ExtensionStateContext"
import ApiOptions from "../ApiOptions"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: vi.fn() }))
vi.mock("../utils/useApiConfigurationHandlers", () => ({ useApiConfigurationHandlers: vi.fn() }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children: _children, ...props }: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))
vi.mock("../providers/OpenAiCodexProvider", () => ({ OpenAiCodexProvider: () => null }))
vi.mock("../providers/OpenRouterProvider", () => ({ OpenRouterProvider: () => null }))
vi.mock("../providers/ClaudeSubscriptionDirectSdkProvider", () => ({ ClaudeSubscriptionDirectSdkProvider: () => null }))
vi.mock("../providers/CloudflareProvider", () => ({ CloudflareProvider: () => null }))
vi.mock("../providers/NousresearchProvider", () => ({ NousResearchProvider: () => null }))

describe("API provider selection", () => {
	const handleModeFieldChange = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(useExtensionState).mockReturnValue({
			apiConfiguration: { actModeApiProvider: "openai-codex" },
		} as ReturnType<typeof useExtensionState>)
		vi.mocked(useApiConfigurationHandlers).mockReturnValue({ handleModeFieldChange } as ReturnType<
			typeof useApiConfigurationHandlers
		>)
		Element.prototype.scrollIntoView = vi.fn()
	})

	it("displays the saved provider without selecting the first available option", () => {
		render(<ApiOptions currentMode="act" showModelOptions />)
		expect(screen.getByRole("combobox")).toHaveValue("OpenAI Codex (ChatGPT subscription)")
		fireEvent.focus(screen.getByRole("combobox"))
		fireEvent.mouseDown(document.body)
		expect(screen.getByRole("combobox")).toHaveValue("OpenAI Codex (ChatGPT subscription)")
		expect(handleModeFieldChange).not.toHaveBeenCalled()
	})

	it("shows a failed provider save and preserves the current selection", async () => {
		handleModeFieldChange.mockRejectedValueOnce(new Error("Provider could not be saved"))
		render(<ApiOptions currentMode="act" showModelOptions />)
		fireEvent.focus(screen.getByRole("combobox"))
		await act(async () => fireEvent.click(screen.getByTestId("provider-option-openrouter")))
		expect(screen.getByRole("alert")).toHaveTextContent("Provider could not be saved")
		expect(screen.getByRole("combobox")).toHaveValue("OpenAI Codex (ChatGPT subscription)")
		expect(screen.getByRole("combobox")).not.toBeDisabled()
	})

	it("does not reuse the previous result index when a search changes", () => {
		render(<ApiOptions currentMode="act" showModelOptions />)
		const input = screen.getByRole("combobox")
		fireEvent.focus(input)
		fireEvent.keyDown(input, { key: "ArrowDown" })
		fireEvent.input(input, { target: { value: "Codex" } })
		fireEvent.keyDown(input, { key: "Enter" })
		expect(handleModeFieldChange).not.toHaveBeenCalled()
	})
})
