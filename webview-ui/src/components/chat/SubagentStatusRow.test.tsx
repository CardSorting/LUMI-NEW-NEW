import type { DietCodeMessage } from "@shared/ExtensionMessage"
import { act, fireEvent, render, screen } from "@testing-library/react"
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
	it("shows a recovered interruption as distinct from cancellation and preserves partial work", () => {
		render(<SubagentStatusRow isLast message={message("interrupted")} />)
		expect(screen.getByRole("status")).toHaveTextContent("1 interrupted")
		expect(screen.getByText("interrupted")).toBeVisible()
		expect(screen.queryByText("cancelled")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Show output for Schema review" }))
		expect(screen.getByText("No regressions found")).toBeVisible()
	})
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

	it("does not infer interruption or cancellation from a newer resume message", () => {
		render(
			<SubagentStatusRow
				isLast
				lastModifiedMessage={{ ts: 2, type: "ask", ask: "resume_task" }}
				message={message("running")}
			/>,
		)
		expect(screen.getByText("running")).toBeInTheDocument()
		expect(screen.queryByText("interrupted")).not.toBeInTheDocument()
		expect(screen.queryByText("cancelled")).not.toBeInTheDocument()
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
		expect(screen.getByText("awaiting approval")).toBeVisible()
		expect(screen.queryByText("queued")).not.toBeInTheDocument()
	})

	it.each([
		{ type: "say" as const, partial: true, label: "preparing assignment", summary: "Preparing assignment" },
		{ type: "say" as const, partial: false, label: "not started", summary: "Not started yet" },
		{ type: "ask" as const, partial: false, label: "awaiting approval", summary: "Waiting for approval" },
	])("distinguishes $label from an execution queue", ({ type, partial, label, summary }) => {
		render(
			<SubagentStatusRow
				isLast
				message={{
					ts: 1,
					type,
					...(type === "say" ? { say: "use_subagents" } : { ask: "use_subagents" }),
					partial,
					text: JSON.stringify({ prompts: ["Implement minesweeper"] }),
				}}
			/>,
		)
		expect(screen.getByText(label)).toBeVisible()
		expect(screen.getByRole("status")).toHaveTextContent(`1 helper · ${summary}`)
		expect(screen.queryByText(/queued|0 of 1 completed/)).not.toBeInTheDocument()
	})

	it("updates a queued helper in place with its current work, commentary, and changed files", () => {
		const data = message("pending")
		const { rerender } = render(<SubagentStatusRow isLast message={data} />)
		expect(screen.getByText("Waiting for an available helper slot")).toBeVisible()
		expect(screen.queryByText(/elapsed/)).not.toBeInTheDocument()
		const payload = JSON.parse(data.text!)
		Object.assign(payload.items[0], {
			status: "running",
			activity: { phase: "tool", detail: "Editing src/domain/game.ts" },
			latestMessage: "Safe opening is implemented. I’m adding chording tests.",
			filesModified: ["src/domain/game.ts"],
			recentTools: [
				{ id: "read", label: "Reading src/domain/game.ts", status: "returned" },
				{ id: "edit", label: "Editing src/domain/game.ts", status: "running" },
			],
		})
		rerender(<SubagentStatusRow isLast message={{ ...data, text: JSON.stringify(payload) }} />)
		expect(screen.queryByText("queued")).not.toBeInTheDocument()
		expect(screen.getAllByText("Editing src/domain/game.ts")[0]).toBeVisible()
		expect(screen.getByText("Safe opening is implemented. I’m adding chording tests.")).toBeVisible()
		expect(screen.getByText("Files changed")).toBeVisible()
		expect(screen.getByText("src/domain/game.ts")).toBeVisible()
		fireEvent.click(screen.getByText("Tool results (2)"))
		expect(screen.getByText("Reading src/domain/game.ts")).toBeVisible()
		expect(screen.getByText("Result received")).toBeVisible()
		expect(screen.getByText("In progress")).toBeVisible()
	})

	it("does not describe a previous tool as current work while waiting for the model", () => {
		const data = message("running")
		const payload = JSON.parse(data.text!)
		payload.items[0].activity = { phase: "waiting" }
		payload.items[0].latestToolCall = "read_file(path=src/domain/game.ts)"
		render(<SubagentStatusRow isLast message={{ ...data, text: JSON.stringify(payload) }} />)
		expect(screen.getByText("Waiting for model response")).toBeVisible()
		expect(screen.getByText("Last tool: read_file(path=src/domain/game.ts)")).toBeVisible()
	})

	it("keeps cancelled tool outcomes unconfirmed and preserves the last public update", () => {
		const data = message("cancelled")
		const payload = JSON.parse(data.text!)
		payload.items[0].latestMessage = "Running the chording tests."
		payload.items[0].recentTools = [{ id: "test", label: "Running npm test", status: "running" }]
		render(<SubagentStatusRow isLast message={{ ...data, text: JSON.stringify(payload) }} />)
		fireEvent.click(screen.getByText("Tool results (1)"))
		expect(screen.getByText("Outcome not confirmed")).toBeVisible()
		expect(screen.getByText("Running the chording tests.")).toBeVisible()
		expect(screen.queryByText("In progress")).not.toBeInTheDocument()
	})

	it("ticks elapsed time while a helper waits and stops its timer on completion", () => {
		vi.useFakeTimers()
		try {
			vi.setSystemTime(new Date("2026-09-27T12:00:00Z"))
			const data = message("running")
			const payload = JSON.parse(data.text!)
			payload.items[0].startedAt = Date.now()
			const { rerender, unmount } = render(
				<SubagentStatusRow isLast message={{ ...data, text: JSON.stringify(payload) }} />,
			)
			act(() => vi.advanceTimersByTime(5000))
			expect(screen.getByText("5s elapsed")).toBeVisible()
			Object.assign(payload.items[0], { status: "completed", durationMs: 5200 })
			rerender(<SubagentStatusRow isLast message={{ ...data, text: JSON.stringify(payload) }} />)
			expect(vi.getTimerCount()).toBe(0)
			act(() => vi.advanceTimersByTime(10000))
			expect(screen.getByText("5s elapsed")).toBeVisible()
			unmount()
		} finally {
			vi.useRealTimers()
		}
	})

	it("distinguishes runtime check-ins from actual activity and stops implying liveness when updates go stale", () => {
		vi.useFakeTimers()
		try {
			vi.setSystemTime(new Date("2026-09-27T12:00:00Z"))
			const data = message("running")
			const payload = JSON.parse(data.text!)
			Object.assign(payload.items[0], {
				startedAt: Date.now() - 40000,
				heartbeatAt: Date.now(),
				lastActivityAt: Date.now() - 35000,
				activity: { phase: "waiting", startedAt: Date.now() - 35000, deadlineAt: Date.now() + 60000 },
			})
			const { rerender, container, unmount } = render(
				<SubagentStatusRow isLast message={{ ...data, text: JSON.stringify(payload) }} />,
			)
			expect(screen.getByText(/Runtime is responding/)).toBeVisible()
			expect(screen.getByText("Wait timeout in 1m 00s")).toBeVisible()
			act(() => vi.advanceTimersByTime(12000))
			expect(screen.getByText("updates delayed")).toBeVisible()
			expect(screen.getByText(/running state is not confirmed/)).toBeVisible()
			expect(container.querySelector(".motion-safe\\:animate-spin")).toBeNull()
			payload.items[0].heartbeatAt = Date.now()
			rerender(<SubagentStatusRow isLast message={{ ...data, text: JSON.stringify(payload) }} />)
			expect(screen.queryByText("updates delayed")).not.toBeInTheDocument()
			expect(screen.getByText(/Activity 47s ago/)).toBeVisible()
			unmount()
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it("shows actual actions and command output without opening the assignment or tool history", () => {
		const data = message("running")
		const payload = JSON.parse(data.text!)
		Object.assign(payload.items[0], {
			activityEvents: [
				{ id: "read", at: 1000, kind: "tool", label: "Read game.ts" },
				{ id: "test", at: 2000, kind: "phase", label: "Testing safe openings" },
			],
			commands: [{ id: "cmd", command: "npm test", status: "running", output: "Safe opening: passed\nChording: running" }],
			responseChunks: 42,
			responseBytes: 1000,
		})
		render(<SubagentStatusRow isLast message={{ ...data, text: JSON.stringify(payload) }} />)
		expect(screen.getByText("Read game.ts")).toBeVisible()
		expect(screen.getByText("Testing safe openings")).toBeVisible()
		expect(screen.getByLabelText("Command output: npm test")).toBeVisible()
		expect(screen.getByLabelText("Command output: npm test")).toHaveTextContent("Safe opening: passed")
		expect(screen.getByText(/42 response chunks/)).toBeVisible()
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
