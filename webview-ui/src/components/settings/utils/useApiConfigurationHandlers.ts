import { ApiConfiguration } from "@shared/api"
import { UpdateApiConfigurationPartialRequest } from "@shared/proto/dietcode/models"
import { convertApiConfigurationToProto } from "@shared/proto-conversions/models/api-configuration-conversion"
import { Mode } from "@shared/storage/types"
import { useCallback } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"

export const useApiConfigurationHandlers = () => {
	const { planActSeparateModelsSetting } = useExtensionState()

	/**
	 * Updates the supplied fields atomically, preserving unrelated settings on the host.
	 */
	const handleFieldsChange = useCallback(async (updates: Partial<ApiConfiguration>) => {
		// Send only the edited fields. Replaying a captured configuration here lets a
		// delayed key/model update restore an old provider or another mode's settings.
		await ModelsServiceClient.updateApiConfigurationPartial(
			UpdateApiConfigurationPartialRequest.create({
				apiConfiguration: convertApiConfigurationToProto(updates),
				updateMask: Object.keys(updates),
			}),
		)
	}, [])

	const handleFieldChange = useCallback(
		async <K extends keyof ApiConfiguration>(field: K, value: ApiConfiguration[K]) => {
			await handleFieldsChange({ [field]: value })
		},
		[handleFieldsChange],
	)

	const handleModeFieldChange = useCallback(
		async <PlanK extends keyof ApiConfiguration, ActK extends keyof ApiConfiguration>(
			fieldPair: { plan: PlanK; act: ActK },
			value: ApiConfiguration[PlanK] & ApiConfiguration[ActK], // Intersection ensures value is compatible with both field types
			currentMode: Mode,
		) => {
			if (planActSeparateModelsSetting) {
				const targetField = fieldPair[currentMode]
				await handleFieldChange(targetField, value)
			} else {
				await handleFieldsChange({
					[fieldPair.plan]: value,
					[fieldPair.act]: value,
				})
			}
		},
		[planActSeparateModelsSetting, handleFieldChange, handleFieldsChange],
	)

	/**
	 * Updates multiple mode-specific fields in a single atomic operation.
	 *
	 * This prevents race conditions that can occur when making multiple separate
	 * handleModeFieldChange calls in rapid succession.
	 *
	 * @param fieldPairs - Object mapping keys to plan/act field pairs
	 * @param values - Object with values for each key
	 * @param currentMode - The current mode being targeted
	 */
	const handleModeFieldsChange = useCallback(
		async <T extends Record<string, any>>(
			fieldPairs: { [K in keyof T]: { plan: keyof ApiConfiguration; act: keyof ApiConfiguration } },
			values: T,
			currentMode: Mode,
		) => {
			if (planActSeparateModelsSetting) {
				// Update only the current mode's fields
				const updates: Partial<ApiConfiguration> = {}
				Object.entries(fieldPairs).forEach(([key, { plan, act }]) => {
					const targetField = currentMode === "plan" ? plan : act
					updates[targetField] = values[key]
				})
				await handleFieldsChange(updates)
			} else {
				// Update both modes' fields
				const updates: Partial<ApiConfiguration> = {}
				Object.entries(fieldPairs).forEach(([key, { plan, act }]) => {
					updates[plan] = values[key]
					updates[act] = values[key]
				})
				await handleFieldsChange(updates)
			}
		},
		[planActSeparateModelsSetting, handleFieldsChange],
	)

	return { handleFieldChange, handleFieldsChange, handleModeFieldChange, handleModeFieldsChange }
}
