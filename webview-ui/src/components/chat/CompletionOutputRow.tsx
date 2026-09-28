import { COMPLETION_REVIEW_ERRORS, type CompletionReview, parseCompletionReview } from "@shared/CompletionReview"
import type { TaskAuditMetadata } from "@shared/ExtensionMessage"
import { Int64Request } from "@shared/proto/dietcode/common"
import { CheckIcon, ClockIcon, FileDiffIcon, MessageSquareTextIcon, SquareIcon } from "lucide-react"
import { memo, useRef, useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import { PLATFORM_CONFIG, PlatformType } from "@/config/platform.config"
import { cn } from "@/lib/utils"
import { completionWalkthroughs } from "@/services/completion-walkthrough"
import { TaskServiceClient } from "@/services/grpc-client"
import { CopyButton } from "../common/CopyButton"
import MarkdownBlock from "../common/MarkdownBlock"
import { AuditReportPanel } from "./AuditReportPanel"
import { CompletionChecks } from "./CompletionChecks"
import { WalkthroughStatus } from "./WalkthroughStatus"

interface CompletionOutputRowProps {
	text: string
	headClassNames?: string
	showActionRow?: boolean
	seeNewChangesDisabled: boolean
	setSeeNewChangesDisabled: (value: boolean) => void
	messageTs: number
	auditMetadata?: TaskAuditMetadata
	completionReview?: CompletionReview
	partial?: boolean
}

export const CompletionOutputRow = memo(
	({
		headClassNames,
		text,
		showActionRow,
		seeNewChangesDisabled,
		setSeeNewChangesDisabled,
		messageTs,
		auditMetadata,
		completionReview,
		partial = false,
	}: CompletionOutputRowProps) => {
		const review = parseCompletionReview(completionReview)
		return (
			<section
				aria-busy={partial}
				aria-label="Task result"
				className="min-w-0 rounded-lg border border-description/25 bg-code/40">
				<div className={cn(headClassNames, "flex items-center justify-between gap-2 px-3 py-3 m-0")}>
					<div className="flex min-w-0 items-center gap-2" role="status">
						{partial ? (
							<ClockIcon aria-hidden className="size-4 shrink-0 text-description" />
						) : (
							<CheckIcon
								aria-hidden
								className="size-4 shrink-0 text-[var(--vscode-testing-iconPassed,var(--vscode-foreground))]"
							/>
						)}
						<h3 className="m-0 text-base font-medium text-foreground">
							{partial ? "Preparing result" : "Task complete"}
						</h3>
					</div>
					{!partial && (
						<CopyButton
							ariaLabel="Copy result"
							className="min-h-[44px] min-w-[44px] scale-100 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border"
							textToCopy={text}
						/>
					)}
				</div>
				{partial && (
					<div className="px-3 pb-2 text-xs text-description">
						Completion checks will run after the summary is ready.
					</div>
				)}
				<div className="completion-output-content min-w-0 px-3 pb-3 wrap-anywhere [&_hr]:opacity-20 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_p]:line-clamp-none [&_p]:leading-relaxed">
					<MarkdownBlock markdown={text} showCursor={partial} />
				</div>
				{!partial &&
					(review ? (
						<CompletionChecks key={`checks-${messageTs}`} review={review} />
					) : (
						<div className="border-t border-description/20 px-3 py-3 text-xs text-description">
							Check details weren’t recorded for this result.
						</div>
					))}
				{!partial && auditMetadata && <AuditReportPanel auditMetadata={auditMetadata} variant="neutral" />}
				{!partial && showActionRow && (
					<CompletionOutputActionRow
						key={`actions-${messageTs}`}
						messageTs={messageTs}
						seeNewChangesDisabled={seeNewChangesDisabled}
						setSeeNewChangesDisabled={setSeeNewChangesDisabled}
					/>
				)}
			</section>
		)
	},
)

CompletionOutputRow.displayName = "CompletionOutputRow"

const CompletionOutputActionRow = memo(
	({
		seeNewChangesDisabled,
		setSeeNewChangesDisabled,
		messageTs,
	}: Pick<CompletionOutputRowProps, "seeNewChangesDisabled" | "setSeeNewChangesDisabled" | "messageTs">) => {
		const [pending, setPending] = useState(false)
		const inFlight = useRef(false)
		const [error, setError] = useState<string>()
		const walkthrough = useSyncExternalStore(completionWalkthroughs.subscribe, () => completionWalkthroughs.get(messageTs))
		const activeTs = useSyncExternalStore(completionWalkthroughs.subscribe, completionWalkthroughs.getActiveTimestamp)
		const running = activeTs === messageTs
		const anotherRunning = activeTs !== undefined && !running
		const runDiff = async () => {
			if (inFlight.current) return
			inFlight.current = true
			setPending(true)
			setError(undefined)
			setSeeNewChangesDisabled(true)
			try {
				await TaskServiceClient.taskCompletionViewChanges(Int64Request.create({ value: messageTs }))
			} catch (err) {
				console.error("Failed to open completion review:", err)
				const recovery = Object.values(COMPLETION_REVIEW_ERRORS).find(
					(message) => err instanceof Error && err.message === message,
				)
				setError(recovery ?? "Couldn’t open the changes. Try Review changes again.")
			} finally {
				inFlight.current = false
				setPending(false)
				setSeeNewChangesDisabled(false)
			}
		}
		const visibleError = error ?? walkthrough.error
		return (
			<div className="border-t border-description/20 px-3 py-3">
				<div className="mb-2 text-xs text-description">
					{PLATFORM_CONFIG.type === PlatformType.VSCODE
						? "Review the diff or open a walkthrough with inline explanations."
						: "Review the diff for this result."}
				</div>
				<div className="flex flex-wrap gap-2">
					<Button
						aria-busy={pending}
						className="min-h-[44px] min-w-0 basis-48 grow whitespace-normal text-button-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border"
						disabled={pending || seeNewChangesDisabled}
						onClick={() => void runDiff()}
						type="button">
						<FileDiffIcon aria-hidden />
						<span className="min-w-0 wrap-anywhere">{pending ? "Opening changes…" : "Review changes"}</span>
					</Button>
					{PLATFORM_CONFIG.type === PlatformType.VSCODE && (
						<Button
							aria-label={running ? "Stop walkthrough" : undefined}
							className="min-h-[44px] min-w-0 basis-48 grow whitespace-normal shadow-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border"
							disabled={!running && (pending || anotherRunning)}
							onClick={() => {
								setError(undefined)
								if (running) completionWalkthroughs.stop(messageTs)
								else completionWalkthroughs.start(messageTs)
							}}
							type="button"
							variant="secondary">
							{running ? <SquareIcon aria-hidden /> : <MessageSquareTextIcon aria-hidden />}
							<span className="min-w-0 wrap-anywhere">
								{running
									? "Stop generating"
									: walkthrough.phase === "complete"
										? "Explain again"
										: "Explain changes"}
							</span>
						</Button>
					)}
				</div>
				<WalkthroughStatus state={walkthrough} />
				{anotherRunning && (
					<div className="mt-2 text-sm text-foreground">A walkthrough is running for another result.</div>
				)}
				{visibleError && (
					<div className="mt-2 text-sm text-error wrap-anywhere" role="alert">
						{visibleError}
						{walkthrough.phase === "error" && walkthrough.commentCount > 0 && (
							<div>Explanations already added remain in the diff.</div>
						)}
					</div>
				)}
			</div>
		)
	},
)

CompletionOutputActionRow.displayName = "CompletionOutputActionRow"
