import type { IController } from "@core/controller/types"
import { Empty } from "@shared/proto/dietcode/common"
import type { CommandControlRequest } from "@shared/proto/dietcode/task"

export async function controlCommand(controller: IController, request: CommandControlRequest): Promise<Empty> {
	const task = controller.task
	if (!task || !request.taskId || task.taskId !== request.taskId || !request.executionId) {
		throw new Error("This command belongs to a different or closed task. Inspect the terminal panel before retrying.")
	}
	if (request.action !== "show" && request.action !== "stop") throw new Error("Unknown command action.")
	task.controlCommand(request.executionId, request.action)
	return Empty.create()
}
