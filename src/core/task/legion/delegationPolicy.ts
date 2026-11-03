/** Explicit delegation prohibitions in the user's initial objective. */
export function explicitlyProhibitsDelegation(objective: string): boolean {
	return /\b(?:do\s+not|don't|never|without|avoid|no)\b[^.!?\n]{0,45}\b(?:delegat\w*|sub[ -]?agents?|agents?|specialists?|a\s+team|teams?)\b/i.test(
		objective,
	)
}
