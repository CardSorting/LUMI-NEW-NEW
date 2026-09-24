import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import * as vscode from "vscode"

export const REQUIRED_PACKAGES = ["better-sqlite3"] as const

export const TROUBLESHOOTING_URL = "https://docs.dietcode.io/troubleshooting/extension-wont-start"

export const HEALTH_OUTPUT_CHANNEL_NAME = "LUMI Health"

export type HealthStatus = "pass" | "warn" | "fail"

export type InstallationHealthCheck = {
	id: string
	status: HealthStatus
	title: string
	detail?: string
	fix?: string[]
}

export type AbiMismatch = {
	compiledAbi: string
	requiredAbi: string
}

export type PackageVersionMismatch = {
	installedVersion: string
	supportedMajor: number
}

export type NodeApiMismatch = {
	addonApiVersion: string
	runtimeApiVersion: string
}

export type NativeRuntimeInfo = {
	platform: string
	architecture: string
	nodeVersion: string
	electronVersion?: string
	nodeModuleVersion?: string
	nodeApiVersion?: string
}

export type NativeDepsHealthResult = {
	ok: boolean
	missingPackages: string[]
	loadError?: string
	architectureMismatch?: { builtFor: string; required: string }
	abiMismatch?: AbiMismatch
	packageVersionMismatch?: PackageVersionMismatch
	nodeApiMismatch?: NodeApiMismatch
	runtime: NativeRuntimeInfo
}

const MIN_NATIVE_BINARY_BYTES = 100_000
const SUPPORTED_BETTER_SQLITE3_MAJOR = 13
const REQUIRED_NODE_API_VERSION = 10

const STATUS_LABEL: Record<HealthStatus, string> = {
	pass: "OK",
	warn: "WARN",
	fail: "FAIL",
}

function architectureLabel(arch: string): string {
	if (arch === "arm64" || arch === "aarch64") return "Apple silicon (ARM64)"
	if (arch === "x64" || arch === "x86_64") return "Intel (x64)"
	return arch
}

function getNativeRuntimeInfo(): NativeRuntimeInfo {
	return {
		platform: process.platform,
		architecture: process.arch,
		nodeVersion: process.versions.node,
		electronVersion: process.versions.electron,
		nodeModuleVersion: process.versions.modules,
		nodeApiVersion: process.versions.napi,
	}
}

export function findAbiMismatch(message: string): AbiMismatch | undefined {
	const match = message.match(
		/compiled\s+against\s+a\s+different\s+Node\.js\s+version\s+using\s+NODE_MODULE_VERSION\s+(\d+)[\s\S]{0,240}?requires\s+NODE_MODULE_VERSION\s+(\d+)/i,
	)
	if (!match) return undefined
	const compiledAbi = match[1]
	const requiredAbi = match[2]
	return { compiledAbi, requiredAbi }
}

function findPackageManifest(entryPath: string, expectedName: string): { version?: string } | undefined {
	let directory = path.dirname(entryPath)
	for (let depth = 0; depth < 8; depth++) {
		const manifestPath = path.join(directory, "package.json")
		try {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name?: string; version?: string }
			if (manifest.name === expectedName) return manifest
		} catch {
			// Continue walking until the owning package manifest is found.
		}
		const parent = path.dirname(directory)
		if (parent === directory) break
		directory = parent
	}
	return undefined
}

function formatRuntime(runtime: NativeRuntimeInfo): string {
	const editorRuntime = runtime.electronVersion ? `Electron ${runtime.electronVersion}, ` : ""
	const napi = runtime.nodeApiVersion ? `, N-API ${runtime.nodeApiVersion}` : ""
	return `${editorRuntime}Node.js ${runtime.nodeVersion} (${runtime.platform}-${runtime.architecture}, ABI ${runtime.nodeModuleVersion ?? "unknown"}${napi})`
}

function nativePrebuildPath(extensionPath: string): string {
	let isMusl = false
	if (process.platform === "linux") {
		try {
			const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined
			isMusl = report?.header?.glibcVersionRuntime === undefined
		} catch {
			// Keep the glibc prebuild as the standard fallback when runtime metadata is unavailable.
		}
	}
	const packagePlatform = isMusl ? "linuxmusl" : process.platform
	return path.join(extensionPath, `node_modules/better-sqlite3/prebuilds/${packagePlatform}-${process.arch}.node`)
}

