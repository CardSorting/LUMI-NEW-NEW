import { buildAgentOperatorHints, roadmapToolCommandToSlash } from "./RoadmapOperator"

export interface RoadmapErrorEnvelope {
	roadmap_mode: "advisory"
	completion_ready: true
	required_action: null
	agent_next_call: ""
	ok: false
	success: false
	string_code: string
	error: string
	message: string
	human_message?: string
	action?: string
	workspace?: string
	safe_to_retry: boolean
	retry_condition: string
	retry_command: string
	diagnostic_command: string
	operator_action: string
	suggested_slash_command: string
	_roadmap_error_envelope?: boolean
	_roadmap_operator_hints: Record<string, unknown>
}

const RECOVERY_BY_CODE: Record<string, string> = {
	roadmap_disabled: "Enable lumi.roadmap.enabled in VS Code settings",
	workspace_unresolved: "Open a workspace folder before using roadmap steering",
	roadmap_missing: "roadmap(action='checkpoint') to bootstrap ROADMAP.md",
	schema_invalid: "Edit the reported schema issues; unchanged validation cannot repair them",
	checkpoint_stale: "roadmap(action='checkpoint', context='stale refresh')",
	gate_closed: "Roadmap gates are retired; continue the assigned task",
	validation_pending: "roadmap(action='validate') — ROADMAP.md mutated since last validate",
	unknown_action: "roadmap(action='guide') for phase and next call",
	unknown_roadmap_action: "Use a documented roadmap action; do not repeat the unrecognized action",
}

function recoveryForCode(code: string, action: string): string {
	return RECOVERY_BY_CODE[code] || `roadmap(action='${action || "guide"}')`
}

function diagnosticForCode(code: string): string {
	if (code === "checkpoint_stale") return "/roadmap explain-stale"
	if (["gate_closed", "schema_invalid", "validation_pending"].includes(code)) {
		return "/roadmap explain-gate"
	}
	return "/roadmap doctor"
}

export function errorEnvelope(params: {
	code: string
	message: string
	action?: string
	workspace?: string
	safeToRetry?: boolean
	retryCommand?: string
	detail?: string
	phase?: string
}): RoadmapErrorEnvelope {
	const action = params.action || "guide"
	const retry =
		params.retryCommand ||
		(action === "validate"
			? "roadmap(action='validate')"
			: action === "checkpoint"
				? "roadmap(action='checkpoint')"
				: recoveryForCode(params.code, action))

	const operatorAction = recoveryForCode(params.code, action)
	const diagnostic = diagnosticForCode(params.code)
	const slash = roadmapToolCommandToSlash(retry)

	const hints = buildAgentOperatorHints({
		action,
		workspace: params.workspace,
		last_error: {
			message: params.message,
			operator_action: operatorAction,
			retry_command: retry,
			safe_to_retry: params.safeToRetry ?? false,
		},
	})

	return {
		roadmap_mode: "advisory",
		completion_ready: true,
		required_action: null,
		agent_next_call: "",
		ok: false,
		success: false,
		string_code: params.code,
		error: params.message,
		message: params.message,
		human_message: params.message,
		action,
		workspace: params.workspace,
		safe_to_retry: params.safeToRetry ?? false,
		retry_condition: "Retry only after resolving the reported cause or observing a new content revision.",
		retry_command: retry,
		diagnostic_command: diagnostic,
		operator_action: operatorAction,
		suggested_slash_command: slash.startsWith("/roadmap") ? slash : "/roadmap cockpit",
		_roadmap_error_envelope: true,
		_roadmap_operator_hints: {
			...hints,
			suggested_slash_command: slash.startsWith("/roadmap") ? slash : "/roadmap cockpit",
			recovery_suggestion: params.message,
			next_action: "",
		},
	}
}

export function gateClosedEnvelope(message: string, action = "explain_gate"): RoadmapErrorEnvelope {
	return errorEnvelope({
		code: "gate_closed",
		message,
		action,
		phase: "gate.blocked",
	})
}

export function validationPendingEnvelope(workspace = ""): RoadmapErrorEnvelope {
	return {
		...errorEnvelope({
			code: "validation_pending",
			message: "ROADMAP.md changed — document diagnostics are out of date (advisory)",
			action: "validate",
			workspace,
		}),
		diagnostic_command: "/roadmap explain-gate",
		retry_command: "roadmap(action='validate')",
		suggested_slash_command: "/roadmap validate",
	}
}

export function fromException(error: unknown, action = ""): RoadmapErrorEnvelope {
	const message = error instanceof Error ? error.message : String(error)
	return errorEnvelope({
		code: "roadmap_failed",
		message,
		action: action || "guide",
		detail: error instanceof Error ? error.name : undefined,
	})
}
