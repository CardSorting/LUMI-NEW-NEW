import type { ApiHandler } from "@core/api"
import { expect } from "chai"
import sinon from "sinon"
import type { SpawnedLegionMember } from "@/infrastructure/ai/LegionCoordinator"
import { LEGION_CORE_RULES, LegionAgentHost } from "../LegionAgentHost"

const member = { assignment: { title: "Researcher", focusObjective: "Inspect the code" } } as SpawnedLegionMember

describe("LegionAgentHost", () => {
	it("does not create provider or tools when already cancelled", async () => {
		const controller = new AbortController()
		controller.abort()
		const createApi = sinon.spy()
		const createTools = sinon.spy()
		const host = new LegionAgentHost({ createApi, createTools })
		const result = await host.execute(member, { handoff: [], signal: controller.signal })
		expect(result.status).to.equal("cancelled")
		sinon.assert.notCalled(createApi)
		sinon.assert.notCalled(createTools)
	})

	it("reports unresolved initialization on cancellation and disposes a late adapter", async () => {
		const controller = new AbortController()
		const dispose = sinon.spy()
		const createMessage = sinon.spy()
		let started!: () => void
		let resolveTools!: (tools: any) => void
		const initialized = new Promise<void>((resolve) => {
			started = resolve
		})
		const factory = new Promise<any>((resolve) => {
			resolveTools = resolve
		})
		const host = new LegionAgentHost({
			createApi: () => ({ createMessage }) as unknown as ApiHandler,
			createTools: async () => {
				started()
				return factory
			},
		})
		const execution = host.execute(member, { handoff: [], signal: controller.signal })
		await initialized
		controller.abort()
		const result = await execution
		expect(result.status).to.equal("unresolved")
		if (result.status === "unresolved") expect(result.safeToRetry).to.equal(false)
		resolveTools({ definitions: [], allowedNames: new Set(), execute: async () => "", dispose })
		await new Promise((resolve) => setImmediate(resolve))
		sinon.assert.calledOnce(dispose)
		sinon.assert.notCalled(createMessage)
	})

	it("retains committed artifact evidence when a specialist is cancelled", async () => {
		const controller = new AbortController()
		const api = {
			createMessage: () =>
				(async function* () {
					yield {
						type: "tool_calls",
						tool_call: { function: { id: "write", name: "write_to_file", arguments: '{"path":"saved.ts"}' } },
					}
				})(),
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			createApi: () => api,
			createTools: async () => ({
				definitions: [],
				allowedNames: new Set(["write_to_file"]),
				execute: async () => {
					controller.abort()
					return "saved"
				},
				getModifiedArtifacts: () => ["saved.ts"],
			}),
		})
		const result = await host.execute(member, { handoff: [], signal: controller.signal })
		expect(result.status).to.equal("cancelled")
		if (result.status === "cancelled") expect(result.reason).to.include("saved.ts")
	})
	it("discovers enabled skills in the project and supplies newly recorded artifacts to later specialists", async () => {
		const systems: string[] = []
		const histories: string[] = []
		const discover = sinon.stub().resolves([
			{ name: "enabled", description: "project skill", path: "/project/enabled/SKILL.md", source: "project" },
			{ name: "disabled", description: "disabled skill", path: "/project/disabled/SKILL.md", source: "project" },
		])
		const artifacts: string[] = []
		const api = {
			createMessage: (system: string, history: unknown) => {
				systems.push(system)
				histories.push(JSON.stringify(history))
				return (async function* () {
					yield {
						type: "tool_calls",
						tool_call: { function: { id: "done", name: "attempt_completion", arguments: '{"result":"Done"}' } },
					}
				})()
			},
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			cwd: "/project",
			discoverSkills: discover,
			isSkillEnabled: (skill) => skill.name !== "disabled",
			workspaceArtifacts: artifacts,
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
		})
		await host.execute(member, { handoff: [], signal: new AbortController().signal })
		artifacts.push("src/new.ts")
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(discover.alwaysCalledWith("/project", sinon.match.instanceOf(AbortSignal))).to.equal(true)
		expect(systems[0]).to.include("project skill").and.not.include("disabled skill")
		expect(systems[1]).not.to.include("src/new.ts")
		expect(histories[1]).to.include("src/new.ts")
		expect(result).to.deep.equal({ status: "completed", summary: "Done" })
	})
	it("respects toggles and intentional emptiness for configured skill lists", async () => {
		const systems: string[] = []
		const discover = sinon
			.stub()
			.resolves([{ name: "unexpected", description: "unexpected", path: "/u/SKILL.md", source: "project" }])
		const api = {
			createMessage: (system: string) => {
				systems.push(system)
				return (async function* () {
					yield {
						type: "tool_calls",
						tool_call: { function: { id: "done", name: "attempt_completion", arguments: '{"result":"Done"}' } },
					}
				})()
			},
		} as unknown as ApiHandler
		const common = {
			discoverSkills: discover,
			isSkillEnabled: (skill: any) => skill.name !== "disabled",
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set<string>(), execute: async () => "" }),
		}
		const configured = new LegionAgentHost({
			...common,
			availableSkills: [
				{ name: "enabled", description: "allowed skill", path: "/e/SKILL.md", source: "project" },
				{ name: "disabled", description: "disabled skill", path: "/d/SKILL.md", source: "project" },
			],
		})
		const empty = new LegionAgentHost({ ...common, availableSkills: [] })
		await configured.execute(member, { handoff: [], signal: new AbortController().signal })
		await empty.execute(member, { handoff: [], signal: new AbortController().signal })
		sinon.assert.notCalled(discover)
		expect(systems[0]).to.include("allowed skill").and.not.include("disabled skill")
		expect(systems[1]).not.to.include("<available_skills>")
	})
	it("refreshes the discovered skill catalog between specialist turns", async () => {
		const systems: string[] = []
		const discover = sinon.stub()
		discover.onFirstCall().resolves([{ name: "old", description: "old skill", path: "/old/SKILL.md", source: "project" }])
		discover.onSecondCall().resolves([{ name: "new", description: "new skill", path: "/new/SKILL.md", source: "project" }])
		const api = {
			createMessage: (system: string) => {
				systems.push(system)
				const first = systems.length === 1
				return (async function* () {
					yield {
						type: "tool_calls",
						tool_call: {
							function: {
								id: first ? "read" : "done",
								name: first ? "read_file" : "attempt_completion",
								arguments: first ? '{"path":"file"}' : '{"result":"Done"}',
							},
						},
					}
				})()
			},
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			discoverSkills: discover,
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(["read_file"]), execute: async () => "contents" }),
		})
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result.status).to.equal("completed")
		sinon.assert.calledTwice(discover)
		expect(systems[0]).to.include("old skill").and.not.include("new skill")
		expect(systems[1]).to.include("new skill").and.not.include("old skill")
	})
	it("cancels stalled skill discovery and disposes the tool adapter", async () => {
		const controller = new AbortController()
		const dispose = sinon.spy()
		const createMessage = sinon.spy()
		let started!: () => void
		const discoveryStarted = new Promise<void>((resolve) => {
			started = resolve
		})
		const host = new LegionAgentHost({
			createApi: () => ({ createMessage }) as unknown as ApiHandler,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "", dispose }),
			discoverSkills: async () => {
				started()
				return await new Promise<never>(() => {})
			},
		})
		const execution = host.execute(member, { handoff: [], signal: controller.signal })
		await discoveryStarted
		controller.abort()
		expect((await execution).status).to.equal("cancelled")
		sinon.assert.calledOnce(dispose)
		sinon.assert.notCalled(createMessage)
	})
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

	for (const invalid of [-100, Number.NaN]) {
		it(`does not let ${String(invalid)} token usage disable the budget guard`, async () => {
			const api = {
				createMessage: () =>
					(async function* () {
						yield { type: "usage", inputTokens: 10, outputTokens: 0 }
						yield { type: "usage", inputTokens: invalid, outputTokens: 0 }
						yield { type: "usage", inputTokens: 11, outputTokens: 0 }
						yield {
							type: "tool_calls",
							tool_call: { function: { id: "done", name: "attempt_completion", arguments: '{"result":"Done"}' } },
						}
					})(),
			} as unknown as ApiHandler
			const host = new LegionAgentHost({
				availableSkills: [],
				maxTokens: 20,
				createApi: () => api,
				createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
			})
			const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
			expect(result.status).to.equal("failed")
			if (result.status === "failed") expect(result.reason).to.include("budget exhausted")
		})
	}

	it("never reduces accumulated cost when provider totals decrease", async () => {
		const costs: number[] = []
		const api = {
			createMessage: () =>
				(async function* () {
					yield { type: "usage", inputTokens: 1, outputTokens: 0, totalCost: 0.1 }
					yield { type: "usage", inputTokens: 0, outputTokens: 1, totalCost: 0.01 }
					yield {
						type: "tool_calls",
						tool_call: { function: { id: "done", name: "attempt_completion", arguments: '{"result":"Done"}' } },
					}
				})(),
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			availableSkills: [],
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
			onUsage: async (usage) => {
				costs.push(usage.cost ?? 0)
			},
		})
		expect((await host.execute(member, { handoff: [], signal: new AbortController().signal })).status).to.equal("completed")
		expect(costs).to.deep.equal([0.1, 0.1])
	})

	it("estimates missing tokens when a stream reports cost only", async () => {
		const snapshots: Array<{ tokensIn: number; cost?: number }> = []
		const api = {
			createMessage: () =>
				(async function* () {
					yield { type: "usage", inputTokens: 0, outputTokens: 0, totalCost: 0.05 }
					yield {
						type: "tool_calls",
						tool_call: { function: { id: "done", name: "attempt_completion", arguments: '{"result":"Done"}' } },
					}
				})(),
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			availableSkills: [],
			maxTokens: 5,
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
			onUsage: async (usage) => {
				snapshots.push(usage)
			},
		})
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result.status).to.equal("failed")
		expect(snapshots.at(-1)!.tokensIn).to.be.greaterThan(0)
		expect(snapshots.at(-1)!.cost).to.equal(0.05)
	})

	it("counts generated tool arguments before dispatch when provider usage is absent", async () => {
		const execute = sinon.stub().resolves("saved")
		const snapshots: Array<{ tokensOut: number }> = []
		const api = {
			createMessage: () =>
				(async function* () {
					yield {
						type: "tool_calls",
						tool_call: {
							function: {
								id: "write",
								name: "write_to_file",
								arguments: JSON.stringify({ path: "large.txt", content: "x".repeat(20_000) }),
							},
						},
					}
				})(),
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			availableSkills: [],
			maxTokens: 3_000,
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(["write_to_file"]), execute }),
			onUsage: async (usage) => {
				snapshots.push(usage)
			},
		})
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result.status).to.equal("failed")
		if (result.status === "failed") expect(result.reason).to.include("budget exhausted")
		expect(snapshots.at(-1)!.tokensOut).to.be.greaterThan(5_000)
		sinon.assert.notCalled(execute)
	})

	it("uses fallback token usage after a cost-only stream event", async () => {
		const snapshots: Array<{ tokensIn: number; cost?: number }> = []
		const api = {
			createMessage: () =>
				(async function* () {
					yield { type: "usage", inputTokens: 0, outputTokens: 0, totalCost: 0.05 }
					yield {
						type: "tool_calls",
						tool_call: { function: { id: "done", name: "attempt_completion", arguments: '{"result":"Done"}' } },
					}
				})(),
			getApiStreamUsage: async () => ({ type: "usage", inputTokens: 7, outputTokens: 1, totalCost: 0.05 }),
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			availableSkills: [],
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
			onUsage: async (usage) => {
				snapshots.push(usage)
			},
		})
		expect((await host.execute(member, { handoff: [], signal: new AbortController().signal })).status).to.equal("completed")
		expect(snapshots.at(-1)).to.include({ tokensIn: 7, cost: 0.05 })
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

	it("preserves completion when the fallback usage lookup throws synchronously", async () => {
		const snapshots: Array<{ tokensIn: number }> = []
		const api = {
			createMessage: () =>
				(async function* () {
					yield {
						type: "tool_calls",
						tool_call: { function: { id: "done", name: "attempt_completion", arguments: '{"result":"Done"}' } },
					}
				})(),
			getApiStreamUsage: () => {
				throw new Error("lookup unavailable")
			},
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			availableSkills: [],
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
			onUsage: async (usage) => {
				snapshots.push(usage)
			},
		})
		expect((await host.execute(member, { handoff: [], signal: new AbortController().signal })).status).to.equal("completed")
		expect(snapshots.at(-1)!.tokensIn).to.be.greaterThan(0)
	})

	it("does not wait for a stalled fallback usage lookup after cancellation", async () => {
		const controller = new AbortController()
		const dispose = sinon.spy()
		const api = {
			createMessage: () =>
				(async function* () {
					yield {
						type: "tool_calls",
						tool_call: { function: { id: "done", name: "attempt_completion", arguments: '{"result":"Done"}' } },
					}
				})(),
			getApiStreamUsage: async () => {
				controller.abort()
				return await new Promise<never>(() => {})
			},
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			availableSkills: [],
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "", dispose }),
		})
		expect((await host.execute(member, { handoff: [], signal: controller.signal })).status).to.equal("cancelled")
		sinon.assert.calledOnce(dispose)
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
		const result = await pending
		expect(result.status).to.equal("cancelled")
		if (result.status === "cancelled") {
			expect(result.safeToRetry).to.equal(false)
		}
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

	it("continues after a stalled usage callback", async () => {
		const callback = sinon.stub().returns(new Promise<void>(() => {}))
		const api = {
			createMessage: () =>
				(async function* () {
					yield { type: "usage", inputTokens: 10, outputTokens: 2 }
					yield {
						type: "tool_calls",
						tool_call: { function: { id: "done", name: "attempt_completion", arguments: '{"result":"Done"}' } },
					}
				})(),
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			availableSkills: [],
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "" }),
			onUsage: callback,
		})
		expect((await host.execute(member, { handoff: [], signal: new AbortController().signal })).status).to.equal("completed")
		sinon.assert.calledOnce(callback)
	})

	it("stops before dispatch when required usage persistence fails", async () => {
		const execute = sinon.spy()
		const notify = sinon.spy()
		const api = {
			createMessage: () =>
				(async function* () {
					yield { type: "usage", inputTokens: 10, outputTokens: 1 }
					yield {
						type: "tool_calls",
						tool_call: { function: { id: "write", name: "write_to_file", arguments: '{"path":"file"}' } },
					}
				})(),
		} as unknown as ApiHandler
		const createApi = sinon.stub().returns(api)
		const host = new LegionAgentHost({
			availableSkills: [],
			requireUsagePersistence: true,
			onUsageFailure: notify,
			createApi,
			createTools: async () => ({ definitions: [], allowedNames: new Set(["write_to_file"]), execute }),
			onUsage: async () => {
				throw new Error("storage unavailable")
			},
		})
		const result = await host.execute(member, { handoff: [], signal: new AbortController().signal })
		expect(result.status).to.equal("failed")
		if (result.status === "failed") expect(result.reason).to.include("usage could not be persisted")
		sinon.assert.calledOnce(notify)
		sinon.assert.notCalled(execute)
		expect((await host.execute(member, { handoff: [], signal: new AbortController().signal })).status).to.equal("failed")
		sinon.assert.calledOnce(createApi)
	})

	it("does not wait for a stalled usage callback after cancellation", async () => {
		const controller = new AbortController()
		const dispose = sinon.spy()
		const api = {
			createMessage: () =>
				(async function* () {
					yield { type: "usage", inputTokens: 10, outputTokens: 2 }
				})(),
		} as unknown as ApiHandler
		const host = new LegionAgentHost({
			availableSkills: [],
			createApi: () => api,
			createTools: async () => ({ definitions: [], allowedNames: new Set(), execute: async () => "", dispose }),
			onUsage: async () => {
				controller.abort()
				await new Promise<void>(() => {})
			},
		})
		expect((await host.execute(member, { handoff: [], signal: controller.signal })).status).to.equal("cancelled")
		sinon.assert.calledOnce(dispose)
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
