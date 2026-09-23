import type { IController as Controller } from "@core/controller/types"
import { Empty, EmptyRequest } from "@shared/proto/dietcode/common"
import { ShowMessageType } from "@shared/proto/host/window"
import { HostProvider } from "@/hosts/host-provider"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { Logger } from "@/shared/services/Logger"
import { openExternal } from "@/utils/env"

/**
 * Initiates OpenAI Codex OAuth authentication flow
 * Opens the authorization URL in the user's browser
 */
export async function openAiCodexSignIn(controller: Controller, _: EmptyRequest): Promise<Empty> {
	try {
		// Start the authorization flow and get the auth URL
		const authUrl = await openAiCodexOAuthManager.startAuthorizationFlow()
		const callback = openAiCodexOAuthManager.waitForCallback()

		// Open the auth URL in the browser
		await openExternal(authUrl)
		await controller.postStateToWebview()

		// Keep the settings UI in sync when approval succeeds, fails, or is cancelled.
		void callback
			.then(
				async () => {
					HostProvider.window.showMessage({
						type: ShowMessageType.INFORMATION,
						message: "Successfully signed in to OpenAI Codex",
					})
				},
				async (error) => {
					Logger.error("[openAiCodexSignIn] OAuth callback failed:", error)
					openAiCodexOAuthManager.cancelAuthorizationFlow()
					// Don't show notifications when the user cancelled or abandoned sign-in.
					const errorMessage = error instanceof Error ? error.message : String(error)
					if (!/timed out|cancelled/i.test(errorMessage)) {
						HostProvider.window.showMessage({
							type: ShowMessageType.ERROR,
							message: "OpenAI Codex sign-in couldn’t be completed. Return to Settings and try again.",
						})
					}
				},
			)
			.finally(() => controller.postStateToWebview())
			.catch((error) => Logger.error("[openAiCodexSignIn] Failed to refresh sign-in state:", error))
	} catch (error) {
		Logger.error("[openAiCodexSignIn] Failed to start OAuth flow:", error)
		openAiCodexOAuthManager.cancelAuthorizationFlow()
		throw error
	}

	return {}
}
