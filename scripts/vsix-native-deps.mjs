#!/usr/bin/env node
/**
 * Native dependency health checks for LUMI packaging, installs, and CI.
 *
 * better-sqlite3 is externalized in esbuild and must ship inside every VSIX /
 * installed extension folder (see .vscodeignore whitelist).
 */
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import semver from "semver"
import yauzl from "yauzl"
import { REQUIRED_RUNTIME_PACKAGES } from "./native-dependency-contract.mjs"

export { REQUIRED_RUNTIME_PACKAGES }

export const VSIX_NATIVE_MODULE_MARKER = "extension/node_modules/better-sqlite3/prebuilds/"

export const INSTALLED_NATIVE_MODULE_RELATIVE = "node_modules/better-sqlite3/build/Release/better_sqlite3.node"

export const MIN_NATIVE_BINARY_BYTES = 100_000

export const SUPPORTED_BETTER_SQLITE3_MAJOR = 13
export const MIN_VSCODE_VERSION = "1.101.0"
export const MIN_NODE_VERSION_FOR_NAPI10 = "22.14.0"
const SUPPORTED_EXTENSION_IDS = new Set(["cardsorting.lumi", "cardsorting.lumi-vscode"])

export const DEFAULT_EXTENSION_ROOTS = [
	{ id: "antigravity", label: "Antigravity IDE", dir: path.join(os.homedir(), ".antigravity-ide", "extensions") },
	{ id: "cursor", label: "Cursor", dir: path.join(os.homedir(), ".cursor", "extensions") },
	{ id: "vscode", label: "VS Code", dir: path.join(os.homedir(), ".vscode", "extensions") },
]

export const LUMI_EXTENSION_FOLDER_PATTERN = /^(?:cardsorting\.lumi(?:-vscode)?|dreambeesai\.dietcode)(?:-|$)/i

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

