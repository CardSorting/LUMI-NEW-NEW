import { strict as assert } from "node:assert"
import * as path from "node:path"
import sinon from "sinon"
import { FluidPolicyEngine } from "../FluidPolicyEngine"

describe("FluidPolicyEngine read observations", () => {
	for (const [total, perFile] of [
		[0, 0],
		[5, 1],
		[3, 3],
		[15, 1],
	]) {
		it(`records reads without altering content at counts ${total}/${perFile}`, async () => {
			const updateNode = sinon.stub()
			const recordRead = sinon.stub().resolves()
			const engine = Object.assign(Object.create(FluidPolicyEngine.prototype), {
				cwd: "/workspace",
				sessionFiles: new Map(),
				spiderEngine: { updateNode },
				stalenessTracker: { recordRead },
			}) as FluidPolicyEngine
			const content = "export class Test {}"
			const file = path.resolve("/workspace", "src/domain/test.ts")
			assert.equal(await engine.onRead(file, content, total, perFile), content)
			sinon.assert.calledOnceWithExactly(updateNode, file, content)
			sinon.assert.calledOnceWithExactly(recordRead, file, content)
		})
	}
})
