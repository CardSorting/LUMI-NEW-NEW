import { COMMAND_OUTPUT_STRING, COMMAND_REQ_APP_STRING } from "@shared/combineCommandSequences"
import { DietCodeMessage, isActiveCommandExecution } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/dietcode/common"
import { memo, useEffect, useRef, useState } from "react"
import { VscIcon } from "@/components/ui/vsc-icon"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/services/grpc-client"
import { CommandControls } from "./CommandControls"
import ExpandHandle from "./ExpandHandle"

const TerminalText = ({ text }: { text: string }) => (
	<pre className="m-0 p-2.5 whitespace-pre-wrap break-all text-foreground font-mono text-xs leading-relaxed">
		<code>{text}</code>
	</pre>
)

export const CommandOutputContent = memo(
	({
		output,
		isOutputFullyExpanded,
		onToggle,
		isContainerExpanded,
	}: {
		output: string
		isOutputFullyExpanded: boolean
		onToggle: () => void
		isContainerExpanded: boolean
	}) => {
		const outputLines = output.split("\n")
		const lineCount = outputLines.length
		const shouldAutoShow = lineCount <= 5
		const outputRef = useRef<HTMLDivElement>(null)
		const followingOutput = useRef(true)
		const [logError, setLogError] = useState<string>()

		// Auto-scroll to bottom when output changes (only when showing limited output)
		useEffect(() => {
			if (!isOutputFullyExpanded && followingOutput.current && outputRef.current) {
				outputRef.current.scrollTop = outputRef.current.scrollHeight
			}
		}, [isOutputFullyExpanded, output])

		// Don't render anything if container is collapsed
		if (!isContainerExpanded) {
			return null
		}

		// Check if output contains a log file path indicator
		const logFilePathMatch = output.match(/(?:📋 Output is being logged to:|Full captured output saved to:) ([^\n]+)/)
		const logFilePath = logFilePathMatch ? logFilePathMatch[1].trim() : null

		// Render output with clickable log file path
		const renderOutput = () => {
			if (!logFilePath) {
				return <TerminalText text={output} />
			}

			// Split output into parts: before log path, log path line, after log path
			const logPathLineStart = logFilePathMatch!.index!
			const logPathLineEnd = output.indexOf("\n", logPathLineStart)
			const beforeLogPath = output.substring(0, logPathLineStart)
			const afterLogPath = logPathLineEnd !== -1 ? output.substring(logPathLineEnd) : ""

			// Extract just the filename from the full path for display
			const fileName = logFilePath.split(/[\\/]/).pop() || logFilePath

			return (
				<div className="border border-editor-group-border rounded-sm">
					{beforeLogPath && <TerminalText text={beforeLogPath} />}
					<button
						className="flex flex-wrap items-center gap-1.5 px-3 py-2 mx-2 my-1.5 rounded-sm bg-banner-background cursor-pointer hover:brightness-110 transition-colors"
						onClick={() => {
							setLogError(undefined)
							FileServiceClient.openFile(StringRequest.create({ value: logFilePath })).catch((err) =>
								setLogError(`Could not open the output log: ${err instanceof Error ? err.message : String(err)}`),
							)
						}}
						title={`Click to open: ${logFilePath}`}
						type="button">
						<span>Open output log</span>
						<span className="text-vscode-textLink-foreground underline break-all">{fileName}</span>
					</button>
					{logError && (
						<p className="px-3 text-error break-words" role="alert">
							{logError}
						</p>
					)}
					{afterLogPath && <TerminalText text={afterLogPath} />}
				</div>
			)
		}

		return (
			<div className={cn("w-full overflow-visible border-t border-editor-group-border bg-code rounded-sm")}>
				<div
					className={cn("text-foreground bg-code overflow-y-auto", {
						"max-h-[75px]": !shouldAutoShow && !isOutputFullyExpanded,
						"max-h-[200px]": !shouldAutoShow && isOutputFullyExpanded,
						"overflow-y-visible": shouldAutoShow,
					})}
					onScroll={() => {
						const node = outputRef.current
						if (node) followingOutput.current = node.scrollHeight - node.clientHeight - node.scrollTop < 24
					}}
					ref={outputRef}>
					<div className="bg-code">{renderOutput()}</div>
				</div>
				{lineCount > 5 ? <ExpandHandle isExpanded={isOutputFullyExpanded} onToggle={onToggle} /> : null}
			</div>
		)
	},
)

CommandOutputContent.displayName = "CommandOutputContent"

