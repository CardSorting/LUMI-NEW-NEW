import type { IController as Controller } from "@core/controller/types"
import { Empty, EmptyRequest } from "@shared/proto/dietcode/common"
import { OpenRouterCompatibleModelInfo } from "@shared/proto/dietcode/models"
import { readMcpMarketplaceCatalogFromCache } from "@/core/storage/disk"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import { GlobalStateAndSettings } from "@/shared/storage/state-keys"
import { sendMcpMarketplaceCatalogEvent } from "../mcp/subscribeToMcpMarketplaceCatalog"
import { refreshOpenRouterModels } from "../models/refreshOpenRouterModels"
import { sendOpenRouterModelsEvent } from "../models/subscribeToOpenRouterModels"

export async function initializeWebview(controller: Controller, _request: EmptyRequest): Promise<Empty> {
	try {
		const cached = await controller.readOpenRouterModels()
		if (cached) sendOpenRouterModelsEvent(OpenRouterCompatibleModelInfo.create({ models: cached }))
		refreshOpenRouterModels(controller).then(async (models) => {
			if (!models || Object.keys(models).length === 0) return
			const config = controller.stateManager.getApiConfiguration()
			const separate = controller.stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")
			const mode = controller.stateManager.getGlobalSettingsKey("mode")
			if (separate) {
				const idKey = mode === "plan" ? "planModeOpenRouterModelId" : "actModeOpenRouterModelId"
				const infoKey = mode === "plan" ? "planModeOpenRouterModelInfo" : "actModeOpenRouterModelInfo"
				const id = config[idKey]
				if (id && models[id]) {
					controller.stateManager.setGlobalState(infoKey, models[id])
					await controller.postStateToWebview()
				}
				return
			}
			const updates: Partial<GlobalStateAndSettings> = {}
			if (config.planModeOpenRouterModelId && models[config.planModeOpenRouterModelId])
				updates.planModeOpenRouterModelInfo = models[config.planModeOpenRouterModelId]
			if (config.actModeOpenRouterModelId && models[config.actModeOpenRouterModelId])
				updates.actModeOpenRouterModelInfo = models[config.actModeOpenRouterModelId]
			if (Object.keys(updates).length) {
				controller.stateManager.setGlobalStateBatch(updates)
				await controller.postStateToWebview()
			}
		})
		const catalog = await readMcpMarketplaceCatalogFromCache()
		if (catalog) sendMcpMarketplaceCatalogEvent(catalog)
		controller.refreshMcpMarketplace(true)
		controller
			.getStateToPostToWebview()
			.then((state) => telemetryService.updateTelemetryState(state.telemetrySetting !== "disabled"))
		return Empty.create({})
	} catch (error) {
		Logger.error("Failed to initialize webview:", error)
		return Empty.create({})
	}
}
