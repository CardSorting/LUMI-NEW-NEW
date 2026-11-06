import { DietCodeMessage } from "./ExtensionMessage"

interface ApiMetrics {
	totalTokensIn: number
	totalTokensOut: number
	totalCacheWrites?: number
	totalCacheReads?: number
	totalCost: number
}

/** Budget decisions must not silently ignore malformed or negative recorded usage. */
export function hasValidApiUsage(messages: DietCodeMessage[]): boolean {
	const fields = ["tokensIn", "tokensOut", "cacheWrites", "cacheReads", "cost"] as const
	const validFields = (value: Record<string, unknown>) =>
		fields.every((field) => {
			const amount = value[field]
			return amount == null || (typeof amount === "number" && Number.isFinite(amount) && amount >= 0)
		})
	return messages.every((message) => {
		if (message.type !== "say" || !["api_req_started", "api_req_finished", "deleted_api_reqs"].includes(message.say ?? ""))
			return true
		try {
			const data: unknown = JSON.parse(message.text || "{}")
			if (!data || typeof data !== "object" || Array.isArray(data)) return false
			const record = data as Record<string, unknown>
			if (!validFields(record)) return false
			const specialist = record.specialistUsage
			return (
				specialist == null ||
				(typeof specialist === "object" &&
					!Array.isArray(specialist) &&
					validFields(specialist as Record<string, unknown>))
			)
		} catch {
			return false
		}
	})
}

/**
 * Calculates API metrics from an array of DietCodeMessages.
 *
 * This function processes usage-carrying say messages.
 * It includes:
 * - 'api_req_started' messages that have been combined with their corresponding 'api_req_finished' messages
 * - 'deleted_api_reqs' messages, which are aggregated from deleted messages
 * It extracts and sums up the tokensIn, tokensOut, cacheWrites, cacheReads, and cost from these messages.
 *
 * @param messages - An array of DietCodeMessage objects to process.
 * @returns An ApiMetrics object containing totalTokensIn, totalTokensOut, totalCacheWrites, totalCacheReads, and totalCost.
 *
 * @example
 * const messages = [
 *   { type: "say", say: "api_req_started", text: '{"request":"GET /api/data","tokensIn":10,"tokensOut":20,"cost":0.005}', ts: 1000 }
 * ];
 * const { totalTokensIn, totalTokensOut, totalCost } = getApiMetrics(messages);
 * // Result: { totalTokensIn: 10, totalTokensOut: 20, totalCost: 0.005 }
 */
export function getApiMetrics(messages: DietCodeMessage[]): ApiMetrics {
	const result: ApiMetrics = {
		totalTokensIn: 0,
		totalTokensOut: 0,
		totalCacheWrites: undefined,
		totalCacheReads: undefined,
		totalCost: 0,
	}

	messages.forEach((message) => {
		if (message.type === "say" && (message.say === "api_req_started" || message.say === "deleted_api_reqs") && message.text) {
			try {
				const parsedData = JSON.parse(message.text)
				const { tokensIn, tokensOut, cacheWrites, cacheReads, cost, specialistUsage } = parsedData

				if (typeof tokensIn === "number") {
					result.totalTokensIn += tokensIn
				}
				if (typeof tokensOut === "number") {
					result.totalTokensOut += tokensOut
				}
				if (typeof cacheWrites === "number") {
					result.totalCacheWrites = (result.totalCacheWrites ?? 0) + cacheWrites
				}
				if (typeof cacheReads === "number") {
					result.totalCacheReads = (result.totalCacheReads ?? 0) + cacheReads
				}
				if (typeof cost === "number") {
					result.totalCost += cost
				}
				if (specialistUsage && typeof specialistUsage === "object") {
					if (typeof specialistUsage.tokensIn === "number") result.totalTokensIn += specialistUsage.tokensIn
					if (typeof specialistUsage.tokensOut === "number") result.totalTokensOut += specialistUsage.tokensOut
					if (typeof specialistUsage.cacheWrites === "number")
						result.totalCacheWrites = (result.totalCacheWrites ?? 0) + specialistUsage.cacheWrites
					if (typeof specialistUsage.cacheReads === "number")
						result.totalCacheReads = (result.totalCacheReads ?? 0) + specialistUsage.cacheReads
					if (typeof specialistUsage.cost === "number") result.totalCost += specialistUsage.cost
				}
			} catch {
				// Ignore JSON parse errors
			}
		}
	})

	return result
}

/**
 * Gets the total token count from the last API request.
 *
 * This is used for context window progress display - it shows how much of the
 * context window is used in the current/most recent request, not cumulative totals.
 *
 * @param messages - An array of DietCodeMessage objects to process.
 * @returns The total tokens (tokensIn + tokensOut + cacheWrites + cacheReads) from the last api_req_started message, or 0 if none found.
 */
export function getLastApiReqTotalTokens(messages: DietCodeMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.type === "say" && msg.say === "api_req_started" && msg.text) {
			try {
				const { tokensIn, tokensOut, cacheWrites, cacheReads } = JSON.parse(msg.text)
				const total = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
				if (total > 0) {
					return total
				}
			} catch {
				// Ignore JSON parse errors, continue searching
			}
		}
	}
	return 0
}
