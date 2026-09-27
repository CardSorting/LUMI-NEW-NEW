import type { TaskAuditMetadata } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PreCompletionGateStrip } from "./PreCompletionGateStrip"

const { options } = vi.hoisted(() => ({
	options: {
		gateEnabled: true,
		scoreThreshold: 50,
		criticalOnly: false,
		intentAdjustedThreshold: false,
		advisoryMetadata: { violations: ["test_warning"] },
	},
}))
vi.mock("@/hooks/useAuditGateEvaluation", () => ({ useAuditGateEvaluation: () => options }))

const metadata = { hardening_score: 20, violations: ["test_warning"] } as unknown as TaskAuditMetadata

describe("PreCompletionGateStrip", () => {
	beforeEach(() => {
		options.criticalOnly = false
	})

	it("distinguishes blocking and advisory navigation and exposes expanded details", () => {
		const blocking = vi.fn()
		const advisory = vi.fn()
		render(
			<PreCompletionGateStrip
				auditMetadata={metadata}
				onScrollToLatestAdvisory={advisory}
				onScrollToLatestGateBlock={blocking}
			/>,
		)
		expect(screen.getByText("Blocked")).toBeInTheDocument()
		const disclosure = screen.getByRole("button", { name: /Before finishing/ })
		expect(disclosure).toHaveAttribute("aria-expanded", "true")
		expect(document.getElementById(disclosure.getAttribute("aria-controls")!)).toBeVisible()
		fireEvent.click(screen.getByRole("button", { name: "View blocking check" }))
		fireEvent.click(screen.getByRole("button", { name: "View advisory notes" }))
		expect(blocking).toHaveBeenCalledOnce()
		expect(advisory).toHaveBeenCalledOnce()
		fireEvent.click(disclosure)
		expect(document.getElementById(disclosure.getAttribute("aria-controls")!)).not.toBeVisible()
	})

	it("labels advisory-only findings as ready and offers no blocking action", () => {
		options.criticalOnly = true
		render(<PreCompletionGateStrip auditMetadata={metadata} onScrollToLatestGateBlock={vi.fn()} />)
		expect(screen.getByText("Ready with warnings")).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "View blocking check" })).not.toBeInTheDocument()
	})
})
