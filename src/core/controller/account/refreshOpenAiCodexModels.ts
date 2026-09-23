import type { IController as Controller } from "@core/controller/types"
import { String } from "@shared/proto/dietcode/common"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"

export async function refreshOpenAiCodexModels(_controller: Controller): Promise<String> {
	const models = await openAiCodexOAuthManager.listModels(true)
	return { value: JSON.stringify(models) }
}
