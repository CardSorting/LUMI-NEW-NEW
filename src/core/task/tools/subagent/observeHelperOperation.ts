import pTimeout from "p-timeout"
import { Logger } from "@/shared/services/Logger"

/** Optional helper observation gets one bounded opportunity; execution and handoffs never retry it. */
export async function observeHelperOperation<T>(
	label: string,
	operation: () => Promise<T>,
	milliseconds = 1000,
): Promise<T | undefined> {
	try {
		return await pTimeout(Promise.resolve().then(operation), { milliseconds })
	} catch (error) {
		Logger.warn(`[Subagent] ${label} unavailable; execution continues:`, error)
		return undefined
	}
}
