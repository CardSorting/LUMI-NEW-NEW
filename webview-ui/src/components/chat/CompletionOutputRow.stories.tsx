import type { CompletionReview } from "@shared/CompletionReview"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { CompletionOutputRow } from "./CompletionOutputRow"

const review: CompletionReview = {
	schemaVersion: 1,
	attempt: 2,
	priorBlocks: 1,
	checks: [
		{ id: "checklist", status: "passed", detail: "3 of 3 items marked complete." },
		{ id: "audit", status: "passed", detail: "Score 91/100 · policy threshold 80." },
		{ id: "review", status: "not_run", detail: "A second review was not requested." },
	],
}

const meta = {
	title: "Chat/Completion result",
	component: CompletionOutputRow,
	args: {
		text: "Completion notices now use readable messages. The finished result keeps a record of which checks ran.\n\nThe checklist and audit passed. A second review was not enabled.\n\n**Verification**\n- Regression coverage for a blocked attempt followed by success\n- TypeScript and formatting checks",
		messageTs: 42,
		completionReview: review,
		showActionRow: true,
		seeNewChangesDisabled: false,
		setSeeNewChangesDisabled: () => {},
	},
} satisfies Meta<typeof CompletionOutputRow>

export default meta
type Story = StoryObj<typeof meta>
export const Completed: Story = {}
export const PreparingResult: Story = { args: { partial: true, text: "Preparing a summary of the completion gate changes…" } }
export const NoOptionalChecks: Story = {
	args: {
		completionReview: {
			schemaVersion: 1,
			attempt: 1,
			priorBlocks: 0,
			checks: [
				{ id: "checklist", status: "not_run", detail: "No task checklist was provided." },
				{ id: "audit", status: "not_run", detail: "Not enabled for this task." },
				{ id: "review", status: "not_run", detail: "A second review was not requested." },
			],
		},
		text: "Updated the requested wording.",
		showActionRow: false,
	},
}
export const DemoRunning: Story = {
	args: {
		completionReview: {
			...review,
			checks: [
				...review.checks,
				{
					id: "demo",
					status: "running",
					detail: "npm run dev\nStill running when this result was recorded. Check the terminal for its outcome.",
				},
			],
		},
	},
}
export const LegacyResult: Story = {
	args: { completionReview: undefined, showActionRow: false, text: "The requested change is complete." },
}
export const LongResult: Story = {
	args: {
		text: `Updated src/components/review/completion/checks/a-very-long-path-without-spaces-to-exercise-narrow-sidebar-wrapping.tsx.\n\n${"The result remains readable at larger text sizes and narrow widths. ".repeat(10)}\n\n日本語の結果を確認できます。 التغييرات جاهزة للمراجعة.`,
	},
}
