import type { IController as Controller } from "@core/controller/types"
import { EmptyRequest, String as ProtoString } from "@shared/proto/dietcode/common"
import { opencodeOAuthManager } from "@/integrations/opencode/oauth"

export async function getOpencodeStatus(_controller: Controller, _request: EmptyRequest): Promise<ProtoString> {
	const status = await opencodeOAuthManager.getStatus()
	return { value: JSON.stringify(status) }
}
