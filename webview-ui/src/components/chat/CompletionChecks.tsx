import { COMPLETION_CHECK_LABELS, type CompletionReview } from "@shared/CompletionReview"
import { CheckIcon, ChevronDownIcon, CircleHelpIcon, CircleMinusIcon, ClockIcon } from "lucide-react"
import { memo, useId, useState } from "react"
import { cn } from "@/lib/utils"

const STATUS = {
	passed: { label: "Passed", Icon: CheckIcon, color: "text-[var(--vscode-testing-iconPassed,var(--vscode-foreground))]" },
	not_run: { label: "Not run", Icon: CircleMinusIcon, color: "text-description" },
	running: { label: "Running", Icon: ClockIcon, color: "text-description" },
	unverified: { label: "Not verified", Icon: CircleHelpIcon, color: "text-description" },
}

export const CompletionChecks = memo(({ review }: { review: CompletionReview }) => {
	const needsAttention = review.checks.some((check) => check.status === "running" || check.status === "unverified")
	const [expanded, setExpanded] = useState(needsAttention)
	const detailsId = useId()
	const counts = Object.entries(STATUS).flatMap(([status, { label }]) => {
		const count = review.checks.filter((check) => check.status === status).length
		return count ? [`${count} ${label.toLowerCase()}`] : []
	})
	return (
		<div className="border-t border-description/20">
			<button
				aria-controls={detailsId}
				aria-expanded={expanded}
				className="flex min-h-[44px] w-full items-center gap-2 rounded-xs bg-transparent px-3 py-2 text-start text-foreground hover:bg-list-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border cursor-pointer"
				onClick={() => setExpanded(!expanded)}
				type="button">
				<span className="min-w-0 flex-1">
					<span className="block text-sm font-medium">Completion checks</span>
					<span className="block text-xs text-foreground wrap-anywhere">{counts.join(" · ")}</span>
				</span>
				<ChevronDownIcon aria-hidden className={cn("size-4 shrink-0", expanded && "rotate-180")} />
			</button>
			<div hidden={!expanded} id={detailsId}>
				<ul aria-label="Check results" className="m-0 list-none px-3 pb-3">
					{review.checks.map((check) => {
						const { Icon, color, label } = STATUS[check.status]
						return (
							<li className="flex items-start gap-2 py-2" key={check.id}>
								<Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", color)} />
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
										<span className="font-medium">{COMPLETION_CHECK_LABELS[check.id]}</span>
										<span className="text-xs text-description">{label}</span>
									</div>
									<div className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-description wrap-anywhere">
										{check.detail}
									</div>
								</div>
							</li>
						)
					})}
				</ul>
				<div className="px-3 pb-3 text-xs text-description">
					Recorded at completion{review.attempt > 1 ? ` · attempt ${review.attempt}` : ""}.
					{review.priorBlocks > 0 && " Earlier completion blockers were resolved."}
				</div>
			</div>
		</div>
	)
})

CompletionChecks.displayName = "CompletionChecks"
