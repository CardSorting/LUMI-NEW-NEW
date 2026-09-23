import type { IController as Controller } from "@core/controller/types"
import { String, StringRequest } from "@shared/proto/dietcode/common"
import { diagnoseClaudeSubscriptionDirectSdk } from "@/integrations/claude-subscription-directsdk/provider"
import { readClaudeSubscriptionDirectSdkOptions } from "./claudeSubscriptionDirectSdk"

export async function getClaudeSubscriptionDirectSdkStatus(_controller: Controller, request: StringRequest): Promise<String> {
	const status = await diagnoseClaudeSubscriptionDirectSdk(readClaudeSubscriptionDirectSdkOptions(request))
	return { value: JSON.stringify(status) }
}
