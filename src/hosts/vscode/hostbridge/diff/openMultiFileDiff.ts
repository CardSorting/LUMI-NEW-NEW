import * as vscode from "vscode"
import { OpenMultiFileDiffRequest, OpenMultiFileDiffResponse } from "@/shared/proto/index.host"
import { reviewDiffUri } from "../../review/reviewDiffUri"

export async function openMultiFileDiff(request: OpenMultiFileDiffRequest): Promise<OpenMultiFileDiffResponse> {
	await vscode.commands.executeCommand(
		"vscode.changes",
		request.title,
		request.diffs.map((diff) => {
			const file = vscode.Uri.file(diff.filePath || "")
			const left = diff.leftContent ?? ""
			const right = diff.rightContent ?? ""
			return [file, reviewDiffUri(diff.filePath || "", left), reviewDiffUri(diff.filePath || "", right)]
		}),
	)

	return {}
}
