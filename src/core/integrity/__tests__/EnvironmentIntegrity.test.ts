import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, beforeEach, describe, it } from "mocha"
import { EnvironmentIntegrity } from "../EnvironmentIntegrity"

describe("EnvironmentIntegrity startup probes", () => {
	let cwd: string
	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lumi-environment-"))
	})
	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true })
	})

	it("shares concurrent validation, probes only relevant binaries, and preserves workspace files", async () => {
		await Promise.all([
			fs.writeFile(path.join(cwd, "package.json"), "{}"),
			fs.writeFile(path.join(cwd, "requirements.txt"), ""),
			fs.writeFile(path.join(cwd, ".dietcode_canary"), "user content"),
		])
		const calls: string[] = []
		let active = 0
		let peak = 0
		const integrity = new EnvironmentIntegrity(cwd, undefined, async (file, args) => {
			calls.push([file, ...args].join(" "))
			peak = Math.max(peak, ++active)
			await delay(5)
			active--
			return { stdout: file === "which" || file === "where" ? `/usr/bin/${args[0]}` : "1.0" }
		})
		const [first, second] = await Promise.all([integrity.validateEnvironment(), integrity.validateEnvironment()])
		assert.equal(first, second)
		assert.equal(first.success, true)
		assert.ok(peak >= 4)
		assert.equal(calls.length, 6)
		assert.ok(calls.includes("python3 --version"))
		assert.ok(calls.includes(`${process.platform === "win32" ? "where" : "which"} python3`))
		assert.equal(await integrity.validateEnvironment(), first)
		assert.equal(calls.length, 6)
		assert.equal(await fs.readFile(path.join(cwd, ".dietcode_canary"), "utf8"), "user content")
		assert.equal((await fs.readdir(cwd)).filter((name) => name.startsWith(".dietcode_canary-")).length, 0)
		assert.ok(Number.isFinite(Number(first.details?.diskSpaceGB)))
	})

	it("does not cache failed, future-dated, or malformed leases", () => {
		const integrity = new EnvironmentIntegrity(cwd)
		const lease = { fingerprint: integrity.getFingerprint(), success: true, timestamp: Date.now() }
		assert.equal(integrity.isLeaseValid(lease), true)
		assert.equal(integrity.isLeaseValid({ ...lease, success: false }), false)
		assert.equal(integrity.isLeaseValid({ ...lease, timestamp: Date.now() + 60000 }), false)
		assert.equal(integrity.isLeaseValid({ ...lease, timestamp: Number.NaN }), false)
	})

	it("reports unavailable toolchains without blocking unrelated workspace work", async () => {
		await fs.writeFile(path.join(cwd, "package.json"), "{}")
		const integrity = new EnvironmentIntegrity(cwd, undefined, async () => {
			throw new Error("unavailable")
		})
		const lease = await integrity.validateEnvironment()
		assert.equal(lease.success, true)
		assert.equal(lease.details?.toolchain?.git.status, "missing")
		assert.equal(lease.details?.nodeVersion, process.version)
	})
})
