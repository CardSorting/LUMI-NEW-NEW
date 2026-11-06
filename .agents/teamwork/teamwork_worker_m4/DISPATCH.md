# Task Assignment: Milestone 4 Final Monorepo Verification Worker

**Timestamp:** 2026-11-04T22:23:00Z  
**Worker:** `teamwork_worker_m4`  
**Working Directory:** `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_worker_m4/`  
**Target Workspace:** `/Users/bozoegg/Downloads/LUMI`  
**Milestone:** M4 — Final Verification, Monorepo Regression Testing & Full Verification Matrix  
**Orchestrator ID:** `5a83290e-eac1-48cd-9057-d64900999e6d`

---

## Mandatory Prerequisites

1. Read `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/ORIGINAL_REQUEST.md`
2. Read `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/PROJECT.md`
3. Read the previous worker handoffs:
   - `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_worker_m2/handoff.md` (M2 Workspace Audit)
   - `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_worker_m3_iter2/handoff.md` (M3 Hardening)
   - `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_worker_m1/handoff.md` (M1 Dynamic Knowledge)

---

## Scope & Verification Objective

Execute the comprehensive monorepo verification suite across all layers of LUMI and `agentswarm`:

1. **Type Checking & Protos:**
   - Execute: `npm run check-types`
   - Confirm exit code 0 and zero TypeScript compiler diagnostics across all tsconfigs (monorepo root and `webview-ui`).

2. **Linter & Code Hygiene:**
   - Execute: `npm run lint`
   - Confirm exit code 0 and zero Biome linter errors across all 1770 files.

3. **Multi-Agent Swarm Test Suite:**
   - Execute: `npm run test:swarm`
   - Confirm all 355+ tests pass with zero failures and exit cleanly in ~2 seconds.

4. **AgentSwarm Documentation Link Integrity:**
   - Execute: `npm run docs:check-agentswarm`
   - Confirm all 68 files, 432 links, 16 ADRs, and 17 post-mortems pass verification.

5. **Root Documentation & Metrics:**
   - Execute: `npm run docs:check-root-readme`
   - Execute: `npm run docs:check-readme-metrics`
   - Confirm all v26.4.0 tool counts and version badges match perfectly.

6. **Git Workspace Hygiene:**
   - Execute: `git status --short`
   - Confirm zero untracked scratch files outside `.agents/teamwork/`.

7. **Compile Final Monorepo Verification Matrix:**
   - Document each command, exit code, test count, duration, and verbatim output in `/Users/bozoegg/Downloads/LUMI/.agents/teamwork/teamwork_worker_m4/handoff.md`.

---

## MANDATORY INTEGRITY WARNING

DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.
