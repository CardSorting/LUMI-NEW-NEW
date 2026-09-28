import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import * as vscode from "vscode"
import { openMultiFileDiff } from "../../hostbridge/diff/openMultiFileDiff"
import { reviewDiffUri } from "../reviewDiffUri"

describe("walkthrough diff documents", () => {
	afterEach(() => sinon.restore())
	it("keeps equal filenames and content in separate workspace roots distinct", () => {
		assert.notEqual(reviewDiffUri("/one/src/a.ts", "same").toString(), reviewDiffUri("/two/src/a.ts", "same").toString())
	})
	it("preserves special characters in paths and ties the document to its saved content", () => {
		const path = "/project/日本語 #1?.ts"
		const uri = reviewDiffUri(path, "café\nnew content")
		assert.equal(uri.path, path)
		assert.equal(uri.fragment, "")
		assert.equal(Buffer.from(uri.query, "base64").toString(), "café\nnew content")
		assert.notEqual(uri.toString(), reviewDiffUri(path, "earlier content").toString())
	})
	it("opens the matching saved documents without closing the user's panel", async () => {
		const execute = sinon.stub(vscode.commands, "executeCommand").resolves()
		await openMultiFileDiff({
			title: "Explain Changes",
			diffs: [{ filePath: "/two/a.ts", leftContent: "before", rightContent: "after" }],
		})
		assert.equal(execute.callCount, 1)
		assert.equal(execute.firstCall.args[0], "vscode.changes")
		const documents = execute.firstCall.args[2] as vscode.Uri[][]
		assert.equal(documents[0][2].toString(), reviewDiffUri("/two/a.ts", "after").toString())
	})
})
