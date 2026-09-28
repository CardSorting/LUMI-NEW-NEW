import { CheckIcon, ClockIcon, SquareIcon } from "lucide-react"
import type { WalkthroughState } from "@/services/completion-walkthrough"

export function WalkthroughStatus({ state }: { state: WalkthroughState }) {
	if (state.phase === "idle" || state.phase === "error") return null
	const completed = state.phase === "complete"
	const stopped = state.phase === "cancelled"
	const Icon = completed ? CheckIcon : stopped ? SquareIcon : ClockIcon
	return (
		<div aria-atomic="true" aria-live="polite" className="mt-3 flex min-w-0 items-start gap-2 text-foreground" role="status">
			<Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
			<div className="min-w-0 flex-1 text-sm wrap-anywhere">
				<div className="font-medium">
					{completed
						? "Walkthrough ready"
						: stopped
							? "Generation stopped"
							: state.phase === "loading"
								? "Loading saved changes…"
								: "Adding inline explanations…"}
				</div>
				{stopped ? (
					<div className="mt-1">The diff and any explanations already added are still available.</div>
				) : state.commentCount > 0 ? (
					<div className="mt-1">
						{state.commentCount} {state.commentCount === 1 ? "explanation" : "explanations"} added across{" "}
						{state.filesExplained} {state.filesExplained === 1 ? "file" : "files"}.
					</div>
				) : state.filesTotal > 0 ? (
					<div className="mt-1">
						Reading {state.filesTotal} changed {state.filesTotal === 1 ? "file" : "files"}.
					</div>
				) : null}
				{state.currentFile && (
					<div className="mt-1">
						Current file: <bdi>{state.currentFile}</bdi>
					</div>
				)}
				{completed && <div className="mt-1">Open Review changes to read the explanations in the diff.</div>}
			</div>
		</div>
	)
}