function binaryArchitecturesFromBuffer(binary) {
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

function binaryArchitectures(binaryPath) {
	return binaryArchitecturesFromBuffer(fs.readFileSync(binaryPath))
}

function binaryFormatFromBuffer(binary) {
	const magic = binary.subarray(0, 4).toString("hex")
	if (["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "cafebabf", "bebafeca", "bfbafeca"].includes(magic)) {
		return "macho"
	}
	if (magic === "7f454c46") return "elf"
	if (magic.startsWith("4d5a")) return "pe"
	return "unknown"
}

function binaryFormat(binaryPath) {
	return binaryFormatFromBuffer(fs.readFileSync(binaryPath))
}

function hostTarget() {
	const platform = process.platform
	return `${platform}-${process.arch}`
}

function packageVersionMajor(version) {
	const match = /^(\d+)\./.exec(String(version ?? ""))
	return match ? Number(match[1]) : undefined
}

function extensionIdFromManifest(manifest) {
	if (!manifest?.publisher || !manifest?.name) return undefined
	return `${manifest.publisher}.${manifest.name}`.toLowerCase()
}

export function expectedExtensionIdForFolderName(folderName) {
	const normalizedName = String(folderName).toLowerCase()
	if (/^cardsorting\.lumi-vscode(?:-|$)/.test(normalizedName)) return "cardsorting.lumi-vscode"
	if (/^cardsorting\.lumi(?:-|$)/.test(normalizedName)) return "cardsorting.lumi"
	return undefined
}

function declaredVersionMajor(range) {
	const match = /(?:^|\D)(\d+)\.(?:\d+|x|\*)/.exec(String(range ?? ""))
	return match ? Number(match[1]) : undefined
}

function rangeIsSubsetOf(range, supportedRange) {
	try {
		return Boolean(range) && semver.validRange(range) !== null && semver.subset(range, supportedRange)
	} catch {
		return false
	}
}

function nodeEngineSupportsNapi10(engine) {
	return rangeIsSubsetOf(engine, `>=${MIN_NODE_VERSION_FOR_NAPI10} <23.0.0 || >=23.6.0`)
}

function editorEngineSupportsNapi10(engine) {
	return rangeIsSubsetOf(engine, `>=${MIN_VSCODE_VERSION}`)
}

function readJsonIfPresent(filePath) {
	if (!fs.existsSync(filePath)) return undefined
	return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function runtimeContractChecks(repoRoot) {
	const rootManifest = readJsonIfPresent(path.join(repoRoot, "package.json"))
	const lock = readJsonIfPresent(path.join(repoRoot, "package-lock.json"))
	const workspaceLock = readJsonIfPresent(path.join(repoRoot, "broccolidb/package-lock.json"))
	const evalsManifest = readJsonIfPresent(path.join(repoRoot, "evals/package.json"))
	const evalsLock = readJsonIfPresent(path.join(repoRoot, "evals/package-lock.json"))
	const installed = readJsonIfPresent(path.join(repoRoot, "node_modules/better-sqlite3/package.json"))
	const workspaceManifest = readJsonIfPresent(path.join(repoRoot, "broccolidb/package.json"))
	const lockedVersion = lock?.packages?.["node_modules/better-sqlite3"]?.version
	const workspaceLockedVersion = workspaceLock?.packages?.["node_modules/better-sqlite3"]?.version
	const evalsLockedVersion = evalsLock?.packages?.["node_modules/better-sqlite3"]?.version
	const bunLockPath = path.join(repoRoot, "bun.lock")
	const bunLockText = fs.existsSync(bunLockPath) ? fs.readFileSync(bunLockPath, "utf8") : ""
	const bunLockedVersion = /"better-sqlite3":\s*\["better-sqlite3@([^" ]+)/.exec(bunLockText)?.[1]
	const declaredMajor = declaredVersionMajor(rootManifest?.dependencies?.["better-sqlite3"])
	const workspaceMajor = declaredVersionMajor(workspaceManifest?.dependencies?.["better-sqlite3"])
	const evalsMajor = declaredVersionMajor(evalsManifest?.dependencies?.["better-sqlite3"])
	const lockedMajor = packageVersionMajor(lockedVersion)
	const workspaceLockedMajor = packageVersionMajor(workspaceLockedVersion)
	const evalsLockedMajor = packageVersionMajor(evalsLockedVersion)
	const bunLockedMajor = packageVersionMajor(bunLockedVersion)
	const installedMajor = packageVersionMajor(installed?.version)
	const minimumEditor = String(rootManifest?.engines?.vscode ?? "")
	const lockedMinimumEditor = String(lock?.packages?.[""]?.engines?.vscode ?? "")
	const editorSupportsNapi10 = minimumEditor === lockedMinimumEditor && editorEngineSupportsNapi10(minimumEditor)
	const broccolidbNodeEngines = [
		{ source: "broccolidb/package.json", value: String(workspaceManifest?.engines?.node ?? "") },
		{ source: "package-lock workspace entry", value: String(lock?.packages?.broccolidb?.engines?.node ?? "") },
		{ source: "broccolidb/package-lock.json", value: String(workspaceLock?.packages?.[""]?.engines?.node ?? "") },
	]
	const broccolidbNodeEngine = broccolidbNodeEngines[0].value
	const broccolidbSupportsNapi10 =
		broccolidbNodeEngines.every((engine) => engine.value === broccolidbNodeEngine) &&
		broccolidbNodeEngines.every((engine) => nodeEngineSupportsNapi10(engine.value))
	const evalsNodeEngine = String(evalsManifest?.engines?.node ?? "")
	const evalsLockedNodeEngine = String(evalsLock?.packages?.[""]?.engines?.node ?? "")
	const evalsSupportsNapi10 = evalsNodeEngine === evalsLockedNodeEngine && nodeEngineSupportsNapi10(evalsNodeEngine)
	const result = []
	const packageContractOk =
		declaredMajor === SUPPORTED_BETTER_SQLITE3_MAJOR &&
		workspaceMajor === SUPPORTED_BETTER_SQLITE3_MAJOR &&
		evalsMajor === SUPPORTED_BETTER_SQLITE3_MAJOR &&
		lockedMajor === SUPPORTED_BETTER_SQLITE3_MAJOR &&
		workspaceLockedMajor === SUPPORTED_BETTER_SQLITE3_MAJOR &&
		evalsLockedMajor === SUPPORTED_BETTER_SQLITE3_MAJOR &&
		(!bunLockText || bunLockedMajor === SUPPORTED_BETTER_SQLITE3_MAJOR) &&
		installedMajor === SUPPORTED_BETTER_SQLITE3_MAJOR
	result.push({
		id: "sqlite:napi-package",
		status: packageContractOk ? "pass" : "fail",
		title: "better-sqlite3 uses the ABI-stable Node-API build",
		detail: packageContractOk
			? `Manifest, lockfile, workspace, and install use major ${installed?.version}`
			: `Expected the reviewed better-sqlite3 ${SUPPORTED_BETTER_SQLITE3_MAJOR}.x runtime in all manifests, lockfiles, and node_modules (found ${JSON.stringify({ declared: rootManifest?.dependencies?.["better-sqlite3"], workspace: workspaceManifest?.dependencies?.["better-sqlite3"], evals: evalsManifest?.dependencies?.["better-sqlite3"], locked: lockedVersion, workspaceLocked: workspaceLockedVersion, evalsLocked: evalsLockedVersion, bunLocked: bunLockedVersion, installed: installed?.version })})`,
		fix: packageContractOk
			? undefined
			: [
					"Run: npm install --package-lock-only",
					"Run in broccolidb/: npm install --package-lock-only",
					"Run in evals/: npm install --package-lock-only",
					"Refresh bun.lock with: bun install --lockfile-only",
					"Then run: npm ci --include=optional",
				],
	})
	result.push({
		id: "sqlite:napi-evals-floor",
		status: evalsSupportsNapi10 ? "pass" : "fail",
		title: "Evaluation tooling runtime floor supports Node-API 10",
		detail: evalsSupportsNapi10
			? `Minimum Node.js version: ${evalsNodeEngine}`
			: `Expected evals/package.json and evals/package-lock.json to require Node ${MIN_NODE_VERSION_FOR_NAPI10}+ and Node 23.6+ (found ${JSON.stringify({ manifest: evalsNodeEngine, lockfile: evalsLockedNodeEngine })})`,
		fix: evalsSupportsNapi10
			? undefined
			: [
					`Set evals/package.json engines.node to >=${MIN_NODE_VERSION_FOR_NAPI10} <23.0.0 || >=23.6.0`,
					"Regenerate evals/package-lock.json",
				],
	})
	result.push({
		id: "sqlite:napi-runtime-floor",
		status: editorSupportsNapi10 ? "pass" : "fail",
		title: "VS Code minimum version supports Node-API 10",
		detail: editorSupportsNapi10
			? `Minimum editor version: ${minimumEditor}`
			: `Expected package.json and package-lock.json to require VS Code ^${MIN_VSCODE_VERSION} or newer (found ${JSON.stringify({ manifest: minimumEditor, lockfile: lockedMinimumEditor })})`,
		fix: editorSupportsNapi10
			? undefined
			: [`Set engines.vscode to ^${MIN_VSCODE_VERSION} or newer`, "Regenerate package-lock.json"],
	})
	result.push({
		id: "sqlite:napi-broccolidb-floor",
		status: broccolidbSupportsNapi10 ? "pass" : "fail",
		title: "BroccoliDB runtime floor supports Node-API 10",
		detail: broccolidbSupportsNapi10
			? `Minimum Node.js version: ${broccolidbNodeEngine}`
			: `better-sqlite3 13 uses Node-API 10, available in Node ${MIN_NODE_VERSION_FOR_NAPI10}+ and Node 23.6+; runtime floors must match in the manifest and both npm lockfiles (found ${JSON.stringify(broccolidbNodeEngines)})`,
		fix: broccolidbSupportsNapi10
			? undefined
			: [
					`Set broccolidb/package.json engines.node to >=${MIN_NODE_VERSION_FOR_NAPI10} <23.0.0 || >=23.6.0`,
					"Regenerate both npm lockfiles",
				],
	})
	return result
}

export function nativePrebuildNames(target) {
	const arch = parseTargetArchitecture(target)
	if (target.startsWith("darwin-")) return [`darwin-${arch}`]
	if (target.startsWith("linux-")) return [`linux-${arch}`, `linuxmusl-${arch}`]
	if (target.startsWith("win32-")) return [`win32-${arch}`]
	throw new Error(`Unsupported better-sqlite3 target: ${target}`)
}

export function createTargetVscodeIgnoreFile(repoRoot, target) {
	const baseIgnorePath = path.join(repoRoot, ".vscodeignore")
	const baseRules = fs
		.readFileSync(baseIgnorePath, "utf8")
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "!node_modules/better-sqlite3/prebuilds/**")
		.join("\n")
		.trimEnd()
	const targetPrebuildNames = nativePrebuildNames(target)
	const ignoreDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "lumi-vsix-ignore-"))
	const ignorePath = path.join(ignoreDirectory, ".vscodeignore")
	const prebuildRules = [
		"",
		".vscodeignore",
		"# Keep only the ABI-stable SQLite binaries needed by this VSIX target.",
		"node_modules/better-sqlite3/prebuilds/**",
		...targetPrebuildNames.map((name) => `!node_modules/better-sqlite3/prebuilds/${name}.node`),
	]
	try {
		fs.writeFileSync(ignorePath, `${baseRules}\n${prebuildRules.join("\n")}\n`)
		return ignorePath
	} catch (error) {
		fs.rmSync(ignoreDirectory, { recursive: true, force: true })
		throw error
	}
}

