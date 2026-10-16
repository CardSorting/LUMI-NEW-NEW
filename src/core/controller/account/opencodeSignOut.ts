import type { IController as Controller } from "@core/controller/types"
import { Empty, EmptyRequest } from "@shared/proto/dietcode/common"
import { opencodeOAuthManager } from "@/integrations/opencode/oauth"
import { Logger } from "@/shared/services/Logger"

export async function opencodeSignOut(controller: Controller, _: EmptyRequest): Promise<Empty> {
	try {
		await opencodeOAuthManager.clearCredentials()
		await controller.postStateToWebview()
	} catch (error) {
		Logger.error("[opencodeSignOut] Failed to sign out:", error)
		throw error
	}

	return {}
}
