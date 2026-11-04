#!/usr/bin/env node
/**
 * Automated guardrail for agentswarm documentation and wiki tree integrity:
 * 1. Required core documentation files exist.
 * 2. Every relative markdown link resolves to a real target file.
 * 3. Every heading anchor link (#slug) matches a valid heading in the target document.
 * 4. All Architecture Decision Records (ADRs) are indexed in agentswarm/adr/README.md.
 * 5. All Post-Mortems (PMs) are indexed in agentswarm/postmortems/README.md.
 * 6. Root agentswarm/README.md correctly cites up-to-date ADR and PM ranges.
 */
import assert from "node:assert"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const swarmRoot = path.join(repoRoot, "agentswarm")

assert.ok(fs.existsSync(swarmRoot), "agentswarm directory not found")

const requiredDocs = [
	"README.md",
	"CHANGELOG.md",
	"glossary.md",
	"reincorporation.md",
	"agentswarm.md",
	"agentswarm2.md",
	"agentswarm3.md",
	"agentswarm4.md",
	"adr/README.md",
	"postmortems/README.md",
	"maintainers/README.md",
	"maintainers/01-system-from-scratch.md",
	"maintainers/02-codebase-tour.md",
	"maintainers/03-operating-handbook.md",
	"maintainers/04-failure-modes-and-drills.md",
	"onboarding/for-agents.md",
	"onboarding/for-human-developers.md",
	"onboarding/for-maintainers.md",
	"papers/01-philosophy.md",
	"papers/02-stakeholder-handoff.md",
	"papers/03-technical-whitepaper.md",
	"playbooks/README.md",
	"playbooks/PB-01-enable-or-disable-the-swarm.md",
	"playbooks/PB-02-add-a-setting-end-to-end.md",
	"playbooks/PB-03-add-a-legion-specialist.md",
	"playbooks/PB-04-diagnose-a-stuck-pipeline.md",
	"playbooks/PB-05-recover-a-failed-legion-formation.md",
	"playbooks/PB-06-triage-sqlite-flush-errors.md",
	"playbooks/PB-07-release-verification.md",
	"playbooks/PB-08-audit-after-interrupted-work.md",
	"implementation/file-map.md",
	"implementation/findings.md",
]

for (const rel of requiredDocs) {
	const full = path.join(swarmRoot, rel)
	assert.ok(fs.existsSync(full), `Required agentswarm doc missing: agentswarm/${rel}`)
}

function walkMarkdown(dir, out = []) {
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		if (ent.name === "node_modules" || ent.name.startsWith(".")) continue
		const full = path.join(dir, ent.name)
		if (ent.isDirectory()) {
			walkMarkdown(full, out)
		} else if (ent.name.endsWith(".md")) {
			out.push(full)
		}
	}
	return out
}

function extractHeadings(content) {
	const headings = []
	for (const line of content.split("\n")) {
		const m = line.match(/^#{1,6}\s+(.+)$/)
		if (m) headings.push(m[1].trim())
	}
	return headings
}

function gfmSlug(heading) {
	const clean = heading.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
	return clean
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/\s/g, "-")
}

function collapsedSlug(heading) {
	const clean = heading.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
	return clean
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/[-\s]+/g, "-")
}

const allMdFiles = walkMarkdown(swarmRoot)
const headingCache = new Map()

for (const file of allMdFiles) {
	const content = fs.readFileSync(file, "utf8")
	const slugs = new Set()
	for (const h of extractHeadings(content)) {
		slugs.add(gfmSlug(h))
		slugs.add(collapsedSlug(h))
	}
	headingCache.set(file, slugs)
}

const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g
const broken = []
let linkCount = 0

for (const file of allMdFiles) {
	const rel = path.relative(repoRoot, file)
	const content = fs.readFileSync(file, "utf8")
	let m
	while ((m = linkPattern.exec(content))) {
		const target = m[1].trim()
		if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:")) {
			continue
		}
		linkCount++
		const [filePart, anchorPart] = target.split("#")
		const resolvedTarget = filePart ? path.resolve(path.dirname(file), filePart) : file

		if (!fs.existsSync(resolvedTarget)) {
			broken.push(`${rel} → ${target} (file not found: ${path.relative(repoRoot, resolvedTarget)})`)
			continue
		}

		if (anchorPart) {
			const slugs = headingCache.get(resolvedTarget)
			const normalizedAnchor = anchorPart.toLowerCase().replace(/^#/, "")
			if (slugs && !slugs.has(normalizedAnchor)) {
				broken.push(
					`${rel} → ${target} (heading anchor #${normalizedAnchor} not found in ${path.relative(repoRoot, resolvedTarget)})`,
				)
			}
		}
	}
}

assert.strictEqual(broken.length, 0, `Broken agentswarm links or anchors detected:\n${broken.join("\n")}`)

// ADR Index Coverage Check
const adrFiles = fs
	.readdirSync(path.join(swarmRoot, "adr"))
	.filter((f) => /^ADR-\d{4}.*\.md$/.test(f))
	.sort()
const adrReadme = fs.readFileSync(path.join(swarmRoot, "adr/README.md"), "utf8")
for (const adr of adrFiles) {
	assert.ok(adrReadme.includes(adr), `ADR file ${adr} not indexed in agentswarm/adr/README.md`)
}

// PM Index Coverage Check
const pmFiles = fs
	.readdirSync(path.join(swarmRoot, "postmortems"))
	.filter((f) => /^PM-\d{3}.*\.md$/.test(f))
	.sort()
const pmReadme = fs.readFileSync(path.join(swarmRoot, "postmortems/README.md"), "utf8")
for (const pm of pmFiles) {
	assert.ok(pmReadme.includes(pm), `PM file ${pm} not indexed in agentswarm/postmortems/README.md`)
}

// Root agentswarm/README.md citations check
const rootReadme = fs.readFileSync(path.join(swarmRoot, "README.md"), "utf8")
assert.ok(rootReadme.includes("0001–0016"), "agentswarm/README.md must cite ADR range 0001–0016")
assert.ok(rootReadme.includes("PM-001–PM-017"), "agentswarm/README.md must cite PM range PM-001–PM-017")
assert.ok(rootReadme.includes("Phases 1–10"), "agentswarm/README.md must cite Phases 1–10")
assert.ok(rootReadme.includes("315 passing backend unit tests"), "agentswarm/README.md must cite 315 passing backend unit tests")

console.log(
	`docs:check-agentswarm OK — ${allMdFiles.length} files, ${linkCount} links verified, ${adrFiles.length} ADRs, ${pmFiles.length} PMs indexed`,
)
