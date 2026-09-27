/** Checkpoint freshness reporting — mirrors dietcode freshness.format_explain_stale_report. */

export function formatExplainStaleReport(freshness: Record<string, unknown>, steeringBrief?: string | null): string {
	const lines = ["🗺️ Roadmap checkpoint freshness"]
	if (steeringBrief) {
		lines.push(`Project: ${steeringBrief}`)
	}
	lines.push(`Stale: ${freshness.stale}`)
	lines.push(`Reason: ${freshness.reason}`)
	if (freshness.summary) lines.push(String(freshness.summary))
	if (freshness.days_since_checkpoint != null) {
		lines.push(`Days since checkpoint: ${freshness.days_since_checkpoint}`)
	}
	lines.push(`Git commits since checkpoint: ${freshness.git_commits_since_checkpoint ?? "?"}`)
	if (freshness.git_commits_in_window != null) {
		lines.push(`Git commits in evidence window: ${freshness.git_commits_in_window}`)
	}
	lines.push(
		freshness.stale
			? `Optional: ${freshness.recommended_action || "Review checkpoint evidence during relevant roadmap work"}. Does not block completion.`
			: "No checkpoint refresh required by the observed activity.",
	)
	return lines.join("\n")
}
