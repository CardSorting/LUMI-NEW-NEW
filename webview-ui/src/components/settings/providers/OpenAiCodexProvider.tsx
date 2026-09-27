import { type ModelInfo } from "@shared/api"
import { Mode } from "@shared/storage/types"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AccountServiceClient } from "@/services/grpc-client"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import ReasoningEffortSelector from "../ReasoningEffortSelector"
import { normalizeApiConfiguration } from "../utils/providerUtils"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

interface OpenAiCodexProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

/**
 * OpenAI Codex (ChatGPT Plus/Pro) provider configuration component.
 * Uses OAuth authentication instead of API keys.
 */
export const OpenAiCodexProvider = ({ showModelOptions, isPopup, currentMode }: OpenAiCodexProviderProps) => {
	const { apiConfiguration, openAiCodexAuthInProgress, openAiCodexIsAuthenticated } = useExtensionState()
	const { handleModeFieldChange } = useApiConfigurationHandlers()
	const [models, setModels] = useState<Record<string, ModelInfo>>({})
	const [isRefreshingModels, setIsRefreshingModels] = useState(false)
	const [isStartingSignIn, setIsStartingSignIn] = useState(false)
	const [isSigningOut, setIsSigningOut] = useState(false)
	const [errorMessage, setErrorMessage] = useState("")
	const wasAuthInProgress = useRef(false)
	const repairedSelection = useRef("")
	const modelCatalogRequest = useRef(0)
	const modelCatalogInFlight = useRef(false)
	const signOutInFlight = useRef(false)
	const isSigningIn = isStartingSignIn || Boolean(openAiCodexAuthInProgress)

	const normalized = normalizeApiConfiguration(apiConfiguration, currentMode)
	const configuredModelId = currentMode === "plan" ? apiConfiguration?.planModeApiModelId : apiConfiguration?.actModeApiModelId
	const firstAvailableModelId = Object.keys(models)[0]
	const selectedModelId =
		configuredModelId && models[configuredModelId]
			? configuredModelId
			: firstAvailableModelId || configuredModelId || normalized.selectedModelId
	const selectedModelInfo = models[selectedModelId] || normalized.selectedModelInfo
	const showReasoningEffort = Boolean(models[selectedModelId]?.supportsReasoning)

	const refreshModels = useCallback(async () => {
		if (!openAiCodexIsAuthenticated || modelCatalogInFlight.current || signOutInFlight.current) return
		const requestId = ++modelCatalogRequest.current
		modelCatalogInFlight.current = true
		setIsRefreshingModels(true)
		setErrorMessage("")
		try {
			const response = await AccountServiceClient.refreshOpenAiCodexModels({})
			const catalog = JSON.parse(response.value) as Record<string, ModelInfo>
			if (!catalog || typeof catalog !== "object" || Array.isArray(catalog) || Object.keys(catalog).length === 0) {
				throw new Error("The Codex account did not return any available models.")
			}
			if (requestId === modelCatalogRequest.current) setModels(catalog)
		} catch (error) {
			if (requestId === modelCatalogRequest.current) {
				setModels({})
				setErrorMessage(error instanceof Error ? error.message : "Could not refresh the Codex model list.")
			}
		} finally {
			if (requestId === modelCatalogRequest.current) {
				modelCatalogInFlight.current = false
				setIsRefreshingModels(false)
			}
		}
	}, [openAiCodexIsAuthenticated])

	// Refresh only when account authentication changes; refresh state changes must not retrigger the request.
	useEffect(() => {
		modelCatalogInFlight.current = false
		setIsRefreshingModels(false)
		setErrorMessage("")
		if (openAiCodexIsAuthenticated) void refreshModels()
		else setModels({})
		return () => {
			// A previous account's response must not populate a new session or an
			// unmounted provider (including React StrictMode effect replay).
			modelCatalogRequest.current += 1
			modelCatalogInFlight.current = false
		}
	}, [openAiCodexIsAuthenticated, refreshModels])

	useEffect(() => {
		if (!openAiCodexIsAuthenticated || !configuredModelId || !firstAvailableModelId || models[configuredModelId]) return
		const repairKey = `${currentMode}:${configuredModelId}->${firstAvailableModelId}`
		if (repairedSelection.current === repairKey) return
		repairedSelection.current = repairKey
		const requestId = modelCatalogRequest.current
		void handleModeFieldChange({ plan: "planModeApiModelId", act: "actModeApiModelId" }, firstAvailableModelId, currentMode)
			.then(() => {
				if (requestId !== modelCatalogRequest.current) return
				setErrorMessage(
					`The saved model “${configuredModelId}” is no longer available. Switched to “${firstAvailableModelId}”.`,
				)
			})
			.catch(() => {
				if (requestId !== modelCatalogRequest.current) return
				setErrorMessage("The saved Codex model is no longer available. Choose a model from the current account list.")
			})
	}, [openAiCodexIsAuthenticated, configuredModelId, firstAvailableModelId, models, currentMode, handleModeFieldChange])

	useEffect(() => {
		if (openAiCodexIsAuthenticated) {
			setIsStartingSignIn(false)
			setErrorMessage("")
		} else if (wasAuthInProgress.current && !openAiCodexAuthInProgress) {
			setErrorMessage("Sign-in ended before the account was connected. Try again when you’re ready.")
		}
		wasAuthInProgress.current = Boolean(openAiCodexAuthInProgress)
	}, [openAiCodexAuthInProgress, openAiCodexIsAuthenticated])

	const handleSignIn = async () => {
		setIsStartingSignIn(true)
		setErrorMessage("")
		try {
			await AccountServiceClient.openAiCodexSignIn({})
			setIsStartingSignIn(false)
		} catch (error) {
			setIsStartingSignIn(false)
			setErrorMessage(error instanceof Error ? error.message : "Could not start OpenAI Codex sign-in.")
		}
	}

	const handleSignOut = async () => {
		if (signOutInFlight.current) return
		signOutInFlight.current = true
		modelCatalogRequest.current += 1
		modelCatalogInFlight.current = false
		setIsRefreshingModels(false)
		setModels({})
		setIsSigningOut(true)
		setErrorMessage("")
		try {
			await AccountServiceClient.openAiCodexSignOut({})
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Could not sign out of OpenAI Codex.")
		} finally {
			signOutInFlight.current = false
			setIsSigningOut(false)
		}
	}

	return (
		<div>
			<div style={{ marginBottom: "15px" }}>
				{openAiCodexIsAuthenticated ? (
					<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
						<span style={{ color: "var(--vscode-descriptionForeground)" }}>Connected to your ChatGPT account</span>
						<VSCodeButton appearance="secondary" disabled={isSigningOut} onClick={handleSignOut}>
							{isSigningOut ? "Signing out…" : "Sign out"}
						</VSCodeButton>
					</div>
				) : (
					<div>
						<p
							style={{
								fontSize: "12px",
								color: "var(--vscode-descriptionForeground)",
								marginBottom: "10px",
							}}>
							Connect the ChatGPT account that includes Codex access. Requests use that account’s subscription.
							Approval opens in your browser; return here when it’s done.
						</p>
						<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
							<VSCodeButton onClick={handleSignIn}>
								{isSigningIn ? "Restart sign-in" : "Connect ChatGPT"}
							</VSCodeButton>
							{isSigningIn && (
								<output style={{ color: "var(--vscode-descriptionForeground)", fontSize: 12 }}>
									Waiting for browser approval…
								</output>
							)}
						</div>
						{isSigningIn && (
							<p style={{ color: "var(--vscode-descriptionForeground)", fontSize: 12, marginTop: 8 }}>
								Keep this window open while you approve access. If the browser didn’t open, try again.
							</p>
						)}
					</div>
				)}
			</div>

			{showModelOptions && (
				<>
					{openAiCodexIsAuthenticated && Object.keys(models).length > 0 ? (
						<ModelSelector
							label="Model"
							models={models}
							onChange={(e: any) =>
								handleModeFieldChange(
									{ plan: "planModeApiModelId", act: "actModeApiModelId" },
									e.target.value,
									currentMode,
								)
							}
							selectedModelId={selectedModelId}
						/>
					) : (
						<output style={{ color: "var(--vscode-descriptionForeground)", fontSize: 12 }}>
							{!openAiCodexIsAuthenticated
								? "Connect your ChatGPT account to load its available Codex models."
								: isRefreshingModels
									? "Loading models from your Codex account…"
									: "No Codex models are loaded. Refresh the account model list to try again."}
						</output>
					)}
					{openAiCodexIsAuthenticated && (
						<VSCodeButton
							appearance="secondary"
							disabled={isRefreshingModels || isSigningOut}
							onClick={() => void refreshModels()}>
							{isRefreshingModels ? "Refreshing models…" : "Refresh account models"}
						</VSCodeButton>
					)}
					<p style={{ color: "var(--vscode-descriptionForeground)", fontSize: 12, marginTop: 5 }}>
						The model list comes from your signed-in Codex account. Refresh it after account or access changes.
					</p>
					{openAiCodexIsAuthenticated && models[selectedModelId] && showReasoningEffort && (
						<ReasoningEffortSelector currentMode={currentMode} />
					)}

					{openAiCodexIsAuthenticated && models[selectedModelId] && (
						<ModelInfoView isPopup={isPopup} modelInfo={selectedModelInfo} selectedModelId={selectedModelId} />
					)}
				</>
			)}
			{errorMessage && (
				<p role="alert" style={{ color: "var(--vscode-errorForeground)", fontSize: 12 }}>
					{errorMessage}
				</p>
			)}
		</div>
	)
}
