# REPRODUCIBILITY AND LIMITATIONS
**Commission 012: Experimental Validation & Audit Boundaries**  
**Classification:** Internal Research / Restricted Distribution  
**Date:** October 17, 2026  
**Investigator:** Deputy Gemini  

---

### 1. Step-by-Step Reproduction Guide

To independently reproduce the benchmark results reported in `BENCHMARK-RESULTS.csv`, execute the following commands within the workspace environment:

```bash
# 1. Navigate to the repository root
cd /Users/bozoegg/Downloads/LUMI

# 2. Verify runtime dependencies
node -v    # Must be Node.js >= 22.14.0 or 23.6.0+ (Tested: v26.8.1)
npx tsx -v # Verify TypeScript execution environment

# 3. Execute the controlled benchmark harness
npx tsx scratch/commission_benchmark_runner.ts

# 4. Verify CSV output integrity
cat /Users/bozoegg/Downloads/LUMI/BENCHMARK-RESULTS.csv | head -n 15
```

The script runs completely non-destructively, creates its test tables in `/tmp/broccolibench_*.db`, executes the statistical passes, logs to stdout, updates `BENCHMARK-RESULTS.csv`, and cleans up all temporary SQLite files upon exit.

---

### 2. Experimental Limitations & Threats to Validity

#### 2.1 Claude Code Comparative Instrumentation Boundaries
* **External Reference Designation:** Anthropic’s published latency improvement figures (p90 TTFT dropping from 4.07s to 1.33s locally, and 16.99s to 6.00s in cloud sessions) were measured on Anthropic’s production infrastructure against live Claude 3.5 Sonnet endpoints.
* **Controlled Isolation:** Because live inference latency is subject to server load, queue wait, and geographic routing variations, our controlled tests separated **transport prefill latency** (client-side upload and compression) from **model generation latency**. Direct head-to-head figures reported in this study strictly compare client-side encoding, SQLite CAS seek times, and theoretical wire transmission.

#### 2.2 Synthetic Dataset Homogeneity
* Category 1 and Category 2 workloads utilized synthetic TypeScript code blocks. Real-world codebases with high non-repetitive entropy (e.g., dense binary assets, compressed minified bundles) may exhibit lower compression ratios (typically 65%–75% compared to the 85%–99% observed on repetitive source text).

#### 2.3 Local NVMe & Unified Memory Bias
* All tests ran on an Apple Silicon unified memory architecture with high-bandwidth NVMe storage. On systems utilizing mechanical hard drives or networked NFS mounts, SQLite WAL commit times (Category 5 & 6) may increase from ~0.7ms to ~3–5ms.

#### 2.4 Prompt Cache Interactions
* Server-side prompt caching (Anthropic `cache_control: ephemeral`) operates on tokenized prefixes after request decompression. While our client-side Gzip and CAS block reuse dramatically lowers upload time, it does not alter server-side cache hit ratios, provided token boundaries are strictly preserved.
