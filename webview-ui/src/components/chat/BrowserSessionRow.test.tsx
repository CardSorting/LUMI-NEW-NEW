import type { DietCodeMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import BrowserSessionRow from "./BrowserSessionRow"

vi.mock("react-use", () => ({ useSize: (element: ReactNode) => [element, { height: 100 }] }))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ browserSettings: { viewport: { width: 900, height: 600 } } }),
}))
vi.mock("@/components/browser/BrowserSettingsMenu", () => ({ BrowserSettingsMenu: () => null }))
vi.mock("@/components/chat/ChatRow", () => ({
	ChatRowContent: () => null,
	ProgressIndicator: () => <span>Browser running</span>,
}))
vi.mock("@/components/common/CodeBlock", () => ({
	CODE_BLOCK_BG_COLOR: "transparent",
	default: ({ source }: { source: string }) => <pre>{source}</pre>,
}))
vi.mock("@/services/grpc-client", () => ({ FileServiceClient: { openImage: vi.fn() } }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}))

const say = (ts: number, kind: DietCodeMessage["say"], text = ""): DietCodeMessage => ({ ts, type: "say", say: kind, text })
const props = { expandedRows: {}, onToggleExpand: vi.fn(), onHeightChange: vi.fn(), onPendingQuoteChange: vi.fn() }
const result = say(
	2,
	"browser_action_result",
	JSON.stringify({ currentUrl: "http://localhost/app", screenshot: "data:image/png;base64,aW1hZ2U=", logs: "ready" }),
)
describe("persistent browser history", () => {
	it("labels navigation in a resumed session without a launch or approval prompt", () => {
		render(
			<BrowserSessionRow
				{...props}
				isLast={false}
				messages={[say(1, "browser_action", '{"action":"navigate","url":"http://localhost/app"}'), result]}
			/>,
		)
		expect(screen.getByText("Navigate to http://localhost/app")).toBeInTheDocument()
		expect(screen.getByText("Browser")).toBeInTheDocument()
		expect(screen.queryByText(/Launch browser at/)).not.toBeInTheDocument()
		expect(screen.getByRole("img", { name: "Browser screenshot" })).toHaveAttribute("src", "data:image/png;base64,aW1hZ2U=")
	})
	for (const [action, label] of [
		["refresh", "Refresh page"],
		["inspect", "Inspect current page"],
	]) {
		it(`shows the familiar ${action} action`, () => {
			render(
				<BrowserSessionRow
					{...props}
					isLast={false}
					messages={[say(1, "browser_action", JSON.stringify({ action })), result]}
				/>,
			)
			expect(screen.getByText(label)).toBeInTheDocument()
		})
	}
	it("stops the running indicator and unlocks history navigation on close", () => {
		render(
			<BrowserSessionRow
				{...props}
				isLast
				messages={[
					say(1, "browser_action", '{"action":"refresh"}'),
					result,
					say(3, "browser_action", '{"action":"close"}'),
				]}
			/>,
		)
		expect(screen.queryByText("Browser running")).not.toBeInTheDocument()
		const previous = screen.getByRole("button", { name: "Previous" })
		expect(previous).toBeEnabled()
		fireEvent.click(previous)
		expect(screen.getByText("Step 1 of 2")).toBeInTheDocument()
	})
})
