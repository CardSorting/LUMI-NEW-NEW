import { SystemPromptSection } from "../../templates/placeholders"
import { TemplateEngine } from "../../templates/TemplateEngine"
import type { PromptVariant, SystemPromptContext } from "../../types"
import { getToolUseExamplesSection } from "./examples"
import { getToolUseFormattingSection } from "./formatting"
import { getToolUseGuidelinesSection } from "./guidelines"
import { getToolUseToolsSection } from "./tools"

export async function getToolUseSection(variant: PromptVariant, context: SystemPromptContext): Promise<string> {
	const template = variant.componentOverrides?.[SystemPromptSection.TOOL_USE]?.template || TOOL_USE_TEMPLATE_TEXT

	const templateEngine = new TemplateEngine()
	return templateEngine.resolve(template, context, {
		TOOL_USE_FORMATTING_SECTION: await getToolUseFormattingSection(variant, context),
		TOOLS_SECTION: await getToolUseToolsSection(variant, context),
		TOOL_USE_EXAMPLES_SECTION: await getToolUseExamplesSection(variant, context),
		TOOL_USE_GUIDELINES_SECTION: await getToolUseGuidelinesSection(variant, context),
		CWD: context.cwd,
	})
}

const TOOL_USE_TEMPLATE_TEXT = (context: SystemPromptContext) => `TOOL USE

Tools follow the user's configured approval policy. ${context.enableParallelToolCalling ? "You may request multiple independent tool calls in one response. Inspect every result before dependent work." : "Use one tool per response and inspect its result before the next call."} Tool results arrive automatically; they do not require an additional user message confirming success.

{{TOOL_USE_FORMATTING_SECTION}}

{{TOOLS_SECTION}}

{{TOOL_USE_EXAMPLES_SECTION}}

{{TOOL_USE_GUIDELINES_SECTION}}`
