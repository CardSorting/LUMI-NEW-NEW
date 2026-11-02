import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import FeatureSettingsSection from "./FeatureSettingsSection"

const fixture = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
	update: vi.fn(),
	updateBatch: vi.fn(),
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => fixture.state }))
vi.mock("../utils/settingsHandlers", () => ({
	updateSetting: (...args: unknown[]) => fixture.update(...args),
	updateSettingsBatch: (...args: unknown[]) => fixture.updateBatch(...args),
}))

function show() {
	return render(
		<TooltipProvider>
			<FeatureSettingsSection renderSectionHeader={() => null} />
		</TooltipProvider>,
	)
}

describe("execution settings", () => {
	beforeEach(() => {
		fixture.state = {
			yoloModeToggled: true,
			agentSwarmEnabled: false,
			agentSwarmCriticalCompletionReviewEnabled: false,
			agentSwarmHierarchicalDeferEnabled: false,
			agentSwarmDefaultDeferBoundary: "safe_boundary",
			agentSwarmAutoDeferOnCompletionReview: true,
			agentSwarmMaxInitialCompletionReviews: 1,
			agentSwarmMaxCorrectiveVerificationPasses: 1,
			agentSwarmLegionEnabled: false,
			agentSwarmLegionStrategy: "adaptive",
			agentSwarmLegionMaxSpecialists: 4,
		}
		fixture.update.mockReset()
		fixture.updateBatch.mockReset()
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
	})
	afterEach(() => vi.unstubAllGlobals())

	it("exposes autonomous execution in the primary group with an accessible switch", () => {
		show()
		const control = screen.getByRole("switch", { name: "Autonomous execution" })
		expect(control).toBeChecked()
		expect(control.closest("#agent-features")).not.toBeNull()
		expect(control).toHaveAccessibleDescription(/without individual approval prompts/)
		fireEvent.click(control)
		expect(fixture.update).toHaveBeenCalledWith("yoloModeToggled", false)
	})

	it("preserves managed policy locks after moving the setting", () => {
		fixture.state.remoteConfigSettings = { yoloModeToggled: false }
		show()
		const control = screen.getByRole("switch", { name: "Autonomous execution" })
		expect(control).not.toBeChecked()
		expect(control).toBeDisabled()
		fireEvent.click(control)
		expect(fixture.update).not.toHaveBeenCalled()
	})

	it("reveals the audit threshold beside its enabled review instead of an unreachable group", () => {
		const view = show()
		expect(screen.queryByText("Minimum completion audit score (0–100)")).not.toBeInTheDocument()
		fixture.state.auditCompletionGateEnabled = true
		view.rerender(
			<TooltipProvider>
				<FeatureSettingsSection renderSectionHeader={() => null} />
			</TooltipProvider>,
		)
		const label = screen.getByText("Minimum completion audit score (0–100)")
		expect(label.closest("#experimental-features")).not.toBeNull()
	})

	it("toggles the Agent Swarm master switch and batch-updates sub-features", () => {
		show()
		const masterSwitch = screen.getByRole("switch", { name: "Agent Swarm auxiliary suite" })
		expect(masterSwitch).not.toBeChecked()
		expect(masterSwitch.closest("#agent-swarm-features")).not.toBeNull()

		fireEvent.click(masterSwitch)
		expect(fixture.updateBatch).toHaveBeenCalledWith({
			agentSwarmEnabled: true,
			agentSwarmCriticalCompletionReviewEnabled: true,
			agentSwarmHierarchicalDeferEnabled: true,
			agentSwarmLegionEnabled: true,
		})
	})

	it("applies Quick Mode Presets for Agent Swarm orchestration including Legion", () => {
		show()
		fireEvent.click(screen.getByTestId("swarm-preset-review-only"))
		expect(fixture.updateBatch).toHaveBeenCalledWith({
			agentSwarmEnabled: false,
			agentSwarmCriticalCompletionReviewEnabled: true,
			agentSwarmHierarchicalDeferEnabled: false,
			agentSwarmLegionEnabled: false,
		})

		fixture.updateBatch.mockReset()
		fireEvent.click(screen.getByTestId("swarm-preset-defer-only"))
		expect(fixture.updateBatch).toHaveBeenCalledWith({
			agentSwarmEnabled: false,
			agentSwarmCriticalCompletionReviewEnabled: false,
			agentSwarmHierarchicalDeferEnabled: true,
			agentSwarmLegionEnabled: false,
		})

		fixture.updateBatch.mockReset()
		fireEvent.click(screen.getByTestId("swarm-preset-legion-only"))
		expect(fixture.updateBatch).toHaveBeenCalledWith({
			agentSwarmEnabled: false,
			agentSwarmCriticalCompletionReviewEnabled: false,
			agentSwarmHierarchicalDeferEnabled: false,
			agentSwarmLegionEnabled: true,
			agentSwarmLegionStrategy: "adaptive",
		})

		fixture.updateBatch.mockReset()
		fireEvent.click(screen.getByTestId("swarm-preset-full"))
		expect(fixture.updateBatch).toHaveBeenCalledWith({
			agentSwarmEnabled: true,
			agentSwarmCriticalCompletionReviewEnabled: true,
			agentSwarmHierarchicalDeferEnabled: true,
			agentSwarmLegionEnabled: true,
			agentSwarmLegionStrategy: "adaptive",
			agentSwarmAutoDeferOnCompletionReview: true,
			agentSwarmDefaultDeferBoundary: "safe_boundary",
		})

		fixture.updateBatch.mockReset()
		fireEvent.click(screen.getByTestId("swarm-preset-off"))
		expect(fixture.updateBatch).toHaveBeenCalledWith({
			agentSwarmEnabled: false,
			agentSwarmCriticalCompletionReviewEnabled: false,
			agentSwarmHierarchicalDeferEnabled: false,
			agentSwarmLegionEnabled: false,
		})
	})

	it("progressively discloses Critical Completion Review, Hierarchical Defer, and Legion Specialist Roster controls", () => {
		const view = show()
		expect(screen.queryByText("Max initial adversarial reviews per completion")).not.toBeInTheDocument()
		expect(screen.queryByText("Default execution boundary for defer requests")).not.toBeInTheDocument()
		expect(screen.queryByText("Legion formation & classification strategy")).not.toBeInTheDocument()
		expect(screen.queryByTestId("legion-specialist-roster-grid")).not.toBeInTheDocument()

		fixture.state.agentSwarmEnabled = true
		fixture.state.agentSwarmCriticalCompletionReviewEnabled = true
		fixture.state.agentSwarmHierarchicalDeferEnabled = true
		fixture.state.agentSwarmLegionEnabled = true
		view.rerender(
			<TooltipProvider>
				<FeatureSettingsSection renderSectionHeader={() => null} />
			</TooltipProvider>,
		)

		expect(screen.getByText("Max initial adversarial reviews per completion")).toBeInTheDocument()
		expect(screen.getByText("Max corrective verification passes")).toBeInTheDocument()
		expect(screen.getByText("Default execution boundary for defer requests")).toBeInTheDocument()
		expect(screen.getByText("Legion formation & classification strategy")).toBeInTheDocument()
		expect(screen.getByText("Max specialists per Legion formation")).toBeInTheDocument()
		expect(screen.getByTestId("legion-specialist-roster-grid")).toBeInTheDocument()
		const pipeline = screen.getByTestId("legion-stage-pipeline")
		expect(pipeline).toHaveTextContent("1 · Lead & Recon")
		expect(pipeline).toHaveTextContent("2 · Parallel Execution")
		expect(pipeline).toHaveTextContent("3 · Verification")
		expect(pipeline).toHaveTextContent(/re-routes its work once/)
		const roster = screen.getByTestId("legion-specialist-roster-grid")
		expect(roster).toHaveTextContent("SENTINEL-QA")
		expect(roster).toHaveTextContent("AESTHETE-UX")
		expect(screen.getByText("CENTURION-ARCH")).toBeInTheDocument()
		expect(screen.getByText("VANGUARD-IMPL")).toBeInTheDocument()
		expect(screen.getByText("AESTHETE-UX")).toBeInTheDocument()
		expect(screen.getByText("AEGIS-HARDEN")).toBeInTheDocument()
		expect(screen.getByText("SENTINEL-QA")).toBeInTheDocument()

		const autoDeferSwitch = screen.getByRole("switch", {
			name: "Auto-defer pipeline during Critical Completion Review",
		})
		expect(autoDeferSwitch).toBeChecked()
		fireEvent.click(autoDeferSwitch)
		expect(fixture.update).toHaveBeenCalledWith("agentSwarmAutoDeferOnCompletionReview", false)
	})

	it("filters preference groups via the search bar and recovers with Reset filter", () => {
		show()
		const filterInput = screen.getByTestId("preferences-search-input")

		// Filter to Agent Swarm only via legion keyword
		fireEvent.change(filterInput, { target: { value: "legion" } })
		expect(screen.getByText("Agent Swarm & Hierarchy Orchestration")).toBeInTheDocument()
		expect(screen.queryByText("Autonomous execution")).not.toBeInTheDocument()

		// Filter to non-existent setting
		fireEvent.change(filterInput, { target: { value: "nonexistent-xyz-setting" } })
		expect(screen.getByText(/No preferences match/)).toBeInTheDocument()
		fireEvent.click(screen.getByText("Reset filter"))
		expect(screen.getByText("Autonomous execution")).toBeInTheDocument()
	})
})
