import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { assignFieldNumbers, parseProtoMessageFieldNumbers } from "./generate-state-proto.mjs"

test("preserves map and hyphenated secret wire tags when adding settings", () => {
	const source = `message Settings { map<string, string> open_ai_headers = 229; optional string api_key = 5; }
	message Secrets { optional string openai_codex_oauth_credentials = 95; }`
	assert.deepEqual(
		assignFieldNumbers(
			[{ name: "openAiHeaders" }, { name: "apiKey" }, { name: "newField" }],
			parseProtoMessageFieldNumbers(source, "Settings"),
		),
		{ openAiHeaders: 229, apiKey: 5, newField: 230 },
	)
	assert.deepEqual(
		assignFieldNumbers([{ name: "openai-codex-oauth-credentials" }], parseProtoMessageFieldNumbers(source, "Secrets")),
		{ "openai-codex-oauth-credentials": 95 },
	)
})

test("retains the published settings and authentication tags", () => {
	const source = readFileSync(new URL("../proto/dietcode/state.proto", import.meta.url), "utf8")
	assert.equal(parseProtoMessageFieldNumbers(source, "Settings").open_ai_headers, 229)
	assert.equal(parseProtoMessageFieldNumbers(source, "Secrets").openai_codex_oauth_credentials, 95)
})
