import { COMPLETION_REVIEW_ERRORS, type CompletionReview } from "@shared/CompletionReview"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { completionWalkthroughs } from "@/services/completion-walkthrough"
import { TaskServiceClient } from "@/services/grpc-client"
import { CompletionOutputRow } from "./CompletionOutputRow"

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: { taskCompletionViewChanges: vi.fn(), streamExplainChanges: vi.fn() },
}))
vi.mock("../common/MarkdownBlock", () => ({ default: ({ markdown }: { markdown: string }) => <div>{markdown}</div> }))
vi.mock("./AuditReportPanel", () => ({ AuditReportPanel: () => <div>Audit report</div> }))

const review: CompletionReview = {
	schemaVersion: 1,
	attempt: 2,
	priorBlocks: 1,
	checks: [
		{ id: "checklist", status: "passed", detail: "2 of 2 items marked complete." },
		{ id: "audit", status: "not_run", detail: "Not enabled for this task." },
		{ id: "review", status: "passed", detail: "Confirmed on a second completion attempt." },
	],
}

function fixture(extra: Partial<React.ComponentProps<typeof CompletionOutputRow>> = {}) {
	const props = {
		text: "The completion messages are readable. Regression checks passed.",
		messageTs: 42,
		completionReview: review,
		showActionRow: true,
		seeNewChangesDisabled: false,
		setSeeNewChangesDisabled: vi.fn(),
		...extra,
	}
	return { ...render(<CompletionOutputRow {...props} />), props }
}

