import type { IController as Controller } from "@core/controller/types"
import { Empty, StringRequest } from "@shared/proto/dietcode/common"
import { opencodeOAuthManager } from "@/integrations/opencode/oauth"
import { Logger } from "@/shared/services/Logger"

export async function switchOpencodeOrganization(controller: Controller, request: StringRequest): Promise<Empty> {
	try {
		const orgId = request.value
		if (!orgId) throw new Error("No organization ID specified")
		await opencodeOAuthManager.switchOrganization(orgId)
		await controller.postStateToWebview()
	} catch (error) {
		Logger.error("[switchOpencodeOrganization] Error:", error)
		throw error
	}
	return {}
}
