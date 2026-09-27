import { combineCommandSequences } from "@shared/combineCommandSequences"
import type { CommandExecutionState, DietCodeMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { FileServiceClient, TaskServiceClient } from "@/services/grpc-client"
import { CommandOutputContent, CommandOutputRow } from "./CommandOutputRow"

vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: { openFile: vi.fn().mockResolvedValue({}) },
	TaskServiceClient: { controlCommand: vi.fn().mockResolvedValue({}) },
}))

const message = (commandExecution?: CommandExecutionState): DietCodeMessage => ({
	ts: 1,
	type: "say",
	say: "command",
	text: "npm test",
	commandExecution,
})
const row = (data: DietCodeMessage) => (
	<CommandOutputRow isOutputFullyExpanded={false} message={data} setIsOutputFullyExpanded={() => {}} />
)

describe("terminal command presentation", () => {
	it.each([
		[{ status: "running" }, "Running"],
		[{ status: "background" }, "Running in terminal"],
		[{ status: "unknown" }, "Status unavailable"],
		[{ status: "stopping" }, "Stop requested"],
		[{ status: "stop_failed" }, "Could not stop"],
		[{ status: "cancelled" }, "Stopped"],
		[{ status: "completed", exitCode: 0 }, "Completed · exit 0"],
		[{ status: "failed", exitCode: 2 }, "Failed · exit 2"],
		[{ status: "completed" }, "Finished · exit unknown"],
		[{ status: "completed", terminalClosed: true }, "Terminal closed · exit unknown"],
	] as [CommandExecutionState, string][])("shows authoritative status %j", (state, label) => {
		render(row(message(state)))
		expect(screen.getByRole("status")).toHaveTextContent(label)
	})
	it("explains unconfirmed cancellation without claiming the process stopped", () => {
		render(row(message({ status: "stopping" })))
		expect(screen.getByText(/command may still be running/)).toBeVisible()
	})
	it("opens and stops exactly the command represented by the row", async () => {
		render(row(message({ status: "background", executionId: "run-1", taskId: "task-1", terminalId: 4 })))
		const open = screen.getByRole("button", { name: "Open terminal" })
		open.focus()
		expect(open).toHaveFocus()
		fireEvent.click(open)
		await waitFor(() =>
			expect(TaskServiceClient.controlCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					taskId: "task-1",
					executionId: "run-1",
					action: "show",
				}),
			),
		)
		fireEvent.click(screen.getByRole("button", { name: "Stop command" }))
		await waitFor(() => expect(screen.getByRole("button", { name: "Stop requested" })).toBeDisabled())
		expect(TaskServiceClient.controlCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				executionId: "run-1",
				action: "stop",
			}),
		)
		expect(screen.getByRole("status")).not.toHaveTextContent("Stopped")
	})
	it("keeps terminal inspection available during an unconfirmed stop", () => {
		render(row(message({ status: "stopping", executionId: "run", taskId: "task" })))
		expect(screen.getByRole("button", { name: "Stop requested" })).toBeDisabled()
		expect(screen.getByRole("button", { name: "Open terminal" })).toBeEnabled()
	})
	it("shows control errors and allows an explicit stop retry", async () => {
		vi.mocked(TaskServiceClient.controlCommand).mockRejectedValueOnce(new Error("Command no longer tracked"))
		render(row(message({ status: "stop_failed", executionId: "run", taskId: "task" })))
		fireEvent.click(screen.getByRole("button", { name: "Retry stop" }))
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Command no longer tracked"))
		expect(screen.getByRole("button", { name: "Retry stop" })).toBeEnabled()
	})
	it("deduplicates clicks and restores retry when the host reports stop failure", async () => {
		let finish!: (value: object) => void
		vi.mocked(TaskServiceClient.controlCommand)
			.mockClear()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve
					}),
			)
		const { rerender } = render(row(message({ status: "background", executionId: "run", taskId: "task" })))
		const button = screen.getByRole("button", { name: "Stop command" })
		fireEvent.click(button)
		fireEvent.click(button)
		expect(TaskServiceClient.controlCommand).toHaveBeenCalledTimes(1)
		expect(screen.getByRole("button", { name: "Open terminal" })).toBeEnabled()
		rerender(row(message({ status: "stop_failed", executionId: "run", taskId: "task" })))
		finish({})
		await waitFor(() => expect(screen.getByRole("button", { name: "Retry stop" })).toBeEnabled())
	})
	it("does not expose controls for completed or restored commands", () => {
		const { rerender } = render(row(message({ status: "completed", executionId: "old-run", taskId: "task", exitCode: 0 })))
		expect(screen.queryByRole("button", { name: "Open terminal" })).not.toBeInTheDocument()
		rerender(row(message({ status: "unknown", detail: "Task reopened. Check View → Terminal." })))
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
		expect(screen.getByText("Task reopened. Check View → Terminal.")).toBeVisible()
	})
	it("keeps startup failures actionable", () => {
		render(row(message({ status: "not_started", detail: "Terminal launch queue timed out. Inspect existing commands." })))
		expect(screen.getByText(/Inspect existing commands/)).toBeVisible()
	})
	it("does not display an old approval request once the command is running", () => {
		render(row({ ...message({ status: "running" }), text: "npm testREQ_APP" }))
		expect(screen.queryByText(/wait for your okay/)).not.toBeInTheDocument()
	})
	it("keeps command text and literal output separate, including Markdown fences and Output: in arguments", () => {
		const command = 'printf "Output: ``` <div> 工具"'
		const output = "  indented output\n```\n# not a heading\n100%"
		const [combined] = combineCommandSequences([
			{ ...message({ status: "completed", exitCode: 0 }), text: command },
			{ ts: 2, type: "say", say: "command_output", text: output },
		])
		render(row(combined))
		const code = document.querySelectorAll("pre code")
		expect(code[0].textContent).toBe(command)
		expect(code[1].textContent).toBe(output)
		expect(screen.queryByRole("heading")).not.toBeInTheDocument()
	})
	it("provides a keyboard accessible output log button and visible open errors", async () => {
		vi.mocked(FileServiceClient.openFile).mockRejectedValueOnce(new Error("File no longer exists"))
		render(
			<CommandOutputContent
				isContainerExpanded
				isOutputFullyExpanded
				onToggle={() => {}}
				output={"Full captured output saved to: /tmp/build log.txt"}
			/>,
		)
		const button = screen.getByRole("button", { name: /Open output log/ })
		button.focus()
		expect(button).toHaveFocus()
		fireEvent.click(button)
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("File no longer exists"))
		expect(FileServiceClient.openFile).toHaveBeenCalledWith(expect.objectContaining({ value: "/tmp/build log.txt" }))
	})
})
