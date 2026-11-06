import type { ApiConfiguration } from "@shared/api"
import { describe, expect, it } from "vitest"
import { validateApiConfiguration } from "@/utils/validate"
import { normalizeApiConfiguration } from "../utils/providerUtils"

describe("API provider configuration", () => {
	it("defaults a missing provider to OpenRouter", () => {
		expect(normalizeApiConfiguration({}, "act").selectedProvider).toBe("openrouter")
	})

	it.each([
		["claude-code", "claude-subscription-directsdk-experimental"],
		["clinepass", "cline-pass"],
		["nous-research", "nousResearch"],
		["opencode-zen", "opencode"],
	])("recognizes the supported legacy alias %s", (saved, expected) => {
		const config = { planModeApiProvider: saved } as ApiConfiguration
		expect(normalizeApiConfiguration(config, "plan").selectedProvider).toBe(expected)
	})

	it("uses the provider for the requested mode", () => {
		const config = { planModeApiProvider: "cloudflare", actModeApiProvider: "openai-codex" } as ApiConfiguration
		expect(normalizeApiConfiguration(config, "plan").selectedProvider).toBe("cloudflare")
		expect(normalizeApiConfiguration(config, "act").selectedProvider).toBe("openai-codex")
	})

	it("rejects unavailable providers during configuration validation", () => {
		const config = { actModeApiProvider: "openai", openRouterApiKey: "other-provider-key" } as ApiConfiguration
		expect(validateApiConfiguration("act", config)).toContain('API provider "openai" is not supported')
	})
})
