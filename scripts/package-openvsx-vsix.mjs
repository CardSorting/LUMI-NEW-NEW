#!/usr/bin/env node
/**
 * Package Open VSX VSIX as CardSorting.lumi (legacy extension ID).
 *
 * Usage:
 *   npm run package:vsix:openvsx
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { assertNativeModuleArchitecture, assertVsixHasNativeModule, createTargetVscodeIgnoreFile } from "./vsix-native-deps.mjs"
import { runVsce } from "./vsix-package-utils.mjs"
import { createWorkspaceLinkManager } from "./workspace-link.mjs"

const OPENVSX_EXTENSION_NAME = "lumi"
const MARKETPLACE_EXTENSION_NAME = "lumi-vscode"

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const packageJsonPath = path.join(repoRoot, "package.json")
const nodeModulesPath = path.join(repoRoot, "node_modules")
const workspaceLinks = createWorkspaceLinkManager({ repoRoot, nodeModulesPath })
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

function restorePackageJson(original) {
	fs.writeFileSync(packageJsonPath, original)
	console.log("[openvsx] restored package.json")
}

async function main() {
	const { target, preRelease, skipPrepublish } = readPackageOptions()
	const originalPackageJson = fs.readFileSync(packageJsonPath, "utf8")
	const pkg = JSON.parse(originalPackageJson)
	const version = pkg.version
	const targetSuffix = target ? `-${target}` : ""
	const outPath = path.join(repoRoot, "dist", `lumi-${version}${targetSuffix}.vsix`)
	let didPatchName = false
	let didReconcileWorkspaceLink = false
	let ignoreFilePath

	fs.mkdirSync(path.dirname(outPath), { recursive: true })

	try {
		const nativeTarget = target ?? `${process.platform}-${process.arch}`
		assertNativeModuleArchitecture(repoRoot, nativeTarget)
		ignoreFilePath = createTargetVscodeIgnoreFile(repoRoot, nativeTarget)

		if (pkg.name !== OPENVSX_EXTENSION_NAME) {
			pkg.name = OPENVSX_EXTENSION_NAME
			fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, "\t")}\n`)
			didPatchName = true
			console.log(`[openvsx] patched name → "${OPENVSX_EXTENSION_NAME}" (CardSorting.${OPENVSX_EXTENSION_NAME})`)
		}

		didReconcileWorkspaceLink = workspaceLinks.reconcile({
			fromName: MARKETPLACE_EXTENSION_NAME,
			toName: OPENVSX_EXTENSION_NAME,
		})
		if (didReconcileWorkspaceLink) {
			console.log(`[openvsx] renamed workspace self-link: ${MARKETPLACE_EXTENSION_NAME} → ${OPENVSX_EXTENSION_NAME}`)
		}

		const args = ["package", "--allow-package-secrets", "sendgrid"]
		if (target) args.push("--target", target)
		if (preRelease) args.push("--pre-release")
		args.push("--ignoreFile", ignoreFilePath)
		args.push("--out", outPath)
		runVsce({ repoRoot, args, skipPrepublish })

		await assertVsixHasNativeModule(outPath)
		console.log(`[openvsx] packaged ${outPath}`)
	} catch (error) {
		process.exitCode = 1
		if (error instanceof Error) {
			console.error(`[openvsx] ${error.message}`)
		}
	} finally {
		if (ignoreFilePath) fs.rmSync(path.dirname(ignoreFilePath), { recursive: true, force: true })
		workspaceLinks.restore({
			fromName: MARKETPLACE_EXTENSION_NAME,
			toName: OPENVSX_EXTENSION_NAME,
			didReconcile: didReconcileWorkspaceLink,
		})
		if (didReconcileWorkspaceLink) {
			console.log(`[openvsx] restored workspace self-link: ${OPENVSX_EXTENSION_NAME} → ${MARKETPLACE_EXTENSION_NAME}`)
		}
		if (didPatchName) {
			restorePackageJson(originalPackageJson)
		}
	}
}

main().catch((error) => {
	console.error(`[openvsx] ${error instanceof Error ? error.message : String(error)}`)
	process.exitCode = 1
})
