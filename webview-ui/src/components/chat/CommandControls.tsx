import type { CommandExecutionState } from "@shared/ExtensionMessage"
import { CommandControlRequest } from "@shared/proto/dietcode/task"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { TaskServiceClient } from "@/services/grpc-client"

/** Controls are scoped to a run; stopping one command never cancels the parent or its siblings. */
export function CommandControls({
	taskId,
	executionId,
	status,
}: {
	taskId: string
	executionId: string
	status: CommandExecutionState["status"]
}) {
	const [pending, setPending] = useState({ show: false, stop: false })
	const inFlight = useRef(new Set<string>())
	const [stopRequested, setStopRequested] = useState(false)
	const [error, setError] = useState<string>()
	const mounted = useRef(true)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])
	useEffect(() => {
		if (status === "stop_failed") setStopRequested(false)
	}, [status])

	const control = async (action: "show" | "stop") => {
		if (inFlight.current.has(action)) return
		inFlight.current.add(action)
		setPending((previous) => ({ ...previous, [action]: true }))
		setError(undefined)
		if (action === "stop") setStopRequested(true)
		try {
			await TaskServiceClient.controlCommand(CommandControlRequest.create({ taskId, executionId, action }))
		} catch (cause) {
			if (mounted.current) {
				setError(cause instanceof Error ? cause.message : "Command control is unavailable. Check View → Terminal.")
				if (action === "stop") setStopRequested(false)
			}
		} finally {
			inFlight.current.delete(action)
			if (mounted.current) setPending((previous) => ({ ...previous, [action]: false }))
		}
	}
	return (
		<div className="flex flex-wrap items-center gap-2 px-2.5 pb-2.5">
			<Button
				disabled={pending.show}
				onClick={(event) => {
					event.stopPropagation()
					void control("show")
				}}
				size="sm"
				variant="secondary">
				{pending.show ? "Opening terminal…" : "Open terminal"}
			</Button>
			<Button
				disabled={pending.stop || stopRequested || status === "stopping"}
				onClick={(event) => {
					event.stopPropagation()
					void control("stop")
				}}
				size="sm"
				title="Stop only this command by closing its terminal"
				variant="secondary">
				{pending.stop
					? "Requesting stop…"
					: stopRequested || status === "stopping"
						? "Stop requested"
						: status === "stop_failed"
							? "Retry stop"
							: "Stop command"}
			</Button>
			{error && (
				<p className="m-0 w-full text-xs text-error break-words" role="alert">
					{error}
				</p>
			)}
		</div>
	)
}
