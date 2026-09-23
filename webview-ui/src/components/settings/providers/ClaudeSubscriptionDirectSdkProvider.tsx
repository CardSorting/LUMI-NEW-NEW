import { claudeSubscriptionDirectSdkDefaultModelId, claudeSubscriptionDirectSdkModels, type ModelInfo } from "@shared/api"
import { StringRequest } from "@shared/proto/dietcode/common"
import { Mode } from "@shared/storage/types"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AccountServiceClient } from "@/services/grpc-client"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import ReasoningEffortSelector from "../ReasoningEffortSelector"
import { normalizeApiConfiguration, supportsReasoningEffortForModelId } from "../utils/providerUtils"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

interface ClaudeSubscriptionDirectSdkProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

interface ClaudeBridgeStatus {
	ready: boolean
	available?: boolean
	loggedIn?: boolean
	plan?: string
	loginCommand?: string[]
	detail: string
}

interface DiscoveredModel {
	id: string
	label?: string
	note?: string
}

export const ClaudeSubscriptionDirectSdkProvider = ({
	showModelOptions,
	isPopup,
	currentMode,
}: ClaudeSubscriptionDirectSdkProviderProps) => {
	const { apiConfiguration } = useExtensionState()
	const { handleFieldChange, handleModeFieldChange } = useApiConfigurationHandlers()
	const [status, setStatus] = useState<ClaudeBridgeStatus | undefined>()
	const [models, setModels] = useState<Record<string, ModelInfo>>(claudeSubscriptionDirectSdkModels)
	const [isChecking, setIsChecking] = useState(false)
	const [isRefreshingModels, setIsRefreshingModels] = useState(false)
	const [errorMessage, setErrorMessage] = useState("")
	const [modelSource, setModelSource] = useState("Choose Refresh routes to load the models available to your Claude account.")
	const checkInFlight = useRef(false)
	const [copiedLoginCommand, setCopiedLoginCommand] = useState(false)
	const options = useMemo(
		() => ({
			claudeSubscriptionDirectSdkPythonPath: apiConfiguration?.claudeSubscriptionDirectSdkPythonPath,
			claudeSubscriptionDirectSdkCommand: apiConfiguration?.claudeSubscriptionDirectSdkCommand,
		}),
		[apiConfiguration?.claudeSubscriptionDirectSdkPythonPath, apiConfiguration?.claudeSubscriptionDirectSdkCommand],
	)
	const request = useMemo(() => StringRequest.create({ value: JSON.stringify(options) }), [options])
	const normalized = normalizeApiConfiguration(apiConfiguration, currentMode)
	const selectedModelId =
		(currentMode === "plan" ? apiConfiguration?.planModeApiModelId : apiConfiguration?.actModeApiModelId) ||
		normalized.selectedModelId ||
		claudeSubscriptionDirectSdkDefaultModelId
	const selectedModelInfo =
		models[selectedModelId] || claudeSubscriptionDirectSdkModels[claudeSubscriptionDirectSdkDefaultModelId]
	const supportsReasoning = supportsReasoningEffortForModelId(selectedModelId)

	const checkSetup = useCallback(async () => {
		if (checkInFlight.current) return
		checkInFlight.current = true
		setIsChecking(true)
		setErrorMessage("")
		try {
			const response = await AccountServiceClient.getClaudeSubscriptionDirectSdkStatus(request)
			setStatus(JSON.parse(response.value) as ClaudeBridgeStatus)
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Could not check the Claude subscription bridge.")
		} finally {
			checkInFlight.current = false
			setIsChecking(false)
		}
	}, [request])

	useEffect(() => {
		void checkSetup()
	}, [checkSetup])

	const copyLoginCommand = useCallback(async () => {
		const command = (status?.loginCommand?.length ? status.loginCommand : ["claude", "auth", "login"])
			.map((part) => `'${part.replaceAll("'", "'\\''")}'`)
			.join(" ")
		try {
			await navigator.clipboard.writeText(command)
			setCopiedLoginCommand(true)
			window.setTimeout(() => setCopiedLoginCommand(false), 2200)
		} catch {
			setErrorMessage("Could not copy the sign-in command. Open a terminal and run: claude auth login")
		}
	}, [status?.loginCommand])

	const refreshModels = useCallback(async () => {
		if (isRefreshingModels) return
		setIsRefreshingModels(true)
		setErrorMessage("")
		try {
			const response = await AccountServiceClient.refreshClaudeSubscriptionDirectSdkModels(request)
			const discovered = JSON.parse(response.value) as DiscoveredModel[]
			if (!Array.isArray(discovered) || discovered.length === 0) {
				throw new Error("Claude Code did not return any account model routes.")
			}
			const accountModels = Object.fromEntries(
				discovered.map((model) => [
					model.id,
					{
						...claudeSubscriptionDirectSdkModels[model.id],
						name: model.label || model.id,
						description: model.note || "Model route reported by your Claude Code account.",
						maxTokens: model.id.toLowerCase().includes("haiku") ? 64_000 : 128_000,
						contextWindow: model.id.includes("[1m]") ? 1_000_000 : 200_000,
						supportsImages: true,
						supportsPromptCache: false,
						inputPrice: 0,
						outputPrice: 0,
					},
				]),
			) as Record<string, ModelInfo>
			setModels(accountModels)
			setModelSource(`${discovered.length} route${discovered.length === 1 ? "" : "s"} loaded from your Claude account.`)
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Could not refresh Claude account routes.")
			setModelSource("Showing built-in fallback routes. Refresh when the bridge is ready.")
		} finally {
			setIsRefreshingModels(false)
		}
	}, [isRefreshingModels, request])

	return (
		<div>
			<p style={{ color: "var(--vscode-descriptionForeground)", fontSize: 12, lineHeight: 1.5, marginTop: 0 }}>
				Use your Claude Code sign-in with LUMI's bundled subscription transport. Your Claude account controls available
				routes and usage.
			</p>

			<output
				aria-live="polite"
				style={{
					display: "block",
					margin: "12px 0",
					padding: 12,
					border: "1px solid var(--vscode-widget-border)",
					borderRadius: 4,
				}}>
				<strong>
					{status
						? status.ready
							? "Claude account connected"
							: status.available === true
								? "Sign-in needed"
								: status.available === false
									? "Claude Code setup needed"
									: "Claude bridge unavailable"
						: isChecking
							? "Checking Claude Code…"
							: errorMessage
								? "Could not verify Claude Code"
								: "Claude Code setup not checked"}
				</strong>
				{status?.plan && <span> · {status.plan}</span>}
				<p style={{ color: "var(--vscode-descriptionForeground)", fontSize: 12, margin: "4px 0" }}>
					{status?.detail ||
						"LUMI checks Claude Code on this computer. Your credentials stay with Claude Code; LUMI does not ask you to paste a token."}
				</p>
				{status?.available === false && (
					<a href="https://code.claude.com/docs/en/getting-started" rel="noreferrer" target="_blank">
						Install Claude Code
					</a>
				)}
				{status?.available && !status.loggedIn && (
					<div style={{ marginTop: 8 }}>
						<strong style={{ fontSize: 12 }}>Sign in with your Claude account</strong>
						<p style={{ color: "var(--vscode-descriptionForeground)", fontSize: 12, margin: "4px 0 8px" }}>
							Run the command below in a terminal, finish the browser sign-in, then return here and check again.
						</p>
						<VSCodeButton appearance="primary" onClick={() => void copyLoginCommand()}>
							{copiedLoginCommand ? "Command copied" : "Copy sign-in command"}
						</VSCodeButton>
					</div>
				)}
			</output>

			<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
				<VSCodeButton appearance="secondary" disabled={isChecking} onClick={() => void checkSetup()}>
					{isChecking ? "Checking…" : status?.loggedIn ? "Check account" : "Check again"}
				</VSCodeButton>
				<VSCodeButton
					appearance="secondary"
					disabled={isRefreshingModels || !status?.ready}
					onClick={() => void refreshModels()}>
					{isRefreshingModels ? "Loading routes…" : "Refresh routes"}
				</VSCodeButton>
			</div>

			<details>
				<summary style={{ cursor: "pointer", marginBottom: 6 }}>Advanced runtime options</summary>
				<DebouncedTextField
					initialValue={apiConfiguration?.claudeSubscriptionDirectSdkPythonPath || ""}
					onChange={(value) => handleFieldChange("claudeSubscriptionDirectSdkPythonPath", value)}
					placeholder="python3"
					style={{ width: "100%", marginTop: 3 }}
					type="text">
					<span style={{ fontWeight: 500 }}>Python executable</span>
				</DebouncedTextField>
				<DebouncedTextField
					initialValue={apiConfiguration?.claudeSubscriptionDirectSdkCommand || ""}
					onChange={(value) => handleFieldChange("claudeSubscriptionDirectSdkCommand", value)}
					placeholder="claude"
					style={{ width: "100%", marginTop: 8 }}
					type="text">
					<span style={{ fontWeight: 500 }}>Claude Code command</span>
				</DebouncedTextField>
			</details>

			{showModelOptions && (
				<>
					<ModelSelector
						label="Claude account route"
						models={models}
						onChange={(event) =>
							handleModeFieldChange(
								{ plan: "planModeApiModelId", act: "actModeApiModelId" },
								event.target.value,
								currentMode,
							)
						}
						selectedModelId={selectedModelId}
					/>
					{supportsReasoning && <ReasoningEffortSelector currentMode={currentMode} />}
					<p style={{ color: "var(--vscode-descriptionForeground)", fontSize: 12, marginTop: 4 }}>{modelSource}</p>
					<ModelInfoView isPopup={isPopup} modelInfo={selectedModelInfo} selectedModelId={selectedModelId} />
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
