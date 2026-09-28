import { strict as assert } from "node:assert"
import { type CompletionReview, formatLegacyCompletionGateNotice, parseCompletionReview } from "@shared/CompletionReview"
import { DietCodeMessage as ProtoMessage } from "@shared/proto/dietcode/ui"
import { describe, it } from "mocha"
import { convertDietCodeMessageToProto, convertProtoToDietCodeMessage } from "./dietcode-message"

const review: CompletionReview = {
	schemaVersion: 1,
	attempt: 2,
	priorBlocks: 0,
	checks: [
		{ id: "audit", status: "passed", detail: "Score 0/100 · required 0." },
		{ id: "review", status: "not_run", detail: "Not enabled." },
	],
}

describe("completion review transport", () => {
	it("preserves check outcomes through protobuf and persisted JSON", () => {
		const message = {
			ts: 42,
			type: "say" as const,
			say: "completion_result" as const,
			text: "Done.",
			completionReview: review,
		}
		const encoded = ProtoMessage.encode(convertDietCodeMessageToProto(message)).finish()
		assert.deepEqual(convertProtoToDietCodeMessage(ProtoMessage.decode(encoded)).completionReview, review)
		assert.deepEqual(parseCompletionReview(JSON.parse(JSON.stringify(message)).completionReview), review)
	})
	it("keeps older results without evidence instead of inventing passing checks", () => {
		assert.equal(convertProtoToDietCodeMessage(ProtoMessage.create({ text: "Done." })).completionReview, undefined)
	})
	for (const bad of [
		{ ...review, schemaVersion: 2 },
		{ ...review, attempt: -1 },
		{ ...review, checks: [{ id: "audit", status: "unknown", detail: "" }] },
		{ ...review, checks: [review.checks[0], review.checks[0]] },
	]) {
		it(`ignores an unsupported review: ${JSON.stringify(bad)}`, () => assert.equal(parseCompletionReview(bad), undefined))
	}
	it("renders the reported historical success envelope without stale failure details", () => {
		const text =
			'<completion_gate_envelope schema_version="1"><completion_gate_digest reason="focus_chain_incomplete" http_status="422" /><completion_gate_status passed="true" prior_blocks="1" score="91" /></completion_gate_envelope>'
		assert.equal(formatLegacyCompletionGateNotice(text), "Completion checks passed. Audit score: 91/100.")
		assert.equal(formatLegacyCompletionGateNotice(`Here is code: ${text}`), undefined)
		assert.equal(
			formatLegacyCompletionGateNotice(text.replace('passed="true"', 'passed="false"')),
			"Completion check details aren’t available for this older notice.",
		)
	})
})
