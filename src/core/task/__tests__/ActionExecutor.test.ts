import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { ActionAlreadyActiveError } from "../ActionExecutionRegistry"
import { ActionExecutor } from "../ActionExecutor"
import { TaskState } from "../TaskState"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("ActionExecutor", () => {
	afterEach(() => sinon.restore())
	it("publishes queue identities before dispatch and isolates reservation observers", async () => {
		const executor = new ActionExecutor()
		const work = deferred()
		const running = Array.from({ length: 5 }, () => executor.execute("task", () => work.promise))
		let id!: string
		const operation = sinon.stub().resolves("done")
		const queued = executor.execute("task", operation, {
			execution: { kind: "helper", input: "assignment", label: "assignment" },
			onReserved: (reserved) => {
				id = reserved
				throw new Error("display failed")
			},
		})
		assert.equal(executor.executions.get("task", id)?.status, "queued")
		sinon.assert.notCalled(operation)
		work.resolve()
		await Promise.all([...running, queued])
		sinon.assert.calledOnce(operation)
	})
	it("retains structured late helper evidence independently of a truncated result preview", async () => {
		const clock = sinon.useFakeTimers()
		const executor = new ActionExecutor()
		let finish!: (value: unknown) => void
		let id!: string
		const timedOut = assert.rejects(
			executor.execute(
				"task",
				() =>
					new Promise((resolve) => {
						finish = resolve
					}),
				{
					execution: { kind: "helper", input: "assignment", label: "assignment" },
					timeoutMs: 10,
					onReserved: (reserved) => {
						id = reserved
					},
				},
			),
			/may still be running/,
		)
		await clock.tickAsync(10)
		await timedOut
		assert.equal(executor.executions.get("task", id)?.status, "awaiting_completion")
		finish({
			status: "cancelled",
			result: "evidence".repeat(2000),
			filesModified: ["committed.ts"],
			filesViewed: ["input.ts"],
			pendingCommandIds: ["still-running"],
		})
		await clock.tickAsync(0)
		const receipt = executor.executions.get("task", id)!
		assert.equal(receipt.status, "cancelled")
		assert.deepEqual(receipt.helper_handoff?.files_modified, ["committed.ts"])
		assert.deepEqual(receipt.helper_handoff?.pending_command_ids, ["still-running"])
		assert.equal(receipt.helper_handoff?.truncated, true)
		assert.equal(receipt.helper_handoff?.result?.length, 8000)
		receipt.helper_handoff!.files_modified.length = 0
		assert.deepEqual(executor.executions.get("task", id)?.helper_handoff?.files_modified, ["committed.ts"])
	})
	it("keeps a background command identity until its actual lifecycle settles", async () => {
		const executor = new ActionExecutor()
		let id!: string
		const execution = { kind: "command" as const, input: { command: "build", cwd: "/workspace" }, label: "build" }
		await executor.execute(
			"task",
			async (_signal, actionId) => {
				id = actionId!
				return [false, "still running", { status: "background", executionId: id }]
			},
			{ execution },
		)
		assert.equal(executor.executions.get("task", id)?.status, "awaiting_completion")
		assert.deepEqual(executor.getQueues("task"), [], "background processes must not occupy foreground scheduling slots")
		await assert.rejects(
			executor.execute("task", async () => "duplicate", { execution }),
			ActionAlreadyActiveError,
		)
		executor.executions.reconcileCommand("task", id, { status: "failed", exitCode: 9 })
		assert.equal(executor.executions.get("task", id)?.status, "failed")
		assert.equal(executor.executions.list("task").active.length, 0)
	})
	it("retains a final host result that arrives before a late foreground return", async () => {
		const executor = new ActionExecutor()
		let id!: string
		await executor.execute(
			"task",
			async (_signal, actionId) => {
				id = actionId!
				executor.executions.reconcileCommand("task", id, { status: "unconfirmed", terminalClosed: true })
				return [false, "old foreground snapshot", { status: "background" }]
			},
			{ execution: { kind: "command", input: "test", label: "test" } },
		)
		assert.equal(executor.executions.get("task", id)?.status, "unconfirmed")
	})
	it("does not strand an action claim when the command owner returns an existing execution", async () => {
		const executor = new ActionExecutor()
		let original!: string
		let duplicate!: string
		await executor.execute(
			"task",
			async (_signal, id) => {
				original = id!
				return [false, "running", { status: "background", executionId: id }]
			},
			{ execution: { kind: "command", input: "original", label: "original" } },
		)
		await executor.execute(
			"task",
			async (_signal, id) => {
				duplicate = id!
				return [false, "already running", { status: "background", executionId: original }]
			},
			{ execution: { kind: "command", input: "equivalent request", label: "same command" } },
		)
		assert.equal(executor.executions.get("task", duplicate)?.status, "not_started")
		assert.match(executor.executions.get("task", duplicate)!.result_preview!, new RegExp(original))
		assert.deepEqual(
			executor.executions.list("task").active.map((entry) => entry.execution_id),
			[original],
		)
		executor.executions.reconcileCommand("task", original, { status: "completed", exitCode: 0 })
		assert.equal(executor.executions.list("task").active.length, 0)
	})
	it("reports cancelled helpers as cancelled receipts", async () => {
		const executor = new ActionExecutor()
		await executor.execute("task", async () => ({ status: "cancelled" }), {
			execution: { kind: "helper", input: "work", label: "work" },
		})
		assert.equal(executor.executions.list("task").recent[0].status, "cancelled")
	})
	it("exposes FIFO blockers, unknown occupants, and queue removal without changing scheduler state", async () => {
		const clock = sinon.useFakeTimers()
		const executor = new ActionExecutor()
		const work = deferred()
		const running = Array.from({ length: 5 }, (_, i) =>
			executor.execute("task", () => work.promise, {
				concurrencyGroup: "mcp:docs",
				...(i < 3 ? { execution: { kind: "mcp_tool" as const, input: i, label: `request ${i}` } } : {}),
			}),
		)
		const controller = new AbortController()
		const cancelled = assert.rejects(
			executor.execute("task", async () => "must not start", {
				concurrencyGroup: "mcp:docs",
				signal: controller.signal,
				execution: { kind: "mcp_tool", input: "queued", label: "queued" },
			}),
			/abort/i,
		)
		await clock.tickAsync(0)
		const queues = executor.getQueues("task")
		assert.equal(queues[0].occupied_slots, 5)
		assert.equal(queues[0].concurrency, 5)
		assert.equal(queues[0].active_execution_ids.length, 3)
		assert.equal(queues[0].untracked_active, 2)
		assert.equal(queues[0].queue[0].position, 1)
		const queuedId = queues[0].queue[0].execution_id!
		assert.equal(executor.executions.get("task", queuedId)?.queue_timeout_ms, 30_000)
		assert.equal(executor.executions.get("task", queuedId)?.attempt, 0)
		assert.deepEqual(executor.getQueues("other-task"), [])
		assert.deepEqual(executor.getQueues("task"), queues)
		queues[0].queue.length = 0
		assert.equal(executor.getQueues("task")[0].queue.length, 1)
		controller.abort()
		await cancelled
		assert.equal(executor.getQueues("task")[0].occupied_slots, 5)
		assert.equal(executor.getQueues("task")[0].queue.length, 0)
		work.resolve()
		await Promise.all(running)
		assert.deepEqual(executor.getQueues("task"), [])
		assert.equal(clock.countTimers(), 0)
	})
	it("shows retry attempts accurately when a later attempt expires in the queue", async () => {
		const clock = sinon.useFakeTimers()
		const executor = new ActionExecutor()
		const operation = sinon.stub().rejects(new Error("SQLITE_BUSY"))
		const pending = assert.rejects(
			executor.execute("task", operation, {
				idempotent: true,
				maxRetries: 3,
				backoffMs: 10,
				queueTimeoutMs: 5,
				execution: { kind: "mcp_resource", input: "docs", label: "Read docs" },
			}),
			/waiting for an execution slot/,
		)
		await clock.tickAsync(0)
		const id = executor.executions.list("task").active[0].execution_id
		assert.equal(executor.executions.get("task", id)?.attempt, 1)
		assert.equal(executor.executions.get("task", id)?.max_attempts, 3)
		const work = deferred()
		const blockers = Array.from({ length: 5 }, () => executor.execute("task", () => work.promise))
		await clock.tickAsync(10)
		assert.equal(executor.executions.get("task", id)?.status, "queued")
		assert.equal(executor.getQueues("task")[0].queue[0].execution_id, id)
		await clock.tickAsync(5)
		await pending
		assert.equal(
			executor.executions.get("task", id)?.status,
			"failed",
			"the first attempt ran; the whole action was not 'not_started'",
		)
		assert.equal(executor.executions.get("task", id)?.attempt, 1)
		sinon.assert.calledOnce(operation)
		work.resolve()
		await Promise.all(blockers)
		assert.equal(clock.countTimers(), 0)
	})
	it("shows bounded distinguishing inputs while keeping credential redaction out of identity matching", async () => {
		const executor = new ActionExecutor()
		const work = deferred()
		const pending = ["secret-one", "secret-two"].map((token) =>
			executor.execute("task", () => work.promise, {
				execution: {
					kind: "mcp_tool",
					label: "docs/save",
					input: {
						server: "docs",
						arguments: { path: "report.txt", token, overwrite: false, limit: 7, pages: [1, 2] },
					},
				},
			}),
		)
		const active = executor.executions.list("task").active
		assert.equal(active.length, 2)
		assert.notEqual(active[0].execution_id, active[1].execution_id)
		for (const action of active) {
			const input = JSON.parse(action.input_preview!)
			assert.equal(input.arguments.path, "report.txt")
			assert.equal(input.arguments.overwrite, false)
			assert.equal(input.arguments.limit, 7)
			assert.deepEqual(input.arguments.pages, [1, 2])
			assert.equal(input.arguments.token, "[redacted]")
			assert.ok(!action.input_preview!.includes("secret-"))
			assert.ok(action.input_preview!.length <= 800)
		}
		work.resolve()
		await Promise.all(pending)
	})
	it("claims semantic identity before queueing and ignores owner and JSON key order", async () => {
		const executor = new ActionExecutor()
		const work = deferred()
		const blockers = Array.from({ length: 5 }, () => executor.execute("task", () => work.promise))
		const operation = sinon.stub().resolves("saved")
		const queued = executor.execute("task", operation, {
			execution: { kind: "mcp_tool", input: { a: 1, b: 2 }, label: "save", owner: "helper one" },
		})
		const [{ execution_id, status }] = executor.executions.list("task").active
		assert.equal(status, "queued")
		await assert.rejects(
			executor.execute("task", operation, {
				execution: { kind: "mcp_tool", input: { b: 2, a: 1 }, label: "same save", owner: "helper two" },
			}),
			(error: unknown) => {
				assert.ok(error instanceof ActionAlreadyActiveError)
				assert.equal(error.execution.execution_id, execution_id)
				return true
			},
		)
		sinon.assert.notCalled(operation)
		work.resolve()
		await Promise.all([...blockers, queued])
		sinon.assert.calledOnce(operation)
		assert.equal(executor.executions.get("task", execution_id)?.status, "completed")
		assert.equal(executor.executions.get("another task", execution_id), undefined)
		assert.equal(
			await executor.execute("task", operation, {
				execution: { kind: "mcp_tool", input: { a: 1, b: 2 }, label: "save again" },
			}),
			"saved",
		)
		sinon.assert.calledTwice(operation)
	})
	it("keeps a timed-out identity reserved and publishes its actual late result", async () => {
		const clock = sinon.useFakeTimers()
		const executor = new ActionExecutor()
		let finish!: (value: string) => void
		const operation = sinon.stub().returns(
			new Promise<string>((resolve) => {
				finish = resolve
			}),
		)
		const execution = { kind: "mcp_tool" as const, input: ["save", "a"], label: "Save a" }
		const timedOut = assert.rejects(executor.execute("task", operation, { execution, timeoutMs: 10 }), /may still be running/)
		const id = executor.executions.list("task").active[0].execution_id
		await clock.tickAsync(10)
		await timedOut
		assert.equal(executor.executions.get("task", id)?.status, "awaiting_completion")
		assert.deepEqual(executor.getQueues("task")[0].active_execution_ids, [id])
		assert.equal(executor.executions.get("task", id)?.max_attempts, 1)
		await assert.rejects(executor.execute("task", operation, { execution }), ActionAlreadyActiveError)
		sinon.assert.calledOnce(operation)
		finish("Saved once")
		await clock.tickAsync(0)
		assert.equal(executor.executions.get("task", id)?.status, "completed")
		assert.equal(executor.executions.get("task", id)?.result_preview, "Saved once")
		assert.equal(executor.executions.list("task").active.length, 0)
		assert.equal(clock.countTimers(), 0)
	})
	it("keeps a single identity throughout idempotent backoff and clears it on cancellation", async () => {
		const clock = sinon.useFakeTimers()
		const executor = new ActionExecutor()
		const controller = new AbortController()
		const operation = sinon.stub().rejects(new Error("SQLITE_BUSY"))
		const execution = { kind: "file_write" as const, input: "a", label: "Save a" }
		const pending = assert.rejects(
			executor.execute("task", operation, { execution, idempotent: true, signal: controller.signal, backoffMs: 100 }),
			/abort/i,
		)
		await clock.tickAsync(0)
		const id = executor.executions.list("task").active[0].execution_id
		assert.equal(executor.executions.get("task", id)?.status, "retrying")
		await assert.rejects(executor.execute("task", operation, { execution }), ActionAlreadyActiveError)
		controller.abort()
		await pending
		assert.equal(executor.executions.get("task", id)?.status, "failed")
		assert.equal(executor.executions.list("task").active.length, 0)
		sinon.assert.calledOnce(operation)
		assert.equal(clock.countTimers(), 0)
	})
	it("releases an expired queue reservation without dispatching it and bounds completed receipts", async () => {
		const clock = sinon.useFakeTimers()
		const executor = new ActionExecutor()
		const work = deferred()
		const blockers = Array.from({ length: 5 }, () => executor.execute("task", () => work.promise))
		const operation = sinon.stub().resolves("x".repeat(5000))
		const execution = { kind: "file_write" as const, input: "a", label: "Save a" }
		const expired = assert.rejects(executor.execute("task", operation, { execution, queueTimeoutMs: 10 }), /did not start/)
		const id = executor.executions.list("task").active[0].execution_id
		await clock.tickAsync(10)
		await expired
		assert.equal(executor.executions.get("task", id)?.status, "not_started")
		sinon.assert.notCalled(operation)
		work.resolve()
		await Promise.all(blockers)
		for (let i = 0; i < 129; i++) await executor.execute("task", operation, { execution })
		assert.equal(executor.executions.get("task", id), undefined)
		assert.equal(executor.executions.list("task").recent.length, 8)
		assert.ok(executor.executions.list("task").recent.every((entry) => entry.result_preview!.length <= 1600))
		assert.equal(clock.countTimers(), 0)
	})
	it("limits helper concurrency across separate batches without blocking shell actions", async () => {
		const executor = new ActionExecutor()
		const work = deferred()
		const operation = sinon.stub().returns(work.promise)
		const helpers = Array.from({ length: 5 }, (_, index) =>
			executor.execute("task", operation, {
				concurrencyGroup: "helpers:0",
				execution: { kind: "helper", input: index, label: `Helper ${index}` },
			}),
		)
		await flush()
		assert.equal(operation.callCount, 3)
		assert.equal(executor.executions.list("task").active.filter((entry) => entry.status === "queued").length, 2)
		assert.equal(await executor.execute("task", async () => "independent", { concurrencyGroup: "shell" }), "independent")
		assert.equal(await executor.execute("task", async () => "child", { concurrencyGroup: "helpers:1" }), "child")
		work.resolve()
		await Promise.all(helpers)
		assert.equal(operation.callCount, 5)
	})
	it("does not discard completed SDK values when a preview encounters cycles or throwing getters", async () => {
		const executor = new ActionExecutor()
		const cyclic: Record<string, unknown> = { text: "saved" }
		cyclic.self = cyclic
		const getter = Object.defineProperty({}, "isError", {
			enumerable: true,
			get() {
				throw new Error("unreadable")
			},
		})
		for (const value of [cyclic, getter]) {
			assert.equal(
				await executor.execute("task", async () => value, {
					execution: { kind: "mcp_tool", input: "resource", label: "Read resource" },
				}),
				value,
			)
			const receipt = executor.executions.list("task").recent.at(-1)!
			assert.equal(receipt.status, "completed")
			assert.ok(receipt.result_preview!.length <= 1600)
			receipt.status = "failed"
			assert.equal(executor.executions.get("task", receipt.execution_id)?.status, "completed")
		}
	})

	it("expires queued work without ever dispatching it later or freeing an occupied slot", async () => {
		const clock = sinon.useFakeTimers()
		const executor = new ActionExecutor()
		const work = deferred()
		const running = Array.from({ length: 5 }, () => executor.execute("task", () => work.promise))
		const operation = sinon.stub().resolves()
		const queued = assert.rejects(
			executor.execute("task", operation, { queueTimeoutMs: 20, idempotent: true }),
			/Action did not start/,
		)
		await clock.tickAsync(20)
		await queued
		sinon.assert.notCalled(operation)
		assert.equal(await executor.execute("task", async () => "independent", { concurrencyGroup: "other" }), "independent")
		work.resolve()
		await Promise.all(running)
		sinon.assert.notCalled(operation)
		assert.equal(clock.countTimers(), 0)
	})

	it("does not turn oversized operation deadlines into immediate timeouts", async () => {
		const clock = sinon.useFakeTimers()
		const work = deferred()
		const pending = new ActionExecutor().execute("task", () => work.promise, { timeoutMs: 1e15 })
		await clock.tickAsync(100)
		work.resolve()
		await pending
		assert.equal(clock.countTimers(), 0)
	})

	it("does not replay a mutating action on transient errors", async () => {
		const executor = new ActionExecutor()
		const operation = sinon.stub().rejects(new Error("UNAVAILABLE"))
		await assert.rejects(executor.execute("task", operation, { maxRetries: 5 }), /UNAVAILABLE/)
		sinon.assert.calledOnce(operation)
	})

	it("retries explicitly idempotent work with bounded backoff", async () => {
		const clock = sinon.useFakeTimers()
		const operation = sinon.stub().onFirstCall().rejects(new Error("SQLITE_BUSY"))
		operation.onSecondCall().resolves("saved")
		const result = new ActionExecutor().execute("task", operation, { idempotent: true, backoffMs: 20 })
		await clock.tickAsync(19)
		sinon.assert.calledOnce(operation)
		await clock.tickAsync(1)
		assert.equal(await result, "saved")
		assert.equal(clock.countTimers(), 0)
	})

	it("does not retry timeout or cancellation errors even for idempotent work", async () => {
		for (const message of ["TIMEOUT", "ABORTED", "deadline exceeded"]) {
			const operation = sinon.stub().rejects(new Error(message))
			await assert.rejects(new ActionExecutor().execute("task", operation, { idempotent: true }))
			sinon.assert.calledOnce(operation)
		}
	})

	it("lets tools own their default timeout, including commands longer than a minute", async () => {
		const clock = sinon.useFakeTimers()
		const work = deferred()
		let settled = false
		const result = new ActionExecutor()
			.execute("task", () => work.promise)
			.finally(() => {
				settled = true
			})
		await clock.tickAsync(120_000)
		assert.equal(settled, false)
		assert.equal(clock.countTimers(), 0)
		work.resolve()
		await result
	})

	it("keeps timed-out work in its slot until the operation actually settles", async () => {
		const clock = sinon.useFakeTimers()
		const executor = new ActionExecutor()
		const work = Array.from({ length: 5 }, deferred)
		const operations = work.map((item) => sinon.stub().returns(item.promise))
		const results = operations.map((operation) =>
			assert.rejects(
				executor.execute("task", operation, {
					timeoutMs: 10,
					idempotent: true,
				}),
				/may still be running/,
			),
		)
		const next = sinon.stub().resolves()
		const queued = executor.execute("task", next)
		await clock.tickAsync(10)
		await Promise.all(results)
		operations.forEach((operation) => sinon.assert.calledOnce(operation))
		sinon.assert.notCalled(next)
		work[0].resolve()
		await queued
		sinon.assert.calledOnce(next)
		work.forEach((item) => item.resolve())
		await clock.tickAsync(0)
		assert.equal(clock.countTimers(), 0)
	})

	it("hands slots to queued work in FIFO order without exceeding capacity", async () => {
		const executor = new ActionExecutor()
		const work = Array.from({ length: 14 }, deferred)
		const started: number[] = []
		let active = 0
		let peak = 0
		const pending = work.map((item, index) =>
			executor.execute("task", async () => {
				started.push(index)
				peak = Math.max(peak, ++active)
				await item.promise
				active--
			}),
		)
		await flush()
		assert.deepEqual(started, [0, 1, 2, 3, 4])
		for (const item of work) {
			item.resolve()
			await flush()
		}
		await Promise.all(pending)
		assert.equal(peak, 5)
		assert.deepEqual(
			started,
			work.map((_, index) => index),
		)
	})

	it("removes cancelled queued actions and keeps unrelated tasks moving", async () => {
		const executor = new ActionExecutor()
		const work = deferred()
		const running = Array.from({ length: 5 }, () => executor.execute("task", () => work.promise))
		const state = new TaskState()
		const operation = sinon.stub().resolves()
		const cancelled = assert.rejects(executor.execute("task", operation, { signal: state.abortSignal }), /abort/i)
		state.abort = true
		await cancelled
		assert.equal(await executor.execute("other task", async () => "ready"), "ready")
		work.resolve()
		await Promise.all(running)
		sinon.assert.notCalled(operation)
		assert.equal(await executor.execute("task", async () => "ready"), "ready")
	})

	it("propagates running cancellation and clears its deadline", async () => {
		const clock = sinon.useFakeTimers()
		const state = new TaskState()
		const work = deferred()
		let signal: AbortSignal | undefined
		const result = assert.rejects(
			new ActionExecutor().execute(
				"task",
				(current) => {
					signal = current
					return work.promise
				},
				{ timeoutMs: 500, signal: state.abortSignal },
			),
			/abort/i,
		)
		await clock.tickAsync(0)
		state.abort = true
		await result
		assert.equal(signal?.aborted, true)
		assert.equal(clock.countTimers(), 0)
		work.resolve()
	})

	it("cleans up successful deadlines and cancelled retry delays", async () => {
		const clock = sinon.useFakeTimers()
		const executor = new ActionExecutor()
		await executor.execute("task", async () => "done", { timeoutMs: 50 })
		assert.equal(clock.countTimers(), 0)
		const state = new TaskState()
		const operation = sinon.stub().rejects(new Error("RATE_LIMIT"))
		const result = assert.rejects(
			executor.execute("task", operation, { idempotent: true, signal: state.abortSignal }),
			/abort/i,
		)
		await clock.tickAsync(0)
		state.abort = true
		await result
		sinon.assert.calledOnce(operation)
		assert.equal(clock.countTimers(), 0)
	})

	it("lets an in-flight atomic save settle before its caller cleans up", async () => {
		const state = new TaskState()
		const work = deferred()
		let settled = false
		const result = new ActionExecutor()
			.execute("task", () => work.promise, {
				signal: state.abortSignal,
				settleOnAbort: true,
			})
			.finally(() => {
				settled = true
			})
		await flush()
		state.abort = true
		await flush()
		assert.equal(settled, false)
		work.resolve()
		await result
		assert.equal(settled, true)
	})

	it("does not apply one task's accumulated failures to another action", async () => {
		const executor = new ActionExecutor()
		for (let i = 0; i < 25; i++)
			await assert.rejects(
				executor.execute("broken", async () => {
					throw new Error("failed")
				}),
			)
		assert.equal(await executor.execute("healthy", async () => "done"), "done")
		assert.equal(await executor.execute("broken", async () => "recovered"), "recovered")
	})

	it("never starts an action after cancellation, and can resume with a fresh signal", async () => {
		const state = new TaskState()
		const operation = sinon.stub().resolves()
		const executor = new ActionExecutor()
		state.abort = true
		await assert.rejects(executor.execute("task", operation, { signal: state.abortSignal }), /abort/i)
		sinon.assert.notCalled(operation)
		state.abort = false
		await executor.execute("task", operation, { signal: state.abortSignal })
		sinon.assert.calledOnce(operation)
	})
})
