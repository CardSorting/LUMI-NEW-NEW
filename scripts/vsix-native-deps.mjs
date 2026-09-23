#!/usr/bin/env node
/**
 * Native dependency health checks for LUMI packaging, installs, and CI.
 *
 * better-sqlite3 is externalized in esbuild and must ship inside every VSIX /
 * installed extension folder (see .vscodeignore whitelist).
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Packages required at extension runtime (must match esbuild externals + sqlite chain). */
export const REQUIRED_RUNTIME_PACKAGES = ["better-sqlite3", "bindings", "file-uri-to-path"]

export const VSIX_NATIVE_MODULE_MARKER = "extension/node_modules/better-sqlite3/build/Release/better_sqlite3.node"

export const INSTALLED_NATIVE_MODULE_RELATIVE = "node_modules/better-sqlite3/build/Release/better_sqlite3.node"

export const MIN_NATIVE_BINARY_BYTES = 100_000

export const ELECTRON_VERSION = "39.2.3"

export const DEFAULT_EXTENSION_ROOTS = [
	{ id: "antigravity", label: "Antigravity IDE", dir: path.join(os.homedir(), ".antigravity-ide", "extensions") },
	{ id: "cursor", label: "Cursor", dir: path.join(os.homedir(), ".cursor", "extensions") },
	{ id: "vscode", label: "VS Code", dir: path.join(os.homedir(), ".vscode", "extensions") },
]

export const LUMI_EXTENSION_FOLDER_PATTERN = /(?:cardsorting\.lumi|lumi-vscode|dietcode)/i

/**
 * @typedef {"pass" | "warn" | "fail"} CheckStatus
 * @typedef {{ id: string, status: CheckStatus, title: string, detail?: string, fix?: string[] }} HealthCheck
 */

function parseTargetArchitecture(target) {
	const arch = target?.split("-").at(-1)
	if (arch === "x64" || arch === "arm64" || arch === "armhf") return arch
	if (arch === "arm") return "armhf"
	throw new Error(`Cannot determine native module architecture from target: ${target}`)
}

function binaryArchitectures(binaryPath) {
	const binary = fs.readFileSync(binaryPath)
	if (binary.length < 20) return []

	// Thin and universal Mach-O binaries.
	const magic = binary.subarray(0, 4).toString("hex")
	const machoCpuName = (cpuType) => {
		const cpu = cpuType >>> 0
		if (cpu === 0x01000007) return "x64"
		if (cpu === 0x0100000c) return "arm64"
		return undefined
	}
	if (magic === "cffaedfe" || magic === "cefaedfe") return [machoCpuName(binary.readUInt32LE(4))].filter(Boolean)
	if (magic === "feedfacf" || magic === "feedface") return [machoCpuName(binary.readUInt32BE(4))].filter(Boolean)
	if (magic === "cafebabe" || magic === "cafebabf" || magic === "bebafeca" || magic === "bfbafeca") {
		const littleEndian = magic === "bebafeca" || magic === "bfbafeca"
		const is64 = magic === "cafebabf" || magic === "bfbafeca"
		const count = littleEndian ? binary.readUInt32LE(4) : binary.readUInt32BE(4)
		const stride = is64 ? 32 : 20
		const architectures = []
		for (let index = 0; index < count && 8 + (index + 1) * stride <= binary.length; index++) {
			const offset = 8 + index * stride
			const cpuType = littleEndian ? binary.readUInt32LE(offset) : binary.readUInt32BE(offset)
			const name = machoCpuName(cpuType)
			if (name) architectures.push(name)
		}
		return [...new Set(architectures)]
	}

	// ELF (Linux) and PE/COFF (Windows) modules.
	if (binary.subarray(0, 4).toString("hex") === "7f454c46") {
		const littleEndian = binary[5] === 1
		const machine = littleEndian ? binary.readUInt16LE(18) : binary.readUInt16BE(18)
		if (machine === 62) return ["x64"]
		if (machine === 183) return ["arm64"]
		if (machine === 40) return ["armhf"]
	}
	if (binary.length >= 0x40 && binary.subarray(0, 2).toString("hex") === "4d5a") {
		const peOffset = binary.readUInt32LE(0x3c)
		if (peOffset + 6 <= binary.length && binary.subarray(peOffset, peOffset + 4).toString("hex") === "50450000") {
			const machine = binary.readUInt16LE(peOffset + 4)
			if (machine === 0x8664) return ["x64"]
			if (machine === 0xaa64) return ["arm64"]
		}
	}
	return []
}

