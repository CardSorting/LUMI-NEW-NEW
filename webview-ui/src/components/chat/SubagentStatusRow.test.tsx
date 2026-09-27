import type { DietCodeMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import SubagentStatusRow from "./SubagentStatusRow"

vi.mock("../common/MarkdownBlock", () => ({ default: ({ markdown }: { markdown: string }) => <p>{markdown}</p> }))
vi.mock("./ParentAuditGateBadge", () => ({ ParentAuditGateBadge: () => null }))

function message(status: string): DietCodeMessage {
	return {
		ts: 1,
		type: "say",
		say: "subagent_status",
		text: JSON.stringify({
			status,
			items: [
				{
					id: "helper-1",
					index: 1,
					name: "Schema review",
					prompt: "Review the roadmap schema",
					status,
					result: "No regressions found",
					error: "The required tool is unavailable",
				},
			],
		}),
	} as DietCodeMessage
}

describe("SubagentStatusRow", () => {
	it("keeps helpers running when unrelated progress arrives", () => {
		render(
			<SubagentStatusRow
				isLast={false}
				lastModifiedMessage={{ ts: 2, type: "say", say: "info", text: "Parent progress" }}
				message={message("running")}
			/>,
		)
		expect(screen.getByText("running")).toBeInTheDocument()
		expect(screen.queryByText("cancelled")).not.toBeInTheDocument()
	})

	it("marks interrupted helpers cancelled after a newer task resume", () => {
		render(
			<SubagentStatusRow
				isLast
				lastModifiedMessage={{ ts: 2, type: "ask", ask: "resume_task" }}
				message={message("running")}
			/>,
		)
		expect(screen.getByText("cancelled")).toBeInTheDocument()
	})
	it("shows a named status and keyboard-accessible result disclosure", () => {
		render(<SubagentStatusRow isLast message={message("completed")} />)
		expect(screen.getByText("Schema review")).toBeInTheDocument()
		expect(screen.getByText("completed")).toBeInTheDocument()
		const disclosure = screen.getByRole("button", { name: "Show subagent output" })
		expect(disclosure).toHaveAttribute("aria-expanded", "false")
		fireEvent.click(disclosure)
		expect(disclosure).toHaveAttribute("aria-expanded", "true")
		expect(document.getElementById(disclosure.getAttribute("aria-controls")!)).toBeVisible()
		expect(screen.getByText("No regressions found")).toBeVisible()
	})

	it("keeps failure details available for the parent handoff", () => {
		render(<SubagentStatusRow isLast message={message("failed")} />)
		expect(screen.getByText("failed")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Show subagent output" }))
		expect(screen.getByText("The required tool is unavailable")).toBeVisible()
	})
})
