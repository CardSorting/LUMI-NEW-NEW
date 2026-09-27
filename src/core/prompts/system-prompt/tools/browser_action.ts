import { ModelFamily } from "@/shared/prompts"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { DietCodeToolSpec } from "../spec"

const id = DietCodeDefaultTool.BROWSER

const GENERIC: DietCodeToolSpec = {
	variant: ModelFamily.GENERIC,
	id,
	name: "browser_action",
	description: `Request to interact with a Puppeteer-controlled browser. Every action, except \`close\`, will be responded to with a screenshot of the browser's current state, along with any new console logs. You may only perform one browser action per message, and inspect the tool result including its screenshot and logs to determine the next action.
- Launch once to start a session. The browser remains open while you read or edit files and run commands. Use navigate for a new URL, refresh after edits, and inspect to capture the current page without changing it. Close when finished; task completion and Stop also clean up the session.
- After an uncertain action or missing screenshot, inspect before retrying. Do not repeat clicks or typing just to obtain another screenshot.
- The browser window has a resolution of **{{BROWSER_VIEWPORT_WIDTH}}x{{BROWSER_VIEWPORT_HEIGHT}}** pixels. When performing any click actions, ensure the coordinates are within this resolution range.
- Before clicking on any elements such as icons, links, or buttons, you must consult the provided screenshot of the page to determine the coordinates of the element. The click should be targeted at the **center of the element**, not on its edges.`,
	contextRequirements: (context) => context.supportsBrowserUse === true,
	parameters: [
		{
			name: "action",
			required: true,
			instruction: `The action to perform. The available actions are:
	* launch: Launch a new Puppeteer-controlled browser instance at the specified URL. This **must always be the first action**.
		- Use with the \`url\` parameter to provide the URL.
		- Ensure the URL is valid and includes the appropriate protocol (e.g. http://localhost:3000/page, file:///path/to/file.html, etc.)
	* navigate: Navigate the existing browser to the specified url, preserving the session.
	* refresh: Reload the current page after edits.
	* inspect: Capture the current page and logs without changing it.
	* click: Click at a specific x,y coordinate.
		- Use with the \`coordinate\` parameter to specify the location.
		- Always click in the center of an element (icon, button, link, etc.) based on coordinates derived from a screenshot.
	* type: Type a string of text on the keyboard. You might use this after clicking on a text field to input text.
		- Use with the \`text\` parameter to provide the string to type.
	* scroll_down: Scroll down the page by one page height.
	* scroll_up: Scroll up the page by one page height.
	* close: Close the Puppeteer-controlled browser instance. Use when you no longer need the session.
	    - Example: \`<action>close</action>\``,
			usage: "Action to perform (e.g., launch, navigate, refresh, inspect, click, type, scroll_down, scroll_up, close)",
		},
		{
			name: "url",
			required: false,
			instruction: `Use this for providing the URL for the \`launch\` or \`navigate\` action.
	* Example: <url>https://example.com</url>`,
			usage: "URL to launch or navigate to (optional)",
		},
		{
			name: "coordinate",
			required: false,
			instruction: `The X and Y coordinates for the \`click\` action. Coordinates should be within the **{{BROWSER_VIEWPORT_WIDTH}}x{{BROWSER_VIEWPORT_HEIGHT}}** resolution.
	* Example: <coordinate>450,300</coordinate>`,
			usage: "x,y coordinates (optional)",
		},
		{
			name: "text",
			required: false,
			instruction: `Use this for providing the text for the \`type\` action.
	* Example: <text>Hello, world!</text>`,
			usage: "Text to type (optional)",
		},
	],
}

const NATIVE_NEXT_GEN: DietCodeToolSpec = {
	variant: ModelFamily.NATIVE_NEXT_GEN,
	id,
	name: "browser_action",
	description: `Request to interact with a Puppeteer-controlled browser. Every action, except \`close\`, will be responded to with a screenshot of the browser's current state, along with any new console logs. You may only perform one browser action per message, and inspect the tool result including its screenshot and logs to determine the next action.
- Launch once to start a session. The browser remains open while you read or edit files and run commands. Use navigate for a new URL, refresh after edits, and inspect to capture the current page without changing it. Close when finished; task completion and Stop also clean up the session.
- After an uncertain action or missing screenshot, inspect before retrying. Do not repeat clicks or typing just to obtain another screenshot.
- The browser window has a resolution of **{{BROWSER_VIEWPORT_WIDTH}}x{{BROWSER_VIEWPORT_HEIGHT}}** pixels. When performing any click actions, ensure the coordinates are within this resolution range.
- Before clicking on any elements such as icons, links, or buttons, you must consult the provided screenshot of the page to determine the coordinates of the element. The click should be targeted at the **center of the element**, not on its edges.`,
	contextRequirements: (context) => context.supportsBrowserUse === true,
	parameters: [
		{
			name: "action",
			required: true,
			instruction: `The action to perform. The available actions are:
	* launch: Launch a new Puppeteer-controlled browser instance at the specified URL. This **must always be the first action**.
		- Use with the \`url\` parameter to provide the URL.
		- Ensure the URL is valid and includes the appropriate protocol (e.g. http://localhost:3000/page, file:///path/to/file.html, etc.)
	* navigate: Navigate the existing browser to the specified url, preserving the session.
	* refresh: Reload the current page after edits.
	* inspect: Capture the current page and logs without changing it.
	* click: Click at a specific x,y coordinate.
		- Use with the \`coordinate\` parameter to specify the location.
		- Always click in the center of an element (icon, button, link, etc.) based on coordinates derived from a screenshot.
	* type: Type a string of text on the keyboard. You might use this after clicking on a text field to input text.
		- Use with the \`text\` parameter to provide the string to type.
	* scroll_down: Scroll down the page by one page height.
	* scroll_up: Scroll up the page by one page height.
	* close: Close the Puppeteer-controlled browser instance. Use when you no longer need the session.
	    - Example: 'close'`,
		},
		{
			name: "url",
			required: false,
			instruction: `Use this for providing the URL for the \`launch\` or \`navigate\` action.`,
		},
		{
			name: "coordinate",
			required: false,
			instruction: `x,y coordinates - The X and Y coordinates for the \`click\` action. Coordinates should be within the **{{BROWSER_VIEWPORT_WIDTH}}x{{BROWSER_VIEWPORT_HEIGHT}}** resolution. Example: '450,300'`,
		},
		{
			name: "text",
			required: false,
			instruction: `Use this for providing the text for the \`type\` action. Example: 'Hello, world!'`,
		},
	],
}

export const browser_action_variants = [GENERIC, NATIVE_NEXT_GEN]