function findArchitectureMismatch(message: string): NativeDepsHealthResult["architectureMismatch"] {
	const match = message.match(/have ['"]([^'"]+)['"], need ['"]([^'"]+)['"]/i)
	if (!match) return undefined
	const normalize = (arch: string) => {
		const value = arch.toLowerCase()
		if (value.includes("x86_64") || value === "x64") return "x64"
		if (value.includes("arm64") || value === "aarch64") return "arm64"
		return value
	}
	const builtFor = normalize(match[1])
	const required = normalize(match[2])
	return builtFor === required ? undefined : { builtFor, required }
}

let healthOutputChannel: vscode.OutputChannel | undefined

export function getHealthOutputChannel(): vscode.OutputChannel {
	if (!healthOutputChannel) {
		healthOutputChannel = vscode.window.createOutputChannel(HEALTH_OUTPUT_CHANNEL_NAME)
	}
	return healthOutputChannel
}

export function registerHealthOutputChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
	const channel = getHealthOutputChannel()
	context.subscriptions.push(channel)
	return channel
}

export function checkExtensionNativeDeps(extensionPath: string): NativeDepsHealthResult {
	const extensionRequire = createRequire(path.join(extensionPath, "package.json"))
	const missingPackages: string[] = []
	const runtime = getNativeRuntimeInfo()
	let betterSqliteEntry: string | undefined

	for (const packageName of REQUIRED_PACKAGES) {
		try {
			const entry = extensionRequire.resolve(packageName, { paths: [extensionPath] })
			if (packageName === "better-sqlite3") betterSqliteEntry = entry
		} catch {
			missingPackages.push(packageName)
		}
	}

	if (missingPackages.length > 0) {
		return { ok: false, missingPackages, runtime }
	}
	if (betterSqliteEntry) {
		const packageManifest = findPackageManifest(betterSqliteEntry, "better-sqlite3")
		const version = packageManifest?.version ?? "unknown"
		const installedMajor = /^(\d+)\./.exec(version)?.[1]
		if (Number(installedMajor) !== SUPPORTED_BETTER_SQLITE3_MAJOR) {
			return {
				ok: false,
				missingPackages: [],
				packageVersionMismatch: { installedVersion: version, supportedMajor: SUPPORTED_BETTER_SQLITE3_MAJOR },
				runtime,
			}
		}
		const runtimeApiVersion = Number(runtime.nodeApiVersion ?? 0)
		if (runtimeApiVersion < REQUIRED_NODE_API_VERSION) {
			return {
				ok: false,
				missingPackages: [],
				nodeApiMismatch: {
					addonApiVersion: String(REQUIRED_NODE_API_VERSION),
					runtimeApiVersion: runtime.nodeApiVersion ?? "unavailable",
				},
				runtime,
			}
		}
	}

	try {
		extensionRequire(betterSqliteEntry ?? extensionRequire.resolve("better-sqlite3", { paths: [extensionPath] }))
		return { ok: true, missingPackages: [], runtime }
	} catch (error) {
		const loadError = error instanceof Error ? error.message : String(error)
		return {
			ok: false,
			missingPackages,
			loadError,
			architectureMismatch: findArchitectureMismatch(loadError),
			abiMismatch: findAbiMismatch(loadError),
			nodeApiMismatch: findNodeApiMismatch(loadError),
			runtime,
		}
	}
}

function findNodeApiMismatch(message: string): NodeApiMismatch | undefined {
	const match = message.match(
		/compiled\s+against\s+a\s+different\s+Node\.js\s+version\s+using\s+N-API\s+version\s+(\d+)[\s\S]{0,240}?(?:requires|supports)\s+N-API\s+version\s+(\d+)/i,
	)
	if (!match) return undefined
	return { addonApiVersion: match[1], runtimeApiVersion: match[2] }
}

