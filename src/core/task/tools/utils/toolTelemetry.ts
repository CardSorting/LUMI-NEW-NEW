import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"

/** Usage reporting must never delay a tool or turn its outcome into a retry. */
export function reportToolUsage(...args: Parameters<typeof telemetryService.captureToolUsage>): void {
	try {
		void Promise.resolve(telemetryService.captureToolUsage(...args)).catch((error) => {
			Logger.warn("[ToolTelemetry] Usage reporting unavailable:", error)
		})
	} catch (error) {
		Logger.warn("[ToolTelemetry] Usage reporting unavailable:", error)
	}
}