export function assertNativeModuleArchitecture(repoRoot, target) {
	const contractFailures = runtimeContractChecks(repoRoot).filter((check) => check.status === "fail")
	if (contractFailures.length > 0) {
		throw new Error(
			`SQLite runtime compatibility checks failed:\n${contractFailures.map((check) => `  - ${check.title}: ${check.detail}`).join("\n")}`,
		)
	}

	const nativeDir = path.join(repoRoot, "node_modules", "better-sqlite3", "prebuilds")
	const expectedArch = parseTargetArchitecture(target)
	const expectedFormat = target.startsWith("darwin-") ? "macho" : target.startsWith("win32-") ? "pe" : "elf"
	const names = nativePrebuildNames(target)
	for (const name of names) {
		const expectedBinaryArch = name.endsWith("-arm64") ? "arm64" : name.endsWith("-x64") ? "x64" : expectedArch
		const binaryPath = path.join(nativeDir, `${name}.node`)
		if (!fs.existsSync(binaryPath)) {
			throw new Error(`better-sqlite3 Node-API prebuild is missing for ${name}: ${binaryPath}`)
		}
		const size = fs.statSync(binaryPath).size
		if (size < MIN_NATIVE_BINARY_BYTES) {
			throw new Error(`better-sqlite3 Node-API prebuild is incomplete for ${name} (${size} bytes)`)
		}
		const actualFormat = binaryFormat(binaryPath)
		if (actualFormat !== expectedFormat) {
			throw new Error(
				`better-sqlite3 binary format mismatch for ${name}: expected ${expectedFormat}, found ${actualFormat}`,
			)
		}
		const actualArchitectures = binaryArchitectures(binaryPath)
		if (!actualArchitectures.includes(expectedBinaryArch)) {
			throw new Error(
				`better-sqlite3 architecture mismatch for ${name}: expected ${expectedBinaryArch}, found ${actualArchitectures.join(", ") || "unknown"}`,
			)
		}
	}
	assertNodeApiDatabaseLoads(repoRoot)
	console.log(`[vsix] verified ABI-stable better-sqlite3 prebuilds: ${names.join(", ")}`)
}

function assertNodeApiDatabaseLoads(repoRoot) {
	const requireFromRepo = createRequire(path.join(repoRoot, "package.json"))
	const Database = requireFromRepo("better-sqlite3")
	const db = new Database(":memory:")
	try {
		const row = db.prepare("SELECT 1 AS healthy").get()
		if (row?.healthy !== 1) throw new Error("SQLite smoke query returned an unexpected result")
	} finally {
		db.close()
	}
}

const MAX_VSIX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_PACKAGE_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_VSIX_ENTRIES = 100_000
const MAX_VSIX_EXTRACTED_BYTES = 1024 * 1024 * 1024

const CRC32_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC32_TABLE.length; index++) {
	let crc = index
	for (let bit = 0; bit < 8; bit++) {
		crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
	}
	CRC32_TABLE[index] = crc >>> 0
}

function crc32Update(crc, buffer) {
	for (const byte of buffer) {
		crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
	}
	return crc >>> 0
}

function crc32(buffer) {
	return (crc32Update(0xffffffff, buffer) ^ 0xffffffff) >>> 0
}

function assertSafeArchivePath(name) {
	const normalizedName = name.endsWith("/") ? name.slice(0, -1) : name
	const segments = normalizedName.split("/")
	const hasControlCharacter = [...name].some((character) => character.charCodeAt(0) < 0x20)
	if (
		!name ||
		name.startsWith("/") ||
		/^[a-z]:/i.test(name) ||
		name.includes("\\") ||
		hasControlCharacter ||
		/[<>:"|?*]/.test(name) ||
		segments.some(
			(segment) =>
				segment === "" ||
				segment === "." ||
				segment === ".." ||
				/[ .]$/.test(segment) ||
				/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment),
		)
	) {
		throw new Error(`VSIX contains an unsafe archive path: ${JSON.stringify(name)}`)
	}
}

