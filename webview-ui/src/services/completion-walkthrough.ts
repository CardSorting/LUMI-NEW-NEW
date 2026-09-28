import { COMPLETION_REVIEW_ERRORS } from "@shared/CompletionReview"
import type { ExplainChangesProgress } from "@shared/proto/dietcode/task"
import { TaskServiceClient } from "./grpc-client"
import type { Callbacks } from "./grpc-client-base"

export interface WalkthroughState extends ExplainChangesProgress {
	phase: "idle" | "loading" | "generating" | "complete" | "cancelled" | "error"
	error?: string
}

const IDLE: WalkthroughState = { phase: "idle", filesTotal: 0, filesExplained: 0, commentCount: 0, currentFile: "" }
type StartRequest = (messageTs: number, callbacks: Callbacks<ExplainChangesProgress>) => () => void

/** A chat row may be virtualized away while generation continues. Keep the operation outside React. */
export class CompletionWalkthroughStore {
	private records = new Map<number, WalkthroughState>()
	private listeners = new Set<() => void>()
	private active?: { messageTs: number; cancel?: () => void }

	constructor(private readonly request: StartRequest) {}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	get = (messageTs: number): WalkthroughState => this.records.get(messageTs) ?? IDLE
	getActiveTimestamp = (): number | undefined => this.active?.messageTs

	start(messageTs: number): void {
		if (this.active) return
		const run = { messageTs, cancel: undefined as (() => void) | undefined }
		this.active = run
		this.publish(messageTs, { ...IDLE, phase: "loading" })
		const fail = (error: Error) => {
			if (this.active !== run) return
			this.active = undefined
			const recovery = Object.values(COMPLETION_REVIEW_ERRORS).find((message) => message === error.message)
			this.publish(messageTs, {
				...this.get(messageTs),
				phase: "error",
				currentFile: "",
				error: recovery ?? "Couldn’t finish the walkthrough. Try Explain changes again.",
			})
		}
		try {
			const cancel = this.request(messageTs, {
				onResponse: (progress) => {
					if (this.active !== run) return
					if (!["loading", "generating", "complete", "cancelled"].includes(progress.phase)) return
					if (
						![progress.filesTotal, progress.filesExplained, progress.commentCount].every(
							(count) => Number.isSafeInteger(count) && count >= 0,
						) ||
						progress.filesExplained > progress.filesTotal
					)
						return
					this.publish(messageTs, { ...progress, phase: progress.phase as WalkthroughState["phase"] })
				},
				onError: fail,
				onComplete: () => {
					if (this.active !== run) return
					const state = this.get(messageTs)
					if (state.phase !== "complete" && state.phase !== "cancelled") {
						fail(new Error("Walkthrough ended without a completion result"))
						return
					}
					this.active = undefined
					this.publish(messageTs, state)
				},
			})
			if (this.active === run) run.cancel = cancel
			else cancel()
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)))
		}
	}

	stop(messageTs: number): void {
		const run = this.active
		if (!run || run.messageTs !== messageTs) return
		this.active = undefined
		this.publish(messageTs, { ...this.get(messageTs), phase: "cancelled", currentFile: "" })
		run.cancel?.()
	}

	/** Dispose a webview session; unmounting a virtual chat row only unsubscribes. */
	dispose(): void {
		const run = this.active
		this.active = undefined
		run?.cancel?.()
		this.records.clear()
		this.listeners.forEach((listener) => listener())
	}

	private publish(messageTs: number, state: WalkthroughState): void {
		this.records.delete(messageTs)
		this.records.set(messageTs, state)
		// Keep session memory bounded; saved task results remain in message history.
		if (this.records.size > 20) this.records.delete(this.records.keys().next().value as number)
		this.listeners.forEach((listener) => listener())
	}
}

export const completionWalkthroughs = new CompletionWalkthroughStore((messageTs, callbacks) =>
	TaskServiceClient.streamExplainChanges({ metadata: {}, messageTs }, callbacks),
)

if (typeof window !== "undefined") window.addEventListener("pagehide", () => completionWalkthroughs.dispose())
