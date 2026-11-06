const { spawnSync } = require("node:child_process")
const { existsSync } = require("node:fs")
const path = require("node:path")

const root = path.resolve(__dirname, "..")
const backend = [
	"src/core/assistant-message/__tests__/parse-assistant-message.test.ts",
	"src/integrations/terminal/__tests__/normalizeCommand.test.ts",
	"src/core/task/__tests__/ActionExecutor.test.ts",
	"src/integrations/terminal/CommandExecutor.ownership.test.ts",
	"src/integrations/terminal/CommandOrchestrator.test.ts",
	"src/integrations/terminal/SupervisedShell.test.ts",
	"src/hosts/vscode/terminal/VscodeTerminalLifecycle.test.ts",
	"src/hosts/vscode/terminal/VscodeTerminalProcess.test.ts",
	"src/hosts/vscode/VscodeDiffViewProvider.test.ts",
	"src/core/controller/__tests__/partial-message-delivery.test.ts",
	"src/core/task/__tests__/ToolProgressTracker.test.ts",
	"src/core/task/legion/__tests__/LegionAgentHost.test.ts",
	"src/core/task/legion/__tests__/LegionToolAdapter.test.ts",
	"src/core/task/tools/handlers/__tests__/ApplyPatchHandler.execution.test.ts",
	"src/integrations/editor/__tests__/DiffViewProvider.test.ts",
	"src/integrations/editor/__tests__/FileEditProvider.test.ts",
	"src/integrations/editor/__tests__/FileMutationCoordinator.test.ts",
	"src/core/task/tools/handlers/__tests__/WriteToFileToolHandler.documentation.test.ts",
	"src/core/task/tools/handlers/__tests__/WriteToFileToolHandler.execution.test.ts",
	"src/core/task/tools/handlers/__tests__/ExecuteCommandToolHandler.approval.test.ts",
	"src/core/task/tools/handlers/__tests__/GetExecutionStateToolHandler.test.ts",
	"src/core/task/tools/handlers/__tests__/AttemptCompletionHandler.execution.test.ts",
	"src/core/task/__tests__/Task.commandExecution.test.ts",
	"src/core/task/__tests__/ExecutionState.test.ts",
	"src/core/task/__tests__/ExecutionContext.test.ts",
	"src/core/task/__tests__/Task.executionState.test.ts",
	"src/core/task/__tests__/reconcileCommandExecutions.test.ts",
	"src/core/task/__tests__/ToolExecutor.observation.test.ts",
	"src/core/task/__tests__/ExecutionRecovery.test.ts",
]
const webview = ["src/components/chat/CommandOutputRow.test.tsx", "src/components/chat/chat-view/utils/messageUtils.test.ts"]
const webviewRoot = path.join(root, "webview-ui")

for (const [directory, files] of [
	[root, backend],
	[webviewRoot, webview],
]) {
	const missing = files.filter((file) => !existsSync(path.join(directory, file)))
	if (missing.length) {
		console.error(`Execution reliability tests are missing from ${directory}:\n${missing.join("\n")}`)
		process.exit(1)
	}
}

function run(args, cwd) {
	const result = spawnSync(process.execPath, args, {
		cwd,
		env: { ...process.env, TS_NODE_PROJECT: path.join(root, "tsconfig.unit-test.json") },
		stdio: "inherit",
	})
	if (result.error) throw result.error
	if (result.status !== 0) process.exit(result.status ?? 1)
}

run(
	[
		"node_modules/mocha/bin/mocha.js",
		"--no-config",
		"--require",
		"ts-node/register",
		"--require",
		"tsconfig-paths/register",
		"--require",
		"./src/test/requires.cjs",
		"--timeout",
		"10000",
		"--reporter",
		"dot",
		"--exit",
		...backend,
	],
	root,
)

run(["node_modules/vitest/vitest.mjs", "run", ...webview], webviewRoot)
