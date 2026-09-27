import { formatSubagentParentSignal, isParentGateSignal } from "@shared/audit/auditSubagentRollup"
import type { DietCodeMessage, SubagentActivity, SubagentExecutionStatus, SubagentStatusItem } from "@shared/ExtensionMessage"
import { parseSubagentStatusPayload } from "@shared/subagents"
import {
	BotIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleSlashIcon,
	CircleXIcon,
	LoaderCircleIcon,
	NetworkIcon,
} from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import MarkdownBlock from "../common/MarkdownBlock"
import { ParentAuditGateBadge } from "./ParentAuditGateBadge"

interface SubagentStatusRowProps {
	message: DietCodeMessage
	isLast: boolean
	lastModifiedMessage?: DietCodeMessage
}

interface SubagentRowData {
	status: SubagentExecutionStatus
	items: SubagentStatusItem[]
}

const controlClass =
	"min-h-6 inline-flex items-center gap-1 rounded-xs border-0 bg-transparent px-1 py-0.5 text-xs text-foreground cursor-pointer hover:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--vscode-focusBorder)]"

function StatusIcon({ status }: { status: SubagentExecutionStatus }) {
	const Icon =
		status === "running"
			? LoaderCircleIcon
			: status === "completed"
				? CheckIcon
				: status === "failed"
					? CircleXIcon
					: status === "cancelled" || status === "interrupted"
						? CircleSlashIcon
						: BotIcon
	const color =
		status === "running"
			? "text-link motion-safe:animate-spin"
			: status === "completed"
				? "text-success"
				: status === "failed"
					? "text-error"
					: "text-description"
	return <Icon aria-hidden="true" className={`mt-0.5 size-3.5 shrink-0 ${color}`} />
}

const formatCount = (value: number): string => Intl.NumberFormat().format(value)
const formatCost = (value: number): string =>
	Intl.NumberFormat(undefined, {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: value >= 0.01 ? 2 : 4,
	}).format(value)
