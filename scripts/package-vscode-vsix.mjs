#!/usr/bin/env node
/**
 * Package VS Code Marketplace VSIX as CardSorting.lumi-vscode.
 *
 * Rebuilds better-sqlite3 for Electron and verifies the native binary is
 * included before the VSIX is considered valid.
 *
 * Usage:
 *   npm run package:vsix
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { assertVsixHasNativeModule, rebuildBetterSqlite3 } from "./vsix-native-deps.mjs"
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
		skipNativeRebuild: process.argv.includes("--skip-native-rebuild"),
	}
}

function main() {
	const { target, preRelease, skipPrepublish, skipNativeRebuild } = readPackageOptions()
	const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
	const targetSuffix = target ? `-${target}` : ""
	const outPath = path.join(repoRoot, "dist", `lumi-vscode-${pkg.version}${targetSuffix}.vsix`)

	fs.mkdirSync(path.dirname(outPath), { recursive: true })

	try {
		if (!skipNativeRebuild) rebuildBetterSqlite3(repoRoot)
		const args = ["package", "--allow-package-secrets", "sendgrid"]
		if (target) args.push("--target", target)
		if (preRelease) args.push("--pre-release")
		args.push("--out", outPath)
		runVsce({ repoRoot, args, skipPrepublish })
		assertVsixHasNativeModule(outPath)
		console.log(`[vscode] packaged ${outPath}`)
	} catch (error) {
		process.exitCode = 1
		if (error instanceof Error) {
			console.error(`[vscode] ${error.message}`)
		}
	}
}

main()
