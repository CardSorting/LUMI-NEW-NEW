import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { VscodeDiffViewProvider } from "./VscodeDiffViewProvider"

class SaveProbe extends VscodeDiffViewProvider {
	setDocument(document: { isDirty: boolean; save: () => Promise<boolean> }): void {
		Object.assign(this, { activeDiffEditor: { document } })
	}
	commit(): Promise<boolean> {
		return this.saveDocument()
	}
}

describe("VS Code save acknowledgement", () => {
	for (const dirty of [false, true]) {
		for (const saved of [false, true]) {
			it(`honors the editor save result ${saved} with isDirty=${dirty}`, async () => {
				const provider = new SaveProbe()
				const save = sinon.stub().resolves(saved)
				provider.setDocument({ isDirty: dirty, save })
				assert.equal(await provider.commit(), saved)
				sinon.assert.calledOnce(save)
			})
		}
	}
	it("propagates a failed save and rejects a missing editor", async () => {
		const provider = new SaveProbe()
		assert.equal(await provider.commit(), false)
		provider.setDocument({
			isDirty: true,
			save: async () => {
				throw new Error("disk unavailable")
			},
		})
		await assert.rejects(provider.commit(), /disk unavailable/)
	})
})
