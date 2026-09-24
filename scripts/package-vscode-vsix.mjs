#!/usr/bin/env node
/**
 * Package VS Code Marketplace VSIX as CardSorting.lumi-vscode.
 *
 * Verifies the ABI-stable better-sqlite3 prebuilds are present before the
 * VSIX is considered valid.
 *
 * Usage:
 *   npm run package:vsix
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { assertNativeModuleArchitecture, assertVsixHasNativeModule, createTargetVscodeIgnoreFile } from "./vsix-native-deps.mjs"
import { runVsce } from "./vsix-package-utils.mjs"

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const packageJsonPath = path.join(repoRoot, "package.json")
const VALID_TARGETS = new Set(["linux-x64", "win32-x64", "darwin-x64", "darwin-arm64"])

function readPackageOptions() {
	const targetIndex = process.argv.indexOf("--target")
	const target = targetIndex === -1 ? undefined : process.argv[targetIndex + 1]
	if (targetIndex !== -1 && (!target || !VALID_TARGETS.has(target))) {
		throw new Error(`Unsupported VSIX target: ${target || "(missing)"}`)
	}
	return {
		target,
		preRelease: process.argv.includes("--pre-release"),
		skipPrepublish: process.argv.includes("--skip-prepublish"),
	}
}

async function main() {
	const { target, preRelease, skipPrepublish } = readPackageOptions()
	const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
	const targetSuffix = target ? `-${target}` : ""
	const outPath = path.join(repoRoot, "dist", `lumi-vscode-${pkg.version}${targetSuffix}.vsix`)

	fs.mkdirSync(path.dirname(outPath), { recursive: true })
	let ignoreFilePath

	try {
		const nativeTarget = target ?? `${process.platform}-${process.arch}`
		assertNativeModuleArchitecture(repoRoot, nativeTarget)
		ignoreFilePath = createTargetVscodeIgnoreFile(repoRoot, nativeTarget)
		const args = ["package", "--allow-package-secrets", "sendgrid"]
		if (target) args.push("--target", target)
		if (preRelease) args.push("--pre-release")
		args.push("--ignoreFile", ignoreFilePath)
		args.push("--out", outPath)
		runVsce({ repoRoot, args, skipPrepublish })
		await assertVsixHasNativeModule(outPath)
		console.log(`[vscode] packaged ${outPath}`)
	} catch (error) {
		process.exitCode = 1
		if (error instanceof Error) {
			console.error(`[vscode] ${error.message}`)
		}
	} finally {
		if (ignoreFilePath) fs.rmSync(path.dirname(ignoreFilePath), { recursive: true, force: true })
	}
}

main().catch((error) => {
	console.error(`[vscode] ${error instanceof Error ? error.message : String(error)}`)
	process.exitCode = 1
})
