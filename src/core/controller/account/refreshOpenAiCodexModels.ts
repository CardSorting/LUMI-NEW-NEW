import type { IController as Controller } from "@core/controller/types"
import { String } from "@shared/proto/dietcode/common"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"

export async function refreshOpenAiCodexModels(controller: Controller): Promise<String> {
	try {
		const models = await openAiCodexOAuthManager.listModels(true)
		return { value: JSON.stringify(models) }
	} finally {
		// Refresh can invalidate revoked credentials. Publish that state even when
		// the catalog request fails so Settings cannot keep showing "Connected".
		await controller.postStateToWebview()
	}
}
