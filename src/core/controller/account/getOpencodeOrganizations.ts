import type { IController as Controller } from "@core/controller/types"
import { EmptyRequest, String as ProtoString } from "@shared/proto/dietcode/common"
import { opencodeOAuthManager } from "@/integrations/opencode/oauth"
import { Logger } from "@/shared/services/Logger"

export async function getOpencodeOrganizations(_controller: Controller, _request: EmptyRequest): Promise<ProtoString> {
	try {
		const orgs = await opencodeOAuthManager.getOrganizations()
		return { value: JSON.stringify(orgs) }
	} catch (error) {
		Logger.error("[getOpencodeOrganizations] Error:", error)
		return { value: JSON.stringify([]) }
	}
}