const formatDuration = (value: number): string => {
	const seconds = Math.floor(value / 1000)
	return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`
}

function activityLabel(activity?: SubagentActivity): string | undefined {
	switch (activity?.phase) {
		case "preparing":
			return "Preparing"
		case "waiting":
			return "Waiting for response"
		case "responding":
			return "Working"
		case "tool":
			return "Running tool"
		case "recovering":
			return "Changing approach"
		case "retrying":
			return activity.attempt && activity.maxAttempts
				? `Retrying · attempt ${activity.attempt} of ${activity.maxAttempts}`
				: "Retrying automatically"
	}
}

function parseSubagentRowData(message: Pick<DietCodeMessage, "text" | "ask" | "say">): SubagentRowData | undefined {
	if (message.ask !== "use_subagents" && message.say !== "use_subagents") return parseSubagentStatusPayload(message.text)
	try {
		const payload: unknown = JSON.parse(message.text || "null")
		if (!payload || typeof payload !== "object" || !("prompts" in payload) || !Array.isArray(payload.prompts))
			return undefined
		const items = payload.prompts.flatMap((prompt, index) =>
			typeof prompt === "string" && prompt.trim()
				? [
						{
							id: `pending-${index}`,
							name: `Helper ${index + 1}`,
							index: index + 1,
							prompt: prompt.trim(),
							status: "pending" as const,
							toolCalls: 0,
							inputTokens: 0,
							outputTokens: 0,
							totalCost: 0,
							contextTokens: 0,
							contextWindow: 0,
							contextUsagePercentage: 0,
						},
					]
				: [],
		)
		return items.length ? { status: "pending", items } : undefined
	} catch {
		return undefined
	}
}

function Assignment({ prompt, name }: { prompt: string; name: string }) {
	const promptId = useId()
	const promptRef = useRef<HTMLDivElement | null>(null)
	const [expanded, setExpanded] = useState(false)
	const [overflows, setOverflows] = useState(false)
	useEffect(() => {
		const element = promptRef.current
		if (!element || expanded || !prompt) return
		const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1)
		measure()
		if (typeof ResizeObserver === "undefined") return
		const observer = new ResizeObserver(measure)
		observer.observe(element)
		return () => observer.disconnect()
	}, [expanded, prompt])
	return (
		<div className="min-w-0">
			<div
				className={`text-sm text-foreground whitespace-pre-wrap wrap-anywhere ${expanded ? "" : "line-clamp-2"}`}
				id={promptId}
				ref={promptRef}>
				{prompt}
			</div>
			{(expanded || overflows) && (
				<button
					aria-controls={promptId}
					aria-expanded={expanded}
					aria-label={`${expanded ? "Collapse" : "Show full"} assignment for ${name}`}
					className={`${controlClass} mt-1`}
					onClick={() => setExpanded(!expanded)}
					type="button">
					{expanded ? "Show less" : "Show full assignment"}
				</button>
			)}
		</div>
	)
}

function HelperItem({ entry, interrupted, drafting }: { entry: SubagentStatusItem; interrupted: boolean; drafting: boolean }) {
	const outputId = useId()
	const [expanded, setExpanded] = useState(false)
	const status = interrupted && (entry.status === "running" || entry.status === "pending") ? "interrupted" : entry.status
	const hasOutput = Boolean(entry.result?.trim())
	const activity = status === "running" ? activityLabel(entry.activity) : undefined
	const stats = [
		entry.toolCalls ? `${formatCount(entry.toolCalls)} tool ${entry.toolCalls === 1 ? "call" : "calls"}` : "",
		entry.durationMs ? formatDuration(entry.durationMs) : "",
		entry.totalCost ? formatCost(entry.totalCost) : "",
	]
		.filter(Boolean)
		.join(" · ")
	return (
		<li className="min-w-0 py-3 first:pt-0 last:pb-0">
			<div className="flex items-start gap-2">
				<StatusIcon status={status} />
				<div className="min-w-0 flex-1">
					<div className="mb-1 flex items-baseline justify-between gap-x-3">
						<span className="min-w-0 flex-1 line-clamp-2 text-sm font-medium wrap-anywhere" title={entry.name}>
							{entry.name}
						</span>
						<span className={`shrink-0 text-xs ${status === "failed" ? "text-error" : "text-description"}`}>
							{status === "pending" ? "queued" : status}
						</span>
					</div>
					<Assignment name={entry.name} prompt={entry.prompt} />
					{activity && <div className="mt-1 text-xs text-description">{activity}</div>}
					{status === "running" && entry.latestToolCall?.trim() && (
						<div className="mt-1 truncate font-mono text-xs text-description" title={entry.latestToolCall}>
							{entry.latestToolCall}
						</div>
					)}
					{(status === "failed" || status === "cancelled" || status === "interrupted") && entry.error && (
						<div
							className={`mt-2 text-sm whitespace-pre-wrap wrap-anywhere ${status === "failed" ? "text-error" : "text-description"}`}>
							{entry.error}
						</div>
					)}
					{!drafting && stats && <div className="mt-1 text-xs tabular-nums text-description">{stats}</div>}
					{!drafting && hasOutput && (
						<button
							aria-controls={outputId}
							aria-expanded={expanded}
							aria-label={`${expanded ? "Hide" : "Show"} output for ${entry.name}`}
							className={`${controlClass} mt-1 -ms-1`}
							onClick={() => setExpanded(!expanded)}
							type="button">
							{expanded ? (
								<ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
							) : (
								<ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" />
							)}
							{expanded ? "Hide output" : status === "completed" ? "Show output" : "Show partial work"}
						</button>
					)}
					<div hidden={!expanded} id={outputId}>
						{expanded && hasOutput && (
							<div className="mt-2 min-w-0 text-sm wrap-anywhere">
								{status !== "completed" && <div className="mb-1 font-medium">Partial work</div>}
								<MarkdownBlock markdown={entry.result ?? ""} />
								{entry.contextTokens > 0 && (
									<div className="mt-2 text-xs text-description tabular-nums">
										Context: {formatCount(entry.contextTokens)}
										{entry.contextWindow > 0 ? ` / ${formatCount(entry.contextWindow)}` : ""} tokens
									</div>
								)}
								{!!entry.criticalSignals?.length && (
									<ul className="mt-2 ps-4 text-xs text-description">
										{entry.criticalSignals.map((signal) => (
											<li className="wrap-anywhere" key={signal}>
												{isParentGateSignal(signal) ? formatSubagentParentSignal(signal) : signal}
											</li>
										))}
									</ul>
								)}
							</div>
						)}
					</div>
				</div>
			</div>
		</li>
	)
}

export default function SubagentStatusRow({ message }: SubagentStatusRowProps) {
	const headingId = useId()
	const { text, ask, say } = message
	const data = useMemo(() => parseSubagentRowData({ text, ask, say }), [text, ask, say])
	if (!data)
		return (
			<div className="text-sm text-description">
				Helper status is unavailable. Check the conversation for the latest results.
			</div>
		)
	// The owner reconciles restart evidence. A newer chat message cannot establish
	// cancellation or interruption of a helper that may still have a live owner.
	const interrupted = data.status === "interrupted"
	const completed = data.items.filter((entry) => entry.status === "completed").length
	const failed = data.items.filter((entry) => entry.status === "failed").length
	const queued = interrupted ? 0 : data.items.filter((entry) => entry.status === "pending").length
	const running = interrupted ? 0 : data.items.filter((entry) => entry.status === "running").length
	const cancelled = data.items.filter((entry) => entry.status === "cancelled").length
	const interruptedCount = data.items.filter(
		(entry) => entry.status === "interrupted" || (interrupted && (entry.status === "running" || entry.status === "pending")),
	).length
	const summary = [
		`${completed} of ${data.items.length} completed`,
		running ? `${running} running` : "",
		queued ? `${queued} queued` : "",
		failed ? `${failed} failed` : "",
		cancelled ? `${cancelled} cancelled` : "",
		interruptedCount ? `${interruptedCount} interrupted` : "",
	]
		.filter(Boolean)
		.join(" · ")
	const availableWork = data.items.some((entry) => entry.result?.trim())
	const drafting = message.ask === "use_subagents" || message.say === "use_subagents"
	return (
		<section aria-labelledby={headingId} className="mb-2 min-w-0">
			<div className="mb-1 flex flex-wrap items-center gap-2">
				<NetworkIcon aria-hidden="true" className="size-3.5 shrink-0 text-description" />
				<h3 className="m-0 text-sm font-medium" id={headingId}>
					Delegated work
				</h3>
				<ParentAuditGateBadge />
			</div>
			<output aria-atomic="true" aria-live="polite" className="mb-3 block text-xs text-description tabular-nums">
				{summary}
			</output>
			{(failed > 0 || cancelled > 0 || interruptedCount > 0) && availableWork && (
				<div className="mb-3 text-xs text-description">
					Available results are preserved below for the main agent to continue.
				</div>
			)}
			<ul className="m-0 list-none divide-y divide-editor-group-border p-0">
				{data.items.map((entry, index) => (
					<HelperItem
						drafting={drafting && message.partial === true && index === data.items.length - 1}
						entry={entry}
						interrupted={interrupted}
						key={`${message.ts}:${entry.id}`}
					/>
				))}
			</ul>
		</section>
	)
}
