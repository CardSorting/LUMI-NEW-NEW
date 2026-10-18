# BENCHMARK METHODOLOGY: COMMISSION 012
**Standardized Experimental Protocols for Agent Transport and Substrate Benchmarking**  
**Classification:** Internal Research / Restricted Distribution  
**Date:** October 17, 2026  
**Investigator:** Deputy Gemini  

---

### 1. Environmental & Hardware Baseline

All benchmark trials were executed within a controlled, isolated execution context under the following hardware and software specifications:

* **Host Platform:** Apple Silicon ARM64 (Darwin 24.6.0 / macOS 15.6)
* **Compute Architecture:** 10-core heterogeneous CPU (Performance + Efficiency)
* **Memory Substrate:** Unified LPDDR5 Memory Subsystem
* **Node.js Runtime:** v26.8.1 (V8 Engine v13.4.114)
* **Embedded Database Engine:** `better-sqlite3` v11.8.1 with SQLite 3.48.0 (WAL Mode enabled)
* **Compression Subsystem:** Node.js native `zlib` (libz 1.3.1 with SIMD vector extensions)
* **Network Stack:** Undici v7.16.0 / HTTP/2 & HTTP/1.1 Duplex Transport

---

### 2. The Eight Benchmark Categories

The benchmark suite systematically measures the eight distinct operational dimensions of agent context transfer and persistence:

#### Category 1: Cold Transport Egress
* **Objective:** Measure encoding CPU latency and wire compression ratios on fresh, un-cached conversation contexts.
* **Workload:** Synthetic multi-turn agent payloads ranging from 25 KB (~6,000 tokens) to 5.3 MB (~1.3M tokens) modeled on typical TypeScript source code and tool outputs.
* **Metric:** CPU encoding time (ms) and resulting wire payload size (bytes). $N = 20$ iterations per payload tier.

#### Category 2: Warm Transport Egress (CAS Multi-Turn Stream Assembly)
* **Objective:** Measure the efficiency of reusing pre-compressed RFC 1952 GZIP members from BroccoliDB's SQLite CAS cache vs. monolithic re-compression.
* **Workload:** 10-turn incremental conversation (500 KB cumulative). Turns 1–9 are pre-seeded into the CAS store.
* **Metric:** Time to synthesize the wire payload (ms). $N = 30$ trials.

#### Category 3: Context Retrieval & Query Latency
* **Objective:** Benchmark SQLite WAL point seek latency for content-addressed binary chunks.
* **Workload:** 200 distinct 512-byte compressed chunks seeded in SQLite table `compressed_chunks` (`WITHOUT ROWID`).
* **Metric:** Random point lookup latency in microseconds (µs). $N = 500$ trials.

#### Category 4: Structural AST Distillation / Context Truncation
* **Objective:** Quantify the reduction in context mass achieved by BroccoliDB's Spider Engine skeletonization.
* **Workload:** A realistic 40-method TypeScript controller class (12.6 KB). Spider preserves the active edit target (method 39) while skeletonizing the remaining 39 methods to structural type signatures.
* **Metric:** Raw file size vs. distilled skeleton size; reduction percentage.

#### Category 5: Session Persistence & Replay Hydration
* **Objective:** Measure the commit and restoration velocity of BroccoliDB's `RuntimeGraphStore`.
* **Workload:** Persisting a 50-node runtime state graph (audit, findings, gates, execution steps) into SQLite and re-hydrating the state into memory.
* **Metric:** Transaction commit latency (ms) and JSON state hydration latency (ms). $N = 25$ runs.

#### Category 6: Startup & Lifecycle Initialization
* **Objective:** Quantify the cold start penalty of initializing BroccoliDB's SQLite WAL database pool.
* **Workload:** Repeated creation, WAL pragma setup, and initial table verification.
* **Metric:** Initialization time from zero to operational readiness (ms). $N = 30$ runs.

#### Category 7: Multi-Agent Concurrency & Contention
* **Objective:** Measure write throughput and lock contention under multi-agent workloads.
* **Workload:** 1, 5, 10, and 20 concurrent simulated agent streams writing batches into SQLite.
* **Metric:** Aggregate throughput (operations per second) and total batch completion time (ms).

#### Category 8: Degraded Network / Simulated Uplink Latency
* **Objective:** Model end-to-end Time-to-First-Token (TTFT) prefill wait across realistic network constraints for a 2.5 MB raw payload.
* **Profiles:**
  1. *Mobile Tethering:* 5 Mbps upload, 120 ms RTT.
  2. *Standard Broadband:* 15 Mbps upload, 40 ms RTT.
  3. *High-Speed Office:* 50 Mbps upload, 15 ms RTT.
* **Metric:** Estimated upload wait time: $T = \text{RTT} + \frac{\text{Bytes} \times 8}{\text{Bandwidth}}$.

---

### 3. Sampling, Warmup & Statistical Rigor

To prevent transient JIT and disk buffer anomalies from skewing results:
1. **Warmup Protocol:** Every category executes 3 unmeasured warmup cycles prior to sample collection.
2. **Percentiles:** Reported as $p50$ (median), $p90$, and $p99$ to capture tail latency.
3. **Mean & Sample Variance:**
   $$\bar{x} = \frac{1}{N} \sum_{i=1}^N x_i, \quad s^2 = \frac{1}{N-1} \sum_{i=1}^N (x_i - \bar{x})^2$$
4. **95% Confidence Interval Margin:**
   $$\text{CI}_{95} = 1.96 \cdot \frac{s}{\sqrt{N}}$$

---

### 4. Integrity & Reproducibility Constraints

* **Synthetic Data Only:** Payloads were synthetically generated using repetitive TypeScript syntax patterns; no proprietary code, private keys, or customer data were introduced.
* **Isolated Temporary Storage:** All database benchmarks operated against `/tmp/broccolibench_*.db`, which was cleanly unlinked and destroyed upon suite completion.
