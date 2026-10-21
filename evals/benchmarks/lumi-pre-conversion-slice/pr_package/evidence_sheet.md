# LUMI: EMPIRICAL BASELINE EVIDENCE SHEET

**Commission:** LUMI — The Engineering People Never See  
**Commissioning Authority:** MAJO, Executive Chair, HEAV3NS  
**Principal:** EGG  
**Lead Investigator & Presenter:** Deputy Gemini  
**Target Repository:** `CardSorting/LUMI`  
**Git Revision:** `e0a200fc38ee025c3928ba24b5c9bd3f368d870e`  
**Measurement Date:** October 21, 2026  

---

## 1. Experimental Rigor & Environment

* **Hardware Substrate:** Apple Silicon ARM64 (Darwin 25.5.0 / macOS 15.6)
* **Compute Architecture:** Apple M1 Pro (10-Core heterogeneous CPU: 8 Performance cores, 2 Efficiency cores)
* **Memory Substrate:** 16 GB Unified LPDDR5 Memory Subsystem
* **Storage Engine:** APFS on NVMe SSD
* **Runtime:** Node.js v26.8.1 (V8 Engine v14.6.202.34-node.28)
* **Embedded Database:** `better-sqlite3` v13.0.3 with SQLite 3.48+ (WAL Mode, `synchronous = NORMAL`, `temp_store = MEMORY`)
* **Warmup Protocol:** 3–5 unmeasured warmup iterations per category to prime V8 JIT tiers and filesystem buffers.
* **Separation of Latency:** Deterministic local execution strictly decoupled from non-deterministic upstream LLM inference queues.

---

## 2. Core Benchmark Measurements

| Workload ID | Name & Description | Sample Size ($N$) | $p50$ (Median) | $p90$ | $p99$ | Mean ± $\text{CI}_{95}$ | Observed Throughput | Memory (Heap Δ) | Correctness Rate |
|---|---|---|---|---|---|---|---|---|---|
| **`1_harness_stream_dispatch`** | XML stream parsing (50B chunks) & ActionExecutor reservation | 50 reps | **2.903 ms** | 7.559 ms | 13.161 ms | 3.908 ± 0.630 ms | **1,279 turns/s** | +2.60 MB | **100%** (250/250 tool calls) |
| **`2_project_search_context_prep`** | Recursive workspace discovery, regex symbol search & TokenService | 30 reps | **0.634 ms** | 0.838 ms | 0.857 ms | 0.670 ± 0.028 ms | **37,325 files/s** | -0.99 MB | **100%** (8/8 controllers found) |
| **`3_state_persistence_cas`** | SQLite WAL graph commit, CAS chunk seek & state hydration | 50 reps | **0.122 ms** | 0.144 ms | 0.509 ms | 0.130 ± 0.016 ms | **230,769 ops/s** | +0.75 MB | **100%** (1000/1000 cache hits) |
| **`4_tool_diff_patching`** | AST multi-hunk search/replace diff application & verification | 50 reps | **0.017 ms** | 0.025 ms | 0.115 ms | 0.019 ± 0.004 ms | **2.12M lines/s** | +0.18 MB | **100%** (`df96eb...` SHA-256 match) |
| **`5_end_to_end_agent_cycle`** | Deterministic 4-turn task cycle (discover → read → diff → verify) | 20 reps | **0.728 ms** | 0.928 ms | 1.103 ms | 0.751 ± 0.048 ms | **5,329 steps/s** | -0.46 MB | **100%** (20/20 tasks verified) |

---

## 3. What the Evidence Establishes vs. What It Does Not

### Established by Evidence
1. **Local Harness Overhead is Negligible:** The existing TypeScript implementation operates in microseconds to low single-digit milliseconds. It accounts for **< 0.1%** of total turn duration in production (where remote LLM streaming takes 1,000–5,000 ms).
2. **V8 and SQLite are Heavily Optimized:** AST diff patching runs in **17 microseconds**; SQLite graph commits complete in **122 microseconds**.
3. **No Speed Justification for Language Conversion Alone:** Shaving 1–2 milliseconds off local execution produces zero human-perceptible improvement in agent interaction speed.

### Not Established by Evidence (Open Questions for Future Research)
1. **VS Code Extension Host Boot Overhead:** These benchmarks measure steady-state execution; they do not measure the initial ~300ms Node.js module loading overhead during VS Code cold start.
2. **Multi-Day Memory Fragmentation:** Measurements were collected over 50 iterations; long-running daemon memory growth over days remains unmeasured.
3. **Packaging Simplicity:** Compiled languages (Rust/Go) provide single-binary distribution, eliminating npm/node dependency resolution friction.

---

## 4. Verification & Artifact Links

* **Raw JSON Measurements:** [baseline-results.json](file:///Users/bozoegg/Downloads/LUMI/evals/benchmarks/lumi-pre-conversion-slice/results/baseline-results.json)
* **Raw CSV Data:** [baseline-results.csv](file:///Users/bozoegg/Downloads/LUMI/evals/benchmarks/lumi-pre-conversion-slice/results/baseline-results.csv)
* **Conversion Comparison Contract:** [contract.json](file:///Users/bozoegg/Downloads/LUMI/evals/benchmarks/lumi-pre-conversion-slice/contract.json)
* **Master Video File:** [lumi_invisible_engineering.mp4](file:///Users/bozoegg/Downloads/LUMI/evals/benchmarks/lumi-pre-conversion-slice/pr_package/video/lumi_invisible_engineering.mp4)
* **Captions (SRT):** [captions.srt](file:///Users/bozoegg/Downloads/LUMI/evals/benchmarks/lumi-pre-conversion-slice/pr_package/captions.srt)