function readVsixArchive(vsixPath) {
	return new Promise((resolve, reject) => {
		yauzl.open(
			vsixPath,
			{ lazyEntries: true, autoClose: false, decodeStrings: true, strictFileNames: true, validateEntrySizes: true },
			(error, zipFile) => {
				if (error || !zipFile) {
					reject(error ?? new Error("VSIX archive could not be opened"))
					return
				}

				const entries = new Map()
				const normalizedPaths = new Set()
				let totalUncompressedBytes = 0
				let archiveClosed = false
				let listingFinished = false
				const close = () => {
					if (archiveClosed) return
					archiveClosed = true
					zipFile.close()
				}
				const fail = (failure) => {
					if (listingFinished) return
					listingFinished = true
					close()
					reject(failure)
				}

				zipFile.once("error", fail)
				zipFile.on("entry", (entry) => {
					try {
						const name = entry.fileName
						assertSafeArchivePath(name)
						const normalizedPath = name.replace(/\/$/, "").normalize("NFC").toLowerCase()
						if (normalizedPaths.has(normalizedPath))
							throw new Error(`VSIX contains a duplicate or cross-platform-colliding archive path: ${name}`)
						normalizedPaths.add(normalizedPath)
						if (entries.size >= MAX_VSIX_ENTRIES) throw new Error(`VSIX exceeds the ${MAX_VSIX_ENTRIES} entry limit`)
						if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
							throw new Error(`VSIX entry has an invalid uncompressed size: ${name}`)
						}
						totalUncompressedBytes += entry.uncompressedSize
						if (totalUncompressedBytes > MAX_VSIX_EXTRACTED_BYTES) {
							throw new Error(`VSIX exceeds the ${MAX_VSIX_EXTRACTED_BYTES}-byte uncompressed size limit`)
						}
						if (entry.generalPurposeBitFlag & 0x1) throw new Error(`VSIX contains an encrypted entry: ${name}`)
						const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
						if ((unixMode & 0xf000) === 0xa000) throw new Error(`VSIX contains a symbolic link: ${name}`)
						entries.set(name, entry)
						zipFile.readEntry()
					} catch (entryError) {
						fail(entryError)
					}
				})
				zipFile.once("end", () => {
					if (listingFinished) return
					listingFinished = true
					resolve({
						entries,
						close,
						readEntry(name, maxBytes = MAX_VSIX_ENTRY_BYTES) {
							const entry = entries.get(name)
							if (!entry) return Promise.reject(new Error(`VSIX entry is missing: ${name}`))
							if (
								!Number.isSafeInteger(entry.uncompressedSize) ||
								entry.uncompressedSize < 0 ||
								entry.uncompressedSize > maxBytes
							) {
								return Promise.reject(new Error(`VSIX entry exceeds the ${maxBytes}-byte size limit: ${name}`))
							}

							return new Promise((resolveEntry, rejectEntry) => {
								zipFile.openReadStream(entry, (streamError, stream) => {
									if (streamError || !stream) {
										rejectEntry(streamError ?? new Error(`VSIX entry could not be read: ${name}`))
										return
									}

									const chunks = []
									let size = 0
									let settled = false
									const failEntry = (streamFailure) => {
										if (settled) return
										settled = true
										rejectEntry(streamFailure)
									}
									stream.on("data", (chunk) => {
										if (settled) return
										size += chunk.length
										if (size > maxBytes) {
											stream.destroy()
											failEntry(new Error(`VSIX entry exceeds the ${maxBytes}-byte size limit: ${name}`))
											return
										}
										chunks.push(chunk)
									})
									stream.once("error", failEntry)
									stream.once("end", () => {
										if (settled) return
										settled = true
										const contents = Buffer.concat(chunks, size)
										if (crc32(contents) !== entry.crc32) {
											rejectEntry(new Error(`VSIX entry failed CRC-32 validation: ${name}`))
											return
										}
										resolveEntry(contents)
									})
								})
							})
						},
					})
				})
				zipFile.readEntry()
			},
		)
	})
}

function extractVsixExtension(vsixPath, extractionRoot) {
	return new Promise((resolve, reject) => {
		yauzl.open(
			vsixPath,
			{ lazyEntries: true, autoClose: true, decodeStrings: true, strictFileNames: true, validateEntrySizes: true },
			(error, zipFile) => {
				if (error || !zipFile) {
					reject(error ?? new Error("VSIX archive could not be opened"))
					return
				}

				const extensionRoot = path.resolve(extractionRoot, "extension")
				let extractedBytes = 0
				let settled = false
				let processedEntries = 0
				const normalizedPaths = new Set()
				const fail = (failure) => {
					if (settled) return
					settled = true
					zipFile.close()
					reject(failure)
				}
				zipFile.on("error", fail)
				zipFile.on("entry", (entry) => {
					const processEntry = async () => {
						assertSafeArchivePath(entry.fileName)
						const normalizedPath = entry.fileName.replace(/\/$/, "").normalize("NFC").toLowerCase()
						if (normalizedPaths.has(normalizedPath))
							throw new Error(
								`VSIX contains a duplicate or cross-platform-colliding archive path: ${entry.fileName}`,
							)
						normalizedPaths.add(normalizedPath)
						processedEntries += 1
						if (processedEntries > MAX_VSIX_ENTRIES)
							throw new Error(`VSIX exceeds the ${MAX_VSIX_ENTRIES} entry limit`)
						const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
						if ((unixMode & 0xf000) === 0xa000)
							throw new Error(`Refusing to extract a symbolic link: ${entry.fileName}`)
						if (!entry.fileName.startsWith("extension/")) {
							zipFile.readEntry()
							return
						}
						const relativePath = entry.fileName.slice("extension/".length)
						const destination = path.resolve(extensionRoot, relativePath)
						if (destination !== extensionRoot && !destination.startsWith(`${extensionRoot}${path.sep}`)) {
							throw new Error(`Refusing to extract an unsafe VSIX path: ${entry.fileName}`)
						}
						if (entry.fileName.endsWith("/")) {
							fs.mkdirSync(destination, { recursive: true })
							zipFile.readEntry()
							return
						}
						if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
							throw new Error(`VSIX entry has an invalid size: ${entry.fileName}`)
						}
						if (
							entry.uncompressedSize > MAX_VSIX_EXTRACTED_BYTES ||
							extractedBytes + entry.uncompressedSize > MAX_VSIX_EXTRACTED_BYTES
						) {
							throw new Error(
								`VSIX extension contents exceed the ${MAX_VSIX_EXTRACTED_BYTES}-byte extraction limit`,
							)
						}
						extractedBytes += entry.uncompressedSize
						fs.mkdirSync(path.dirname(destination), { recursive: true })
						await new Promise((resolveStream, rejectStream) => {
							zipFile.openReadStream(entry, (streamError, readStream) => {
								if (streamError || !readStream) {
									rejectStream(streamError ?? new Error(`VSIX entry could not be read: ${entry.fileName}`))
									return
								}
								let entryBytes = 0
								let checksum = 0xffffffff
								const verifier = new Transform({
									transform(chunk, _encoding, callback) {
										entryBytes += chunk.length
										if (
											entryBytes > entry.uncompressedSize ||
											extractedBytes - entry.uncompressedSize + entryBytes > MAX_VSIX_EXTRACTED_BYTES
										) {
											callback(
												new Error(`VSIX entry exceeds its declared or allowed size: ${entry.fileName}`),
											)
											return
										}
										checksum = crc32Update(checksum, chunk)
										callback(null, chunk)
									},
									flush(callback) {
										const actualChecksum = (checksum ^ 0xffffffff) >>> 0
										if (entryBytes !== entry.uncompressedSize || actualChecksum !== entry.crc32) {
											callback(new Error(`VSIX entry failed size or CRC-32 validation: ${entry.fileName}`))
											return
										}
										callback()
									},
								})
								pipeline(readStream, verifier, fs.createWriteStream(destination, { flags: "wx" })).then(
									resolveStream,
									rejectStream,
								)
							})
						})
						zipFile.readEntry()
					}

					processEntry().catch(fail)
				})
				zipFile.once("end", () => {
					if (settled) return
					settled = true
					resolve()
				})
				zipFile.readEntry()
			},
		)
	})
}

