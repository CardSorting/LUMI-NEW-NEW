import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ButtonHTMLAttributes } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AccountServiceClient } from "@/services/grpc-client"
import { OpenAiCodexProvider } from "../providers/OpenAiCodexProvider"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: vi.fn() }))
vi.mock("@/services/grpc-client", () => ({
	AccountServiceClient: {
		refreshOpenAiCodexModels: vi.fn(),
		openAiCodexSignIn: vi.fn(),
		openAiCodexSignOut: vi.fn(),
	},
}))
vi.mock("../utils/useApiConfigurationHandlers", () => ({ useApiConfigurationHandlers: vi.fn() }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({
		children,
		appearance: _appearance,
		...props
	}: ButtonHTMLAttributes<HTMLButtonElement> & { appearance?: string }) => <button {...props}>{children}</button>,
}))
vi.mock("../common/ModelSelector", () => ({
	ModelSelector: ({ selectedModelId }: { selectedModelId: string }) => <output data-testid="model">{selectedModelId}</output>,
}))
vi.mock("../common/ModelInfoView", () => ({ ModelInfoView: () => null }))
vi.mock("../ReasoningEffortSelector", () => ({ default: () => null }))

const catalog = { value: JSON.stringify({ "account-model": { name: "Account model" } }) }

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: Error) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

function mockState(authenticated: boolean) {
	vi.mocked(useExtensionState).mockReturnValue({
		apiConfiguration: { actModeApiProvider: "openai-codex", actModeApiModelId: "saved-model" },
		openAiCodexIsAuthenticated: authenticated,
		openAiCodexAuthInProgress: false,
	} as ReturnType<typeof useExtensionState>)
}

describe("Codex account model requests", () => {
	const handleModeFieldChange = vi.fn().mockResolvedValue(undefined)

	beforeEach(() => {
		vi.clearAllMocks()
		mockState(true)
		vi.mocked(useApiConfigurationHandlers).mockReturnValue({ handleModeFieldChange } as ReturnType<
			typeof useApiConfigurationHandlers
		>)
		vi.mocked(AccountServiceClient.openAiCodexSignOut).mockResolvedValue({})
	})

	it("does not retry a failed model request on unrelated state updates", async () => {
		vi.mocked(AccountServiceClient.refreshOpenAiCodexModels).mockRejectedValue(new Error("Account unavailable"))
		const { rerender } = render(<OpenAiCodexProvider currentMode="act" showModelOptions />)
		expect(await screen.findByRole("alert")).toHaveTextContent("Account unavailable")
		rerender(<OpenAiCodexProvider currentMode="act" showModelOptions />)
		expect(AccountServiceClient.refreshOpenAiCodexModels).toHaveBeenCalledTimes(1)
		fireEvent.click(screen.getByRole("button", { name: "Refresh account models" }))
		await waitFor(() => expect(AccountServiceClient.refreshOpenAiCodexModels).toHaveBeenCalledTimes(2))
	})

	it("discards a model response as soon as sign-out begins, before auth state reaches the UI", async () => {
		const models = deferred<{ value: string }>()
		const signOut = deferred<Record<string, never>>()
		vi.mocked(AccountServiceClient.refreshOpenAiCodexModels).mockReturnValue(models.promise)
		vi.mocked(AccountServiceClient.openAiCodexSignOut).mockReturnValue(signOut.promise)
		render(<OpenAiCodexProvider currentMode="act" showModelOptions />)
		fireEvent.click(screen.getByRole("button", { name: "Sign out" }))
		expect(screen.getByRole("button", { name: "Refresh account models" })).toBeDisabled()
		await act(async () => models.resolve(catalog))
		expect(screen.queryByTestId("model")).not.toBeInTheDocument()
		expect(handleModeFieldChange).not.toHaveBeenCalled()
		await act(async () => signOut.resolve({}))
	})

	it("ignores an old request failure after sign-out and loads a new catalog on sign-in", async () => {
		const oldModels = deferred<{ value: string }>()
		vi.mocked(AccountServiceClient.refreshOpenAiCodexModels)
			.mockReturnValueOnce(oldModels.promise)
			.mockResolvedValueOnce(catalog)
		const { rerender } = render(<OpenAiCodexProvider currentMode="act" showModelOptions />)
		mockState(false)
		rerender(<OpenAiCodexProvider currentMode="act" showModelOptions />)
		await act(async () => oldModels.reject(new Error("Not signed in")))
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
		mockState(true)
		rerender(<OpenAiCodexProvider currentMode="act" showModelOptions />)
		expect(await screen.findByTestId("model")).toHaveTextContent("account-model")
		expect(AccountServiceClient.refreshOpenAiCodexModels).toHaveBeenCalledTimes(2)
	})

	it("does not repair model settings when a request finishes after leaving provider settings", async () => {
		const models = deferred<{ value: string }>()
		vi.mocked(AccountServiceClient.refreshOpenAiCodexModels).mockReturnValue(models.promise)
		const { unmount } = render(<OpenAiCodexProvider currentMode="act" showModelOptions />)
		unmount()
		await act(async () => models.resolve(catalog))
		expect(handleModeFieldChange).not.toHaveBeenCalled()
	})

	it("does not show a stale model repair error after sign-out", async () => {
		const repair = deferred<void>()
		handleModeFieldChange.mockReturnValueOnce(repair.promise)
		vi.mocked(AccountServiceClient.refreshOpenAiCodexModels).mockResolvedValueOnce(catalog)
		render(<OpenAiCodexProvider currentMode="act" showModelOptions />)
		await screen.findByTestId("model")
		expect(handleModeFieldChange).toHaveBeenCalledTimes(1)
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign out" })))
		await act(async () => repair.reject(new Error("Old model update failed")))
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
	})
})
