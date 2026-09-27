import * as assert from "assert"
import { bootstrapSkeleton, findBootstrapPlaceholders, getSectionBody, validateRoadmapContent } from "../RoadmapSchema"

describe("RoadmapSchema", () => {
	it("reads the final section through EOF, including literal Z and CRLF", () => {
		assert.strictEqual(getSectionBody("## Last\nZone Z remains", "Last"), "Zone Z remains")
		assert.strictEqual(getSectionBody("## Last\r\nZone Z remains\r\n", "Last"), "Zone Z remains\r\n")
		assert.strictEqual(getSectionBody("## First\nA\n## Last\nB", "First"), "A\n")
	})

	it("keeps missing non-goals advisory and accepts familiar labels", () => {
		const skeleton = bootstrapSkeleton({})
		const without = skeleton.replace(/\*\*What This Project Must Not Become:\*\*[\s\S]*?(?=## 2\.)/, "")
		const result = validateRoadmapContent(without)
		assert.strictEqual(result.valid, true)
		assert.strictEqual(result.issues.find((issue) => issue.code === "missing_anti_goals")?.severity, "warning")
		for (const label of ["Non-goals", "Anti-goals", "Out of scope"]) {
			const validation = validateRoadmapContent(skeleton.replace("What This Project Must Not Become", label))
			assert.strictEqual(validation.valid, true)
			assert.ok(!validation.issues.some((issue) => issue.code === "missing_anti_goals"))
		}
	})

	describe("validateRoadmapContent", () => {
		it("should return invalid for empty content", () => {
			const res = validateRoadmapContent("")
			assert.strictEqual(res.valid, false)
			assert.strictEqual(res.issues.length, 1)
			assert.strictEqual(res.issues[0].code, "missing_file")
		})

		it("should identify missing sections", () => {
			const content = "## 1. Project Center of Gravity\n"
			const res = validateRoadmapContent(content)
			assert.strictEqual(res.valid, false)
			assert.strictEqual(res.schema_complete, false)
			const missingIssues = res.issues.filter((i) => i.code === "missing_section")
			assert.ok(missingIssues.length > 0)
		})

		it("should validate a complete template generated via bootstrapSkeleton", () => {
			const skeleton = bootstrapSkeleton({
				project_hint: "Test project",
				anti_goals: "What This Project Must Not Become: a mess.",
			})
			const res = validateRoadmapContent(skeleton)
			// It may have warnings due to placeholder phrases, but should parse health and risk
			assert.strictEqual(res.schema_complete, true)
			assert.strictEqual(res.health_status, "Coherent")
			assert.strictEqual(res.code_soup_risk, "Low")
		})
	})

	describe("findBootstrapPlaceholders", () => {
		it("should find placeholder phrases", () => {
			const text = "Some text with 'Describe from README and project evidence' placeholder."
			const issues = findBootstrapPlaceholders(text)
			assert.ok(issues.length > 0)
			assert.strictEqual(issues[0].code, "bootstrap_placeholder")
		})
	})
})
