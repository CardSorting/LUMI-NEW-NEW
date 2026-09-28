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
		durationMs: 18200,
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
		activity: { phase: "tool", detail: "Reading src/navigation/routes.ts" },
		latestToolCall: "read_file(path=src/navigation/routes.ts)",
		latestMessage: "The route update is saved. I’m checking the navigation tests.",
		filesModified: ["src/navigation/routes.ts"],
		recentTools: [
			{ id: "edit", label: "Editing src/navigation/routes.ts", status: "returned" },
			{ id: "read", label: "Reading src/navigation/routes.ts", status: "running" },
		],
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
export const MinesweeperProgress: Story = {
	args: {
		message: message([
			helper(1, {
				prompt: "Implement pure TypeScript minesweeper domain and vitest tests in src/domain/game.ts and src/domain/game.test.ts only. Contract: export type Difficulty = 'beginner'|'intermediate'|'expert'; export const PRESETS mapping each to {label,rows,cols,mines}; export interface Cell {mine:boolean;adjacent:number;revealed:boolean;flagged:boolean}; createGame(difficulty):Game; reveal(game,index,rng=Math.random):Game; toggleFlag(game,index):Game; chord(game,index):Game. Pure immutable transitions, safe openings, flood fill, flags, win/loss, and chording tests.",
				status: "running",
				activity: {
					phase: "tool",
					detail: "Running npx vitest run src/domain/game.test.ts",
					startedAt: Date.now() - 8000,
				},
				startedAt: Date.now() - 72000,
				heartbeatAt: Date.now(),
				lastActivityAt: Date.now() - 1000,
				responseChunks: 184,
				responseBytes: 16324,
				requestCount: 4,
				activityEvents: [
					{ id: "start", at: Date.now() - 72000, kind: "phase", label: "Helper started" },
					{ id: "read", at: Date.now() - 65000, kind: "tool", label: "Result received: Reading package.json" },
					{ id: "game", at: Date.now() - 35000, kind: "tool", label: "Result received: Writing src/domain/game.ts" },
					{
						id: "tests",
						at: Date.now() - 12000,
						kind: "tool",
						label: "Result received: Writing src/domain/game.test.ts",
					},
					{ id: "test", at: Date.now() - 8000, kind: "phase", label: "Running npx vitest run src/domain/game.test.ts" },
				],
				commands: [
					{
						id: "vitest",
						command: "npx vitest run src/domain/game.test.ts",
						status: "running",
						output: "✓ safe opening — all presets\n✓ flags and flood fill\n✓ win / loss transitions\nRunning chording tests…",
					},
				],
				latestMessage:
					"The game logic and safe opening checks are implemented. I’m running the tests for flags, flood fill, and chording.",
				filesModified: ["src/domain/game.ts", "src/domain/game.test.ts"],
				toolCalls: 5,
				durationMs: 72000,
				recentTools: [
					{ id: "read", label: "Reading package.json", status: "returned" },
					{ id: "write-game", label: "Writing src/domain/game.ts", status: "returned" },
					{ id: "write-tests", label: "Writing src/domain/game.test.ts", status: "returned" },
					{ id: "test", label: "Running npx vitest run src/domain/game.test.ts", status: "running" },
				],
			}),
		]),
	},
}
export const SilentProvider: Story = {
	args: {
		message: message([
			helper(1, {
				prompt: "Review the tests for boundary conditions.",
				status: "running",
				startedAt: Date.now() - 52000,
				heartbeatAt: Date.now(),
				lastActivityAt: Date.now() - 46000,
				activity: { phase: "waiting", startedAt: Date.now() - 46000, deadlineAt: Date.now() + 134000 },
				activityEvents: [{ id: "wait", at: Date.now() - 46000, kind: "phase", label: "Waiting for model response" }],
			}),
		]),
	},
}
export const DelayedUpdates: Story = {
	args: {
		message: message([
			helper(1, {
				prompt: "Verify the game logic.",
				status: "running",
				startedAt: Date.now() - 80000,
				heartbeatAt: Date.now() - 30000,
				lastActivityAt: Date.now() - 45000,
				activity: { phase: "tool", detail: "Running npm test", startedAt: Date.now() - 45000 },
			}),
		]),
	},
}
export const WaitingForSlot: Story = {
	args: {
		message: message([
			helper(1, {
				prompt: "Check keyboard access once a helper slot is available.",
				queuePosition: 2,
				queuedAt: Date.now() - 25000,
				heartbeatAt: Date.now(),
			}),
		]),
	},
}
export const PreparingAssignment: Story = {
	args: {
		message: {
			ts: 1,
			type: "say",
			say: "use_subagents",
			partial: true,
			text: JSON.stringify({
				prompts: ["Implement the minesweeper game logic and tests in src/domain/game.ts and src/domain/game.test.ts."],
			}),
		},
	},
}
export const AwaitingApproval: Story = {
	args: {
		message: { ...PreparingAssignment.args!.message!, type: "ask", say: undefined, ask: "use_subagents", partial: false },
	},
}
export const CancelledBatch: Story = {
	args: {
		message: message([
			items[0],
			helper(2, {
				name: "Verify navigation",
				status: "cancelled",
				error: "Stopped by user.",
				result: "Identified the affected route. Verification remains unfinished.",
				toolCalls: 2,
				durationMs: 9400,
			}),
			helper(3, { name: "Check keyboard access", status: "cancelled", error: "Cancelled before starting." }),
		]),
	},
}
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
