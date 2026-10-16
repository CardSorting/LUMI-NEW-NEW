import { ModelInfo, opencodeDefaultModelId, opencodeModels } from "@shared/api"
import { EmptyRequest, StringRequest } from "@shared/proto/dietcode/common"
import { Mode } from "@shared/storage/types"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AccountServiceClient } from "@/services/grpc-client"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import ReasoningEffortSelector from "../ReasoningEffortSelector"
import { normalizeApiConfiguration, supportsReasoningEffortForModelId } from "../utils/providerUtils"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

interface OpencodeProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

interface OpencodeStatus {
	ready: boolean
	loggedIn: boolean
	authInProgress?: boolean
	email?: string
	orgName?: string
	detail: string
	pendingUserCode?: string
	pendingVerificationUri?: string
	loginCommand?: string[]
}

interface DiscoveredModel {
	id: string
	label?: string
	note?: string
}

interface Organization {
	id: string
	name: string
	active: boolean
}

export const OpencodeProvider = ({ showModelOptions, isPopup, currentMode }: OpencodeProviderProps) => {
	const { apiConfiguration, opencodeIsAuthenticated, opencodeAuthInProgress, opencodeAuthInfo } = useExtensionState()
	const { handleModeFieldsChange } = useApiConfigurationHandlers()

	const [status, setStatus] = useState<OpencodeStatus | undefined>()
	const [models, setModels] = useState<Record<string, ModelInfo>>(opencodeModels)
	const [organizations, setOrganizations] = useState<Organization[]>([])
	const [isChecking, setIsChecking] = useState(false)
	const [isStartingSignIn, setIsStartingSignIn] = useState(false)
	const [isSigningOut, setIsSigningOut] = useState(false)
	const [isSwitchingOrg, setIsSwitchingOrg] = useState(false)
	const [isRefreshingModels, setIsRefreshingModels] = useState(false)
	const [errorMessage, setErrorMessage] = useState("")
	const [copiedCode, setCopiedCode] = useState(false)
	const [copiedCliCommand, setCopiedCliCommand] = useState(false)
	const [modelSource, setModelSource] = useState("OpenCode Console catalog loaded.")

	const checkInFlight = useRef(false)
	const previousAuthInProgress = useRef(false)

	const isCurrentlyAuthenticated = Boolean(opencodeIsAuthenticated || status?.loggedIn)
	const isCurrentlyAuthenticating = Boolean(
		isStartingSignIn || opencodeAuthInProgress || status?.authInProgress || opencodeAuthInfo?.userCode,
	)

	const displayUserCode = opencodeAuthInfo?.userCode || status?.pendingUserCode
	const displayVerificationUri = opencodeAuthInfo?.verificationUri || status?.pendingVerificationUri
	const displayOrgName = opencodeAuthInfo?.orgName || status?.orgName
	const displayEmail = opencodeAuthInfo?.email || status?.email

	const normalized = normalizeApiConfiguration(apiConfiguration, currentMode)
	const selectedModelId =
		(currentMode === "plan" ? apiConfiguration?.planModeOpencodeModelId : apiConfiguration?.actModeOpencodeModelId) ||
		normalized.selectedModelId ||
		opencodeDefaultModelId
	const selectedModelInfo =
		models[selectedModelId] ||
		opencodeModels[selectedModelId as keyof typeof opencodeModels] ||
		opencodeModels[opencodeDefaultModelId]
	const supportsReasoning = supportsReasoningEffortForModelId(selectedModelId)

	const fetchOrganizations = useCallback(async () => {
		try {
			const res = await AccountServiceClient.getOpencodeOrganizations(EmptyRequest.create({}))
			const orgs = JSON.parse(res.value) as Organization[]
			if (Array.isArray(orgs)) {
				setOrganizations(orgs)
			}
		} catch {
			// Non-critical, ignore
		}
	}, [])

	const checkStatus = useCallback(async () => {
		if (checkInFlight.current) return
		checkInFlight.current = true
		setIsChecking(true)
		setErrorMessage("")
		try {
			const response = await AccountServiceClient.getOpencodeStatus(EmptyRequest.create({}))
			const parsed = JSON.parse(response.value) as OpencodeStatus
			setStatus(parsed)
			if (parsed.loggedIn) {
				void fetchOrganizations()
			}
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Could not verify OpenCode connection status.")
		} finally {
			checkInFlight.current = false
			setIsChecking(false)
		}
	}, [fetchOrganizations])

	useEffect(() => {
		void checkStatus()
	}, [checkStatus])

	// Auto-polling while authentication is pending so the UI transitions instantly on approval
	useEffect(() => {
		if (!isCurrentlyAuthenticating) return
		const timer = setInterval(() => {
			void checkStatus()
		}, 2500)
		return () => clearInterval(timer)
	}, [isCurrentlyAuthenticating, checkStatus])

	// Detect transition from authenticating to authenticated
	useEffect(() => {
		if (isCurrentlyAuthenticated && previousAuthInProgress.current) {
			void checkStatus()
			void refreshModels()
		}
		previousAuthInProgress.current = isCurrentlyAuthenticating
	}, [isCurrentlyAuthenticated, isCurrentlyAuthenticating, checkStatus])

	const handleConnect = async () => {
		setIsStartingSignIn(true)
		setErrorMessage("")
		try {
			const res = await AccountServiceClient.opencodeSignIn(EmptyRequest.create({}))
			if (res.value) {
				const parsed = JSON.parse(res.value) as { userCode?: string; verificationUri?: string }
				if (parsed.userCode || parsed.verificationUri) {
					setStatus((prev) => ({
						ready: false,
						loggedIn: false,
						authInProgress: true,
						pendingUserCode: parsed.userCode,
						pendingVerificationUri: parsed.verificationUri,
						detail: "Waiting for approval in your browser.",
						loginCommand: prev?.loginCommand || ["opencode", "auth", "login", "opencode"],
					}))
				}
			}
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Could not start OpenCode authentication.")
		} finally {
			setIsStartingSignIn(false)
		}
	}

	const handleCancelSignIn = async () => {
		try {
			await AccountServiceClient.cancelOpencodeSignIn(EmptyRequest.create({}))
			setStatus((prev) => (prev ? { ...prev, authInProgress: false } : undefined))
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Failed to cancel sign-in.")
		}
	}

	const handleDisconnect = async () => {
		setIsSigningOut(true)
		setErrorMessage("")
		try {
			await AccountServiceClient.opencodeSignOut(EmptyRequest.create({}))
			setStatus({
				ready: false,
				loggedIn: false,
				authInProgress: false,
				detail: "Disconnected from OpenCode Console.",
				loginCommand: ["opencode", "auth", "login", "opencode"],
			})
			setOrganizations([])
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Could not disconnect OpenCode account.")
		} finally {
			setIsSigningOut(false)
		}
	}

	const handleSwitchOrg = async (orgId: string) => {
		if (!orgId) return
		setIsSwitchingOrg(true)
		setErrorMessage("")
		try {
			await AccountServiceClient.switchOpencodeOrganization(StringRequest.create({ value: orgId }))
			await checkStatus()
			await refreshModels()
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Could not switch organization.")
		} finally {
			setIsSwitchingOrg(false)
		}
	}

	const copyCode = async () => {
		if (!displayUserCode) return
		try {
			await navigator.clipboard.writeText(displayUserCode)
			setCopiedCode(true)
			window.setTimeout(() => setCopiedCode(false), 2200)
		} catch {
			setErrorMessage(`Please manually enter this code: ${displayUserCode}`)
		}
	}

	const copyCliCommand = async () => {
		try {
			await navigator.clipboard.writeText("opencode auth login opencode")
			setCopiedCliCommand(true)
			window.setTimeout(() => setCopiedCliCommand(false), 2200)
		} catch {
			setErrorMessage("Could not copy CLI command.")
		}
	}

	const refreshModels = useCallback(async () => {
		if (isRefreshingModels) return
		setIsRefreshingModels(true)
		setErrorMessage("")
		try {
			const response = await AccountServiceClient.refreshOpencodeModels(EmptyRequest.create({}))
			const discovered = JSON.parse(response.value) as DiscoveredModel[]
			if (!Array.isArray(discovered) || discovered.length === 0) {
				throw new Error("OpenCode did not return any model routes.")
			}
			const accountModels = Object.fromEntries(
				discovered.map((model) => [
					model.id,
					{
						...(opencodeModels[model.id as keyof typeof opencodeModels] || {
							maxTokens: 32_768,
							contextWindow: 128_000,
							supportsImages: true,
							supportsPromptCache: false,
							supportsReasoning: true,
							inputPrice: 0,
							outputPrice: 0,
						}),
						name: model.label || model.id,
						description: model.note || "Model route available to your OpenCode account.",
					},
				]),
			) as Record<string, ModelInfo>
			setModels(accountModels)
			setModelSource(`${discovered.length} route${discovered.length === 1 ? "" : "s"} loaded from OpenCode account.`)
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Could not refresh OpenCode routes.")
			setModelSource("Showing default OpenCode models.")
		} finally {
			setIsRefreshingModels(false)
		}
	}, [isRefreshingModels])

	const handleModelChange = useCallback(
		(event: { target: { value: string } }) => {
			const newModelId = event.target.value
			const newModelInfo = models[newModelId] || opencodeModels[newModelId as keyof typeof opencodeModels]
			void handleModeFieldsChange(
				{
					opencodeModelId: { plan: "planModeOpencodeModelId", act: "actModeOpencodeModelId" },
					opencodeModelInfo: { plan: "planModeOpencodeModelInfo", act: "actModeOpencodeModelInfo" },
				},
				{
					opencodeModelId: newModelId,
					opencodeModelInfo: newModelInfo,
				},
				currentMode,
			)
		},
		[currentMode, handleModeFieldsChange, models],
	)

	return (
		<div>
			<p style={{ color: "var(--vscode-descriptionForeground)", fontSize: 12, lineHeight: 1.5, marginTop: 0 }}>
				Connect your OpenCode Console account to access frontier models (Kimi K2.6, GLM-5.3, Qwen3.8 Max, MiniMax M3)
				directly with your subscription. No API keys or separate CLI installation required.
			</p>

			{/* Authentication Card */}
			<div
				style={{
					margin: "12px 0",
					padding: 14,
					border: "1px solid var(--vscode-widget-border)",
					borderRadius: 6,
					backgroundColor: "var(--vscode-editor-background)",
				}}>
				{/* 1. Connected State */}
				{isCurrentlyAuthenticated ? (
					<div>
						<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
							<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
								<span
									style={{
										display: "inline-block",
										width: 9,
										height: 9,
										borderRadius: "50%",
										backgroundColor: "var(--vscode-testing-iconPassed, #4caf50)",
										boxShadow: "0 0 6px rgba(76, 175, 80, 0.4)",
									}}
								/>
								<strong style={{ fontSize: 13 }}>OpenCode Console Connected</strong>
							</div>
							<VSCodeButton appearance="secondary" disabled={isSigningOut} onClick={() => void handleDisconnect()}>
								{isSigningOut ? "Disconnecting…" : "Disconnect"}
							</VSCodeButton>
						</div>

						{/* Organization and Account Details */}
						<div style={{ marginBottom: 12 }}>
							<p style={{ color: "var(--vscode-descriptionForeground)", fontSize: 12, margin: "2px 0 6px" }}>
								{displayEmail && (
									<span>
										Account: <strong>{displayEmail}</strong>
									</span>
								)}
								{displayOrgName && (
									<span>
										{" "}
										· Org: <strong>{displayOrgName}</strong>
									</span>
								)}
							</p>

							{/* Organization Switcher (if user has access to multiple orgs) */}
							{organizations.length > 1 && (
								<div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
									<label
										htmlFor="opencode-org-select"
										style={{ fontSize: 12, color: "var(--vscode-descriptionForeground)" }}>
										Active Workspace:
									</label>
									<select
										disabled={isSwitchingOrg}
										id="opencode-org-select"
										onChange={(e) => void handleSwitchOrg(e.target.value)}
										style={{
											background: "var(--vscode-dropdown-background)",
											color: "var(--vscode-dropdown-foreground)",
											border: "1px solid var(--vscode-dropdown-border)",
											borderRadius: 3,
											padding: "3px 6px",
											fontSize: 12,
										}}
										value={organizations.find((o) => o.active)?.id || ""}>
										{organizations.map((org) => (
											<option key={org.id} value={org.id}>
												{org.name} {org.active ? "(active)" : ""}
											</option>
										))}
									</select>
								</div>
							)}
						</div>

						<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
							<VSCodeButton
								appearance="secondary"
								disabled={isRefreshingModels}
								onClick={() => void refreshModels()}>
								{isRefreshingModels ? "Refreshing routes…" : "Refresh routes"}
							</VSCodeButton>
							<VSCodeButton appearance="secondary" disabled={isChecking} onClick={() => void checkStatus()}>
								{isChecking ? "Checking…" : "Verify status"}
							</VSCodeButton>
						</div>
					</div>
				) : isCurrentlyAuthenticating ? (
					/* 2. Authorization In-Progress State */
					<div>
						<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
							<span
								style={{
									display: "inline-block",
									width: 9,
									height: 9,
									borderRadius: "50%",
									backgroundColor: "var(--vscode-progressBar-background, #007acc)",
									boxShadow: "0 0 6px rgba(0, 122, 204, 0.5)",
								}}
							/>
							<strong style={{ fontSize: 13 }}>Approve Connection in Browser</strong>
						</div>

						<p style={{ color: "var(--vscode-descriptionForeground)", fontSize: 12, margin: "4px 0 10px" }}>
							Confirm the code shown below in OpenCode Console. LUMI automatically detects approval and links your
							session.
						</p>

						{displayUserCode && (
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: 12,
									margin: "12px 0",
									padding: "10px 16px",
									background: "var(--vscode-editorWidget-background, rgba(0,0,0,0.15))",
									borderRadius: 6,
									border: "1px dashed var(--vscode-focusBorder, #007acc)",
									width: "fit-content",
								}}>
								<span
									style={{
										fontFamily: "var(--vscode-editor-font-family, monospace)",
										fontSize: 20,
										fontWeight: 700,
										letterSpacing: 3,
										color: "var(--vscode-editor-foreground)",
									}}>
									{displayUserCode}
								</span>
								<VSCodeButton appearance="secondary" onClick={() => void copyCode()}>
									{copiedCode ? "Copied!" : "Copy code"}
								</VSCodeButton>
							</div>
						)}

						<div style={{ display: "flex", gap: 8, marginTop: 12 }}>
							{displayVerificationUri && (
								<VSCodeButton
									appearance="primary"
									onClick={() => {
										if (displayVerificationUri) {
											window.open(displayVerificationUri, "_blank")
										}
									}}>
									Open in browser again
								</VSCodeButton>
							)}
							<VSCodeButton appearance="secondary" onClick={() => void handleCancelSignIn()}>
								Cancel
							</VSCodeButton>
						</div>
					</div>
				) : (
					/* 3. Disconnected / Connect State */
					<div>
						<strong style={{ fontSize: 13, display: "block", marginBottom: 4 }}>Connect OpenCode Console</strong>
						<p style={{ color: "var(--vscode-descriptionForeground)", fontSize: 12, margin: "4px 0 12px" }}>
							Authenticate with OpenCode Console to stream completions through your account subscription. No API
							keys or manual tokens required.
						</p>

						<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
							<VSCodeButton appearance="primary" disabled={isStartingSignIn} onClick={() => void handleConnect()}>
								{isStartingSignIn ? "Opening browser…" : "Connect OpenCode Console"}
							</VSCodeButton>
							<VSCodeButton appearance="secondary" disabled={isChecking} onClick={() => void checkStatus()}>
								{isChecking ? "Checking…" : "Check existing session"}
							</VSCodeButton>
						</div>
					</div>
				)}
			</div>

			{/* Model Options */}
			{showModelOptions && (
				<>
					<ModelSelector
						label="OpenCode model route"
						models={models}
						onChange={handleModelChange}
						selectedModelId={selectedModelId}
					/>
					{supportsReasoning && <ReasoningEffortSelector currentMode={currentMode} />}
					<p style={{ color: "var(--vscode-descriptionForeground)", fontSize: 12, marginTop: 4 }}>{modelSource}</p>
					<ModelInfoView isPopup={isPopup} modelInfo={selectedModelInfo} selectedModelId={selectedModelId} />
				</>
			)}

			{/* Advanced Options Accordion */}
			<details style={{ marginTop: 14 }}>
				<summary style={{ cursor: "pointer", fontSize: 12, color: "var(--vscode-descriptionForeground)" }}>
					Advanced & CLI Interoperability
				</summary>
				<div
					style={{
						marginTop: 8,
						padding: 10,
						border: "1px solid var(--vscode-widget-border)",
						borderRadius: 4,
						fontSize: 12,
						lineHeight: 1.5,
					}}>
					<p style={{ margin: "0 0 6px" }}>
						<strong>Seamless Synchronization:</strong> When you connect in LUMI, credentials are securely stored in
						LUMI's keychain and synced with the local OpenCode database (
						<code>~/.local/share/opencode/opencode.db</code>) when available.
					</p>
					<div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
						<VSCodeButton appearance="secondary" onClick={() => void copyCliCommand()}>
							{copiedCliCommand ? "Command copied!" : "Copy terminal login command"}
						</VSCodeButton>
					</div>
				</div>
			</details>

			{/* Error Message */}
			{errorMessage && (
				<p role="alert" style={{ color: "var(--vscode-errorForeground)", fontSize: 12, marginTop: 10 }}>
					{errorMessage}
				</p>
			)}
		</div>
	)
}
