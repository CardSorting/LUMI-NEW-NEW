import { URI } from "vscode-uri"
import { DIFF_VIEW_URI_SCHEME } from "../VscodeDiffViewProvider"

/** Diff editors and inline comments must identify the same immutable document. */
export function reviewDiffUri(filePath: string, content: string): URI {
	return URI.file(filePath).with({ scheme: DIFF_VIEW_URI_SCHEME, query: Buffer.from(content).toString("base64"), fragment: "" })
}
