/** Event subscriptions may remain silent until a user action or state change. */
export function isSubscriptionMethod(methodName: string): boolean {
	const method = methodName.toLowerCase()
	// Some services prefix their subscription methods (e.g. ocaSubscribeToAuthStatusUpdate).
	return method.includes("subscribe") || method.includes("subscription")
}
