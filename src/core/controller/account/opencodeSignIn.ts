import type { IController as Controller } from "@core/controller/types"
import { EmptyRequest, String as ProtoString } from "@shared/proto/dietcode/common"
import { ShowMessageType } from "@shared/proto/host/window"
import { HostProvider } from "@/hosts/host-provider"
import { opencodeOAuthManager } from "@/integrations/opencode/oauth"
import { Logger } from "@/shared/services/Logger"
import { openExternal } from "@/utils/env"

export async function opencodeSignIn(controller: Controller, _: EmptyRequest): Promise<ProtoString> {
	try {
		const auth = await opencodeOAuthManager.startAuthorizationFlow()
		const callback = opencodeOAuthManager.waitForAuthorization()

		void callback
			.then(
				async (cred) => {
					const orgName = cred.metadata?.orgName || cred.metadata?.orgID
					const label = orgName ? `OpenCode Console (${orgName})` : "OpenCode Console"
					void HostProvider.window
						.showMessage({
							type: ShowMessageType.INFORMATION,
							message: `Successfully connected to ${label}`,
						})
						.catch((err) => Logger.error("[opencodeSignIn] Failed to show notification:", err))
				},
				async (error) => {
					Logger.error("[opencodeSignIn] Authorization callback failed:", error)
					const msg = error instanceof Error ? error.message : String(error)
					if (!/cancelled|abort/i.test(msg)) {
						void HostProvider.window
							.showMessage({
								type: ShowMessageType.ERROR,
								message: "OpenCode Console authorization could not be completed. Please try again.",
							})
							.catch((err) => Logger.error("[opencodeSignIn] Failed to show error notification:", err))
					}
				},
			)
			.finally(() => controller.postStateToWebview())
			.catch((err) => Logger.error("[opencodeSignIn] Failed to refresh webview state:", err))

		// Open verification URL in browser
		if (auth.verificationUri) {
			await openExternal(auth.verificationUri)
		}

		await controller.postStateToWebview()
		return { value: JSON.stringify(auth) }
	} catch (error) {
		Logger.error("[opencodeSignIn] Failed to start device authorization:", error)
		await controller.postStateToWebview().catch(() => {})
		throw error
	}
}