export function auditCurrentInstallation(extensionPath: string): InstallationHealthCheck[] {
	const checks: InstallationHealthCheck[] = []
	const extensionRequire = createRequire(path.join(extensionPath, "package.json"))

	for (const packageName of REQUIRED_PACKAGES) {
		let status: HealthStatus = "fail"
		let detail: string | undefined = "Not found in this extension folder"
		try {
			extensionRequire.resolve(packageName, { paths: [extensionPath] })
			status = "pass"
			detail = undefined
		} catch {
			// keep fail
		}
		checks.push({
			id: `pkg:${packageName}`,
			status,
			title: `Database dependency: ${packageName}`,
			detail,
			fix:
				status === "pass"
					? undefined
					: ["Open Extensions → ⋯ → Install from VSIX… and pick a fresh LUMI download", `See: ${TROUBLESHOOTING_URL}`],
		})
	}

	const prebuildPath = nativePrebuildPath(extensionPath)
	const releaseBinaryPath = path.join(extensionPath, "node_modules/better-sqlite3/build/Release/better_sqlite3.node")
	const binaryPath = fs.existsSync(prebuildPath) ? prebuildPath : releaseBinaryPath

	const loadResult = checkExtensionNativeDeps(extensionPath)
	let binaryStatus: HealthStatus = "fail"
	let binaryDetail = "Native SQLite driver file is missing"
	if (fs.existsSync(binaryPath)) {
		const size = fs.statSync(binaryPath).size
		if (size >= MIN_NATIVE_BINARY_BYTES) {
			binaryStatus = "pass"
			binaryDetail = `Found (${Math.round(size / 1024)} KB)`
		} else {
			binaryStatus = "warn"
			binaryDetail = `File exists but looks too small (${size} bytes)`
		}
	}
	if (loadResult.architectureMismatch) {
		binaryStatus = "fail"
		binaryDetail = `Built for ${architectureLabel(loadResult.architectureMismatch.builtFor)}; this editor requires ${architectureLabel(loadResult.architectureMismatch.required)}`
	} else if (loadResult.abiMismatch) {
		binaryStatus = "fail"
		binaryDetail = `Compiled for Node ABI ${loadResult.abiMismatch.compiledAbi}; this editor requires ABI ${loadResult.abiMismatch.requiredAbi} (${formatRuntime(loadResult.runtime)})`
	} else if (loadResult.packageVersionMismatch) {
		binaryStatus = "fail"
		binaryDetail = `better-sqlite3 ${loadResult.packageVersionMismatch.installedVersion} is outside the supported major ${loadResult.packageVersionMismatch.supportedMajor}`
	} else if (loadResult.nodeApiMismatch) {
		binaryStatus = "fail"
		binaryDetail = `SQLite requires Node-API ${loadResult.nodeApiMismatch.addonApiVersion}; this editor provides ${loadResult.nodeApiMismatch.runtimeApiVersion} (${formatRuntime(loadResult.runtime)})`
	}

	checks.push({
		id: "binary",
		status: binaryStatus,
		title: "SQLite native driver (better_sqlite3.node)",
		detail: binaryDetail,
		fix:
			binaryStatus === "pass"
				? undefined
				: [
						"Install the VSIX for this editor (Apple silicon: darwin-arm64; Intel Mac: darwin-x64)",
						"If you maintain a source checkout: npm run doctor:fix",
					],
	})

	checks.push({
		id: "load",
		status: loadResult.ok ? "pass" : "fail",
		title: "Database driver loads successfully",
		detail: loadResult.ok ? undefined : (loadResult.loadError ?? nativeDepsFailureMessage(loadResult)),
		fix: loadResult.ok ? undefined : ["Reinstall LUMI using Install from VSIX…", `Guide: ${TROUBLESHOOTING_URL}`],
	})

	const nodeModulesPath = path.join(extensionPath, "node_modules")
	checks.push({
		id: "node_modules",
		status: fs.existsSync(nodeModulesPath) ? "pass" : "fail",
		title: "Extension includes node_modules",
		detail: fs.existsSync(nodeModulesPath) ? undefined : "Install appears incomplete (common with broken Open VSX builds)",
		fix: fs.existsSync(nodeModulesPath) ? undefined : ["Install from VSIX instead of a broken marketplace copy"],
	})

	return checks
}

export function summarizeInstallationChecks(checks: InstallationHealthCheck[]) {
	const pass = checks.filter((c) => c.status === "pass").length
	const warn = checks.filter((c) => c.status === "warn").length
	const fail = checks.filter((c) => c.status === "fail").length
	return { pass, warn, fail, total: checks.length, ok: fail === 0 }
}

