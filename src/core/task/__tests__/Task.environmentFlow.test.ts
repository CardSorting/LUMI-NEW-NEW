import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import * as roadmap from "@/services/roadmap/RoadmapSession"
import { Task } from "../index"
import { TaskState } from "../TaskState"

describe("parent environment throughput", () => {
	afterEach(() => sinon.restore())
	it("collects current output without waiting for a continuously busy terminal to cool down", async () => {
		sinon.stub(HostProvider, "env").get(() => ({ getHostVersion: async () => ({ platform: "test" }) }))
		sinon
			.stub(HostProvider, "window")
			.get(() => ({ getVisibleTabs: async () => ({ paths: [] }), getOpenTabs: async () => ({ paths: [] }) }))
		sinon.stub(roadmap, "getRoadmapEnvironmentSection").resolves("")
		const isProcessHot = sinon.stub().throws(new Error("An environment snapshot must not wait for command output"))
		const taskState = new TaskState()
		taskState.didEditFile = true
		const task = Object.assign(Object.create(Task.prototype), {
			cwd: "/workspace",
			taskState,
			formatWorkspaceRootsSection: () => "",
			dietcodeIgnoreController: { filterPaths: (paths: string[]) => paths },
			terminalManager: {
				getTerminals: (busy: boolean) => (busy ? [{ id: 1, lastCommand: "npm run dev" }] : []),
				getUnretrievedOutput: () => "server ready",
				isProcessHot,
			},
			fileContextTracker: { getAndClearRecentlyModifiedFiles: () => [] },
			api: { getModel: () => ({ id: "test", info: { contextWindow: 100_000 } }) },
			messageStateHandler: { getDietCodeMessages: () => [] },
			stateManager: { getGlobalSettingsKey: () => "act" },
		}) as Task
		const details = await task.getEnvironmentDetails()
		assert.match(details, /npm run dev/)
		assert.match(details, /server ready/)
		sinon.assert.notCalled(isProcessHot)
		assert.equal(taskState.didEditFile, false)
	})
})
