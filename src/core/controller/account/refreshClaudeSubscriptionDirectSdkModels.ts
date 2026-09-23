import type { IController as Controller } from "@core/controller/types"
import { String, StringRequest } from "@shared/proto/dietcode/common"
import { discoverClaudeSubscriptionDirectSdkModels } from "@/integrations/claude-subscription-directsdk/provider"
import { readClaudeSubscriptionDirectSdkOptions } from "./claudeSubscriptionDirectSdk"

export async function refreshClaudeSubscriptionDirectSdkModels(_controller: Controller, request: StringRequest): Promise<String> {
	const models = await discoverClaudeSubscriptionDirectSdkModels(readClaudeSubscriptionDirectSdkOptions(request))
	return { value: JSON.stringify(models) }
}
