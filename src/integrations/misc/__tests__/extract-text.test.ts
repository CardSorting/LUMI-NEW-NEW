import { strict as assert } from "node:assert"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import ExcelJS from "exceljs"
import { extractTextFromFile } from "../extract-text"

describe("Excel text extraction", () => {
	it("reads visible sheets and omits hidden sheets", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "lumi-excel-test-"))
		try {
			const file = path.join(dir, "sample.xlsx")
			const workbook = new ExcelJS.Workbook()
			workbook.addWorksheet("Visible").addRow(["Name", 42])
			const hidden = workbook.addWorksheet("Hidden")
			hidden.state = "hidden"
			hidden.addRow(["private content"])
			await workbook.xlsx.writeFile(file)
			const text = await extractTextFromFile(file)
			assert.match(text, /--- Sheet: Visible ---/)
			assert.match(text, /Name\s+42/)
			assert.doesNotMatch(text, /private content|Sheet: Hidden/)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
