import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { FileProviderOperations } from "@/core/task/tools/utils/FileProviderOperations"
import { FileEditProvider } from "../FileEditProvider"
import { canonicalFilePath, withFileMutation } from "../FileMutationCoordinator"

describe("isolated helper file edits", () => {
	let cwd: string
	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(tmpdir(), "lumi-helper-edit-"))
	})
	afterEach(async () => {
		sinon.restore()
		await fs.rm(cwd, { recursive: true, force: true })
	})
	async function edit(name: string, text: string, type: "modify" | "create" = "modify", signal?: AbortSignal) {
		const provider = new FileEditProvider(cwd, signal)
		provider.editType = type
		await provider.open(name)
		await provider.update(text, true)
		return provider
	}
	for (const operation of ["create", "modify", "delete"] as const) {
		it(`cancels a ${operation} waiting for another writer without dispatching it later`, async () => {
			const name = operation === "create" ? "new/file.txt" : "file.txt"
			const target = path.join(cwd, name)
			if (operation !== "create") await fs.writeFile(target, "original")
			const controller = new AbortController()
			const provider = await edit(name, "cancelled edit", operation === "create" ? "create" : "modify", controller.signal)
			const key = await canonicalFilePath(target)
			let release!: () => void
			let entered!: () => void
			const acquired = new Promise<void>((resolve) => {
				entered = resolve
			})
			const holding = withFileMutation(key, () => {
				entered()
				return new Promise<void>((resolve) => {
					release = resolve
				})
			})
			await acquired
			const pending = operation === "delete" ? provider.deleteFile(name) : provider.saveChanges()
			const cancelled = assert.rejects(pending, /cancel this edit/)
			try {
				controller.abort(new Error("cancel this edit"))
				await cancelled
				await provider.revertChanges()
			} finally {
				release()
				await holding
			}
			// Let the abandoned queue entry run if it was incorrectly left behind.
			await withFileMutation(key, async () => {})
			if (operation === "create") await assert.rejects(fs.stat(path.join(cwd, "new")), { code: "ENOENT" })
			else assert.equal(await fs.readFile(target, "utf8"), "original")
		})
	}
	it("checks cancellation after preparing bytes and removes its temporary file without committing", async () => {
		await fs.writeFile(path.join(cwd, "file.txt"), "original")
		const controller = new AbortController()
		const provider = await edit("file.txt", "cancelled edit", "modify", controller.signal)
		const write = fs.writeFile
		sinon.stub(fs, "writeFile").callsFake(async (...args: Parameters<typeof fs.writeFile>) => {
			await write(...args)
			controller.abort(new Error("cancel before commit"))
		})
		await assert.rejects(provider.saveChanges(), /cancel before commit/)
		assert.equal(await fs.readFile(path.join(cwd, "file.txt"), "utf8"), "original")
		assert.deepEqual(await fs.readdir(cwd), ["file.txt"])
	})
	it("retains an actual commit when cancellation arrives during the operating-system mutation", async () => {
		await fs.writeFile(path.join(cwd, "file.txt"), "original")
		const controller = new AbortController()
		const provider = await edit("file.txt", "committed edit", "modify", controller.signal)
		const rename = fs.rename
		sinon.stub(fs, "rename").callsFake(async (...args: Parameters<typeof fs.rename>) => {
			await rename(...args)
			controller.abort(new Error("cancel after commit"))
		})
		assert.equal((await provider.saveChanges()).finalContent, "committed edit")
		await provider.revertChanges()
		assert.equal(await fs.readFile(path.join(cwd, "file.txt"), "utf8"), "committed edit")
	})
	it("prepares without touching disk and saves empty files with exact handoff contents", async () => {
		const provider = await edit("new.ts", "", "create")
		await assert.rejects(fs.stat(path.join(cwd, "new.ts")), { code: "ENOENT" })
		assert.equal((await provider.saveChanges()).finalContent, "")
		assert.equal(await fs.readFile(path.join(cwd, "new.ts"), "utf8"), "")
		const replacement = await edit("new.ts", "a  \n\n")
		assert.equal((await replacement.saveChanges()).finalContent, "a  \n\n")
		assert.equal(await fs.readFile(path.join(cwd, "new.ts"), "utf8"), "a  \n\n")
	})
	it("allows independent concurrent edits and detects same-file conflicts without rollback", async () => {
		await fs.writeFile(path.join(cwd, "a.ts"), "original")
		const first = await edit("a.ts", "first")
		const stale = await edit("a.ts", "stale")
		const independent = await edit("b.ts", "independent", "create")
		const results = await Promise.allSettled([first.saveChanges(), stale.saveChanges(), independent.saveChanges()])
		const competing = results.slice(0, 2)
		assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1)
		const rejected = competing.find((result) => result.status === "rejected") as PromiseRejectedResult
		assert.match(String(rejected.reason), /Edit conflict/)
		assert.equal(results[2].status, "fulfilled")
		await Promise.all([first.revertChanges(), stale.revertChanges()])
		assert.equal(await fs.readFile(path.join(cwd, "a.ts"), "utf8"), results[0].status === "fulfilled" ? "first" : "stale")
		assert.equal(await fs.readFile(path.join(cwd, "b.ts"), "utf8"), "independent")
	})
	it("serializes aliases to the same file and preserves executable permissions", async () => {
		const target = path.join(cwd, "script")
		await fs.writeFile(target, "original", { mode: 0o755 })
		await fs.symlink(target, path.join(cwd, "alias"))
		const first = await edit("script", "first")
		const second = await edit("alias", "second")
		await first.saveChanges()
		await assert.rejects(second.saveChanges(), /Edit conflict/)
		assert.equal((await fs.stat(target)).mode & 0o777, 0o755)
		assert.equal(await fs.readFile(path.join(cwd, "alias"), "utf8"), "first")
	})
	it("does not erase a newly created file when a competing create loses", async () => {
		const first = await edit("same.ts", "first", "create")
		const second = await edit("same.ts", "second", "create")
		await first.saveChanges()
		await assert.rejects(second.saveChanges(), /Edit conflict/)
		await second.revertChanges()
		await first.revertChanges()
		assert.equal(await fs.readFile(path.join(cwd, "same.ts"), "utf8"), "first")
	})
	it("refuses a stale deletion and reports actual save failures", async () => {
		const target = path.join(cwd, "a.ts")
		await fs.writeFile(target, "original")
		const provider = await edit("a.ts", "replacement")
		await fs.writeFile(target, "external")
		await assert.rejects(provider.deleteFile("a.ts"), /Edit conflict/)
		assert.equal(await fs.readFile(target, "utf8"), "external")
		const failed = await edit("a.ts", "replacement")
		Object.assign(failed, { saveDocument: async () => false })
		await assert.rejects(failed.saveChanges(), /File was not saved/)
		await failed.revertChanges()
		assert.equal(await fs.readFile(target, "utf8"), "external")
	})
	it("rejects patches based on an earlier version before preparing a replacement", async () => {
		const target = path.join(cwd, "a.ts")
		await fs.writeFile(target, "newer content")
		const provider = new FileEditProvider(cwd)
		const operations = new FileProviderOperations(provider)
		await assert.rejects(operations.modifyFile("a.ts", "patch output", false, "older content"), /Edit conflict/)
		await provider.revertChanges()
		await assert.rejects(operations.deleteFile("a.ts", true, "older content"), /Edit conflict/)
		assert.equal(await fs.readFile(target, "utf8"), "newer content")
	})
	it("keeps Unicode exact in UTF-8 files and preserves UTF-16 encoding and BOM", async () => {
		const text = "工具 😀\n"
		await fs.writeFile(path.join(cwd, "utf8.txt"), "ASCII source")
		await fs.writeFile(
			path.join(cwd, "utf16.txt"),
			Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("source", "utf16le")]),
		)
		const utf8 = await edit("utf8.txt", text)
		const utf16 = await edit("utf16.txt", text)
		assert.equal((await utf8.saveChanges()).finalContent, text)
		assert.equal((await utf16.saveChanges()).finalContent, text)
		assert.equal(await fs.readFile(path.join(cwd, "utf8.txt"), "utf8"), text)
		const encoded = await fs.readFile(path.join(cwd, "utf16.txt"))
		assert.equal(encoded.subarray(0, 2).toString("hex"), "fffe")
		assert.equal(encoded.subarray(2).toString("utf16le"), text)
	})
	it("deletes an alias without deleting its target and refuses retargeted aliases", async () => {
		const target = path.join(cwd, "target")
		const alias = path.join(cwd, "alias")
		await fs.writeFile(target, "data")
		await fs.symlink(target, alias)
		const provider = await edit("alias", "replacement")
		await provider.deleteFile("alias")
		assert.equal(await fs.readFile(target, "utf8"), "data")
		await fs.symlink(target, alias)
		const stale = await edit("alias", "replacement")
		await fs.unlink(alias)
		await fs.writeFile(path.join(cwd, "other"), "data")
		await fs.symlink(path.join(cwd, "other"), alias)
		await assert.rejects(stale.saveChanges(), /different file/)
		assert.equal(await fs.readFile(target, "utf8"), "data")
		assert.equal(await fs.readFile(alias, "utf8"), "data")
	})
})
