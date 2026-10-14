export const COMPLETION_GATE_SCORE_THRESHOLD = 50

/** Hard stop after this many consecutive completion-gate blocks (prevents unbounded retry loops). */
export const MAX_COMPLETION_GATE_BLOCK_COUNT = 10

/** Warn the agent when approaching the completion gate circuit breaker. */
export const COMPLETION_GATE_WARN_THRESHOLD = 5

/** Default consecutive mistake limit — mirrors state-keys default for breather hints. */
export const DEFAULT_MAX_CONSECUTIVE_MISTAKES = 3

/** Minimum delay between completion retries after a gate block (prevents hammering). */
export const COMPLETION_RETRY_COOLDOWN_MS = 2000

/** Cap for exponential completion retry backoff (mirrors AWS/Azure retry policies). */
export const COMPLETION_RETRY_MAX_COOLDOWN_MS = 30_000

/** Remaining attempts at which gate errors escalate to critical urgency (PagerDuty-style). */
export const COMPLETION_GATE_ESCALATION_REMAINING = 3

/** Schema version for machine-parseable completion_gate_* XML blocks. */
export const COMPLETION_GATE_STATUS_SCHEMA_VERSION = 1

/** Max gate block events retained in task-state history (ring buffer). */
export const COMPLETION_GATE_BLOCK_HISTORY_MAX = 5