function binaryFormat(binaryPath) {
	const magic = fs.readFileSync(binaryPath).subarray(0, 4).toString("hex")
	if (["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "cafebabf", "bebafeca", "bfbafeca"].includes(magic)) {
		return "macho"
	}
	if (magic === "7f454c46") return "elf"
	if (magic.startsWith("4d5a")) return "pe"
	return "unknown"
}

function hostTarget() {
	const platform = process.platform
	return `${platform}-${process.arch}`
}

export function assertNativeModuleArchitecture(repoRoot, target) {
	const expectedArch = parseTargetArchitecture(target)
	const binaryPath = path.join(repoRoot, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node")
	if (!fs.existsSync(binaryPath)) {
		throw new Error(`better-sqlite3 native module is missing: ${binaryPath}`)
	}
	const actualArchitectures = binaryArchitectures(binaryPath)
	const expectedFormat = target.startsWith("darwin-") ? "macho" : target.startsWith("win32-") ? "pe" : "elf"
	const actualFormat = binaryFormat(binaryPath)
	if (actualFormat !== expectedFormat) {
		throw new Error(`better-sqlite3 binary format mismatch for ${target}: expected ${expectedFormat}, found ${actualFormat}`)
	}
	const requiredArchitectures = target.startsWith("darwin-") ? ["x64", "arm64"] : [expectedArch]
	const missingArchitectures = requiredArchitectures.filter((arch) => !actualArchitectures.includes(arch))
	if (missingArchitectures.length > 0) {
		const actual = actualArchitectures.length > 0 ? actualArchitectures.join(", ") : "unknown"
		throw new Error(
			`better-sqlite3 architecture mismatch for ${target}: expected ${requiredArchitectures.join(" + ")}, found ${actual}`,
		)
	}
	console.log(`[vsix] verified better-sqlite3 architecture: ${actualArchitectures.join(" + ")}`)
}

function runElectronRebuild(repoRoot, arch) {
	const npmArgs = ["run", "rebuild:electron:better-sqlite3", "--", `--arch=${arch}`]
	if (process.env.npm_execpath) {
		execFileSync(process.execPath, [process.env.npm_execpath, ...npmArgs], {
			stdio: "inherit",
			cwd: repoRoot,
		})
		return
	}
	if (process.platform === "win32") {
		execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm ${npmArgs.join(" ")}`], {
			stdio: "inherit",
			cwd: repoRoot,
		})
		return
	}
	execFileSync("npm", npmArgs, {
		stdio: "inherit",
		cwd: repoRoot,
	})
}

export function rebuildBetterSqlite3(repoRoot, target = `${process.platform}-${process.arch}`) {
	const requestedArch = parseTargetArchitecture(target)
	const nativeBinaryPath = path.join(repoRoot, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node")
	console.log(`[vsix] rebuilding better-sqlite3 for Electron ${ELECTRON_VERSION} (${target})...`)

	if (target.startsWith("darwin-")) {
		if (process.platform !== "darwin") {
			throw new Error(`Build ${target} packages on macOS; cross-OS native builds are not supported.`)
		}

		// Keep macOS VSIXes usable even when an editor selects the other Mac platform variant.
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumi-better-sqlite3-universal-"))
		try {
			for (const arch of ["x64", "arm64"]) {
				console.log(`[vsix] compiling macOS SQLite slice: ${arch}`)
				runElectronRebuild(repoRoot, arch)
				const builtArchs = binaryArchitectures(nativeBinaryPath)
				if (!builtArchs.includes(arch)) {
					throw new Error(`Electron rebuild requested ${arch}, but produced ${builtArchs.join(", ") || "unknown"}`)
				}
				fs.copyFileSync(nativeBinaryPath, path.join(tempDir, `${arch}.node`))
			}

			const universalPath = path.join(tempDir, "universal.node")
			execFileSync(
				"lipo",
				["-create", path.join(tempDir, "x64.node"), path.join(tempDir, "arm64.node"), "-output", universalPath],
				{ stdio: "inherit" },
			)
			const mode = fs.statSync(path.join(tempDir, "arm64.node")).mode
			fs.copyFileSync(universalPath, nativeBinaryPath)
			fs.chmodSync(nativeBinaryPath, mode)
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	} else {
		runElectronRebuild(repoRoot, requestedArch)
	}

	assertNativeModuleArchitecture(repoRoot, target)
}

function listVsixEntries(vsixPath) {
	if (!fs.existsSync(vsixPath)) {
		return Buffer.alloc(0)
	}
	// ZIP entry names are stored uncompressed in the central directory. Read the
	// archive directly so package validation works on Windows without `unzip`.
	return fs.readFileSync(vsixPath)
}

function packagePathInVsix(packageName) {
	return `extension/node_modules/${packageName}/package.json`
}

function nativeBinaryPathInExtension(extensionDir) {
	return path.join(extensionDir, INSTALLED_NATIVE_MODULE_RELATIVE)
}

function nativeBinaryPathInVsixListing(listing) {
	return listing.includes(VSIX_NATIVE_MODULE_MARKER)
}

function packagePresentInVsix(listing, packageName) {
	return listing.includes(packagePathInVsix(packageName))
}

function packagePresentInExtension(extensionDir, packageName) {
	return fs.existsSync(path.join(extensionDir, "node_modules", packageName, "package.json"))
}

/**
 * @returns {HealthCheck[]}
 */
export function auditVsixHealth(vsixPath) {
	const checks = []
	const name = path.basename(vsixPath)

	if (!fs.existsSync(vsixPath)) {
		checks.push({
			id: `${name}:exists`,
			status: "fail",
			title: `${name} not found`,
			fix: ["Run: npm run package:vsix:all"],
		})
		return checks
	}

	const listing = listVsixEntries(vsixPath)

	for (const pkg of REQUIRED_RUNTIME_PACKAGES) {
		checks.push({
			id: `${name}:pkg:${pkg}`,
			status: packagePresentInVsix(listing, pkg) ? "pass" : "fail",
			title: `${name} includes ${pkg}`,
			detail: packagePresentInVsix(listing, pkg) ? undefined : "Package missing from VSIX",
			fix: packagePresentInVsix(listing, pkg)
				? undefined
				: ["Re-package with: npm run package:vsix:all", "Do not use vsce --no-dependencies"],
		})
	}

	const hasBinary = nativeBinaryPathInVsixListing(listing)
	checks.push({
		id: `${name}:binary`,
		status: hasBinary ? "pass" : "fail",
		title: `${name} includes SQLite native binary`,
		detail: hasBinary ? undefined : "better_sqlite3.node is missing",
		fix: hasBinary ? undefined : ["Run: npm run package:vsix:openvsx", "Then reinstall the new VSIX"],
	})

	return checks
}

/**
 * @returns {HealthCheck[]}
 */
export function auditExtensionHealth(extensionDir, { ideLabel = "Editor" } = {}) {
	const checks = []
	const name = path.basename(extensionDir)
	const display = `${ideLabel} → ${name}`

	for (const pkg of REQUIRED_RUNTIME_PACKAGES) {
		const present = packagePresentInExtension(extensionDir, pkg)
		checks.push({
			id: `${name}:pkg:${pkg}`,
			status: present ? "pass" : "fail",
			title: `${display} has ${pkg}`,
			detail: present ? undefined : "Required package folder is missing",
			fix: present ? undefined : ["Run: npm run doctor -- --fix", "Or reinstall from Extensions → ⋯ → Install from VSIX…"],
		})
	}

	const binaryPath = nativeBinaryPathInExtension(extensionDir)
	let binaryStatus = "fail"
	let binaryDetail = "Native SQLite binary is missing"
	if (fs.existsSync(binaryPath)) {
		const size = fs.statSync(binaryPath).size
		if (size >= MIN_NATIVE_BINARY_BYTES) {
			const expectedArch = parseTargetArchitecture(hostTarget())
			const actualArchs = binaryArchitectures(binaryPath)
			if (actualArchs.includes(expectedArch)) {
				binaryStatus = "pass"
				binaryDetail = undefined
			} else {
				binaryStatus = "fail"
				binaryDetail = `Wrong architecture: found ${actualArchs.join(", ") || "unknown"}; this editor requires ${expectedArch}`
			}
		} else {
			binaryStatus = "warn"
			binaryDetail = `Binary exists but is unusually small (${size} bytes)`
		}
	}

	checks.push({
		id: `${name}:binary`,
		status: binaryStatus,
		title: `${display} SQLite native binary`,
		detail: binaryDetail,
		fix:
			binaryStatus === "pass"
				? undefined
				: [
						"Install the VSIX matching this editor architecture",
						"Run: npm run doctor -- --fix",
						"If that fails, delete the extension folder and reinstall from a fresh VSIX",
					],
	})

	return checks
}

export function vsixHasNativeModule(vsixPath) {
	return auditVsixHealth(vsixPath).every((check) => check.status !== "fail")
}

export function extensionHasNativeModule(extensionDir) {
	return (
		auditExtensionHealth(extensionDir).every((check) => check.status !== "fail") &&
		fs.existsSync(nativeBinaryPathInExtension(extensionDir))
	)
}

export function assertVsixHasNativeModule(vsixPath) {
	const failed = auditVsixHealth(vsixPath).filter((check) => check.status === "fail")
	if (failed.length > 0) {
		throw new Error(`Packaged VSIX failed native dependency checks:\n${failed.map((c) => `  - ${c.title}`).join("\n")}`)
	}
	console.log(`[vsix] verified native dependencies in ${path.basename(vsixPath)}`)
}

export function discoverVsixFiles(distDir) {
	if (!fs.existsSync(distDir)) {
		return []
	}
	return fs
		.readdirSync(distDir)
		.filter((entry) => entry.endsWith(".vsix"))
		.map((entry) => path.join(distDir, entry))
		.sort((a, b) => a.localeCompare(b))
}

export function discoverLumiExtensions(extensionsRoots = DEFAULT_EXTENSION_ROOTS) {
	const results = []

	for (const root of extensionsRoots) {
		if (!fs.existsSync(root.dir)) {
			continue
		}

		for (const entry of fs.readdirSync(root.dir)) {
			const extensionDir = path.join(root.dir, entry)
			if (!fs.statSync(extensionDir).isDirectory()) {
				continue
			}
			if (!LUMI_EXTENSION_FOLDER_PATTERN.test(entry)) {
				continue
			}
			results.push({
				path: extensionDir,
				name: entry,
				ideId: root.id,
				ideLabel: root.label,
			})
		}
	}

	return results.sort((a, b) => a.name.localeCompare(b.name))
}

export function pickRepairVsix(distDir, extensionFolderName) {
	const candidates = discoverVsixFiles(distDir)
	if (candidates.length === 0) {
		return null
	}

	const lower = extensionFolderName.toLowerCase()
	const prefersOpenVsx = lower.includes("cardsorting.lumi") || /\.lumi-/.test(lower)
	const openVsxPackages = candidates.filter((file) => /[/\\]lumi-\d/.test(file) && !file.includes("lumi-vscode"))
	const marketplacePackages = candidates.filter((file) => file.includes("lumi-vscode"))
	const preferred = prefersOpenVsx ? openVsxPackages : marketplacePackages
	const fallback = prefersOpenVsx ? marketplacePackages : openVsxPackages
	const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : process.platform
	const targetSuffix = `-${platform}-${process.arch}.vsix`
	const newest = (files) =>
		[...files].sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }))[0]

	// Never repair an installation with a package for a different architecture.
	return (
		newest(preferred.filter((file) => file.endsWith(targetSuffix))) ??
		newest(fallback.filter((file) => file.endsWith(targetSuffix))) ??
		newest(preferred.filter((file) => !/-((darwin|win32|linux)-)(x64|arm64|armhf)\.vsix$/.test(file))) ??
		newest(fallback.filter((file) => !/-((darwin|win32|linux)-)(x64|arm64|armhf)\.vsix$/.test(file))) ??
		null
	)
}

export function repairExtensionFromVsix({ extensionDir, vsixPath }) {
	if (!vsixPath || !fs.existsSync(vsixPath)) {
		throw new Error(`No repair VSIX found for ${path.basename(extensionDir)}`)
	}

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumi-repair-"))
	try {
		execFileSync("unzip", ["-q", vsixPath, "-d", tmpDir], { stdio: "pipe" })
		const extracted = path.join(tmpDir, "extension")
		if (!fs.existsSync(extracted)) {
			throw new Error(`VSIX ${path.basename(vsixPath)} has no extension/ folder`)
		}

		fs.rmSync(extensionDir, { recursive: true, force: true })
		fs.cpSync(extracted, extensionDir, { recursive: true })
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true })
	}

	return vsixPath
}

/**
 * @param {HealthCheck[]} checks
 */
export function summarizeChecks(checks) {
	const pass = checks.filter((c) => c.status === "pass").length
	const warn = checks.filter((c) => c.status === "warn").length
	const fail = checks.filter((c) => c.status === "fail").length
	return { pass, warn, fail, total: checks.length, ok: fail === 0 }
}

const STATUS_ICON = { pass: "✅", warn: "⚠️ ", fail: "❌" }

/**
 * @param {{ title: string, checks: HealthCheck[], summary?: ReturnType<typeof summarizeChecks> }} section
 */
export function printDoctorSection({ title, checks }) {
	console.log(title)
	console.log("─".repeat(title.length))
	if (checks.length === 0) {
		console.log("  (nothing to check)")
		console.log("")
		return summarizeChecks([])
	}

	for (const check of checks) {
		console.log(`  ${STATUS_ICON[check.status]}  ${check.title}`)
		if (check.detail) {
			console.log(`      ${check.detail}`)
		}
	}
	console.log("")
	return summarizeChecks(checks)
}

export function printFixSteps(checks) {
	const failed = checks.filter((c) => c.status !== "pass" && c.fix?.length)
	if (failed.length === 0) {
		return
	}

	console.log("How to fix")
	console.log("──────────")
	let step = 1
	for (const check of failed) {
		console.log(`\n${check.title}:`)
		for (const line of check.fix ?? []) {
			console.log(`  ${step}. ${line}`)
			step++
		}
	}
	console.log("")
}

export function formatGithubActionsAnnotations(checks) {
	const lines = []
	for (const check of checks) {
		if (check.status === "pass") {
			continue
		}
		const level = check.status === "fail" ? "error" : "warning"
		lines.push(`::${level} title=${check.title}::${check.detail ?? check.title}`)
	}
	return lines.join("\n")
}

// Legacy helpers used by older audit entrypoints
export function auditVsixFiles(distDir) {
	return discoverVsixFiles(distDir).map((vsixPath) => ({
		path: vsixPath,
		name: path.basename(vsixPath),
		ok: vsixHasNativeModule(vsixPath),
		checks: auditVsixHealth(vsixPath),
	}))
}

export function auditInstalledExtensions(extensionsRoots) {
	const roots =
		typeof extensionsRoots[0] === "string"
			? extensionsRoots.map((dir) => ({ id: "unknown", label: "Editor", dir }))
			: extensionsRoots

	return discoverLumiExtensions(roots).map((ext) => ({
		path: ext.path,
		name: ext.name,
		ok: extensionHasNativeModule(ext.path),
		hasNodeModules: fs.existsSync(path.join(ext.path, "node_modules")),
		ideLabel: ext.ideLabel,
		checks: auditExtensionHealth(ext.path, { ideLabel: ext.ideLabel }),
	}))
}

export function verifyVscodeignoreWhitelist(repoRoot) {
	const ignorePath = path.join(repoRoot, ".vscodeignore")
	if (!fs.existsSync(ignorePath)) {
		return [
			{
				id: "vscodeignore:missing",
				status: "fail",
				title: ".vscodeignore file exists",
				fix: ["Restore .vscodeignore from the repository"],
			},
		]
	}

	const ignore = fs.readFileSync(ignorePath, "utf8")
	/** @type {HealthCheck[]} */
	const checks = []

	for (const pkg of REQUIRED_RUNTIME_PACKAGES) {
		const needle = `!node_modules/${pkg}/**`
		checks.push({
			id: `vscodeignore:${pkg}`,
			status: ignore.includes(needle) ? "pass" : "fail",
			title: `.vscodeignore whitelists ${pkg}`,
			detail: ignore.includes(needle) ? undefined : `Expected line: ${needle}`,
			fix: ignore.includes(needle) ? undefined : [`Add "${needle}" to .vscodeignore`],
		})
	}

	return checks
}

/**
 * Build a structured doctor report (shared by CLI and CI).
 */
export function buildDoctorReport({ repoRoot, distDir, extensionRoots = DEFAULT_EXTENSION_ROOTS, scope = "full" }) {
	const configChecks = scope === "install" ? [] : verifyVscodeignoreWhitelist(repoRoot)
	const vsixPaths = scope === "install" ? [] : discoverVsixFiles(distDir)
	const extensions = discoverLumiExtensions(extensionRoots)

	const vsixChecks = vsixPaths.flatMap((vsixPath) => auditVsixHealth(vsixPath))
	const extensionChecks = extensions.flatMap((ext) => auditExtensionHealth(ext.path, { ideLabel: ext.ideLabel }))

	const allChecks = [...configChecks, ...vsixChecks, ...extensionChecks]
	const overall = summarizeChecks(allChecks)

	return {
		ok: overall.ok,
		scope,
		summary: overall,
		packaging: summarizeChecks(vsixChecks),
		installs: summarizeChecks(extensionChecks),
		config: summarizeChecks(configChecks),
		configChecks,
		checks: allChecks,
		vsix: vsixPaths.map((p) => ({ path: p, name: path.basename(p), checks: auditVsixHealth(p) })),
		extensions: extensions.map((ext) => ({
			...ext,
			checks: auditExtensionHealth(ext.path, { ideLabel: ext.ideLabel }),
		})),
	}
}

export function printAuditReport({ vsixResults, extensionResults }) {
	const vsixChecks = vsixResults.flatMap((r) => r.checks ?? [])
	const extensionChecks = extensionResults.flatMap((r) => r.checks ?? [])
	printDoctorSection({ title: "Packaged downloads (dist/*.vsix)", checks: vsixChecks })
	printDoctorSection({ title: "Installed extensions", checks: extensionChecks })
}
