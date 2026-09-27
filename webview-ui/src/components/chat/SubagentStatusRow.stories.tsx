import type { DietCodeMessage, SubagentStatusItem } from "@shared/ExtensionMessage"
import type { Meta, StoryObj } from "@storybook/react-vite"
import SubagentStatusRow from "./SubagentStatusRow"

const helper = (index: number, overrides: Partial<SubagentStatusItem>): SubagentStatusItem => ({
	id: `helper-${index}`,
	index,
	name: `Helper ${index}`,
	prompt: "Review the assigned files and return the relevant findings.",
	status: "pending",
	toolCalls: 0,
	inputTokens: 0,
	outputTokens: 0,
	totalCost: 0,
	contextTokens: 0,
	contextWindow: 200_000,
	contextUsagePercentage: 0,
	...overrides,
})

const items = [
	helper(1, {
		name: "Review routing",
		status: "completed",
		result: "Reviewed the routing changes. The focused checks passed.",
		toolCalls: 4,
		totalCost: 0.024,
		contextTokens: 2400,
	}),
	helper(2, {
		name: "Check retry behavior",
		status: "running",
		activity: { phase: "retrying", attempt: 2, maxAttempts: 3 },
		toolCalls: 2,
		contextTokens: 1100,
	}),
	helper(3, {
		name: "Inspect navigation",
		status: "running",
		activity: { phase: "tool" },
		latestToolCall: "read_file(path=src/navigation/routes.ts)",
		toolCalls: 3,
		contextTokens: 1850,
	}),
	helper(4, {
		name: "Verify saved changes",
		status: "failed",
		error: "The provider stopped responding. Completed work is preserved for the parent.",
		result: "Saved the navigation update. Verification did not finish.",
		toolCalls: 2,
		contextTokens: 1700,
	}),
	helper(5, { name: "Check keyboard access" }),
]

const message = (entries: SubagentStatusItem[]): DietCodeMessage => ({
	ts: 1,
	type: "say",
	say: "subagent",
	text: JSON.stringify({ status: "running", items: entries }),
})

const meta: Meta<typeof SubagentStatusRow> = {
	title: "Views/Chat/Helper progress",
	component: SubagentStatusRow,
	args: { isLast: true, message: message(items) },
}
export default meta
type Story = StoryObj<typeof meta>

export const MixedProgress: Story = {}
export const LongAssignment: Story = {
	args: {
		message: message([
			helper(1, {
				name: "ReviewVeryLongUnbrokenComponentName".repeat(6),
				prompt: "Investigate navigation across nested workspaces. ".repeat(12),
				status: "failed",
				error: "Provider unavailable. The parent has the completed results and can continue independently.",
				result: "Found the affected route. The verification step remains unfinished.",
			}),
		]),
	},
}
