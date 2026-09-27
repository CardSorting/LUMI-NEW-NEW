import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { DietCodeDefaultTool } from "@/shared/tools"
import { TaskState } from "../../../TaskState"
import type { ToolValidator } from "../../ToolValidator"
import type { TaskConfig } from "../../types/TaskConfig"
import { WriteToFileToolHandler } from "../WriteToFileToolHandler"

describe("parent documentation edits", () => {
	it("uses workspace permissions without requiring a forensic helper or completion first", async () => {
		const checkDietCodeIgnorePath = sinon.stub().resolves({ ok: true })
		const handler = new WriteToFileToolHandler({ checkDietCodeIgnorePath } as unknown as ToolValidator)
		const config = {
			cwd: "/workspace",
			taskState: new TaskState(),
			api: { getModel: () => ({ id: "test" }) },
			services: { diffViewProvider: { editType: "create" } },
		} as unknown as TaskConfig
		const result = await handler.validateAndPrepareFileOperation(
			config,
			{
				type: "tool_use",
				name: DietCodeDefaultTool.FILE_NEW,
				params: { path: ".wiki/architecture.md" },
				partial: false,
			},
			".wiki/architecture.md",
			undefined,
			"# Architecture\nDocumented the requested behavior.",
		)
		sinon.assert.calledOnce(checkDietCodeIgnorePath)
		assert.equal(result?.absolutePath, "/workspace/.wiki/architecture.md")
		assert.match(result?.newContent ?? "", /requested behavior/)
		assert.equal(config.taskState.userMessageContent.length, 0)
	})
})
