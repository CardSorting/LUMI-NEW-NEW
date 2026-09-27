import { SystemPromptSection } from "../templates/placeholders"
import { TemplateEngine } from "../templates/TemplateEngine"
import type { PromptVariant, SystemPromptContext } from "../types"
import { HEAV3NS_MANDATE } from "./heav3ns_mandate"

const AGENT_ROLE = [
	"You are DietCode,",
	"a highly skilled software engineer",
	"with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.",
]

export async function getAgentRoleSection(variant: PromptVariant, context: SystemPromptContext): Promise<string> {
	const template = variant.componentOverrides?.[SystemPromptSection.AGENT_ROLE]?.template || AGENT_ROLE.join(" ")

	const role = new TemplateEngine().resolve(template, context, {})
	return `${role}\n\n${HEAV3NS_MANDATE}`
}
