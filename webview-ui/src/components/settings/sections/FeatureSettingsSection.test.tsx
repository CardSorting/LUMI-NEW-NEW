import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import FeatureSettingsSection from "./FeatureSettingsSection"

const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown>, update: vi.fn() }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => fixture.state }))
vi.mock("../utils/settingsHandlers", () => ({ updateSetting: (...args: unknown[]) => fixture.update(...args) }))

function show() {
	return render(
		<TooltipProvider>
			<FeatureSettingsSection renderSectionHeader={() => null} />
		</TooltipProvider>,
	)
}

describe("execution settings", () => {
	beforeEach(() => {
		fixture.state = { yoloModeToggled: true }
		fixture.update.mockReset()
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
})
