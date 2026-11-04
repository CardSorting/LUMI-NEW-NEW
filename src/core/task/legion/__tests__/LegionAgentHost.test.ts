import type { ApiHandler } from "@core/api"
import { expect } from "chai"
import sinon from "sinon"
import type { SpawnedLegionMember } from "@/infrastructure/ai/LegionCoordinator"
import { LEGION_CORE_RULES, LegionAgentHost } from "../LegionAgentHost"

const member = { assignment: { title: "Researcher", focusObjective: "Inspect the code" } } as SpawnedLegionMember

describe("LegionAgentHost", () => {
	it("runs an isolated tool conversation and returns an explicit completion", async () => {
		const messages: unknown[] = []
		let request = 0
		const api = {
			createMessage: (_system: string, history: unknown) => {
				messages.push(structuredClone(history))
				const current = request++
				return (async function* () {
					yield current === 0
						? {
								type: "tool_calls",
								tool_call: { function: { id: "one", name: "read_file", arguments: '{"path":"a.ts"}' } },
							}
						: {
								type: "tool_calls",
								tool_call: {
									function: { id: "two", name: "attempt_completion", arguments: '{"result":"Found evidence"}' },
								},
							}
				})()
			},
		} as unknown as ApiHandler
		const executed: string[] = []
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => ({
				definitions: [],
				allowedNames: new Set(["read_file"]),
				execute: async (name) => {
					executed.push(name)
					return "file contents"
				},
			}),
		})
		const result = await host.execute(member, { handoff: ["prior evidence"], signal: new AbortController().signal })
		expect(result).to.deep.equal({ status: "completed", summary: "Found evidence" })
		expect(executed).to.deep.equal(["read_file"])
		expect(JSON.stringify(messages[1])).to.include("file contents")
	})

	it("does not dispatch a disallowed tool or treat an incomplete response as success", async () => {
		const api = {
			createMessage: () =>
				(async function* () {
					yield { type: "tool_calls", tool_call: { function: { id: "one", name: "execute_command", arguments: "{}" } } }
				})(),
		} as unknown as ApiHandler
		let calls = 0
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => ({
				definitions: [],
				allowedNames: new Set(),
				execute: async () => {
					calls++
					return ""
				},
			}),
		})
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result.status).to.equal("failed")
		expect(calls).to.equal(0)
	})

	it("never executes an incomplete streamed tool call", async () => {
		const api = {
			createMessage: () =>
				(async function* () {
					yield { type: "tool_calls", tool_call: { function: { id: "one", name: "read_file", arguments: '{"path":' } } }
				})(),
		} as unknown as ApiHandler
		let calls = 0
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => ({
				definitions: [],
				allowedNames: new Set(["read_file"]),
				execute: async () => {
					calls++
					return ""
				},
			}),
		})
		expect((await host.execute(member, { handoff: [], signal: new AbortController().signal })).status).to.equal("failed")
		expect(calls).to.equal(0)
	})

	it("preserves attempted tool paths when a later response fails", async () => {
		let turn = 0
		const api = {
			createMessage: () => {
				const current = turn++
				return (async function* () {
					if (current === 0)
						yield {
							type: "tool_calls",
							tool_call: {
								function: {
									id: "one",
									name: "write_to_file",
									arguments: '{"path":"changed.ts","content":"private content"}',
								},
							},
						}
					else throw new Error("provider interrupted")
				})()
			},
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => ({
				definitions: [],
				allowedNames: new Set(["write_to_file"]),
				execute: async () => "saved",
			}),
		})
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result.status).to.equal("failed")
		if (result.status === "failed") {
			expect(result.reason).to.include("write_to_file (changed.ts)")
			expect(result.reason).not.to.include("private content")
		}
	})

	it("shares the reported token budget across specialists", async () => {
		let requests = 0
		const host = new LegionAgentHost({
			maxTokens: 10,
			createApi: () =>
				({
					createMessage: () =>
						(async function* () {
							requests++
							yield { type: "usage", inputTokens: 6, outputTokens: 0 }
							yield {
								type: "tool_calls",
								tool_call: {
									function: { id: "done", name: "attempt_completion", arguments: '{"result":"done"}' },
								},
							}
						})(),
				}) as unknown as ApiHandler,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
		})
		const signal = new AbortController().signal
		expect((await host.execute(member, { handoff: [], signal })).status).to.equal("completed")
		expect((await host.execute(member, { handoff: [], signal })).status).to.equal("failed")
		expect((await host.execute(member, { handoff: [], signal })).status).to.equal("failed")
		expect(requests).to.equal(2)
	})

	it("reports team usage and treats repeated request cost as a cumulative value", async () => {
		const snapshots: Array<{ tokensIn: number; cost?: number }> = []
		const host = new LegionAgentHost({
			createApi: () =>
				({
					createMessage: () =>
						(async function* () {
							yield { type: "usage", inputTokens: 4, outputTokens: 0, totalCost: 0.1 }
							yield { type: "usage", inputTokens: 0, outputTokens: 2, totalCost: 0.15 }
							yield {
								type: "tool_calls",
								tool_call: {
									function: { id: "done", name: "attempt_completion", arguments: '{"result":"done"}' },
								},
							}
						})(),
				}) as unknown as ApiHandler,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
			onUsage: async (usage) => {
				snapshots.push(usage)
			},
		})
		const signal = new AbortController().signal
		expect((await host.execute(member, { handoff: [], signal })).status).to.equal("completed")
		expect((await host.execute(member, { handoff: [], signal })).status).to.equal("completed")
		expect(snapshots.at(-1)?.tokensIn).to.equal(8)
		expect(snapshots.at(-1)?.cost).to.be.closeTo(0.3, 1e-9)
	})

	it("records provider fallback usage when the stream has no usage chunks", async () => {
		const snapshots: Array<{ tokensIn: number; cost?: number }> = []
		const host = new LegionAgentHost({
			createApi: () =>
				({
					createMessage: () =>
						(async function* () {
							yield {
								type: "tool_calls",
								tool_call: {
									function: { id: "done", name: "attempt_completion", arguments: '{"result":"done"}' },
								},
							}
						})(),
					getApiStreamUsage: async () => ({ type: "usage", inputTokens: 7, outputTokens: 1, totalCost: 0.03 }),
				}) as unknown as ApiHandler,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
			onUsage: async (usage) => {
				snapshots.push(usage)
			},
		})
		expect((await host.execute(member, { handoff: [], signal: new AbortController().signal })).status).to.equal("completed")
		expect(snapshots[0]).to.include({ tokensIn: 7, cost: 0.03 })
	})

	it("stops promptly on steering even if the provider does not settle", async () => {
		const controller = new AbortController()
		let started!: () => void
		const ready = new Promise<void>((resolve) => {
			started = resolve
		})
		const host = new LegionAgentHost({
			createApi: () =>
				({
					createMessage: () =>
						(async function* () {
							started()
							await new Promise<void>(() => {})
						})(),
				}) as unknown as ApiHandler,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
		})
		const pending = host.execute(member, { handoff: [], signal: controller.signal })
		await ready
		controller.abort()
		expect((await pending).status).to.equal("failed")
	})

	it("requires a running command to settle before accepting completion", async () => {
		let turn = 0
		let running = true
		const host = new LegionAgentHost({
			createApi: () =>
				({
					createMessage: () => {
						const current = turn++
						return (async function* () {
							const call =
								current === 1
									? { id: "observe", name: "read_command_output", arguments: '{"execution_id":"command-1"}' }
									: { id: `done-${current}`, name: "attempt_completion", arguments: '{"result":"verified"}' }
							yield { type: "tool_calls", tool_call: { function: call } }
						})()
					},
				}) as unknown as ApiHandler,
			createTools: async () => ({
				definitions: [],
				allowedNames: new Set(["read_command_output"]),
				getPendingWork: () => (running ? "Command command-1 is still active" : undefined),
				execute: async () => {
					running = false
					return "completed"
				},
			}),
		})
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result).to.deep.equal({ status: "completed", summary: "verified" })
		expect(turn).to.equal(3)
	})

	it("processes tool calls when ID is on call.call_id or call.id", async () => {
		let turn = 0
		const api = {
			createMessage: () => {
				const current = turn++
				return (async function* () {
					yield current === 0
						? {
								type: "tool_calls",
								tool_call: { call_id: "call-1", function: { name: "read_file", arguments: '{"path":"b.ts"}' } },
							}
						: {
								type: "tool_calls",
								tool_call: {
									call_id: "call-2",
									function: { name: "attempt_completion", arguments: '{"result":"All done"}' },
								},
							}
				})()
			},
		} as unknown as ApiHandler
		const executed: string[] = []
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => ({
				definitions: [],
				allowedNames: new Set(["read_file"]),
				execute: async (name) => {
					executed.push(name)
					return "content"
				},
			}),
		})
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result).to.deep.equal({ status: "completed", summary: "All done" })
		expect(executed).to.deep.equal(["read_file"])
	})

	it("captures fallback usage when provider stream throws mid-stream", async () => {
		const snapshots: Array<{ tokensIn: number; tokensOut: number }> = []
		const api = {
			createMessage: () =>
				(async function* () {
					yield { type: "text", text: "Partial thoughts..." }
					throw new Error("Provider socket reset mid-stream")
				})(),
			getApiStreamUsage: async () => ({ type: "usage", inputTokens: 42, outputTokens: 5, totalCost: 0.002 }),
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
			onUsage: async (usage) => {
				snapshots.push(usage)
			},
		})
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result.status).to.equal("failed")
		expect(snapshots.length).to.be.greaterThan(0)
		expect(snapshots[0].tokensIn).to.equal(42)
		expect(snapshots[0].tokensOut).to.equal(5)
	})

	it("calculates cost fallback from model info when usage chunk omits totalCost", async () => {
		const snapshots: Array<{ tokensIn: number; cost?: number }> = []
		const api = {
			getModel: () => ({ id: "test-model", info: { inputPrice: 3.0, outputPrice: 15.0 } }),
			createMessage: () =>
				(async function* () {
					yield { type: "usage", inputTokens: 1000, outputTokens: 200 }
					yield {
						type: "tool_calls",
						tool_call: {
							function: { id: "done", name: "attempt_completion", arguments: '{"result":"Calculated"}' },
						},
					}
				})(),
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
			onUsage: async (usage) => {
				snapshots.push(usage)
			},
		})
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result.status).to.equal("completed")
		expect(snapshots.length).to.be.greaterThan(0)
		// (1000 * 3 + 200 * 15) / 1_000_000 = 6000 / 1_000_000 = 0.006
		expect(snapshots[0].cost).to.be.closeTo(0.006, 1e-9)
	})

	it("injects reservation warning notice into the assignment prompt", async () => {
		let promptReceived = ""
		const api = {
			createMessage: (_sys: string, conversation: any[]) => {
				promptReceived = conversation[0].content
				return (async function* () {
					yield {
						type: "tool_calls",
						tool_call: {
							function: { id: "done", name: "attempt_completion", arguments: '{"result":"Acknowledged"}' },
						},
					}
				})()
			},
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
		})
		const memberWithWarning = {
			...member,
			reservationWarning: "File 'Button.tsx' already reserved by active stream 12345678",
		}
		const result = await host.execute(memberWithWarning, { handoff: [], signal: new AbortController().signal })
		expect(result.status).to.equal("completed")
		expect(promptReceived).to.include("Reservation Notice: File 'Button.tsx' already reserved by active stream 12345678")
	})

	it("accumulates fallback cost across multiple turns when provider omits totalCost on every turn", async () => {
		const usages: Array<{ tokensIn: number; cost?: number }> = []
		let turnCount = 0
		const api = {
			getModel: () => ({ id: "test-model", info: { inputPrice: 10.0, outputPrice: 20.0 } }),
			createMessage: () => {
				turnCount++
				return (async function* () {
					if (turnCount === 1) {
						yield { type: "usage", inputTokens: 1000, outputTokens: 100 }
						yield {
							type: "tool_calls",
							tool_call: {
								function: { id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' },
							},
						}
					} else {
						yield { type: "usage", inputTokens: 2000, outputTokens: 200 }
						yield {
							type: "tool_calls",
							tool_call: {
								function: { id: "c2", name: "attempt_completion", arguments: '{"result":"All done"}' },
							},
						}
					}
				})()
			},
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => ({
				definitions: [],
				allowedNames: new Set(["read_file", "attempt_completion"]),
				execute: async () => "file content",
			}),
			onUsage: async (usage) => {
				usages.push({ tokensIn: usage.tokensIn, cost: usage.cost })
			},
		})
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result.status).to.equal("completed")
		expect(usages.length).to.equal(2)
		// Turn 1: (1000 * 10 + 100 * 20) / 1e6 = 12000 / 1e6 = 0.012
		expect(usages[0].cost).to.be.closeTo(0.012, 1e-9)
		// Turn 2: Turn 1 cost + (2000 * 10 + 200 * 20) / 1e6 = 0.012 + 0.024 = 0.036
		expect(usages[1].cost).to.be.closeTo(0.036, 1e-9)
	})

	it("estimates heuristic tokens and calls recordUsage when provider stream omits usage entirely", async () => {
		const usages: Array<{ tokensIn: number; tokensOut: number }> = []
		const api = {
			createMessage: () =>
				(async function* () {
					yield { type: "text", text: "Here is the response without any usage chunk." }
					yield {
						type: "tool_calls",
						tool_call: {
							function: { id: "done", name: "attempt_completion", arguments: '{"result":"Done"}' },
						},
					}
				})(),
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
			onUsage: async (usage) => {
				usages.push({ tokensIn: usage.tokensIn, tokensOut: usage.tokensOut })
			},
		})
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result.status).to.equal("completed")
		expect(usages.length).to.be.greaterThan(0)
		expect(usages[0].tokensIn).to.be.greaterThan(0)
		expect(usages[0].tokensOut).to.be.greaterThan(0)
	})

	it("disposes tools in finally block upon completion or failure", async () => {
		const disposeSpy = sinon.spy()
		const api = {
			createMessage: () =>
				(async function* () {
					yield {
						type: "tool_calls",
						tool_call: {
							function: { id: "done", name: "attempt_completion", arguments: '{"result":"Done"}' },
						},
					}
				})(),
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => ({
				definitions: [],
				allowedNames: new Set(),
				execute: async () => "",
				dispose: disposeSpy,
			}),
		})
		sinon.assert.notCalled(disposeSpy)
		await host.execute(member, { handoff: [], signal: new AbortController().signal })
		sinon.assert.calledOnce(disposeSpy)
	})

	it("falls back to heuristic tokens even if stream emitted an empty (0 tokens) usage chunk", async () => {
		const usages: Array<{ tokensIn: number; tokensOut: number }> = []
		const api = {
			createMessage: () =>
				(async function* () {
					yield { type: "usage", inputTokens: 0, outputTokens: 0 }
					yield {
						type: "tool_calls",
						tool_call: {
							function: { id: "done", name: "attempt_completion", arguments: '{"result":"Handled zero usage"}' },
						},
					}
				})(),
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
			onUsage: async (usage) => {
				usages.push({ tokensIn: usage.tokensIn, tokensOut: usage.tokensOut })
			},
		})
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result.status).to.equal("completed")
		expect(usages.length).to.be.greaterThan(0)
		const lastUsage = usages[usages.length - 1]
		expect(lastUsage.tokensIn).to.be.greaterThan(0)
	})

	it("absorbs onUsage callback errors without aborting or failing the specialist", async () => {
		const api = {
			createMessage: () =>
				(async function* () {
					yield { type: "usage", inputTokens: 50, outputTokens: 20 }
					yield {
						type: "tool_calls",
						tool_call: {
							function: {
								id: "done",
								name: "attempt_completion",
								arguments: '{"result":"Success despite onUsage error"}',
							},
						},
					}
				})(),
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
			onUsage: async () => {
				throw new Error("Webview disposed")
			},
		})
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result.status).to.equal("completed")
		if (result.status === "completed") {
			expect(result.summary).to.equal("Success despite onUsage error")
		}
	})

	it("flags transport decoding errors with safeToRetry: false to prevent futile specialist failovers", async () => {
		const api = {
			createMessage: () =>
				(async function* () {
					yield {
						type: "tool_calls",
						tool_call: {
							function: {
								id: "bad",
								name: "read_file",
								arguments: '{"path": invalid-syntax}',
							},
						},
					}
				})(),
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => ({
				definitions: [],
				allowedNames: new Set(["read_file"]),
				execute: async () => "",
			}),
		})
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result.status).to.equal("failed")
		if (result.status === "failed") {
			expect(result.safeToRetry).to.equal(false)
			expect(result.reason).to.include("[Transport Error] Stream decoding failed:")
		}
	})

	it("heals duplicate identical snapshots so execution succeeds seamlessly", async () => {
		const api = {
			createMessage: () =>
				(async function* () {
					// Simulate corrupted stream where delta and snapshot were both yielded and concatenated
					yield {
						type: "tool_calls",
						tool_call: {
							function: {
								id: "heal",
								name: "attempt_completion",
								arguments: '{"result":"Healed work"}',
							},
						},
					}
					yield {
						type: "tool_calls",
						tool_call: {
							function: {
								id: "heal",
								name: "attempt_completion",
								arguments: '{"result":"Healed work"}',
							},
						},
					}
				})(),
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
		})
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result.status).to.equal("completed")
		if (result.status === "completed") {
			expect(result.summary).to.equal("Healed work")
		}
	})

	it("LEGION_CORE_RULES defines file creation mandates, heredoc prohibitions, and non-interactive requirements", () => {
		expect(LEGION_CORE_RULES).to.include("write_to_file")
		expect(LEGION_CORE_RULES).to.include("replace_in_file")
		expect(LEGION_CORE_RULES).to.include("cat <<'EOF'")
		expect(LEGION_CORE_RULES).to.include("cat > file")
		expect(LEGION_CORE_RULES).to.include("tee")
		expect(LEGION_CORE_RULES).to.include("echo >")
		expect(LEGION_CORE_RULES).to.include("non-interactive")
		expect(LEGION_CORE_RULES).to.include("deadlock shell integration")
	})

	it("injects LEGION_CORE_RULES into the specialist system prompt on execute", async () => {
		let capturedSystem = ""
		const api = {
			createMessage: (system: string) => {
				capturedSystem = system
				return (async function* () {
					yield {
						type: "tool_calls",
						tool_call: {
							function: {
								id: "done",
								name: "attempt_completion",
								arguments: '{"result":"All finished"}',
							},
						},
					}
				})()
			},
		} as unknown as ApiHandler

		const host = new LegionAgentHost({
			systemContext: "Parent Context Objective",
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
		})

		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result.status).to.equal("completed")
		expect(capturedSystem).to.include("Parent Context Objective")
		expect(capturedSystem).to.include("Researcher")
		expect(capturedSystem).to.include(LEGION_CORE_RULES)
		expect(capturedSystem).to.include("write_to_file")
		expect(capturedSystem).to.include("cat <<'EOF'")
	})
})
