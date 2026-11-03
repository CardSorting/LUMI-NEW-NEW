const { setDbPath, destroyDb } = require("../../../db/Config")
const { orchestrator } = require("../../Orchestrator")
const { legionCoordinator } = require("../../LegionCoordinator")

async function main() {
	setDbPath(process.argv[2])
	const root = await orchestrator.getOrCreateLegionTaskStream("cross-process-task", "shared objective")
	const claimed = await legionCoordinator.acquireAutomaticFormationToken(root.id, "shared objective")
	const driver = await legionCoordinator.acquireFormationDispatchToken(root.id, "test-formation")
	const dispatch = await legionCoordinator.acquireDispatchToken(root.id)
	process.stdout.write(`LEGION_RESULT:${JSON.stringify({ root: root.id, claimed, driver, dispatch })}\n`)
	await destroyDb()
}
main().then(
	() => process.exit(0),
	(error) => {
		process.stderr.write(String(error.stack || error))
		process.exit(1)
	},
)
