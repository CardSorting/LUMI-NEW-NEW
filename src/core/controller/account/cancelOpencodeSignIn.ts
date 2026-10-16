import type { IController as Controller } from "@core/controller/types"
import { Empty, EmptyRequest } from "@shared/proto/dietcode/common"
import { opencodeOAuthManager } from "@/integrations/opencode/oauth"

export async function cancelOpencodeSignIn(controller: Controller, _: EmptyRequest): Promise<Empty> {
	opencodeOAuthManager.cancelAuthorizationFlow()
	await controller.postStateToWebview().catch(() => {})
	return {}
}
