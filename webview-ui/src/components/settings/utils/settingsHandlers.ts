import { McpDisplayMode, UpdateSettingsRequest } from "@shared/proto/dietcode/state"
import { StateServiceClient } from "@/services/grpc-client"

/**
 * Converts values to their corresponding proto format
 * @param field - The field name
 * @param value - The value to convert
 * @returns The converted value
 * @throws Error if the value is invalid for the field
 */
const convertToProtoValue = (field: keyof UpdateSettingsRequest, value: any): any => {
	if (field === "mcpDisplayMode" && typeof value === "string") {
		switch (value) {
			case "rich":
				return McpDisplayMode.RICH
			case "plain":
				return McpDisplayMode.PLAIN
			case "markdown":
				return McpDisplayMode.MARKDOWN
			default:
				throw new Error(`Invalid MCP display mode value: ${value}`)
		}
	}
	return value
}

/**
 * Updates a single field in the settings.
 *
 * @param field - The field key to update
 * @param value - The new value for the field
 */
export const updateSetting = (field: keyof UpdateSettingsRequest, value: any) => {
	const updateRequest: Partial<UpdateSettingsRequest> = {}

	const convertedValue = convertToProtoValue(field, value)
	updateRequest[field] = convertedValue

	StateServiceClient.updateSettings(UpdateSettingsRequest.create(updateRequest)).catch((error) => {
		console.error(`Failed to update setting ${field}:`, error)
	})
}

/**
 * Updates multiple fields in the settings atomically in a single gRPC request.
 *
 * @param updates - Partial UpdateSettingsRequest map of field keys and values
 */
export const updateSettingsBatch = (updates: Partial<Record<keyof UpdateSettingsRequest, any>>) => {
	const updateRequest: Partial<UpdateSettingsRequest> = {}

	for (const [field, value] of Object.entries(updates) as Array<[keyof UpdateSettingsRequest, any]>) {
		if (value !== undefined) {
			updateRequest[field] = convertToProtoValue(field, value)
		}
	}

	StateServiceClient.updateSettings(UpdateSettingsRequest.create(updateRequest)).catch((error) => {
		console.error("Failed to batch update settings:", error)
	})
}