function packagePathInVsix(packageName) {
	return `extension/node_modules/${packageName}/package.json`
}

function nativePrebuildPathInExtension(extensionDir) {
	const hostArch = `${process.platform}-${process.arch}`
	let isMusl = false
	if (process.platform === "linux") {
		try {
			isMusl = process.report?.getReport?.()?.header?.glibcVersionRuntime === undefined
		} catch {
			// Keep the glibc prebuild as the standard fallback when runtime metadata is unavailable.
		}
	}
	const prebuildName = isMusl ? `linuxmusl-${process.arch}` : hostArch
	return path.join(extensionDir, `node_modules/better-sqlite3/prebuilds/${prebuildName}.node`)
}

function nativeBinaryPathInExtension(extensionDir) {
	const prebuildPath = nativePrebuildPathInExtension(extensionDir)
	if (fs.existsSync(prebuildPath)) {
		return prebuildPath
	}
	return path.join(extensionDir, INSTALLED_NATIVE_MODULE_RELATIVE)
}

const SUPPORTED_VSIX_TARGETS = ["linux-x64", "win32-x64", "darwin-x64", "darwin-arm64"]

function nativePrebuildPathsInVsix(vsixPath, archive) {
	const targetMatch = /-(linux|win32|darwin)-(x64|arm64)\.vsix$/i.exec(path.basename(vsixPath))
	if (targetMatch) {
		const target = `${targetMatch[1].toLowerCase()}-${targetMatch[2].toLowerCase()}`
		if (!SUPPORTED_VSIX_TARGETS.includes(target)) return { target, paths: [] }
		return {
			target,
			paths: nativePrebuildNames(target).map((name) => `extension/node_modules/better-sqlite3/prebuilds/${name}.node`),
		}
	}

	const presentNames = [...archive.entries.keys()]
		.filter((entry) => entry.startsWith(VSIX_NATIVE_MODULE_MARKER) && entry.endsWith(".node"))
		.map((entry) => entry.slice(VSIX_NATIVE_MODULE_MARKER.length, -".node".length))
	const matchingTarget = SUPPORTED_VSIX_TARGETS.find((target) => {
		const names = nativePrebuildNames(target)
		const expected = [...names].sort()
		const actual = [...presentNames].sort()
		return expected.length === actual.length && expected.every((name, index) => name === actual[index])
	})
	return matchingTarget
		? {
				target: matchingTarget,
				paths: nativePrebuildNames(matchingTarget).map(
					(name) => `extension/node_modules/better-sqlite3/prebuilds/${name}.node`,
				),
			}
		: { target: undefined, paths: [] }
}

function packagePresentInVsix(archive, packageName) {
	return archive.entries.has(packagePathInVsix(packageName))
}

function packagePresentInExtension(extensionDir, packageName) {
	return fs.existsSync(path.join(extensionDir, "node_modules", packageName, "package.json"))
}