export function formatInstallationHealthReport({
	checks,
	extensionPath,
	extensionVersion,
	hostName,
	hostVersion,
}: {
	checks: InstallationHealthCheck[]
	extensionPath: string
	extensionVersion: string
	hostName: string
	hostVersion: string
}): string {
	const summary = summarizeInstallationChecks(checks)
	const lines = [
		"LUMI Installation Health Check",
		"==============================",
		"",
		`Editor:     ${hostName} ${hostVersion}`,
		`Extension:  ${extensionVersion}`,
		`Runtime:    ${formatRuntime(getNativeRuntimeInfo())}`,
		`Location:   ${extensionPath}`,
		"",
		"Checks",
		"------",
	]

	for (const check of checks) {
		lines.push(`[${STATUS_LABEL[check.status]}] ${check.title}`)
		if (check.detail) {
			lines.push(`       ${check.detail}`)
		}
	}

	lines.push("")
	lines.push(
		`Summary: ${summary.ok ? "Healthy" : "Needs attention"} — ${summary.pass} passed, ${summary.warn} warnings, ${summary.fail} failed`,
	)

	if (!summary.ok) {
		lines.push("")
		lines.push("Recommended next steps")
		lines.push("----------------------")
		let step = 1
		for (const check of checks) {
			if (check.status === "pass" || !check.fix?.length) {
				continue
			}
			for (const fix of check.fix) {
				lines.push(`${step}. ${fix}`)
				step++
			}
		}
	}

	lines.push("")
	lines.push(`Help: ${TROUBLESHOOTING_URL}`)
	return lines.join("\n")
}

export async function runInstallationHealthCheck(context: vscode.ExtensionContext): Promise<boolean> {
	const channel = getHealthOutputChannel()
	const checks = auditCurrentInstallation(context.extensionPath)
	const summary = summarizeInstallationChecks(checks)
	const hostVersion = vscode.version
	const hostName = vscode.env.appName || "VS Code compatible editor"

	const report = formatInstallationHealthReport({
		checks,
		extensionPath: context.extensionPath,
		extensionVersion: context.extension.packageJSON.version ?? "unknown",
		hostName,
		hostVersion,
	})

	channel.clear()
	channel.appendLine(report)
	channel.show(true)

	if (summary.ok && summary.warn === 0) {
		const choice = await vscode.window.showInformationMessage(
			"LUMI installation looks healthy. See the LUMI Health panel for details.",
			"Open guide",
		)
		if (choice === "Open guide") {
			await vscode.env.openExternal(vscode.Uri.parse(TROUBLESHOOTING_URL))
		}
		return true
	}

	const choice = await vscode.window.showWarningMessage(
		summary.fail > 0
			? "LUMI found problems with this installation. See the LUMI Health panel for step-by-step fixes."
			: "LUMI found minor installation warnings. See the LUMI Health panel for details.",
		"Open Extensions",
		"How to fix",
		"Copy report",
	)

	if (choice === "Open Extensions") {
		await vscode.commands.executeCommand("workbench.extensions.search", "LUMI")
	}

	if (choice === "How to fix") {
		await vscode.env.openExternal(vscode.Uri.parse(TROUBLESHOOTING_URL))
	}

	if (choice === "Copy report") {
		await vscode.env.clipboard.writeText(report)
		void vscode.window.showInformationMessage("Health report copied to clipboard.")
	}

	return summary.ok
}

