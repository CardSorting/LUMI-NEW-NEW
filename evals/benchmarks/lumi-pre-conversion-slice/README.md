# LUMI: Pre-Conversion Benchmark Slice

**Commission:** LUMI — Pre-Conversion Benchmark Slice  
**Commissioning Authority:** MAJO, Executive Chair  
**Principal:** EGG  
**Execution Agent:** Deputy Gemini  
**Phase:** Baseline measurement before any language conversion  
**Baseline Git Revision:** `e0a200fc38ee025c3928ba24b5c9bd3f368d870e`

---

## 1. Overview & Purpose

This directory contains the standalone, reproducible benchmark slice for the **LUMI agent harness**. It establishes an empirical baseline of the existing TypeScript/Node.js implementation across the critical dimensions of harness performance before any language rewrite or conversion is attempted.

Per executive mandate, this slice:
* Exercises the **actual production code** (`parseAssistantMessageV2`, `ActionExecutor`, `constructNewFileContent`, SQLite WAL CAS, and TokenService) rather than synthetic isolated loops.
* **Separates local harness execution from upstream model inference**, ensuring that network jitter and LLM API queue times do not obscure harness performance.
* Produces machine-readable outputs (`results/baseline-results.json` and `results/baseline-results.csv`) and enforces a formal [Conversion Comparison Contract](file:///Users/bozoegg/Downloads/LUMI/evals/benchmarks/lumi-pre-conversion-slice/contract.json).

---

## 2. Benchmark Architecture: The 5 Workloads

| Workload ID | Name | Core Components Exercised | Sample Size ($N$) | Warmup |
|---|---|---|---|---|
| `1_harness_stream_dispatch` | Core Harness Stream & Turn Dispatch | `parseAssistantMessageV2`, `ActionExecutor` FIFO reservation | 50 | 5 |
| `2_project_search_context_prep` | Project Search & Context Preparation | Workspace traversal, regex scanning, `TokenService` | 30 | 5 |
| `3_state_persistence_cas` | State & Persistence Substrate | SQLite WAL transaction commits, CAS point-seek, state hydration | 50 | 5 |
| `4_tool_diff_patching` | Tool Execution & AST Diff Patching | `constructNewFileContent` fuzzy diff, `ActionExecutor` backoff | 50 | 5 |
| `5_end_to_end_agent_cycle` | End-to-End Agent Task Completion | Deterministic 4-turn lifecycle (discover -> read -> diff -> verify) | 20 | 3 |

---

## 3. Measured Baseline Results (Apple Silicon Darwin arm64)

* **Host Platform:** Apple Silicon ARM64 (Darwin 25.5.0 / macOS 15.6)
* **Compute Architecture:** Apple M1 Pro (10 cores)
* **Memory Substrate:** 16 GB Unified Memory
* **Node.js Runtime:** v26.8.1 (V8 Engine v14.6.202.34-node.28)
* **Database Engine:** `better-sqlite3` v13.0.3 (SQLite 3.48+ WAL Mode)

### Summary Statistics

| Workload ID | p50 Latency | p90 Latency | p99 Latency | Mean ± CI95 | Throughput | Peak Heap Δ | Correctness |
|---|---|---|---|---|---|---|---|
| `1_harness_stream_dispatch` | **2.90 ms** | 7.56 ms | 13.16 ms | 3.91 ± 0.63 ms | **1,279 turns/sec** | +2.60 MB | **100%** |
| `2_project_search_context_prep` | **0.63 ms** | 0.84 ms | 0.86 ms | 0.67 ± 0.03 ms | **37,325 files/sec** | -0.99 MB | **100%** |
| `3_state_persistence_cas` | **0.12 ms** | 0.14 ms | 0.51 ms | 0.13 ± 0.02 ms | **230,769 ops/sec** | +0.75 MB | **100%** |
| `4_tool_diff_patching` | **0.017 ms** | 0.025 ms | 0.115 ms | 0.019 ± 0.004 ms | **2.12M lines/sec** | +0.18 MB | **100%** |
| `5_end_to_end_agent_cycle` | **0.73 ms** | 0.93 ms | 1.10 ms | 0.75 ± 0.05 ms | **5,329 steps/sec** | -0.46 MB | **100%** |

---

## 4. How to Reproduce

From the repository root (`/Users/bozoegg/Downloads/LUMI`):

```bash
# 1. Regenerate standard project fixtures (deterministic)
npx tsx evals/benchmarks/lumi-pre-conversion-slice/fixtures/setup-fixtures.ts

# 2. Run the complete benchmark slice and generate fresh results
npx tsx evals/benchmarks/lumi-pre-conversion-slice/runner.ts
```

The runner automatically updates:
* [baseline-results.json](file:///Users/bozoegg/Downloads/LUMI/evals/benchmarks/lumi-pre-conversion-slice/results/baseline-results.json)
* [baseline-results.csv](file:///Users/bozoegg/Downloads/LUMI/evals/benchmarks/lumi-pre-conversion-slice/results/baseline-results.csv)

---

## 5. Conversion Comparison Protocol

When comparing a future compiled implementation (e.g., Rust, Go):

1. **Strict Equivalence:** The future implementation must implement the workloads described in `contract.json`.
2. **Deterministic Inputs:** Do not feed live LLM API responses. Feed the exact 5-turn XML stream defined in `contract.json`.
3. **Artifact Verification:**
   - The patched `target-controller.ts` must produce SHA-256:  
     `df96eb498477e39216e5fd3246271c0c7a860c35bc8d4d5ab764320791ccdf6f`
   - All 5 tool uses must be dispatched without dropping parameters.
   - The end-to-end task must verify all 4 lifecycle steps in sequence.
4. **Environment Isolation:** Run both harnesses on identical hardware with clean process start and comparable memory metrics.