/** @returns {Promise<HealthCheck[]>} */
export async function auditVsixHealth(vsixPath) {
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

	let archive
	try {
		archive = await readVsixArchive(vsixPath)
		for (const pkg of REQUIRED_RUNTIME_PACKAGES) {
			const present = packagePresentInVsix(archive, pkg)
			checks.push({
				id: `${name}:pkg:${pkg}`,
				status: present ? "pass" : "fail",
				title: `${name} includes ${pkg}`,
				detail: present ? undefined : `Package manifest missing: ${packagePathInVsix(pkg)}`,
				fix: present
					? undefined
					: ["Reinstall dependencies with npm ci --include=optional", "Re-package with: npm run package:vsix:all"],
			})
		}

		const packageManifestPath = packagePathInVsix("better-sqlite3")
		let sqliteVersion
		try {
			const manifest = JSON.parse(
				(await archive.readEntry(packageManifestPath, MAX_PACKAGE_MANIFEST_BYTES)).toString("utf8"),
			)
			sqliteVersion = manifest.version
		} catch (error) {
			checks.push({
				id: `${name}:sqlite-version`,
				status: "fail",
				title: `${name} uses the reviewed better-sqlite3 runtime`,
				detail: error instanceof Error ? error.message : String(error),
				fix: ["Reinstall dependencies with npm ci --include=optional", "Re-package with: npm run package:vsix:all"],
			})
		}
		const sqliteMajor = packageVersionMajor(sqliteVersion)
		if (sqliteVersion !== undefined) {
			checks.push({
				id: `${name}:sqlite-version`,
				status: sqliteMajor === SUPPORTED_BETTER_SQLITE3_MAJOR ? "pass" : "fail",
				title: `${name} uses the reviewed better-sqlite3 runtime`,
				detail:
					sqliteMajor === SUPPORTED_BETTER_SQLITE3_MAJOR
						? `better-sqlite3 ${sqliteVersion}`
						: `Expected ${SUPPORTED_BETTER_SQLITE3_MAJOR}.x; found ${sqliteVersion}`,
				fix:
					sqliteMajor === SUPPORTED_BETTER_SQLITE3_MAJOR
						? undefined
						: ["Reinstall dependencies with npm ci --include=optional", "Re-package with: npm run package:vsix:all"],
			})
		}

		const extensionManifestPath = "extension/package.json"
		let extensionManifest
		let extensionEngine
		try {
			extensionManifest = JSON.parse(
				(await archive.readEntry(extensionManifestPath, MAX_PACKAGE_MANIFEST_BYTES)).toString("utf8"),
			)
			if (!extensionManifest || typeof extensionManifest !== "object") {
				throw new Error("Extension manifest is not a JSON object")
			}
			extensionEngine = extensionManifest.engines?.vscode
		} catch (error) {
			checks.push({
				id: `${name}:editor-runtime`,
				status: "fail",
				title: `${name} requires an N-API-compatible editor runtime`,
				detail: error instanceof Error ? error.message : String(error),
				fix: ["Set the package engines.vscode floor to ^1.101.0", "Rebuild the VSIX"],
			})
		}
		if (extensionManifest) {
			const engineOk = editorEngineSupportsNapi10(extensionEngine)
			checks.push({
				id: `${name}:editor-runtime`,
				status: engineOk ? "pass" : "fail",
				title: `${name} requires an N-API-compatible editor runtime`,
				detail: engineOk
					? `VS Code ${extensionEngine}`
					: `VS Code engine range ${JSON.stringify(extensionEngine)} includes runtimes older than ${MIN_VSCODE_VERSION}`,
				fix: engineOk ? undefined : [`Set package.json engines.vscode to ^${MIN_VSCODE_VERSION}`, "Rebuild the VSIX"],
			})

			const extensionId = extensionIdFromManifest(extensionManifest)
			const expectedFilenameId = /^lumi-vscode(?:-|$)/i.test(name)
				? "cardsorting.lumi-vscode"
				: /^lumi-(?:\d|$)/i.test(name)
					? "cardsorting.lumi"
					: undefined
			const identityOk =
				SUPPORTED_EXTENSION_IDS.has(extensionId) && (!expectedFilenameId || extensionId === expectedFilenameId)
			checks.push({
				id: `${name}:identity`,
				status: identityOk ? "pass" : "fail",
				title: `${name} has the expected LUMI extension identity`,
				detail: identityOk
					? extensionId
					: `Expected ${expectedFilenameId ?? "CardSorting.lumi or CardSorting.lumi-vscode"}; found ${extensionId ?? "missing publisher/name"}`,
				fix: identityOk ? undefined : ["Package using npm run package:vsix or npm run package:vsix:openvsx"],
			})
		}

		const expected = nativePrebuildPathsInVsix(vsixPath, archive)
		const allPrebuilds = [...archive.entries.keys()].filter(
			(entry) => entry.startsWith(VSIX_NATIVE_MODULE_MARKER) && entry.endsWith(".node"),
		)
		const missingPrebuilds = expected.paths.filter((entry) => !archive.entries.has(entry))
		const unexpectedPrebuilds = allPrebuilds.filter((entry) => !expected.paths.includes(entry))
		const binaryProblems = []
		if (!expected.target || expected.paths.length === 0) {
			binaryProblems.push(
				`Cannot identify one supported VSIX target from ${allPrebuilds.join(", ") || "no SQLite prebuilds"}`,
			)
		}
		if (missingPrebuilds.length > 0) binaryProblems.push(`Missing: ${missingPrebuilds.join(", ")}`)
		if (unexpectedPrebuilds.length > 0) binaryProblems.push(`Unexpected: ${unexpectedPrebuilds.join(", ")}`)

		for (const binaryPath of expected.paths) {
			if (!archive.entries.has(binaryPath)) continue
			try {
				const binary = await archive.readEntry(binaryPath)
				const prebuildName = path.basename(binaryPath, ".node")
				const expectedArch = parseTargetArchitecture(prebuildName)
				const expectedFormat = prebuildName.startsWith("darwin-")
					? "macho"
					: prebuildName.startsWith("win32-")
						? "pe"
						: "elf"
				const actualArchitectures = binaryArchitecturesFromBuffer(binary)
				if (binary.length < MIN_NATIVE_BINARY_BYTES)
					binaryProblems.push(`${binaryPath} is too small (${binary.length} bytes)`)
				if (binaryFormatFromBuffer(binary) !== expectedFormat)
					binaryProblems.push(`${binaryPath} is not a ${expectedFormat} binary`)
				if (!actualArchitectures.includes(expectedArch)) {
					binaryProblems.push(
						`${binaryPath} architecture mismatch (expected ${expectedArch}; found ${actualArchitectures.join(", ") || "unknown"})`,
					)
				}
			} catch (error) {
				binaryProblems.push(error instanceof Error ? error.message : String(error))
			}
		}
		checks.push({
			id: `${name}:binary`,
			status: binaryProblems.length === 0 ? "pass" : "fail",
			title: `${name} includes valid ABI-stable SQLite prebuilds`,
			detail:
				binaryProblems.length === 0
					? `${expected.paths.length} platform prebuild${expected.paths.length === 1 ? "" : "s"} verified for ${expected.target}`
					: binaryProblems.join("; "),
			fix:
				binaryProblems.length === 0
					? undefined
					: [
							"Reinstall dependencies with npm ci --include=optional",
							"Re-package with: npm run package:vsix:all",
							"Install the VSIX matching this editor architecture",
						],
		})
	} catch (error) {
		checks.push({
			id: `${name}:archive`,
			status: "fail",
			title: `${name} is a readable VSIX archive`,
			detail: error instanceof Error ? error.message : String(error),
			fix: ["Rebuild the package with: npm run package:vsix:all"],
		})
	} finally {
		archive?.close()
	}

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

	let sqliteManifest
	let sqliteManifestError
	try {
		sqliteManifest = readJsonIfPresent(path.join(extensionDir, "node_modules/better-sqlite3/package.json"))
	} catch (error) {
		sqliteManifestError = error instanceof Error ? error.message : String(error)
	}
	const sqliteMajor = packageVersionMajor(sqliteManifest?.version)
	checks.push({
		id: `${name}:sqlite-napi`,
		status: sqliteMajor === SUPPORTED_BETTER_SQLITE3_MAJOR ? "pass" : "fail",
		title: `${display} uses the ABI-stable SQLite runtime`,
		detail: sqliteManifestError
			? `Package manifest is unreadable: ${sqliteManifestError}`
			: sqliteMajor === SUPPORTED_BETTER_SQLITE3_MAJOR
				? `better-sqlite3 ${sqliteManifest.version}`
				: `Expected reviewed better-sqlite3 ${SUPPORTED_BETTER_SQLITE3_MAJOR}.x; found ${sqliteManifest?.version ?? "missing"}`,
		fix:
			sqliteMajor === SUPPORTED_BETTER_SQLITE3_MAJOR
				? undefined
				: ["Install the latest LUMI VSIX from the matching platform release", "Then reload the editor"],
	})
	let extensionManifest
	let extensionManifestError
	try {
		extensionManifest = readJsonIfPresent(path.join(extensionDir, "package.json"))
		if (extensionManifest !== undefined && (!extensionManifest || typeof extensionManifest !== "object")) {
			throw new Error("Extension manifest is not a JSON object")
		}
	} catch (error) {
		extensionManifestError = error instanceof Error ? error.message : String(error)
	}
	const extensionId = extensionIdFromManifest(extensionManifest)
	const expectedExtensionId = expectedExtensionIdForFolderName(name)
	const extensionIdentityOk =
		SUPPORTED_EXTENSION_IDS.has(extensionId) && (!expectedExtensionId || extensionId === expectedExtensionId)
	checks.push({
		id: `${name}:identity`,
		status: extensionIdentityOk ? "pass" : "fail",
		title: `${display} has the expected LUMI extension identity`,
		detail: extensionIdentityOk
			? extensionId
			: extensionManifestError
				? `Extension manifest is unreadable: ${extensionManifestError}`
				: `Expected ${expectedExtensionId ?? "CardSorting.lumi or CardSorting.lumi-vscode"}; found ${extensionId ?? "missing publisher/name"}`,
		fix: extensionIdentityOk ? undefined : ["Install the current LUMI extension from Extensions or a matching VSIX"],
	})
	const extensionEngine = extensionManifest?.engines?.vscode
	const extensionEngineOk = !extensionManifestError && editorEngineSupportsNapi10(extensionEngine)
	checks.push({
		id: `${name}:editor-runtime`,
		status: extensionEngineOk ? "pass" : "fail",
		title: `${display} requires an N-API-compatible editor runtime`,
		detail: extensionEngineOk
			? `VS Code ${extensionEngine}`
			: extensionManifestError
				? `Extension manifest is unreadable: ${extensionManifestError}`
				: `Expected engines.vscode to require ${MIN_VSCODE_VERSION} or newer; found ${JSON.stringify(extensionEngine ?? "missing")}`,
		fix: extensionEngineOk
			? undefined
			: [`Install a current LUMI VSIX requiring VS Code ${MIN_VSCODE_VERSION} or newer`, "Then reload the editor"],
	})

	const binaryPath = nativeBinaryPathInExtension(extensionDir)
	const expectedPrebuildPath = nativePrebuildPathInExtension(extensionDir)
	let binaryStatus = "fail"
	let binaryDetail = "Native SQLite binary is missing"
	try {
		if (fs.existsSync(expectedPrebuildPath)) {
			const size = fs.statSync(expectedPrebuildPath).size
			if (size >= MIN_NATIVE_BINARY_BYTES) {
				const expectedArch = parseTargetArchitecture(hostTarget())
				const expectedFormat = process.platform === "darwin" ? "macho" : process.platform === "win32" ? "pe" : "elf"
				const actualArchs = binaryArchitectures(expectedPrebuildPath)
				const actualFormat = binaryFormat(expectedPrebuildPath)
				if (actualArchs.includes(expectedArch) && actualFormat === expectedFormat) {
					binaryStatus = "pass"
					binaryDetail = undefined
				} else {
					binaryStatus = "fail"
					binaryDetail = `Expected ${expectedFormat}/${expectedArch}; found ${actualFormat}/${actualArchs.join(", ") || "unknown"}`
				}
			} else {
				binaryStatus = "fail"
				binaryDetail = `Prebuild is incomplete (${size} bytes)`
			}
		} else if (fs.existsSync(binaryPath)) {
			binaryDetail = "Found a legacy build/Release binary; this package requires an ABI-stable prebuild"
		}
	} catch (error) {
		binaryStatus = "fail"
		binaryDetail = `Native SQLite prebuild could not be inspected: ${error instanceof Error ? error.message : String(error)}`
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

export async function vsixHasNativeModule(vsixPath) {
	return (await auditVsixHealth(vsixPath)).every((check) => check.status !== "fail")
}

export function extensionHasNativeModule(extensionDir) {
	return (
		auditExtensionHealth(extensionDir).every((check) => check.status !== "fail") &&
		fs.existsSync(nativeBinaryPathInExtension(extensionDir))
	)
}

export async function assertVsixHasNativeModule(vsixPath) {
	const failed = (await auditVsixHealth(vsixPath)).filter((check) => check.status === "fail")
	if (failed.length > 0) {
		throw new Error(
			`Packaged VSIX failed native dependency checks:\n${failed
				.map(
					(check) =>
						`  - ${check.title}${check.detail ? `: ${check.detail}` : ""}${check.fix?.length ? `\n    Fix: ${check.fix.join("; ")}` : ""}`,
				)
				.join("\n")}`,
		)
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
			let entryStat
			try {
				entryStat = fs.lstatSync(extensionDir)
			} catch {
				continue
			}
			if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) {
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

	const expectedExtensionId = expectedExtensionIdForFolderName(extensionFolderName)
	if (!expectedExtensionId) return null
	const openVsxPackages = candidates.filter((file) => /^lumi-\d/i.test(path.basename(file)))
	const marketplacePackages = candidates.filter((file) => /^lumi-vscode(?:-|\.)/i.test(path.basename(file)))
	const preferred = expectedExtensionId === "cardsorting.lumi" ? openVsxPackages : marketplacePackages
	const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : process.platform
	const targetSuffix = `-${platform}-${process.arch}.vsix`
	const newest = (files) =>
		[...files].sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }))[0]

	// Preserve both the installed extension ID and its platform architecture.
	return (
		newest(preferred.filter((file) => file.endsWith(targetSuffix))) ??
		newest(preferred.filter((file) => !/-((darwin|win32|linux)-)(x64|arm64|armhf)\.vsix$/.test(file))) ??
		null
	)
}

