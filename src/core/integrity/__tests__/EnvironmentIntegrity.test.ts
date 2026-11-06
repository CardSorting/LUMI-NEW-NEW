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
			throw Object.assign(new Error("unavailable"), { code: "ENOENT" })
		})
		const lease = await integrity.validateEnvironment()
		assert.equal(lease.success, true)
		assert.equal(lease.details?.toolchain?.git.status, "missing")
		assert.equal(lease.details?.toolchain?.node.status, "missing")
		assert.equal(lease.details?.nodeVersion, undefined)
	})

	it("distinguishes a broken executable from a missing one", async () => {
		await fs.writeFile(path.join(cwd, "package.json"), "{}")
		const integrity = new EnvironmentIntegrity(cwd, undefined, async (file) => {
			if (file === "node") throw Object.assign(new Error("execution failed"), { code: 1 })
			throw Object.assign(new Error("not found"), { code: "ENOENT" })
		})
		const lease = await integrity.validateEnvironment()
		assert.equal(lease.details?.toolchain?.node.status, "broken")
		assert.equal(lease.details?.toolchain?.git.status, "missing")
		assert.equal(lease.details?.nodePath, undefined)
	})

	it("reports a different Node executable even when its basename matches", async () => {
		await fs.writeFile(path.join(cwd, "package.json"), "{}")
		const otherNode = path.join(cwd, "other", path.basename(process.execPath))
		const integrity = new EnvironmentIntegrity(cwd, undefined, async (file) => ({
			stdout: file === "which" || file === "where" ? otherNode : "v1.0.0",
		}))
		const lease = await integrity.validateEnvironment()
		assert.ok(lease.details?.shadowingAlerts?.some((alert) => alert.includes("differs from PATH Node")))
	})

	it("reprobes after manifests change outside the specialist adapter", async () => {
		const integrity = new EnvironmentIntegrity(cwd, undefined, async () => ({ stdout: "1.0" }))
		const first = await integrity.validateEnvironment()
		assert.deepEqual(first.details?.detectedProjectTypes, [])
		await fs.writeFile(path.join(cwd, "pyproject.toml"), "[project]\nname = 'example'\n")
		const second = await integrity.validateEnvironment()
		assert.notEqual(second, first)
		assert.ok(second.details?.detectedProjectTypes?.includes("python"))
		await fs.writeFile(path.join(cwd, "build.gradle.kts"), "plugins {}")
		assert.ok((await integrity.validateEnvironment()).details?.detectedProjectTypes?.includes("gradle"))
	})

	it("does not publish a stale probe after invalidation during execution", async () => {
		let release!: () => void
		let entered!: () => void
		const started = new Promise<void>((resolve) => {
			entered = resolve
		})
		const blocked = new Promise<void>((resolve) => {
			release = resolve
		})
		let calls = 0
		const integrity = new EnvironmentIntegrity(cwd, undefined, async () => {
			if (++calls === 1) {
				entered()
				await blocked
			}
			return { stdout: "1.0" }
		})
		const pending = integrity.validateEnvironment()
		await started
		await fs.writeFile(path.join(cwd, "CMakeLists.txt"), "project(example)")
		integrity.revokeLease()
		const concurrent = integrity.validateEnvironment()
		release()
		const [first, second] = await Promise.all([pending, concurrent])
		assert.equal(first, second)
		assert.ok(first.details?.detectedProjectTypes?.includes("cmake"))
		assert.equal(await integrity.validateEnvironment(), first)
	})

	it("returns a retryable failure when manifests keep changing and recovers when stable", async () => {
		const integrity = new EnvironmentIntegrity(cwd, undefined, async () => ({ stdout: "1.0" }))
		const internal = integrity as any
		const originalProbe = internal.performFullProbe.bind(integrity)
		let calls = 0
		internal.performFullProbe = async () => {
			await fs.writeFile(path.join(cwd, "package.json"), "x".repeat(++calls))
			return { fingerprint: integrity.getFingerprint(), timestamp: Date.now(), success: true }
		}
		const failed = await integrity.validateEnvironment()
		assert.equal(calls, 3)
		assert.equal(failed.success, false)
		assert.match(failed.error || "", /kept changing/)
		internal.performFullProbe = originalProbe
		assert.equal((await integrity.validateEnvironment()).success, true)
	})

	it("reports manifest inspection errors as a failed lease", async () => {
		const file = path.join(cwd, "not-a-directory")
		await fs.writeFile(file, "content")
		const result = await new EnvironmentIntegrity(file).validateEnvironment()
		assert.equal(result.success, false)
		assert.match(result.error || "", /Environment validation failed/)
	})
})
