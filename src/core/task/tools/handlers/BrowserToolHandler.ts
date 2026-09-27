import { BrowserAction, BrowserActionResult, browserActions, DietCodeSayBrowserAction } from "@shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { DietCodeDefaultTool } from "@/shared/tools"
import { ToolUse } from "../../../assistant-message"
import { formatResponse } from "../../../prompts/responses"
import { isToolAutoApproved } from "../autoApprove"
import type { TaskConfig } from "../types/TaskConfig"
import type { IFullyManagedTool, ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { ToolResultUtils } from "../utils/ToolResultUtils"

export class BrowserToolHandler implements IFullyManagedTool {
	readonly name = DietCodeDefaultTool.BROWSER

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.action}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const action: BrowserAction | undefined = block.params.action as BrowserAction
		const url: string | undefined = block.params.url
		const coordinate: string | undefined = block.params.coordinate
		const text: string | undefined = block.params.text

		// Validate action parameter
		if (!action || !browserActions.includes(action)) {
			return // Wait for more content
		}

		// Handle partial block streaming - exact original logic
		if (action === "launch") {
			if (isToolAutoApproved(uiHelpers.shouldAutoApproveTool(block.name))) {
				await uiHelpers.removeLastPartialMessageIfExistsWithType("ask", "browser_action_launch")
				await uiHelpers.say(
					"browser_action_launch",
					uiHelpers.removeClosingTag(block, "url", url),
					undefined,
					undefined,
					block.partial,
				)
			} else {
				await uiHelpers.removeLastPartialMessageIfExistsWithType("say", "browser_action_launch")
				await uiHelpers
					.ask("browser_action_launch", uiHelpers.removeClosingTag(block, "url", url), block.partial)
					.catch(() => {})
			}
		} else {
			await uiHelpers.say(
				this.name,
				JSON.stringify({
					action: action as BrowserAction,
					url: uiHelpers.removeClosingTag(block, "url", url),
					coordinate: uiHelpers.removeClosingTag(block, "coordinate", coordinate),
					text: uiHelpers.removeClosingTag(block, "text", text),
				} satisfies DietCodeSayBrowserAction),
				undefined,
				undefined,
				block.partial,
			)
		}
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const action = block.params.action as BrowserAction | undefined
		const { url, coordinate, text } = block.params
		const signal = config.taskState.abortSignal
		if (signal.aborted) return formatResponse.toolError("Browser action cancelled.")

		const missing =
			!action || !browserActions.includes(action)
				? "action"
				: (action === "launch" || action === "navigate") && !url
					? "url"
					: action === "click" && !coordinate
						? "coordinate"
						: action === "type" && text === undefined
							? "text"
							: undefined
		if (missing) {
			config.taskState.consecutiveMistakeCount++
			return config.callbacks.sayAndCreateMissingParamError(this.name, missing)
		}
		if (
			action === "click" &&
			(!/^\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?$/.test(coordinate!) ||
				!coordinate!.split(",").every((part) => Number.isFinite(Number(part))))
		) {
			return formatResponse.toolError(
				"Use finite, non-negative x,y coordinates from the latest screenshot. The browser remains open.",
			)
		}
		config.taskState.consecutiveMistakeCount = 0

		// Presentation must not turn a completed browser interaction into a failed tool and trigger replay.
		const say: TaskConfig["callbacks"]["say"] = async (...args) => {
			try {
				return await config.callbacks.say(...args)
			} catch (error) {
				Logger.warn("[BrowserToolHandler] Browser display unavailable; result retained:", error)
				return undefined
			}
		}

		try {
			if (action === "launch") {
				if (isToolAutoApproved(config.callbacks.shouldAutoApproveTool(block.name))) {
					await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "browser_action_launch")
					await say("browser_action_launch", url, undefined, undefined, false)
				} else {
					await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "browser_action_launch")
					const approved = await ToolResultUtils.askApprovalAndPushFeedback(
						"browser_action_launch",
						url!,
						config,
						`DietCode wants to use a browser and launch ${url}`,
					)
					if (!approved) return formatResponse.toolDenied()
				}
			}

			try {
				const { ToolHookUtils } = await import("../utils/ToolHookUtils")
				await ToolHookUtils.runPreToolUseIfEnabled(config, block)
			} catch (error) {
				const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
				if (error instanceof PreToolUseHookCancellationError) return formatResponse.toolDenied()
				throw error
			}
			signal.throwIfAborted()

			let result: BrowserActionResult
			if (action === "launch") {
				await say("browser_action_result", "")
				config.services.browserSession = await config.callbacks.applyLatestBrowserSettings()
				signal.throwIfAborted()
				await config.services.browserSession.launchBrowser()
				// Stop may have happened while the browser process was being created.
				signal.throwIfAborted()
				result = await config.services.browserSession.navigateToUrl(url!)
			} else {
				await say(
					this.name,
					JSON.stringify({ action: action!, url, coordinate, text } satisfies DietCodeSayBrowserAction),
					undefined,
					undefined,
					false,
				)
				signal.throwIfAborted()
				const session = config.services.browserSession
				switch (action) {
					case "navigate":
						result = await session.navigateToUrl(url!)
						break
					case "refresh":
						result = await session.refresh()
						break
					case "inspect":
						result = await session.inspect()
						break
					case "click":
						result = await session.click(coordinate!)
						break
					case "type":
						result = await session.type(text!)
						break
					case "scroll_down":
						result = await session.scrollDown()
						break
					case "scroll_up":
						result = await session.scrollUp()
						break
					case "close":
						await session.closeBrowser()
						return formatResponse.toolResult("The browser has been closed.")
					default:
						return formatResponse.toolError("Unknown browser action.")
				}
			}
			signal.throwIfAborted()
			await say("browser_action_result", JSON.stringify(result))
			if (result.error) {
				return formatResponse.toolError(
					`Browser action failed: ${result.error}\nCurrent URL: ${result.currentUrl || "unknown"}\n${result.logs || ""}\nUse inspect to check the current page before retrying an interaction. The session is retained.`,
				)
			}
			return formatResponse.toolResult(
				`Browser action completed. Current URL: ${result.currentUrl || "unknown"}\n\nConsole logs:\n${result.logs || "(No new logs)"}\n\nThe browser stays open while you use other tools. Use inspect to observe the current page, refresh after edits, navigate for another URL, or close when finished.`,
				result.screenshot ? [result.screenshot] : [],
			)
		} catch (error) {
			if (signal.aborted) {
				await config.services.browserSession.closeBrowser()
				return formatResponse.toolError("Browser action cancelled.")
			}
			return formatResponse.toolError(
				`Browser action failed: ${error instanceof Error ? error.message : String(error)}. Use inspect to check an existing session before retrying.`,
			)
		}
	}
}