export async function repairExtensionFromVsix({ extensionDir, vsixPath }) {
	if (!vsixPath || !fs.existsSync(vsixPath)) {
		throw new Error(`No repair VSIX found for ${path.basename(extensionDir)}`)
	}
	await assertVsixHasNativeModule(vsixPath)
	const targetDir = path.resolve(extensionDir)
	const targetName = path.basename(targetDir)
	const expectedExtensionId = expectedExtensionIdForFolderName(targetName)
	if (!expectedExtensionId) throw new Error(`Refusing to replace legacy or unrecognized extension identity: ${targetName}`)
	const targetParent = path.dirname(targetDir)
	if (!LUMI_EXTENSION_FOLDER_PATTERN.test(targetName)) {
		throw new Error(`Refusing to repair a folder that does not look like a LUMI install: ${targetName}`)
	}
	if (!fs.existsSync(targetParent) || !fs.statSync(targetParent).isDirectory()) {
		throw new Error(`Extension parent directory is unavailable: ${targetParent}`)
	}
	let existingTargetStat
	try {
		existingTargetStat = fs.lstatSync(targetDir)
	} catch (error) {
		if (error?.code !== "ENOENT") throw error
	}
	if (existingTargetStat?.isSymbolicLink()) {
		throw new Error(`Refusing to replace a symbolic link instead of an extension folder: ${targetDir}`)
	}
	if (existingTargetStat && !existingTargetStat.isDirectory()) {
		throw new Error(`Refusing to replace a non-directory extension path: ${targetDir}`)
	}

	const stagingRoot = fs.mkdtempSync(path.join(targetParent, `.${targetName}.repair-`))
	const extractDir = path.join(stagingRoot, "extracted")
	const extractedExtension = path.join(extractDir, "extension")
	const stagedExtension = path.join(stagingRoot, "replacement")
	const previousExtension = path.join(stagingRoot, "previous")
	let previousMoved = false
	let replacementCommitted = false
	try {
		fs.mkdirSync(extractDir)
		await extractVsixExtension(vsixPath, extractDir)
		if (!fs.existsSync(extractedExtension) || !fs.statSync(extractedExtension).isDirectory()) {
			throw new Error(`VSIX ${path.basename(vsixPath)} has no extension/ folder`)
		}
		const stagedHealth = auditExtensionHealth(extractedExtension)
		const failedStageChecks = stagedHealth.filter((check) => check.status === "fail")
		if (failedStageChecks.length > 0) {
			throw new Error(
				`Extracted VSIX failed install checks: ${failedStageChecks.map((check) => `${check.title}: ${check.detail ?? "failed"}`).join("; ")}`,
			)
		}
		const stagedManifest = readJsonIfPresent(path.join(extractedExtension, "package.json"))
		if (extensionIdFromManifest(stagedManifest) !== expectedExtensionId) {
			throw new Error(`Repair VSIX identity does not match ${targetName}; the existing install was left in place`)
		}
		fs.renameSync(extractedExtension, stagedExtension)

		if (existingTargetStat && fs.existsSync(targetDir)) {
			const currentTargetStat = fs.lstatSync(targetDir)
			if (currentTargetStat.isSymbolicLink() || !currentTargetStat.isDirectory()) {
				throw new Error(`Refusing to replace a changed extension path: ${targetDir}`)
			}
			fs.renameSync(targetDir, previousExtension)
			previousMoved = true
		}
		try {
			fs.renameSync(stagedExtension, targetDir)
			replacementCommitted = true
		} catch (error) {
			if (previousMoved && !fs.existsSync(targetDir)) {
				try {
					fs.renameSync(previousExtension, targetDir)
					previousMoved = false
				} catch (rollbackError) {
					console.error(
						`[doctor] replacement failed and rollback could not restore the prior install; it is preserved at ${previousExtension}: ${rollbackError}`,
					)
				}
			}
			throw error
		}
	} finally {
		if (!replacementCommitted && previousMoved && !fs.existsSync(targetDir)) {
			try {
				fs.renameSync(previousExtension, targetDir)
				previousMoved = false
			} catch (rollbackError) {
				console.error(`[doctor] prior install remains preserved at ${previousExtension}: ${rollbackError}`)
			}
		}
		if (replacementCommitted || !previousMoved) {
			try {
				fs.rmSync(stagingRoot, { recursive: true, force: true })
			} catch (cleanupError) {
				console.warn(`[doctor] could not remove repair staging directory ${stagingRoot}: ${cleanupError}`)
			}
		} else {
			console.error(
				`[doctor] prior install is preserved at ${previousExtension}; remove it only after confirming the replacement manually`,
			)
		}
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
export async function auditVsixFiles(distDir) {
	const results = []
	for (const vsixPath of discoverVsixFiles(distDir)) {
		const checks = await auditVsixHealth(vsixPath)
		results.push({ path: vsixPath, name: path.basename(vsixPath), ok: summarizeChecks(checks).ok, checks })
	}
	return results
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
	const expectedRules = {
		"better-sqlite3": [
			"!node_modules/better-sqlite3/package.json",
			"!node_modules/better-sqlite3/lib/**",
			"!node_modules/better-sqlite3/prebuilds/**",
		],
	}

	for (const pkg of REQUIRED_RUNTIME_PACKAGES) {
		const missingRules = expectedRules[pkg].filter((rule) => !ignore.includes(rule))
		const whitelisted = missingRules.length === 0
		checks.push({
			id: `vscodeignore:${pkg}`,
			status: whitelisted ? "pass" : "fail",
			title: `.vscodeignore includes the runtime files for ${pkg}`,
			detail: whitelisted ? undefined : `Missing rules: ${missingRules.join(", ")}`,
			fix: whitelisted ? undefined : missingRules.map((rule) => `Add "${rule}" to .vscodeignore`),
		})
	}

	return [...checks, ...runtimeContractChecks(repoRoot)]
}

/**
 * Build a structured doctor report (shared by CLI and CI).
 */
export async function buildDoctorReport({ repoRoot, distDir, extensionRoots = DEFAULT_EXTENSION_ROOTS, scope = "full" }) {
	const configChecks = scope === "install" ? [] : verifyVscodeignoreWhitelist(repoRoot)
	const vsix = scope === "install" ? [] : await auditVsixFiles(distDir)
	const extensions = discoverLumiExtensions(extensionRoots)

	const vsixChecks = vsix.flatMap((result) => result.checks)
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
		vsix,
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