export const CommandOutputRow = memo(
	({
		message,
		isCommandExecuting = false,
		isCommandPending = false,
		isCommandCompleted = false,
		icon,
		title,
		isOutputFullyExpanded,
		setIsOutputFullyExpanded,
	}: {
		message: DietCodeMessage
		isCommandExecuting?: boolean
		isCommandPending?: boolean
		isCommandCompleted?: boolean
		icon?: JSX.Element | null
		title?: JSX.Element | null
		isOutputFullyExpanded: boolean
		setIsOutputFullyExpanded: (expanded: boolean) => void
	}) => {
		const splitMessage = (text: string) => {
			const outputIndex = text.indexOf(COMMAND_OUTPUT_STRING)
			if (outputIndex === -1) {
				return { command: text, output: "" }
			}
			return {
				command: text.slice(0, outputIndex).trim(),
				output: text
					.slice(outputIndex + COMMAND_OUTPUT_STRING.length)
					.trim()
					.split("")
					.map((char) => {
						switch (char) {
							case "\t":
								return "→   "
							case "\b":
								return "⌫"
							case "\f":
								return "⏏"
							case "\v":
								return "⇳"
							default:
								return char
						}
					})
					.join(""),
			}
		}

		const { command: rawCommand, output } =
			message.commandOutput !== undefined
				? { command: message.text || "", output: message.commandOutput }
				: splitMessage(message.text || "")

		const requestsApproval = rawCommand.endsWith(COMMAND_REQ_APP_STRING)
		const command = requestsApproval ? rawCommand.slice(0, -COMMAND_REQ_APP_STRING.length) : rawCommand
		const execution = message.commandExecution
		const status = getCommandStatus(message, isCommandExecuting, isCommandPending, isCommandCompleted)
		const running = execution ? execution.status === "running" || execution.status === "background" : isCommandExecuting
		const warning = execution ? ["unknown", "stopping", "not_started"].includes(execution.status) : isCommandPending
		const failed = execution?.status === "failed" || execution?.status === "stop_failed"

		const commandHeader = (
			<div className="flex items-center gap-2.5 mb-3">
				{icon}
				{title}
			</div>
		)

		return (
			<>
				{(icon || title) && commandHeader}
				<div className="min-w-0 overflow-hidden bg-code rounded-sm border border-editor-group-border">
					{command && (
						<div className="bg-code flex flex-wrap gap-2 items-center justify-between px-2 py-2.5 border-b border-editor-group-border rounded-sm rounded-b-none">
							<div className="flex items-center gap-2 flex-1 min-w-0">
								<div
									aria-hidden="true"
									className={cn("bg-description rounded-full w-2 h-2 shrink-0", {
										"bg-lumi/50 animate-lumi-glow-pulse motion-reduce:animate-none": running,
										"bg-amber-600/50": warning,
										"bg-error": failed,
										"bg-success": execution?.exitCode === 0,
									})}
								/>
								<span
									className={cn("text-foreground font-medium text-sm break-words", {
										"text-editor-warning-foreground": warning,
										"text-error": failed,
									})}
									role="status">
									{status.label}
								</span>
							</div>
						</div>
					)}

					<div className="bg-code text-sm">
						<TerminalText text={command} />
					</div>
					{status.detail && <p className="m-0 px-2.5 pb-2.5 text-xs text-description break-words">{status.detail}</p>}
					{execution?.executionId && execution.taskId && isActiveCommandExecution(execution) && (
						<CommandControls
							executionId={execution.executionId}
							key={execution.executionId}
							status={execution.status}
							taskId={execution.taskId}
						/>
					)}

					{output.length > 0 && (
						<CommandOutputContent
							isContainerExpanded={true}
							isOutputFullyExpanded={isOutputFullyExpanded}
							onToggle={() => setIsOutputFullyExpanded(!isOutputFullyExpanded)}
							output={output}
						/>
					)}
				</div>
				{requestsApproval && !execution && !isCommandCompleted && (
					<div className="flex items-center gap-2.5 p-2 text-[12px] text-editor-warning-foreground">
						<VscIcon className="" name="warning" />
						<span>I'll wait for your okay before running this.</span>
					</div>
				)}
			</>
		)
	},
)

CommandOutputRow.displayName = "CommandOutputRow"

function getCommandStatus(
	message: DietCodeMessage,
	isExecuting: boolean,
	isPending: boolean,
	isCompleted: boolean,
): { label: string; detail?: string } {
	const state = message.commandExecution
	if (state) {
		switch (state.status) {
			case "running":
				return { label: "Running", detail: "Waiting for command completion." }
			case "background":
				return {
					label: "Running in terminal",
					detail: "The agent can continue other work. This command has not finished.",
				}
			case "unknown":
				return {
					label: "Status unavailable",
					detail: state.detail ?? "Check the existing terminal before running this command again.",
				}
			case "stop_failed":
				return {
					label: "Could not stop",
					detail: state.detail ?? "Open the terminal to inspect the command, or retry stopping it.",
				}
			case "stopping":
				return { label: "Stop requested", detail: "Waiting for terminal confirmation. The command may still be running." }
			case "cancelled":
				return { label: "Stopped" }
			case "not_started":
				return { label: "Not started", detail: state.detail }
			case "failed":
				return {
					label:
						typeof state.exitCode === "number"
							? `Failed · exit ${state.exitCode}`
							: state.signal
								? `Stopped · ${state.signal}`
								: "Could not run",
				}
			case "completed":
				return {
					label:
						state.exitCode === 0
							? "Completed · exit 0"
							: state.terminalClosed
								? "Terminal closed · exit unknown"
								: "Finished · exit unknown",
				}
		}
	}
	return { label: isExecuting ? "Running" : isPending ? "Waiting" : isCompleted ? "Finished · exit unknown" : "Not run" }
}
