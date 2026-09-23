import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

/** Invoke VSCE while optionally reusing assets produced by a prior build step. */
export function runVsce({ repoRoot, args, skipPrepublish = false }) {
	const packageJsonPath = path.join(repoRoot, "package.json")
	if (!skipPrepublish) {
		execFileSync(process.execPath, [path.join(repoRoot, "node_modules", "@vscode", "vsce", "vsce"), ...args], {
			stdio: "inherit",
			cwd: repoRoot,
		})
		return
	}
	for (const asset of [path.join(repoRoot, "dist", "extension.js"), path.join(repoRoot, "webview-ui", "build", "index.html")]) {
		if (!fs.existsSync(asset)) {
			throw new Error(`Cannot skip vscode:prepublish; expected built asset is missing: ${path.relative(repoRoot, asset)}`)
		}
	}

	const originalPackageJson = fs.readFileSync(packageJsonPath, "utf8")
	try {
		const manifest = JSON.parse(originalPackageJson)
		if (manifest.scripts?.["vscode:prepublish"]) {
			delete manifest.scripts["vscode:prepublish"]
			fs.writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, "\t")}\n`)
		}
		execFileSync(process.execPath, [path.join(repoRoot, "node_modules", "@vscode", "vsce", "vsce"), ...args], {
			stdio: "inherit",
			cwd: repoRoot,
		})
	} finally {
		fs.writeFileSync(packageJsonPath, originalPackageJson)
	}
}
