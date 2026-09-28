import type { IController } from "@core/controller/types"
import type { ExplainChangesProgress, ExplainChangesRequest } from "@shared/proto/dietcode/task"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import { runCompletionWalkthrough } from "./explainChanges"

export async function streamExplainChanges(
	controller: IController,
	request: ExplainChangesRequest,
	responseStream: StreamingResponseHandler<ExplainChangesProgress>,
	requestId?: string,
): Promise<void> {
	const cancellation = new AbortController()
	if (requestId) getRequestRegistry().registerRequest(requestId, () => cancellation.abort())
	await runCompletionWalkthrough(controller, request, {
		signal: cancellation.signal,
		onProgress: (progress) => responseStream(progress, progress.phase === "complete" || progress.phase === "cancelled"),
	})
}
