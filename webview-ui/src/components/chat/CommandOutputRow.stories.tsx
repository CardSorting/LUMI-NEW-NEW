import type { CommandExecutionState } from "@shared/ExtensionMessage"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { CommandOutputRow } from "./CommandOutputRow"

const examples: { command: string; state: CommandExecutionState; output?: string }[] = [
	{
		command: "npm run build",
		state: { status: "background", executionId: "build", taskId: "example" },
		output: "Compiling application…\nChecking types…",
	},
	{
		command: "npm test",
		state: { status: "failed", exitCode: 2 },
		output: "Expected exit status 0, received 2.\nSee test output in the terminal.",
	},
	{
		command: "npm run dev",
		state: { status: "stopping", executionId: "dev", taskId: "example" },
		output: "Listening on http://localhost:3000",
	},
	{ command: 'printf "Output: 工具 100%"', state: { status: "completed", exitCode: 0 }, output: "Output: 工具 100%" },
	{ command: "python inspect_workspace.py", state: { status: "unknown" } },
	{ command: "npm run watch", state: { status: "stop_failed", executionId: "watch", taskId: "example" } },
	{
		command: "previous session",
		state: {
			status: "unknown",
			detail: "This task was reopened and the command is no longer tracked. Check View → Terminal before running it again.",
		},
	},
]

function States() {
	const [expanded, setExpanded] = useState(false)
	return (
		<div className="flex flex-col gap-5">
			{examples.map(({ command, state, output }, index) => (
				<CommandOutputRow
					isOutputFullyExpanded={expanded}
					key={command}
					message={{
						ts: index,
						type: "say",
						say: "command",
						text: command,
						commandExecution: state,
						commandOutput: output ?? "",
					}}
					setIsOutputFullyExpanded={setExpanded}
				/>
			))}
		</div>
	)
}
const meta: Meta<typeof CommandOutputRow> = { title: "Views/Chat/Terminal execution", component: CommandOutputRow }
export default meta
type Story = StoryObj<typeof meta>
export const ExecutionStates: Story = { render: () => <States /> }
export const LongOutput: Story = {
	args: {
		message: {
			ts: 1,
			type: "say",
			say: "command",
			text: 'npm test --workspace="long-workspace-name-with-nested-directory/another-long-directory"',
			commandExecution: { status: "completed", exitCode: 0 },
			commandOutput:
				"  Preserved indentation\n" +
				"LongUnbrokenOutput".repeat(20) +
				"\nFull captured output saved to: /tmp/output-log-for-long-workspace-name.txt",
		},
		isOutputFullyExpanded: true,
		setIsOutputFullyExpanded: () => {},
	},
}
