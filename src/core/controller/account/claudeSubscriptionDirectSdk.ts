import { StringRequest } from "@shared/proto/dietcode/common"
import type { ClaudeSubscriptionDirectSdkOptions } from "@/integrations/claude-subscription-directsdk/provider"

export function readClaudeSubscriptionDirectSdkOptions(request: StringRequest): ClaudeSubscriptionDirectSdkOptions {
	if (!request.value) return {}
	let value: unknown
	try {
		value = JSON.parse(request.value)
	} catch {
		throw new Error("Claude provider settings must be valid JSON")
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Claude provider settings must be a JSON object")
	}
	const settings = value as Record<string, unknown>
	const option = (key: string): string | undefined => {
		const candidate = settings[key]
		return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined
	}
	return {
		pythonPath: option("claudeSubscriptionDirectSdkPythonPath"),
		command: option("claudeSubscriptionDirectSdkCommand"),
	}
}
