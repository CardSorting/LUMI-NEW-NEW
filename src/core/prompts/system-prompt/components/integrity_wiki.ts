import { TemplateEngine } from "../templates/TemplateEngine"
import type { PromptVariant, SystemPromptContext } from "../types"

const getIntegrityWikiTemplateText = () => `## Documentation handoff

Follow the existing workspace documentation conventions. Update affected documentation only when your assignment changes documented behavior or explicitly requires documentation.

For research-only work, return findings with file references and limitations. Do not create a wiki, require a structural audit, or expand the assignment to satisfy a generic completion checklist.

Ground claims in inspected files and observed results. If a documentation check reveals a code defect within scope, repair it and rerun the affected check; there is no phase that forbids needed repairs. Report unresolved issues to the parent.`

export async function getIntegrityWikiSection(_variant: PromptVariant, context: SystemPromptContext): Promise<string> {
	if (!context.isSubagentRun) {
		return ""
	}
	const template = getIntegrityWikiTemplateText()
	return new TemplateEngine().resolve(template, context, {})
}
