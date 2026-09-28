import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { ExplanationStreamParser } from "../ExplanationStreamParser"

const files = [
	{ absolutePath: "/one/a.ts", relativePath: "a.ts", before: "old", after: "first\nsecond" },
	{ absolutePath: "/two/b.ts", relativePath: "b.ts", before: "old", after: "new" },
]
function parse(chunks: string[], inputFiles = files) {
	const comments: { path: string; line: number; text: string; ended: boolean }[] = []
	const parser = new ExplanationStreamParser(inputFiles, {
		start: (path, line) => comments.push({ path, line, text: "", ended: false }),
		chunk: (text) => {
			const current = comments.at(-1)
			assert.ok(current)
			current.text += text
		},
		end: () => {
			const current = comments.at(-1)
			assert.ok(current)
			current.ended = true
		},
	})
	chunks.forEach((chunk) => parser.push(chunk))
	const count = parser.finish()
	assert.equal(parser.finish(), count, "finishing twice must not duplicate comments")
	return { comments, count }
}

describe("walkthrough stream boundaries", () => {
	const output =
		"@@@ FILE: /one/a.ts\r\n@@@ LINE: 1\r\nKeeps café and 日本語 intact.\r\nA marker inside text: @@@ is ordinary prose.\r\n@@@\r\n@@@ FILE: b.ts\n@@@ LINE: 0\nFinal explanation without a newline"
	it("produces identical comments at every possible network split", () => {
		const expected = parse([output])
		assert.equal(expected.count, 2)
		for (let split = 0; split <= output.length; split++) {
			assert.deepEqual(parse([output.slice(0, split), output.slice(split)]), expected, `split ${split}`)
		}
		assert.deepEqual(parse([...output]), expected)
		assert.match(expected.comments[0].text, /inside text: @@@/)
	})
	it("ignores unknown files and invalid or out-of-range line numbers", () => {
		for (const line of ["-1", "2", "1.2", "1junk", "", "999999999999999999999"]) {
			assert.equal(parse([`@@@ FILE: /one/a.ts\n@@@ LINE: ${line}\nShould be ignored\n@@@`]).count, 0)
		}
		assert.equal(parse(["@@@ FILE: /outside/secrets.ts\n@@@ LINE: 0\nIgnored\n@@@"]).count, 0)
	})
	it("does not count empty comments and closes an unfinished comment at the next file", () => {
		const result = parse([
			"@@@ FILE: a.ts\n@@@ LINE: 0\n\n@@@\n@@@ FILE: a.ts\n@@@ LINE: 0\nFirst\n@@@ FILE: b.ts\n@@@ LINE: 0\nSecond",
		])
		assert.equal(result.count, 2)
		assert.equal(
			result.comments.every((comment) => comment.ended),
			true,
		)
	})
	it("requires absolute paths for ambiguous filenames across workspaces", () => {
		const roots = [files[0], { ...files[0], absolutePath: "/two/a.ts" }]
		assert.equal(parse(["@@@ FILE: a.ts\n@@@ LINE: 0\nAmbiguous"], roots).count, 0)
		assert.equal(parse(["@@@ FILE: /two/a.ts\n@@@ LINE: 0\nSpecific"], roots).comments[0].path, "/two/a.ts")
	})
	it("matches Windows paths without accepting an unrelated file", () => {
		const windowsFile = { ...files[0], absolutePath: "C:\\work\\a.ts" }
		assert.equal(
			parse(["@@@ FILE: C:/work/a.ts\n@@@ LINE: 0\nExplanation"], [windowsFile]).comments[0].path,
			windowsFile.absolutePath,
		)
	})
})
