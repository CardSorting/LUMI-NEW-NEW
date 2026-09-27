import {
	buildPreCompletionChecklistSummary,
	type PreCompletionChecklistSummary,
	shouldShowPreCompletionChecklist,
} from "@shared/audit/auditPreCompletionChecklist"
import type { TaskAuditMetadata } from "@shared/ExtensionMessage"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { memo, useEffect, useId, useMemo, useRef, useState } from "react"
import { useAuditGateEvaluation } from "@/hooks/useAuditGateEvaluation"
import { cn } from "@/lib/utils"
import { auditStrip } from "../audit/auditUiStyles"
import { AuditChecklistItems } from "./AuditChecklistItems"
import { TASK_AUDIT_QUALITY_GATE_ID } from "./AuditHeaderJumpLink"

interface PreCompletionGateStripProps {
	auditMetadata?: TaskAuditMetadata
	onScrollToLatestGateBlock?: () => void
	onScrollToLatestAdvisory?: () => void
	className?: string
	embedded?: boolean
}

export const PreCompletionGateStrip = memo(
	({
		auditMetadata,
		onScrollToLatestGateBlock,
		onScrollToLatestAdvisory,
		className,
		embedded = false,
	}: PreCompletionGateStripProps) => {
		const [expanded, setExpanded] = useState(embedded)
		const detailsId = useId()
		const previousBlockedRef = useRef(false)
		const gateOptions = useAuditGateEvaluation(auditMetadata)
		const summary = useMemo(
			() => buildPreCompletionChecklistSummary(auditMetadata, gateOptions),
			[auditMetadata, gateOptions],
		)

		const blocked = summary && "blocked" in summary ? summary.blocked : false

		useEffect(() => {
			if (blocked && !previousBlockedRef.current) {
				setExpanded(true)
			}
			previousBlockedRef.current = blocked
		}, [blocked])

		if (!shouldShowPreCompletionChecklist(summary)) {
			return null
		}

		const checklist = summary as PreCompletionChecklistSummary
		const failCount = checklist.items.filter((item) => item.status === "fail").length
		const warnCount = checklist.items.filter((item) => item.status === "warn").length
		const pendingAdvisoryCount = gateOptions.advisoryMetadata?.violations?.length ?? 0

		const showDetails = embedded || expanded

		return (
			<section
				aria-label="Before finishing"
				className={cn(
					embedded ? "mt-1 px-1 py-1" : "mt-2 px-3 py-2.5",
					"lumi-audit-exhale transition-opacity duration-[2s]",
					!embedded && auditStrip,
					className,
				)}
				id={embedded ? undefined : TASK_AUDIT_QUALITY_GATE_ID}>
				{embedded ? (
					<p className="m-0 text-[10px] font-medium text-description/85">Before finishing</p>
				) : (
					<button
						aria-controls={detailsId}
						aria-expanded={expanded}
						className="flex w-full items-center justify-between gap-2 cursor-pointer bg-transparent border-0 p-1 text-left font-sans text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--vscode-focusBorder)]"
						onClick={() => setExpanded(!expanded)}
						type="button">
						<div className="flex items-center gap-2 flex-wrap">
							<span className="font-medium text-description/85">Before finishing</span>
							<span
								className={cn(
									"px-1.5 py-0.5 rounded-full text-xs font-medium border",
									checklist.blocked
										? "border-amber-500/40 text-foreground"
										: warnCount > 0
											? "border-amber-500/40 text-foreground"
											: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
								)}>
								{checklist.blocked ? "Blocked" : warnCount > 0 ? "Ready with warnings" : "Ready"}
							</span>
							<span className="font-mono text-description/70">
								{checklist.score}/{checklist.effectiveThreshold}
							</span>
							{failCount > 0 && (
								<span className="text-description">
									{failCount} failed check{failCount === 1 ? "" : "s"}
								</span>
							)}
							{warnCount > 0 && (
								<span className="text-description">
									{warnCount} warning{warnCount === 1 ? "" : "s"}
								</span>
							)}
							{pendingAdvisoryCount > 0 && !checklist.blocked && (
								<span className="text-amber-600/90">
									{pendingAdvisoryCount} note{pendingAdvisoryCount === 1 ? "" : "s"}
								</span>
							)}
						</div>
						{expanded ? (
							<ChevronDownIcon className="size-3 text-description/60" />
						) : (
							<ChevronRightIcon className="size-3 text-description/60" />
						)}
					</button>
				)}

				<div hidden={!showDetails} id={detailsId}>
					<AuditChecklistItems className="mt-2" items={checklist.items} />
				</div>

				{checklist.blocked && onScrollToLatestGateBlock && (
					<button
						className="mt-2 p-1 text-xs font-medium text-link underline underline-offset-2 cursor-pointer bg-transparent border-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--vscode-focusBorder)]"
						onClick={onScrollToLatestGateBlock}
						type="button">
						View blocking check
					</button>
				)}

				{pendingAdvisoryCount > 0 && onScrollToLatestAdvisory && (
					<button
						className="mt-2 p-1 text-xs font-medium text-link underline underline-offset-2 cursor-pointer bg-transparent border-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--vscode-focusBorder)]"
						onClick={onScrollToLatestAdvisory}
						type="button">
						View advisory notes
					</button>
				)}
			</section>
		)
	},
)

PreCompletionGateStrip.displayName = "PreCompletionGateStrip"
