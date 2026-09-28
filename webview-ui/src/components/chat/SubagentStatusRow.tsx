import { formatSubagentParentSignal, isParentGateSignal } from "@shared/audit/auditSubagentRollup"
import type { DietCodeMessage, SubagentActivity, SubagentExecutionStatus, SubagentStatusItem } from "@shared/ExtensionMessage"
import { parseSubagentStatusPayload, SUBAGENT_HEARTBEAT_STALE_MS, SUBAGENT_QUIET_WARNING_MS } from "@shared/subagents"
import {
	BotIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleSlashIcon,
	CircleXIcon,
	Clock3Icon,
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

function StatusIcon({ status, stale = false }: { status: SubagentExecutionStatus; stale?: boolean }) {
	const Icon =
		status === "running"
			? stale
				? Clock3Icon
				: LoaderCircleIcon
			: status === "completed"
				? CheckIcon
				: status === "failed"
					? CircleXIcon
					: status === "cancelled" || status === "interrupted"
						? CircleSlashIcon
						: BotIcon
	const color =
		status === "running"
			? stale
				? "text-description"
				: "text-link motion-safe:animate-spin"
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
	if (activity?.detail?.trim()) return activity.detail
	switch (activity?.phase) {
		case "preparing":
			return "Preparing helper"
		case "waiting":
			return "Waiting for model response"
		case "responding":
			return "Generating response"
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

function useRuntimeClock(active: boolean): number {
	const [now, setNow] = useState(Date.now)
	useEffect(() => {
		if (!active) return
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [active])
	return now
}

function RuntimeDetails({ entry, now }: { entry: SubagentStatusItem; now: number }) {
	const age = (at: number) => Math.max(0, now - at)
	const stale = !!entry.heartbeatAt && age(entry.heartbeatAt) >= SUBAGENT_HEARTBEAT_STALE_MS
	const quiet = !!entry.lastActivityAt && age(entry.lastActivityAt) >= SUBAGENT_QUIET_WARNING_MS
	const deadline = entry.activity?.retryAt ?? entry.activity?.deadlineAt
	return (
		<div className="mt-1 space-y-1 text-xs text-description tabular-nums">
			{entry.activity?.startedAt && <div>{formatDuration(age(entry.activity.startedAt))} in this step</div>}
			{deadline && (
				<div>
					{deadline > now
						? `${entry.activity?.retryAt ? "Retry" : "Wait timeout"} in ${formatDuration(deadline - now)}`
						: entry.activity?.retryAt
							? "Retry due · waiting for runtime update"
							: "Wait deadline reached · checking outcome"}
				</div>
			)}
			<div aria-live="off">
				{entry.heartbeatAt
					? `Runtime check-in ${formatDuration(age(entry.heartbeatAt))} ago`
					: "Live check-in unavailable"}
				{entry.lastActivityAt ? ` · Activity ${formatDuration(age(entry.lastActivityAt))} ago` : ""}
			</div>
			{(stale || quiet) && (
				<div aria-live="polite" className="text-foreground">
					{stale
						? "Live updates delayed. Runtime may be disconnected; running state is not confirmed."
						: entry.heartbeatAt
							? "No new activity yet. Runtime is responding; the current operation is still waiting."
							: "No new activity yet. Live runtime check-ins are unavailable."}
				</div>
			)}
			{stale && <div>Check the connection, or use the task’s Stop control if you no longer want to wait.</div>}
			{!!(entry.responseChunks || entry.requestCount) && (
				<div title="Provider chunks received, including non-text activity. This is not a completion percentage.">
					{formatCount(entry.responseChunks ?? 0)} response chunks · {formatCount(entry.responseBytes ?? 0)} bytes
					received{entry.requestCount ? ` · Request ${entry.requestCount}` : ""}
				</div>
			)}
		</div>
	)
}

function ActivityTrail({ entry }: { entry: SubagentStatusItem }) {
	const events = entry.activityEvents ?? []
	if (!events.length) return null
	const eventList = (items: typeof events) => (
		<ol className="m-0 list-none space-y-1 p-0">
			{items.map((event) => (
				<li className="flex items-baseline gap-2 text-xs" key={event.id}>
					<time
						className="shrink-0 text-description tabular-nums"
						dateTime={new Date(event.at).toISOString()}
						title={new Date(event.at).toLocaleTimeString()}>
						{formatDuration(Math.max(0, event.at - (entry.startedAt ?? entry.queuedAt ?? event.at)))}
					</time>
					<span className={`min-w-0 wrap-anywhere ${event.kind === "warning" ? "text-error" : "text-description"}`}>
						{event.label}
					</span>
				</li>
			))}
		</ol>
	)
	return (
		<div className="mt-3 min-w-0">
			<div className="mb-1 text-xs font-medium">Activity</div>
			{eventList(events.slice(-3))}
			{(events.length > 3 || !!entry.omittedActivityEvents) && (
				<details className="mt-1">
					<summary className={`${controlClass} -ms-1`}>Activity history ({events.length})</summary>
					<div aria-label={`Activity history for ${entry.name}`} className="mt-2 max-h-56 overflow-y-auto" tabIndex={0}>
						{eventList(events.slice(0, -3))}
					</div>
					{!!entry.omittedActivityEvents && (
						<div className="mt-1 text-xs text-description">
							{entry.omittedActivityEvents} earlier events omitted; showing the latest {events.length}.
						</div>
					)}
				</details>
			)}
		</div>
	)
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

function HelperItem({
	entry,
	interrupted,
	preview,
	now,
}: {
	entry: SubagentStatusItem
	interrupted: boolean
	preview?: "drafting" | "approval" | "starting"
	now: number
}) {
	const outputId = useId()
	const [expanded, setExpanded] = useState(false)
	const status = interrupted && (entry.status === "running" || entry.status === "pending") ? "interrupted" : entry.status
	const elapsed = status === "running" && entry.startedAt ? Math.max(0, now - entry.startedAt) : entry.durationMs || undefined
	const stale = status === "running" && !!entry.heartbeatAt && now - entry.heartbeatAt >= SUBAGENT_HEARTBEAT_STALE_MS
	const hasOutput = Boolean(entry.result?.trim())
	const activity =
		status === "running"
			? activityLabel(entry.activity) || "Starting helper"
			: status === "pending" && !preview
				? "Waiting for an available helper slot"
				: undefined
	const statusLabel =
		preview === "drafting"
			? "preparing assignment"
			: preview === "approval"
				? "awaiting approval"
				: preview === "starting"
					? "not started"
					: status === "pending"
						? "queued"
						: status
	const stats = [
		entry.toolCalls ? `${formatCount(entry.toolCalls)} tool ${entry.toolCalls === 1 ? "call" : "calls"}` : "",
		entry.totalCost ? formatCost(entry.totalCost) : "",
	]
		.filter(Boolean)
		.join(" · ")
	return (
		<li className="min-w-0 py-3 first:pt-0 last:pb-0">
			<div className="flex items-start gap-2">
				<StatusIcon stale={stale} status={status} />
				<div className="min-w-0 flex-1">
					<div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
						<span className="min-w-0 flex-1 line-clamp-2 text-sm font-medium wrap-anywhere" title={entry.name}>
							{entry.name}
						</span>
						<div className="flex flex-wrap items-baseline gap-x-2 text-xs">
							<span className={status === "failed" ? "text-error" : "text-description"}>
								{stale ? "updates delayed" : statusLabel}
							</span>
							{elapsed !== undefined && (
								<span aria-live="off" className="font-medium tabular-nums">
									{formatDuration(elapsed)} elapsed
								</span>
							)}
						</div>
					</div>
					{activity && (
						<div aria-atomic="true" aria-live="polite" className="text-sm text-foreground wrap-anywhere">
							{stale ? `Last reported: ${activity}` : activity}
						</div>
					)}
					{(status === "running" || (status === "pending" && !!entry.heartbeatAt)) && !preview && (
						<RuntimeDetails entry={entry} now={now} />
					)}
					{(status === "failed" || status === "cancelled" || status === "interrupted") && entry.error && (
						<div
							className={`mt-2 text-sm whitespace-pre-wrap wrap-anywhere ${status === "failed" ? "text-error" : "text-description"}`}>
							{entry.error}
						</div>
					)}
					{status === "pending" && !preview && (
						<div className="mt-1 text-xs text-description tabular-nums">
							{entry.queuePosition ? `Queue position ${entry.queuePosition}. ` : ""}
							{entry.queuedAt ? `${formatDuration(Math.max(0, now - entry.queuedAt))} waiting. ` : ""}Starts
							automatically when a shared helper slot is available.
						</div>
					)}
					{status === "running" && entry.latestToolCall?.trim() && !entry.activity?.detail && (
						<div className="mt-1 font-mono text-xs text-description wrap-anywhere">
							{entry.activity?.phase === "tool" ? "" : "Last tool: "}
							{entry.latestToolCall}
						</div>
					)}
					{!preview && entry.latestMessage?.trim() && status !== "completed" && (
						<div className="mt-2 text-sm whitespace-pre-wrap wrap-anywhere">
							<span className="text-xs text-description">Latest update</span>
							<div className="mt-1">{entry.latestMessage}</div>
						</div>
					)}
					{!preview && <ActivityTrail entry={entry} />}
					{!!entry.commands?.length && (
						<div className="mt-3 space-y-2">
							<div className="text-xs font-medium">
								Command output <span className="font-normal text-description">· latest captured output</span>
							</div>
							{entry.commands.map((command) => (
								<details key={command.id} open={command.status === "running" || command.status === "background"}>
									<summary className="cursor-pointer text-xs wrap-anywhere">
										<span className="font-mono">{command.command}</span>
										<span className="text-description">
											{" "}
											· {status !== "running" || stale ? "last reported " : ""}
											{command.status.replaceAll("_", " ")}
											{command.exitCode !== undefined ? ` · exit ${command.exitCode}` : ""}
										</span>
									</summary>
									<pre
										aria-label={`Command output: ${command.command}`}
										className="m-0 mt-1 max-h-48 overflow-auto border-s-2 border-editor-group-border ps-2 text-xs whitespace-pre-wrap wrap-anywhere"
										tabIndex={0}>
										{command.output || "No output received yet."}
									</pre>
								</details>
							))}
						</div>
					)}
					{!!entry.filesModified?.length && (
						<div className="mt-2 text-xs text-description">
							Files changed
							<ul className="m-0 mt-1 list-none p-0 font-mono text-foreground">
								{entry.filesModified.map((file) => (
									<li className="wrap-anywhere" key={file}>
										{file}
									</li>
								))}
							</ul>
						</div>
					)}
					{!!entry.recentTools?.length && (
						<details className="mt-2 min-w-0">
							<summary className="cursor-pointer text-xs text-description focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--vscode-focusBorder)]">
								Tool results ({entry.recentTools.length})
							</summary>
							<ol aria-label={`Recent activity for ${entry.name}`} className="m-0 mt-2 list-none space-y-2 p-0">
								{entry.recentTools.map((tool) => (
									<li className="text-xs wrap-anywhere" key={tool.id}>
										<div>{tool.label}</div>
										<div className={tool.status === "failed" ? "text-error" : "text-description"}>
											{tool.status === "returned"
												? "Result received"
												: tool.status === "failed"
													? "Failed"
													: status === "running"
														? "In progress"
														: "Outcome not confirmed"}
										</div>
										{tool.output && (
											<pre
												aria-label={`Result: ${tool.label}`}
												className="m-0 mt-1 max-h-40 overflow-auto border-s-2 border-editor-group-border ps-2 text-xs whitespace-pre-wrap wrap-anywhere"
												tabIndex={0}>
												{tool.output}
											</pre>
										)}
									</li>
								))}
							</ol>
							<div className="mt-2 text-xs text-description">
								Result previews retain up to the latest 4,000 characters per tool.
							</div>
						</details>
					)}
					<div className={preview ? "" : "mt-3"}>
						{!preview && <div className="mb-1 text-xs text-description">Assignment</div>}
						<Assignment name={entry.name} prompt={entry.prompt} />
					</div>
					{!preview && stats && <div className="mt-2 text-xs tabular-nums text-description">{stats}</div>}
					{!preview && hasOutput && (
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
	const now = useRuntimeClock(!!data?.items.some((entry) => entry.status === "running" || entry.status === "pending"))
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
	const delayed = interrupted
		? 0
		: data.items.filter(
				(entry) =>
					entry.status === "running" && !!entry.heartbeatAt && now - entry.heartbeatAt >= SUBAGENT_HEARTBEAT_STALE_MS,
			).length
	const cancelled = data.items.filter((entry) => entry.status === "cancelled").length
	const interruptedCount = data.items.filter(
		(entry) => entry.status === "interrupted" || (interrupted && (entry.status === "running" || entry.status === "pending")),
	).length
	const summary = [
		`${completed} of ${data.items.length} completed`,
		running > delayed ? `${running - delayed} running` : "",
		delayed ? `${delayed} awaiting live updates` : "",
		queued ? `${queued} queued` : "",
		failed ? `${failed} failed` : "",
		cancelled ? `${cancelled} cancelled` : "",
		interruptedCount ? `${interruptedCount} interrupted` : "",
	]
		.filter(Boolean)
		.join(" · ")
	const availableWork = data.items.some((entry) => entry.result?.trim())
	const isRequest = message.ask === "use_subagents" || message.say === "use_subagents"
	const preview = isRequest ? (message.partial ? "drafting" : message.ask ? "approval" : "starting") : undefined
	const requestSummary = `${data.items.length} helper${data.items.length === 1 ? "" : "s"} · ${
		preview === "drafting" ? "Preparing assignment" : preview === "approval" ? "Waiting for approval" : "Not started yet"
	}`
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
				{preview ? requestSummary : summary}
			</output>
			{(failed > 0 || cancelled > 0 || interruptedCount > 0) && availableWork && (
				<div className="mb-3 text-xs text-description">
					Available results are preserved below for the main agent to continue.
				</div>
			)}
			<ul className="m-0 list-none divide-y divide-editor-group-border p-0">
				{data.items.map((entry) => (
					<HelperItem
						entry={entry}
						interrupted={interrupted}
						key={`${message.ts}:${entry.id}`}
						now={now}
						preview={preview}
					/>
				))}
			</ul>
		</section>
	)
}
