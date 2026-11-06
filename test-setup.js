const path = require("node:path")
const tsconfigPaths = require("tsconfig-paths")

// Integration tests are compiled under out/, while TypeScript aliases refer to src/.
const config = tsconfigPaths.loadConfig(__dirname)
if (config.resultType !== "success") {
	throw new Error(`Cannot load TypeScript paths for integration tests: ${config.message}`)
}
tsconfigPaths.register({ baseUrl: path.join(__dirname, "out"), paths: config.paths })