describe("completion review experience", () => {
	beforeEach(() => {
		completionWalkthroughs.dispose()
		vi.clearAllMocks()
		vi.mocked(TaskServiceClient.streamExplainChanges).mockReturnValue(vi.fn())
		vi.spyOn(console, "error").mockImplementation(() => {})
	})
	afterEach(() => {
		expect(vi.mocked(console.error).mock.calls.some(([message]) => String(message).includes("same key"))).toBe(false)
		completionWalkthroughs.dispose()
		vi.restoreAllMocks()
	})

	it("keeps streamed output a draft and hides final controls and passed checks", () => {
		fixture({ partial: true })
		expect(screen.getByRole("heading", { name: "Preparing result" })).toBeInTheDocument()
		expect(screen.getByRole("region", { name: "Task result" })).toHaveAttribute("aria-busy", "true")
		expect(screen.queryByText("Task complete")).not.toBeInTheDocument()
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
	})

	it("offers a compact summary, keyboard disclosure, and one copy action", async () => {
		const user = userEvent.setup()
		fixture()
		expect(screen.getByText("2 passed · 1 not run")).toBeInTheDocument()
		expect(screen.getAllByRole("button", { name: "Copy result" })).toHaveLength(1)
		const disclosure = screen.getByRole("button", { name: /Completion checks/ })
		expect(disclosure).toHaveAttribute("aria-expanded", "false")
		disclosure.focus()
		await user.keyboard("{Enter}")
		expect(disclosure).toHaveAttribute("aria-expanded", "true")
		expect(document.getElementById(disclosure.getAttribute("aria-controls")!)).toBeVisible()
		expect(screen.getByText("Not enabled for this task.")).toBeVisible()
		expect(screen.getByText(/Earlier completion blockers were resolved/)).toBeVisible()
		await user.keyboard(" ")
		expect(disclosure).toHaveAttribute("aria-expanded", "false")
	})

	it("opens unresolved command details and never counts them as passed", () => {
		fixture({
			completionReview: { ...review, checks: [{ id: "demo", status: "running", detail: "Still running at completion." }] },
		})
		expect(screen.getByText("1 running")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: /Completion checks/ })).toHaveAttribute("aria-expanded", "true")
		expect(screen.queryByText(/\d passed/)).not.toBeInTheDocument()
	})

	it("keeps legacy results usable without claiming missing verification", () => {
		fixture({ completionReview: undefined, showActionRow: false })
		expect(screen.getByText(/Check details weren’t recorded/)).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: /Review changes/ })).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Copy result" })).toBeEnabled()
	})

	it("explains unavailable snapshots without suggesting a futile retry", async () => {
		vi.mocked(TaskServiceClient.streamExplainChanges).mockImplementationOnce((_request, callbacks) => {
			callbacks.onError?.(new Error(COMPLETION_REVIEW_ERRORS.snapshotUnavailable))
			return vi.fn()
		})
		fixture()
		fireEvent.click(screen.getByRole("button", { name: "Explain changes" }))
		expect(await screen.findByRole("alert")).toHaveTextContent(COMPLETION_REVIEW_ERRORS.snapshotUnavailable)
		expect(screen.getByRole("button", { name: "Explain changes" })).toBeEnabled()
	})

	it("prevents duplicate diff requests, exposes errors, and allows a retry", async () => {
		const service = vi.mocked(TaskServiceClient.taskCompletionViewChanges)
		let reject!: (reason: Error) => void
		service.mockImplementationOnce(
			() =>
				new Promise((_, fail) => {
					reject = fail
				}),
		)
		service.mockResolvedValueOnce({})
		const { props } = fixture()
		const button = screen.getByRole("button", { name: "Review changes" })
		fireEvent.click(button)
		fireEvent.click(button)
		expect(service).toHaveBeenCalledTimes(1)
		expect(button).toHaveAttribute("aria-busy", "true")
		expect(button).toBeDisabled()
		await act(async () => reject(new Error("offline")))
		expect(screen.getByRole("alert")).toHaveTextContent("Try Review changes again")
		fireEvent.click(screen.getByRole("button", { name: "Review changes" }))
		await waitFor(() => expect(service).toHaveBeenCalledTimes(2))
		await waitFor(() => expect(screen.getByRole("button", { name: "Review changes" })).toBeEnabled())
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
		expect(props.setSeeNewChangesDisabled).toHaveBeenLastCalledWith(false)
	})

	it("shows live walkthrough progress, keeps review available, and stops with the keyboard", async () => {
		const user = userEvent.setup()
		fixture()
		const button = screen.getByRole("button", { name: "Explain changes" })
		await user.click(button)
		const service = vi.mocked(TaskServiceClient.streamExplainChanges)
		const callbacks = service.mock.calls[0][1]
		act(() =>
			callbacks.onResponse({
				phase: "generating",
				filesTotal: 3,
				filesExplained: 1,
				commentCount: 2,
				currentFile: "src/日本語.ts",
			}),
		)
		expect(screen.getByText("2 explanations added across 1 file.")).toBeVisible()
		expect(screen.getByText("src/日本語.ts")).toBeVisible()
		expect(screen.getByRole("button", { name: "Review changes" })).toBeEnabled()
		expect(screen.getByRole("button", { name: "Stop walkthrough" })).toHaveFocus()
		await user.keyboard("{Enter}")
		expect(service.mock.results[0].value).toHaveBeenCalledTimes(1)
		expect(screen.getByText("Generation stopped")).toBeVisible()
		expect(screen.getByRole("button", { name: "Explain changes" })).toHaveFocus()
		act(() => callbacks.onError?.(new Error("late network failure")))
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
	})

	it("retains progress when a virtualized result unmounts and prevents duplicate generation", () => {
		const first = fixture()
		fireEvent.click(screen.getByRole("button", { name: "Explain changes" }))
		const service = vi.mocked(TaskServiceClient.streamExplainChanges)
		first.unmount()
		fixture()
		expect(screen.getByRole("button", { name: "Stop walkthrough" })).toBeEnabled()
		expect(service).toHaveBeenCalledTimes(1)
		expect(service.mock.results[0].value).not.toHaveBeenCalled()
	})

	it("shows the terminal outcome and makes regeneration explicit", () => {
		fixture()
		fireEvent.click(screen.getByRole("button", { name: "Explain changes" }))
		const callbacks = vi.mocked(TaskServiceClient.streamExplainChanges).mock.calls[0][1]
		act(() => {
			callbacks.onResponse({ phase: "complete", filesTotal: 3, filesExplained: 2, commentCount: 3, currentFile: "" })
			callbacks.onComplete?.()
		})
		expect(screen.getByText("Walkthrough ready")).toBeVisible()
		expect(screen.getByRole("button", { name: "Explain again" })).toBeEnabled()
	})

	it("keeps completed explanations visible after a stream error and offers retry", () => {
		fixture()
		fireEvent.click(screen.getByRole("button", { name: "Explain changes" }))
		const service = vi.mocked(TaskServiceClient.streamExplainChanges)
		const callbacks = service.mock.calls[0][1]
		act(() => {
			callbacks.onResponse({ phase: "generating", filesTotal: 3, filesExplained: 1, commentCount: 1, currentFile: "" })
			callbacks.onError?.(new Error("provider unavailable"))
		})
		expect(screen.getByRole("alert")).toHaveTextContent("Explanations already added remain in the diff.")
		fireEvent.click(screen.getByRole("button", { name: "Explain changes" }))
		expect(service).toHaveBeenCalledTimes(2)
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
	})
})
