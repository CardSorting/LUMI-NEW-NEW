import { createHash } from "node:crypto"
import type { TaskState } from "../../TaskState"

/** Unchanged command results and helper handoffs cannot repeatedly reopen completion retries. */
export function recordExecutionEvidence(state: TaskState, source: string, input: unknown, outcome: unknown): void {
	const key = createHash("sha256")
		.update(JSON.stringify([source, input]))
		.digest("hex")
	const digest = createHash("sha256")
		.update(JSON.stringify(outcome) ?? "undefined")
		.digest("hex")
	const evidence = state.executionEvidenceDigests
	if (evidence.get(key) !== digest) state.workspaceRevision++
	evidence.delete(key)
	evidence.set(key, digest)
	if (evidence.size > 128) evidence.delete(evidence.keys().next().value!)
}
