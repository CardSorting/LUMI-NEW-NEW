import type { DietCodeMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import SubagentStatusRow from "./SubagentStatusRow"

vi.mock("../common/MarkdownBlock", () => ({ default: ({ markdown }: { markdown: string }) => <p>{markdown}</p> }))
vi.mock("./ParentAuditGateBadge", () => ({ ParentAuditGateBadge: () => null }))

function message(status: string): DietCodeMessage {
	return {
		ts: 1,
		type: "say",
		say: "subagent",
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
	it.each(["info", "api_req_started"] as const)("keeps helpers running when %s arrives", (say) => {
		render(
			<SubagentStatusRow
				isLast={false}
				lastModifiedMessage={{ ts: 2, type: "say", say, text: "Parent progress" }}
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
	it("lazily displays results with a named, keyboard-accessible disclosure", async () => {
		const user = userEvent.setup()
		render(<SubagentStatusRow isLast message={message("completed")} />)
		expect(screen.getByText("Schema review")).toBeInTheDocument()
		expect(screen.getByText("completed")).toBeInTheDocument()
		const disclosure = screen.getByRole("button", { name: "Show output for Schema review" })
		expect(disclosure).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByText("No regressions found")).not.toBeInTheDocument()
		await user.tab()
		expect(disclosure).toHaveFocus()
		await user.keyboard("{Enter}")
		expect(disclosure).toHaveAttribute("aria-expanded", "true")
		expect(document.getElementById(disclosure.getAttribute("aria-controls")!)).toBeVisible()
		expect(screen.getByText("No regressions found")).toBeVisible()
		await user.keyboard(" ")
		expect(disclosure).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByText("No regressions found")).not.toBeInTheDocument()
	})

	it("keeps failure details available for the parent handoff", () => {
		render(<SubagentStatusRow isLast message={message("failed")} />)
		expect(screen.getByText("failed")).toBeInTheDocument()
		expect(screen.getByText("The required tool is unavailable")).toBeVisible()
		fireEvent.click(screen.getByRole("button", { name: "Show output for Schema review" }))
		expect(screen.getByText("Partial work")).toBeVisible()
		expect(screen.getByText("No regressions found")).toBeVisible()
	})

	it("shows retry attempts and a stable live summary without claiming completion", () => {
		const data = message("running")
		const payload = JSON.parse(data.text!)
		payload.items[0].activity = { phase: "retrying", attempt: 2, maxAttempts: 3 }
		payload.items.push({ id: "next", index: 2, prompt: "Read the next file", status: "pending" })
		data.text = JSON.stringify(payload)
		render(<SubagentStatusRow isLast message={data} />)
		expect(screen.getByText("Retrying · attempt 2 of 3")).toBeVisible()
		expect(screen.getByText("queued")).toBeVisible()
		expect(screen.getByRole("status")).toHaveTextContent("0 of 2 completed · 1 running · 1 queued")
	})

	it("keeps valid helper results visible when another stored entry is malformed", () => {
		const data = message("completed")
		const payload = JSON.parse(data.text!)
		payload.items.unshift(null, { status: "running", prompt: 123 })
		payload.items[2].criticalSignals = { invalid: true }
		data.text = JSON.stringify(payload)
		render(<SubagentStatusRow isLast message={data} />)
		expect(screen.getByText("Schema review")).toBeVisible()
		fireEvent.click(screen.getByRole("button", { name: "Show output for Schema review" }))
		expect(screen.getByText("No regressions found")).toBeVisible()
	})

	it("handles malformed streamed prompts without hiding usable assignments", () => {
		render(
			<SubagentStatusRow
				isLast
				message={{
					ts: 1,
					type: "ask",
					ask: "use_subagents",
					text: JSON.stringify({ prompts: [null, 42, "Read the config"] }),
				}}
			/>,
		)
		expect(screen.getByText("Read the config")).toBeVisible()
		expect(screen.getByText("queued")).toBeVisible()
	})

	it("keeps open results attached to the same helper as stored items change order", () => {
		const data = message("completed")
		const payload = JSON.parse(data.text!)
		const first = payload.items[0]
		const second = { ...first, id: "other", name: "Routing review", result: "Routes checked" }
		data.text = JSON.stringify({ ...payload, items: [first, second] })
		const { rerender } = render(<SubagentStatusRow isLast message={data} />)
		fireEvent.click(screen.getByRole("button", { name: "Show output for Schema review" }))
		rerender(<SubagentStatusRow isLast message={{ ...data, text: JSON.stringify({ ...payload, items: [second, first] }) }} />)
		expect(screen.getByRole("button", { name: "Hide output for Schema review" })).toHaveAttribute("aria-expanded", "true")
		expect(screen.getByRole("button", { name: "Show output for Routing review" })).toHaveAttribute("aria-expanded", "false")
		expect(screen.getByText("No regressions found")).toBeVisible()
		expect(screen.queryByText("Routes checked")).not.toBeInTheDocument()
	})

	it("distinguishes cancelled work from failure and preserves completed sibling results", () => {
		const data = message("completed")
		const payload = JSON.parse(data.text!)
		payload.status = "cancelled"
		payload.items.push({ id: "stopped", prompt: "Check routes", status: "cancelled", error: "Stopped by user" })
		render(<SubagentStatusRow isLast message={{ ...data, text: JSON.stringify(payload) }} />)
		expect(screen.getByRole("status")).toHaveTextContent("1 of 2 completed · 1 cancelled")
		expect(screen.queryByText("failed")).not.toBeInTheDocument()
		expect(screen.getByText("Stopped by user")).toBeVisible()
		fireEvent.click(screen.getByRole("button", { name: "Show output for Schema review" }))
		expect(screen.getByText("No regressions found")).toBeVisible()
	})

	it("shows an understandable fallback for an unreadable status payload", () => {
		render(<SubagentStatusRow isLast message={{ ...message("running"), text: "null" }} />)
		expect(screen.getByText(/Helper status is unavailable/)).toBeVisible()
	})
})
