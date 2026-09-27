import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import { describe, it } from "mocha"
import { withFileMutation } from "../FileMutationCoordinator"

describe("file mutation ownership", () => {
	it("settles a cancelled waiter without allowing later writers past the current owner", async () => {
		const key = randomUUID()
		let release!: () => void
		let entered!: () => void
		const acquired = new Promise<void>((resolve) => {
			entered = resolve
		})
		const order: string[] = []
		const first = withFileMutation(key, async () => {
			order.push("first")
			entered()
			await new Promise<void>((resolve) => {
				release = resolve
			})
			order.push("released")
		})
		await acquired
		const controller = new AbortController()
		const cancelled = withFileMutation(
			key,
			async () => {
				order.push("cancelled")
			},
			controller.signal,
		)
		const rejected = assert.rejects(cancelled, /cancel queued mutation/)
		const next = withFileMutation(key, async () => {
			order.push("next")
		})
		try {
			controller.abort(new Error("cancel queued mutation"))
			await rejected
			await withFileMutation(randomUUID(), async () => {
				order.push("independent")
			})
			assert.deepEqual(order, ["first", "independent"])
		} finally {
			release()
			await Promise.all([first, next])
		}
		assert.deepEqual(order, ["first", "independent", "released", "next"])
	})
	it("releases ownership after a failed operation and rejects already cancelled work", async () => {
		const key = randomUUID()
		let runs = 0
		await assert.rejects(
			withFileMutation(key, async () => {
				throw new Error("save failed")
			}),
			/save failed/,
		)
		await assert.rejects(
			withFileMutation(
				key,
				async () => {
					runs++
				},
				AbortSignal.abort(new Error("already stopped")),
			),
			/already stopped/,
		)
		await withFileMutation(key, async () => {
			runs++
		})
		assert.equal(runs, 1)
	})
})
