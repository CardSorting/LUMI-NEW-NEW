// Mock implementation of VSCode API for unit tests
export class EventEmitter<T> {
	private listeners = new Set<(value: T) => void>()
	readonly event = (listener: (value: T) => void) => {
		this.listeners.add(listener)
		return { dispose: () => this.listeners.delete(listener) }
	}
	fire(value: T) {
		for (const listener of this.listeners) listener(value)
	}
	dispose() {
		this.listeners.clear()
	}
}
export const env = {
	machineId: "test-machine-id",
	isTelemetryEnabled: true,
	onDidChangeTelemetryEnabled: (_callback: (enabled: boolean) => void) => {
		// Return a disposable mock
		return {
			dispose: () => {},
		}
	},
}

export const workspace = {
	getConfiguration: (section?: string) => {
		return {
			get: (key: string, defaultValue?: any) => {
				// Return default values for common configuration keys
				if (section === "dietcode" && key === "telemetrySetting") {
					return "enabled"
				}
				if (section === "telemetry" && key === "telemetryLevel") {
					return "all"
				}
				return defaultValue
			},
		}
	},
}

// Export other commonly used VSCode API mocks as needed
export const window = {
	createTerminal: (options: any) => ({
		name: options.name ?? "test",
		processId: Promise.resolve(undefined),
		shellIntegration: undefined,
		show: () => options.pty?.open(),
		hide: () => {},
		sendText: () => {},
		dispose: () => options.pty?.close(),
	}),
	onDidCloseTerminal: (_listener: (terminal: any) => void) => ({ dispose: () => {} }),
	onDidEndTerminalShellExecution: undefined as ((listener: (event: any) => void) => { dispose: () => void }) | undefined,
	showErrorMessage: (_message: string) => Promise.resolve(),
	showWarningMessage: (_message: string) => Promise.resolve(),
	showInformationMessage: (_message: string) => Promise.resolve(),
	createTextEditorDecorationType: (_options: any) => ({
		key: "mock-decoration-type",
		dispose: () => {},
	}),
	createOutputChannel: (_name: string) => ({
		appendLine: (message: string) => console.debug(message),
		append: (message: string) => console.debug(message),
		clear: () => {},
		show: () => {},
		hide: () => {},
		dispose: () => {},
	}),
}

export const commands = {
	executeCommand: (_command: string, ..._args: any[]) => Promise.resolve(),
}

export const Uri = {
	file: (path: string) => ({ fsPath: path, toString: () => path }),
	parse: (uri: string) => ({ fsPath: uri, toString: () => uri }),
}

export const ExtensionContextMock = {}
export const StatusBarAlignmentMock = { Left: 1, Right: 2 }
export const ViewColumnMock = { One: 1, Two: 2, Three: 3 }