export async function showNativeDepsFailure(result: NativeDepsHealthResult): Promise<void> {
	const missingSummary =
		result.missingPackages.length > 0 ? result.missingPackages.join(", ") : "better-sqlite3 (database driver)"

	const explanation = result.architectureMismatch
		? `The installed database driver is built for ${architectureLabel(result.architectureMismatch.builtFor)}, but this editor needs ${architectureLabel(result.architectureMismatch.required)}.`
		: result.abiMismatch
			? `The installed database driver uses Node ABI ${result.abiMismatch.compiledAbi}; this editor requires ABI ${result.abiMismatch.requiredAbi} (${formatRuntime(result.runtime)}).`
			: result.packageVersionMismatch
				? `The installed database driver is version ${result.packageVersionMismatch.installedVersion}; LUMI requires better-sqlite3 major ${result.packageVersionMismatch.supportedMajor}.`
				: result.nodeApiMismatch
					? `LUMI requires Node-API ${result.nodeApiMismatch.addonApiVersion}; this editor provides ${result.nodeApiMismatch.runtimeApiVersion} (${formatRuntime(result.runtime)}).`
					: "The extension may be incomplete or its database driver may not match this editor."
	const detail = result.loadError ? "\n\nChoose Copy details to include the technical diagnostic." : ""

	const prefix = result.architectureMismatch
		? "LUMI’s database driver is for the wrong processor architecture."
		: result.abiMismatch
			? "LUMI’s database driver was compiled for a different Node.js runtime."
			: result.packageVersionMismatch
				? "LUMI’s database driver is from an unsupported release."
				: result.nodeApiMismatch
					? "This editor’s runtime is too old for LUMI’s database driver."
					: `LUMI could not load its database driver (${missingSummary}).`
	const recovery = result.nodeApiMismatch
		? "Update this editor to VS Code 1.101 or newer, then choose Developer: Reload Window."
		: result.abiMismatch || result.packageVersionMismatch
			? "Update LUMI from Extensions, then choose Developer: Reload Window."
			: "Reinstall LUMI or install the matching platform VSIX, then reload the editor."
	const actions = result.nodeApiMismatch ? ["How to fix", "Copy details"] : ["Open Extensions", "How to fix", "Copy details"]

	const choice = await vscode.window.showErrorMessage(`${prefix} ${explanation} ${recovery}${detail}`, ...actions)

	if (choice === "Open Extensions") {
		await vscode.commands.executeCommand("workbench.extensions.search", "LUMI")
	}

	if (choice === "How to fix") {
		await vscode.env.openExternal(vscode.Uri.parse(TROUBLESHOOTING_URL))
	}

	if (choice === "Copy details") {
		const text = [
			"LUMI native dependency check failed",
			result.missingPackages.length > 0 ? `Missing: ${missingSummary}` : "Missing: none",
			result.architectureMismatch
				? `Architecture: built for ${architectureLabel(result.architectureMismatch.builtFor)}, editor requires ${architectureLabel(result.architectureMismatch.required)}`
				: "",
			result.abiMismatch
				? `ABI Mismatch: compiled for Node ABI ${result.abiMismatch.compiledAbi}, editor requires ABI ${result.abiMismatch.requiredAbi}`
				: "",
			result.packageVersionMismatch
				? `Package Version: installed ${result.packageVersionMismatch.installedVersion}, supported major ${result.packageVersionMismatch.supportedMajor}`
				: "",
			result.nodeApiMismatch
				? `Node-API Mismatch: addon requires ${result.nodeApiMismatch.addonApiVersion}, editor provides ${result.nodeApiMismatch.runtimeApiVersion}`
				: "",
			`Runtime: ${formatRuntime(result.runtime)}`,
			result.loadError ? `Error: ${result.loadError}` : "",
			`Help: ${TROUBLESHOOTING_URL}`,
			"Repair a local source checkout: npm run doctor:fix",
		]
			.filter(Boolean)
			.join("\n")
		await vscode.env.clipboard.writeText(text)
		void vscode.window.showInformationMessage("Error details copied to clipboard.")
	}
}

export function nativeDepsFailureMessage(result: NativeDepsHealthResult): string {
	if (result.architectureMismatch) {
		return `LUMI native dependency architecture mismatch (built for ${result.architectureMismatch.builtFor}, editor requires ${result.architectureMismatch.required})`
	}
	if (result.abiMismatch) {
		return `LUMI native dependency runtime mismatch (compiled for Node ABI ${result.abiMismatch.compiledAbi}, editor requires ABI ${result.abiMismatch.requiredAbi}; ${formatRuntime(result.runtime)})`
	}
	if (result.packageVersionMismatch) {
		return `LUMI native dependency version mismatch (installed better-sqlite3 ${result.packageVersionMismatch.installedVersion}, supported major ${result.packageVersionMismatch.supportedMajor})`
	}
	if (result.nodeApiMismatch) {
		return `LUMI native dependency requires Node-API ${result.nodeApiMismatch.addonApiVersion}, editor provides ${result.nodeApiMismatch.runtimeApiVersion} (${formatRuntime(result.runtime)})`
	}
	const missing = result.missingPackages.length > 0 ? result.missingPackages.join(", ") : "better-sqlite3"
	return `LUMI native dependency check failed (missing: ${missing})`
}
