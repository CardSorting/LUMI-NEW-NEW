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
	let callback: ReturnType<typeof openAiCodexOAuthManager.waitForCallback> | undefined
	try {
		// Start the authorization flow and get the auth URL
		const authUrl = await openAiCodexOAuthManager.startAuthorizationFlow()
		callback = openAiCodexOAuthManager.waitForCallback()

		// Keep the settings UI in sync when approval succeeds, fails, or is cancelled.
		void callback
			.then(
				async () => {
					void HostProvider.window
						.showMessage({
							type: ShowMessageType.INFORMATION,
							message: "Successfully signed in to OpenAI Codex",
						})
						.catch((error) => Logger.error("[openAiCodexSignIn] Failed to show sign-in notification:", error))
				},
				async (error) => {
					Logger.error("[openAiCodexSignIn] OAuth callback failed:", error)
					// The manager has already finished this attempt. Cancelling here
					// would also cancel a replacement started by "Restart sign-in".
					// Don't show notifications when the user cancelled or abandoned sign-in.
					const errorMessage = error instanceof Error ? error.message : String(error)
					if (!/timed out|cancelled/i.test(errorMessage)) {
						void HostProvider.window
							.showMessage({
								type: ShowMessageType.ERROR,
								message: "OpenAI Codex sign-in couldn’t be completed. Return to Settings and try again.",
							})
							.catch((error) => Logger.error("[openAiCodexSignIn] Failed to show sign-in notification:", error))
					}
				},
			)
			.finally(() => controller.postStateToWebview())
			.catch((error) => Logger.error("[openAiCodexSignIn] Failed to refresh sign-in state:", error))

		// Observe completion before opening the browser; an immediate callback or
		// a restarted attempt must not leave its rejection unhandled.
		await openExternal(authUrl)
		await controller.postStateToWebview()
	} catch (error) {
		Logger.error("[openAiCodexSignIn] Failed to start OAuth flow:", error)
		if (callback) openAiCodexOAuthManager.cancelAuthorizationFlow(callback)
		await controller
			.postStateToWebview()
			.catch((stateError) => Logger.error("[openAiCodexSignIn] Failed to refresh sign-in state:", stateError))
		throw error
	}

	return {}
}
