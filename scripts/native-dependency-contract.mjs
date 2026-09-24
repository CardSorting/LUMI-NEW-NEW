/**
 * Runtime modules left external in the extension bundle.
 * Keep the bundler, VSIX whitelist, doctor, and package gate on one contract.
 */
export const HOST_EXTERNAL_MODULES = Object.freeze(["vscode"])
export const REQUIRED_RUNTIME_PACKAGES = Object.freeze(["better-sqlite3"])
export const EXTENSION_EXTERNAL_MODULES = Object.freeze([...HOST_EXTERNAL_MODULES, ...REQUIRED_RUNTIME_PACKAGES])
