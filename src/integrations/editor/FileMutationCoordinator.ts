import * as fs from "node:fs/promises"
import * as path from "node:path"
import pTimeout from "p-timeout"

/** Serialize the compare-and-write step across helpers in this extension host. */
const pending = new Map<string, Promise<void>>()

export async function withFileMutation<T>(canonicalPath: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted()
	const previous = pending.get(canonicalPath) ?? Promise.resolve()
	let release!: () => void
	const slot = new Promise<void>((resolve) => {
		release = resolve
	})
	// Cancelling a queued writer releases only its slot. Later writers must still
	// wait for every earlier owner, including one whose caller has stopped waiting.
	const current = previous.then(() => slot)
	pending.set(canonicalPath, current)
	void current.then(() => {
		if (pending.get(canonicalPath) === current) pending.delete(canonicalPath)
	})
	try {
		await (signal ? pTimeout(previous, { milliseconds: Number.POSITIVE_INFINITY, signal }) : previous)
		signal?.throwIfAborted()
		return await operation()
	} finally {
		release()
	}
}

/** Resolve existing ancestors as well as symlinks when the final file does not exist yet. */
export async function canonicalFilePath(target: string): Promise<string> {
	try {
		return await fs.realpath(target)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(target) === target) throw error
		return path.join(await canonicalFilePath(path.dirname(target)), path.basename(target))
	}
}
