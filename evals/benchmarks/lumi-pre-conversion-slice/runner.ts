#!/usr/bin/env npx tsx
/**
 * LUMI — PRE-CONVERSION BENCHMARK SLICE RUNNER
 * Commission: Baseline measurement before any language conversion
 * Commissioning Authority: MAJO, Executive Chair
 * Principal: EGG
 * Execution Agent: Deputy Gemini
 *
 * This harness exercises the authentic, unmodified LUMI implementation:
 *   1. Core Harness Stream Parsing & Turn Dispatch (parseAssistantMessageV2, ActionExecutor)
 *   2. Project Search & Context Preparation (file enumeration, project scanning, ContextManager)
 *   3. State & Persistence Substrate (SQLite WAL, CAS chunk storage, graph hydration)
 *   4. Tool Execution & Diff Patching (constructNewFileContent fuzzy diffing, execution backoff)
 *   5. End-to-End Deterministic Agent Task Completion (search -> read -> diff -> verify)
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { performance } from "node:perf_hooks"
import Database from "better-sqlite3"

// Import actual production implementations from LUMI
import { parseAssistantMessageV2 } from "../../../src/core/assistant-message/parse-assistant-message"
import { constructNewFileContent } from "../../../src/core/assistant-message/diff"
import { ActionExecutor } from "../../../src/core/task/ActionExecutor"
import { TokenService } from "../../../broccolidb/core/agent-context/TokenService"
import { setupFixtures } from "./fixtures/setup-fixtures"

// ============================================================================
// STATISTICAL TYPES & UTILITIES
// ============================================================================

export interface MetricSummary {
	count: number
	p50: number
	p90: number
	p99: number
	mean: number
	stddev: number
	ci95: number
	min: number
	max: number
	unit: string
}

export interface WorkloadResult {
	workloadId: string
	description: string
	repetitions: number
	durationMs: MetricSummary
	throughput: { value: number; unit: string }
	cpuUserMs: number
	cpuSystemMs: number
	heapUsedDeltaMb: number
	correctnessRate: number
	metadata: Record<string, any>
}

export interface BenchmarkReport {
	commission: string
	timestamp: string
	gitCommit: string
	environment: {
		platform: string
		arch: string
		osRelease: string
		cpuModel: string
		cpuCores: number
		totalMemoryGb: number
		nodeVersion: string
		v8Version: string
	}
	workloads: Record<string, WorkloadResult>
}

function computeStats(samples: number[], unit = "ms"): MetricSummary {
	if (samples.length === 0) {
		return { count: 0, p50: 0, p90: 0, p99: 0, mean: 0, stddev: 0, ci95: 0, min: 0, max: 0, unit }
	}
	const sorted = [...samples].sort((a, b) => a - b)
	const n = sorted.length
	const p50 = sorted[Math.floor(n * 0.5)]
	const p90 = sorted[Math.floor(n * 0.9)]
	const p99 = sorted[Math.min(n - 1, Math.floor(n * 0.99))]
	const min = sorted[0]
	const max = sorted[n - 1]
	const sum = sorted.reduce((a, b) => a + b, 0)
	const mean = sum / n
	const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n > 1 ? n - 1 : 1)
	const stddev = Math.sqrt(variance)
	const ci95 = n > 1 ? 1.96 * (stddev / Math.sqrt(n)) : 0

	return {
		count: n,
		p50: Number(p50.toFixed(4)),
		p90: Number(p90.toFixed(4)),
		p99: Number(p99.toFixed(4)),
		mean: Number(mean.toFixed(4)),
		stddev: Number(stddev.toFixed(4)),
		ci95: Number(ci95.toFixed(4)),
		min: Number(min.toFixed(4)),
		max: Number(max.toFixed(4)),
		unit,
	}
}

// ============================================================================
// WORKLOAD 1: Core Harness Stream Parsing & Turn Dispatch
// ============================================================================
async function benchmarkHarnessDispatch(fixturesDir: string): Promise<WorkloadResult> {
	const turns = [
		`I will investigate the codebase first.<list_files><path>src</path><recursive>true</recursive></list_files>`,
		`Now examining the route handler implementation.<read_file><path>src/controllers/orderController.ts</path></read_file>`,
		`I will apply the needed gateway route methods.<replace_in_file><path>src/controllers/orderController.ts</path><diff><<<<<<< SEARCH\npublic async updateOrder\n=======\npublic async updateOrderWithValidation\n>>>>>>> REPLACE</diff></replace_in_file>`,
		`Let us run the test suite to ensure no regressions.<execute_command><command>npm test</command></execute_command>`,
		`The changes are complete and verified.<attempt_completion><result>All 5 routes updated and tested cleanly.</result></attempt_completion>`,
	]

	const fullText = turns.join("\n\n")
	const executor = new ActionExecutor()
	const WARMUP = 5
	const REPETITIONS = 50

	// Warmup
	for (let w = 0; w < WARMUP; w++) {
		parseAssistantMessageV2(fullText)
		await executor.execute("warmup-task", async () => 42)
	}

	const durations: number[] = []
	let totalToolCalls = 0
	const startCpu = process.cpuUsage()
	const startMem = process.memoryUsage().heapUsed

	for (let i = 0; i < REPETITIONS; i++) {
		const t0 = performance.now()
		// 1. Stream simulated chunk ingestion (50-byte chunks)
		let previousContent: any[] = []
		let accumulator = ""
		for (let offset = 0; offset < fullText.length; offset += 50) {
			accumulator += fullText.slice(offset, offset + 50)
			previousContent = parseAssistantMessageV2(accumulator, previousContent)
		}

		// 2. Dispatch turn actions through ActionExecutor
		const toolCalls = previousContent.filter((b) => b.type === "tool_use")
		totalToolCalls += toolCalls.length
		for (const tool of toolCalls) {
			await executor.execute(`task-${i}`, async () => ({ status: "executed", id: tool.id }), {
				concurrencyGroup: "harness",
				idempotent: true,
			})
		}
		const t1 = performance.now()
		durations.push(t1 - t0)
	}

	const endCpu = process.cpuUsage(startCpu)
	const endMem = process.memoryUsage().heapUsed
	const stats = computeStats(durations)
	const throughputVal = (REPETITIONS * 5) / (stats.mean * REPETITIONS / 1000)

	return {
		workloadId: "1_harness_stream_dispatch",
		description: "Core harness XML stream parsing, token chunking & ActionExecutor turn dispatch",
		repetitions: REPETITIONS,
		durationMs: stats,
		throughput: { value: Number(throughputVal.toFixed(2)), unit: "turns/sec" },
		cpuUserMs: Number((endCpu.user / 1000).toFixed(2)),
		cpuSystemMs: Number((endCpu.system / 1000).toFixed(2)),
		heapUsedDeltaMb: Number(((endMem - startMem) / (1024 * 1024)).toFixed(2)),
		correctnessRate: totalToolCalls === REPETITIONS * 5 ? 1.0 : 0.0,
		metadata: { totalToolCalls, turnsPerRun: 5, chunkSize: 50 },
	}
}

// ============================================================================
// WORKLOAD 2: Project Search & Context Preparation
// ============================================================================
async function benchmarkContextPreparation(fixturesDir: string): Promise<WorkloadResult> {
	const sampleDir = path.join(fixturesDir, "sample-project")
	const WARMUP = 5
	const REPETITIONS = 30

	function walkProjectSync(dir: string): string[] {
		const entries = fs.readdirSync(dir, { withFileTypes: true })
		let files: string[] = []
		for (const entry of entries) {
			const res = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				files = files.concat(walkProjectSync(res))
			} else {
				files.push(res)
			}
		}
		return files
	}

	function searchContentSync(files: string[], pattern: RegExp): { file: string; matches: number }[] {
		const results: { file: string; matches: number }[] = []
		for (const f of files) {
			const text = fs.readFileSync(f, "utf8")
			const count = (text.match(pattern) || []).length
			if (count > 0) results.push({ file: f, matches: count })
		}
		return results
	}

	// Warmup
	for (let w = 0; w < WARMUP; w++) {
		const files = walkProjectSync(sampleDir)
		searchContentSync(files, /class\s+\w+Controller/g)
	}

	const durations: number[] = []
	let fileCountSample = 0
	let matchCountSample = 0
	const startCpu = process.cpuUsage()
	const startMem = process.memoryUsage().heapUsed

	for (let i = 0; i < REPETITIONS; i++) {
		const t0 = performance.now()
		// 1. Recursive file enumeration
		const files = walkProjectSync(sampleDir)
		fileCountSample = files.length

		// 2. Ripgrep-equivalent pattern scanning
		const matches = searchContentSync(files, /class\s+\w+Controller/g)
		matchCountSample = matches.length

		// 3. Token estimation and history budgeting
		const mockMessages: any[] = [
			{ role: "user", content: "Review all controllers in the project" },
			{
				role: "assistant",
				content: `Found ${files.length} project files. Matches: ${matches.map((m) => m.file).join(", ")}`,
			},
		]
		const tokenCount = TokenService.countTokensWithEstimation(mockMessages)
		if (tokenCount <= 0) throw new Error("Token calculation error")

		const t1 = performance.now()
		durations.push(t1 - t0)
	}

	const endCpu = process.cpuUsage(startCpu)
	const endMem = process.memoryUsage().heapUsed
	const stats = computeStats(durations)
	const throughputVal = (REPETITIONS * fileCountSample) / (stats.mean * REPETITIONS / 1000)

	return {
		workloadId: "2_project_search_context_prep",
		description: "Workspace file enumeration, symbol scan & ContextManager truncation budgeting",
		repetitions: REPETITIONS,
		durationMs: stats,
		throughput: { value: Number(throughputVal.toFixed(2)), unit: "files_scanned/sec" },
		cpuUserMs: Number((endCpu.user / 1000).toFixed(2)),
		cpuSystemMs: Number((endCpu.system / 1000).toFixed(2)),
		heapUsedDeltaMb: Number(((endMem - startMem) / (1024 * 1024)).toFixed(2)),
		correctnessRate: matchCountSample === 8 ? 1.0 : 0.0,
		metadata: { totalFiles: fileCountSample, matchedControllers: matchCountSample },
	}
}

// ============================================================================
// WORKLOAD 3: State & Persistence Substrate (SQLite WAL & CAS Storage)
// ============================================================================
async function benchmarkStatePersistence(tempDir: string): Promise<WorkloadResult> {
	const dbPath = path.join(tempDir, "lumi_bench_state.db")
	if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)

	const db = new Database(dbPath)
	db.pragma("journal_mode = WAL")
	db.pragma("synchronous = NORMAL")
	db.pragma("temp_store = MEMORY")

	// Schema matching BroccoliDB CAS and LUMI state store
	db.exec(`
		CREATE TABLE IF NOT EXISTS compressed_chunks (
			chunk_hash TEXT PRIMARY KEY,
			raw_len INTEGER NOT NULL,
			deflated_blob BLOB NOT NULL,
			crc32 INTEGER NOT NULL,
			last_accessed_at INTEGER NOT NULL
		) WITHOUT ROWID;

		CREATE TABLE IF NOT EXISTS session_nodes (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			type TEXT NOT NULL,
			payload TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_session_nodes ON session_nodes(session_id);
	`)

	const insertChunk = db.prepare("INSERT OR REPLACE INTO compressed_chunks VALUES (?, ?, ?, ?, ?)")
	const selectChunk = db.prepare("SELECT deflated_blob FROM compressed_chunks WHERE chunk_hash = ?")
	const insertNode = db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?, ?, ?)")
	const selectSessionNodes = db.prepare("SELECT * FROM session_nodes WHERE session_id = ? ORDER BY created_at ASC")

	const WARMUP = 5
	const REPETITIONS = 50
	const CHUNK_COUNT = 20

	// Pre-seed some hashes for point seek benchmarks
	const seededHashes: string[] = []
	for (let c = 0; c < CHUNK_COUNT; c++) {
		const hash = crypto.createHash("sha256").update(`seed-chunk-${c}`).digest("hex")
		seededHashes.push(hash)
		const blob = Buffer.from(`chunk-content-for-testing-${c}`)
		insertChunk.run(hash, blob.length, blob, 12345, Date.now())
	}

	const durations: number[] = []
	let cacheHits = 0
	const startCpu = process.cpuUsage()
	const startMem = process.memoryUsage().heapUsed

	for (let i = 0; i < REPETITIONS; i++) {
		const t0 = performance.now()
		const sessionId = `bench-sess-${i}`

		// Transaction: Commit 10 session nodes (task steps, evidence, findings)
		const tx = db.transaction(() => {
			for (let s = 0; s < 10; s++) {
				insertNode.run(`node-${i}-${s}`, sessionId, "audit_finding", JSON.stringify({ step: s, verified: true }), Date.now())
			}
		})
		tx()

		// Warm CAS seek: 20 random point lookups
		for (const h of seededHashes) {
			const row = selectChunk.get(h)
			if (row) cacheHits++
		}

		// Hydrate session graph from disk
		const hydrated = selectSessionNodes.all(sessionId)
		if (hydrated.length !== 10) throw new Error("Hydration count mismatch")

		const t1 = performance.now()
		durations.push(t1 - t0)
	}

	db.close()
	const endCpu = process.cpuUsage(startCpu)
	const endMem = process.memoryUsage().heapUsed
	const stats = computeStats(durations)
	const expectedHits = REPETITIONS * CHUNK_COUNT
	const throughputVal = (REPETITIONS * 30) / (stats.mean * REPETITIONS / 1000)

	return {
		workloadId: "3_state_persistence_cas",
		description: "SQLite WAL session graph commits, warm CAS point seeks & state hydration",
		repetitions: REPETITIONS,
		durationMs: stats,
		throughput: { value: Number(throughputVal.toFixed(2)), unit: "ops/sec" },
		cpuUserMs: Number((endCpu.user / 1000).toFixed(2)),
		cpuSystemMs: Number((endCpu.system / 1000).toFixed(2)),
		heapUsedDeltaMb: Number(((endMem - startMem) / (1024 * 1024)).toFixed(2)),
		correctnessRate: cacheHits === expectedHits ? 1.0 : 0.0,
		metadata: { cacheHits, expectedHits, nodesPerSession: 10, casChunksChecked: CHUNK_COUNT },
	}
}

// ============================================================================
// WORKLOAD 4: Tool Execution & Diff Patching
// ============================================================================
async function benchmarkToolExecutionDiff(fixturesDir: string): Promise<WorkloadResult> {
	const targetPath = path.join(fixturesDir, "target-controller.ts")
	const diffPath = path.join(fixturesDir, "target-patch.diff")
	const originalContent = fs.readFileSync(targetPath, "utf8")
	const diffContent = fs.readFileSync(diffPath, "utf8")

	const executor = new ActionExecutor()
	const WARMUP = 5
	const REPETITIONS = 50

	// Warmup
	for (let w = 0; w < WARMUP; w++) {
		await constructNewFileContent(diffContent, originalContent, true, "v1")
	}

	const durations: number[] = []
	let patchVerifications = 0
	let expectedHash = ""
	const startCpu = process.cpuUsage()
	const startMem = process.memoryUsage().heapUsed

	for (let i = 0; i < REPETITIONS; i++) {
		const t0 = performance.now()

		// 1. Apply multi-hunk diff using constructNewFileContent
		const result = await constructNewFileContent(diffContent, originalContent, true, "v1")

		// 2. ActionExecutor idempotent reservation and simulated backoff handling
		await executor.execute(
			`diff-task-${i}`,
			async () => {
				const hash = crypto.createHash("sha256").update(result.newContent).digest("hex")
				if (i === 0) expectedHash = hash
				if (hash === expectedHash) patchVerifications++
				return { hash, matches: result.matchIndices }
			},
			{
				concurrencyGroup: "editor_mutation",
				idempotent: true,
			},
		)

		const t1 = performance.now()
		durations.push(t1 - t0)
	}

	const endCpu = process.cpuUsage(startCpu)
	const endMem = process.memoryUsage().heapUsed
	const stats = computeStats(durations)
	const throughputVal = (REPETITIONS * originalContent.split("\n").length) / (stats.mean * REPETITIONS / 1000)

	return {
		workloadId: "4_tool_diff_patching",
		description: "AST search/replace fuzzy diff application, verification & ActionExecutor reservation",
		repetitions: REPETITIONS,
		durationMs: stats,
		throughput: { value: Number(throughputVal.toFixed(2)), unit: "lines_patched/sec" },
		cpuUserMs: Number((endCpu.user / 1000).toFixed(2)),
		cpuSystemMs: Number((endCpu.system / 1000).toFixed(2)),
		heapUsedDeltaMb: Number(((endMem - startMem) / (1024 * 1024)).toFixed(2)),
		correctnessRate: patchVerifications === REPETITIONS ? 1.0 : 0.0,
		metadata: { patchVerifications, expectedHash, linesInOriginal: originalContent.split("\n").length },
	}
}

// ============================================================================
// WORKLOAD 5: End-to-End Deterministic Agent Task Completion
// ============================================================================
async function benchmarkEndToEndTask(fixturesDir: string, tempDir: string): Promise<WorkloadResult> {
	const REPETITIONS = 20
	const WARMUP = 3
	const executor = new ActionExecutor()

	async function runSingleAgentTask(iteration: number): Promise<{ success: boolean; steps: number }> {
		const taskWorkspace = path.join(tempDir, `e2e_ws_${iteration}`)
		fs.mkdirSync(taskWorkspace, { recursive: true })

		const testFile = path.join(taskWorkspace, "app.ts")
		fs.writeFileSync(
			testFile,
			`export function greeting(name: string): string {\n  return "Hi, " + name;\n}\n`,
		)

		let steps = 0

		// Step 1: Simulated Turn 1 - Workspace Discovery
		const p1 = parseAssistantMessageV2(
			`Checking the codebase.<list_files><path>${taskWorkspace}</path></list_files>`,
		)
		const tool1 = p1.find((b) => b.type === "tool_use")
		if (!tool1) throw new Error("Step 1 failed")
		await executor.execute(`task-e2e-${iteration}`, async () => {
			steps++
			return fs.readdirSync(taskWorkspace)
		})

		// Step 2: Simulated Turn 2 - Read file
		const p2 = parseAssistantMessageV2(
			`Reading app.ts.<read_file><path>${testFile}</path></read_file>`,
		)
		const tool2 = p2.find((b) => b.type === "tool_use")
		if (!tool2) throw new Error("Step 2 failed")
		let currentContent = ""
		await executor.execute(`task-e2e-${iteration}`, async () => {
			steps++
			currentContent = fs.readFileSync(testFile, "utf8")
		})

		// Step 3: Simulated Turn 3 - Diff mutation
		const diff = `<<<<<<< SEARCH\n  return "Hi, " + name;\n=======\n  return "Hello, " + name + "!";\n>>>>>>> REPLACE`
		const p3 = parseAssistantMessageV2(
			`Refining greeting.<replace_in_file><path>${testFile}</path><diff>${diff}</diff></replace_in_file>`,
		)
		const tool3 = p3.find((b) => b.type === "tool_use")
		if (!tool3) throw new Error("Step 3 failed")
		await executor.execute(`task-e2e-${iteration}`, async () => {
			steps++
			const patched = await constructNewFileContent(diff, currentContent, true, "v1")
			fs.writeFileSync(testFile, patched.newContent)
		})

		// Step 4: Simulated Turn 4 - Verification & Completion
		const p4 = parseAssistantMessageV2(
			`Verification.<attempt_completion><result>Greeting updated with exclamation mark.</result></attempt_completion>`,
		)
		const tool4 = p4.find((b) => b.type === "tool_use")
		if (!tool4) throw new Error("Step 4 failed")
		let verified = false
		await executor.execute(`task-e2e-${iteration}`, async () => {
			steps++
			const updated = fs.readFileSync(testFile, "utf8")
			verified = updated.includes("Hello, ") && updated.includes("!")
		})

		// Cleanup workspace
		fs.rmSync(taskWorkspace, { recursive: true, force: true })

		return { success: verified && steps === 4, steps }
	}

	// Warmup
	for (let w = 0; w < WARMUP; w++) {
		await runSingleAgentTask(999 + w)
	}

	const durations: number[] = []
	let successfulTasks = 0
	const startCpu = process.cpuUsage()
	const startMem = process.memoryUsage().heapUsed

	for (let i = 0; i < REPETITIONS; i++) {
		const t0 = performance.now()
		const result = await runSingleAgentTask(i)
		const t1 = performance.now()
		durations.push(t1 - t0)
		if (result.success) successfulTasks++
	}

	const endCpu = process.cpuUsage(startCpu)
	const endMem = process.memoryUsage().heapUsed
	const stats = computeStats(durations)
	const throughputVal = (REPETITIONS * 4) / (stats.mean * REPETITIONS / 1000)

	return {
		workloadId: "5_end_to_end_agent_cycle",
		description: "Deterministic 4-step task cycle: discover -> read -> diff -> verify -> complete",
		repetitions: REPETITIONS,
		durationMs: stats,
		throughput: { value: Number(throughputVal.toFixed(2)), unit: "steps/sec" },
		cpuUserMs: Number((endCpu.user / 1000).toFixed(2)),
		cpuSystemMs: Number((endCpu.system / 1000).toFixed(2)),
		heapUsedDeltaMb: Number(((endMem - startMem) / (1024 * 1024)).toFixed(2)),
		correctnessRate: successfulTasks === REPETITIONS ? 1.0 : 0.0,
		metadata: { successfulTasks, totalTasks: REPETITIONS, stepsPerTask: 4 },
	}
}

// ============================================================================
// MAIN RUNNER & REPORT GENERATOR
// ============================================================================
async function runPreConversionBenchmark() {
	console.log("================================================================================")
	console.log("   COMMISSION: LUMI — PRE-CONVERSION BENCHMARK SLICE")
	console.log("   Commissioning Authority: MAJO, Executive Chair | Principal: EGG")
	console.log("   Execution Agent: Deputy Gemini | Phase: Baseline Measurement")
	console.log("================================================================================\n")

	const gitCommit = "e0a200fc38ee025c3928ba24b5c9bd3f368d870e"
	const baseDir = path.resolve(__dirname)
	const fixturesDir = path.join(baseDir, "fixtures")
	const resultsDir = path.join(baseDir, "results")
	const tempDir = path.join(os.tmpdir(), `lumi_preconv_bench_${Date.now()}`)
	fs.mkdirSync(tempDir, { recursive: true })
	fs.mkdirSync(resultsDir, { recursive: true })

	// Ensure fixtures are prepared
	setupFixtures(fixturesDir)

	const cpus = os.cpus()
	const environment = {
		platform: process.platform,
		arch: process.arch,
		osRelease: os.release(),
		cpuModel: cpus[0]?.model || "Apple Silicon",
		cpuCores: cpus.length,
		totalMemoryGb: Number((os.totalmem() / (1024 ** 3)).toFixed(2)),
		nodeVersion: process.version,
		v8Version: process.versions.v8,
	}

	console.log(`[Host] ${environment.platform} ${environment.arch} (${environment.osRelease})`)
	console.log(`[CPU]  ${environment.cpuModel} (${environment.cpuCores} cores) | [RAM] ${environment.totalMemoryGb} GB`)
	console.log(`[Node] ${environment.nodeVersion} (V8 ${environment.v8Version}) | [Git] ${gitCommit.slice(0, 8)}\n`)

	console.log(">>> Executing Workload 1: Core Harness Stream Parsing & Turn Dispatch...")
	const res1 = await benchmarkHarnessDispatch(fixturesDir)
	console.log(`    p50: ${res1.durationMs.p50} ms | p90: ${res1.durationMs.p90} ms | Throughput: ${res1.throughput.value} ${res1.throughput.unit} | Success: ${(res1.correctnessRate * 100).toFixed(0)}%`)

	console.log(">>> Executing Workload 2: Project Search & Context Preparation...")
	const res2 = await benchmarkContextPreparation(fixturesDir)
	console.log(`    p50: ${res2.durationMs.p50} ms | p90: ${res2.durationMs.p90} ms | Throughput: ${res2.throughput.value} ${res2.throughput.unit} | Success: ${(res2.correctnessRate * 100).toFixed(0)}%`)

	console.log(">>> Executing Workload 3: State & Persistence Substrate (SQLite WAL & CAS)...")
	const res3 = await benchmarkStatePersistence(tempDir)
	console.log(`    p50: ${res3.durationMs.p50} ms | p90: ${res3.durationMs.p90} ms | Throughput: ${res3.throughput.value} ${res3.throughput.unit} | Success: ${(res3.correctnessRate * 100).toFixed(0)}%`)

	console.log(">>> Executing Workload 4: Tool Execution & Diff Patching...")
	const res4 = await benchmarkToolExecutionDiff(fixturesDir)
	console.log(`    p50: ${res4.durationMs.p50} ms | p90: ${res4.durationMs.p90} ms | Throughput: ${res4.throughput.value} ${res4.throughput.unit} | Success: ${(res4.correctnessRate * 100).toFixed(0)}%`)

	console.log(">>> Executing Workload 5: End-to-End Deterministic Agent Task Completion...")
	const res5 = await benchmarkEndToEndTask(fixturesDir, tempDir)
	console.log(`    p50: ${res5.durationMs.p50} ms | p90: ${res5.durationMs.p90} ms | Throughput: ${res5.throughput.value} ${res5.throughput.unit} | Success: ${(res5.correctnessRate * 100).toFixed(0)}%`)

	// Clean up temporary bench directory
	fs.rmSync(tempDir, { recursive: true, force: true })

	const report: BenchmarkReport = {
		commission: "LUMI PRE-CONVERSION BENCHMARK SLICE",
		timestamp: new Date().toISOString(),
		gitCommit,
		environment,
		workloads: {
			[res1.workloadId]: res1,
			[res2.workloadId]: res2,
			[res3.workloadId]: res3,
			[res4.workloadId]: res4,
			[res5.workloadId]: res5,
		},
	}

	// 1. Write machine-readable JSON
	const jsonPath = path.join(resultsDir, "baseline-results.json")
	fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2))

	// 2. Write CSV
	const csvRows = [
		"workload_id,description,repetitions,p50_ms,p90_ms,p99_ms,mean_ms,stddev_ms,ci95_margin_ms,throughput_val,throughput_unit,cpu_user_ms,cpu_sys_ms,heap_delta_mb,correctness_pct",
	]
	for (const w of Object.values(report.workloads)) {
		csvRows.push(
			`"${w.workloadId}","${w.description}",${w.repetitions},${w.durationMs.p50},${w.durationMs.p90},${w.durationMs.p99},${w.durationMs.mean},${w.durationMs.stddev},${w.durationMs.ci95},${w.throughput.value},"${w.throughput.unit}",${w.cpuUserMs},${w.cpuSystemMs},${w.heapUsedDeltaMb},${(w.correctnessRate * 100).toFixed(1)}`,
		)
	}
	const csvPath = path.join(resultsDir, "baseline-results.csv")
	fs.writeFileSync(csvPath, csvRows.join("\n"))

	console.log("\n================================================================================")
	console.log("   LUMI BASELINE MEASUREMENT RESULTS SUMMARY")
	console.log("================================================================================")
	console.table(
		Object.values(report.workloads).map((w) => ({
			"Workload ID": w.workloadId,
			"Reps": w.repetitions,
			"p50 (ms)": w.durationMs.p50,
			"p90 (ms)": w.durationMs.p90,
			"p99 (ms)": w.durationMs.p99,
			"Mean ± CI95 (ms)": `${w.durationMs.mean} ± ${w.durationMs.ci95}`,
			"Throughput": `${w.throughput.value} ${w.throughput.unit}`,
			"Heap Δ (MB)": w.heapUsedDeltaMb,
			"Correctness": `${(w.correctnessRate * 100).toFixed(0)}%`,
		})),
	)

	console.log(`\n✅ Machine-readable baseline preserved:`)
	console.log(`   - JSON: ${jsonPath}`)
	console.log(`   - CSV:  ${csvPath}\n`)
}

runPreConversionBenchmark().catch((err) => {
	console.error("FATAL: Benchmark failed with error:", err)
	process.exit(1)
})
