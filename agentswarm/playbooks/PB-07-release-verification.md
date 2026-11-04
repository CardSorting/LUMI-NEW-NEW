# PB-07 — Release verification checklist

```bash
# 1. Types
npx tsc --noEmit && npx tsc -b webview-ui --pretty false

# 2. Backend suites (expect 190 passing tests across Auxiliary, Orchestrator, Legion Host/Adapter/Task, Engage Swarm, ToolSet Discovery, State Keys, Codex Streaming deduplication, and StreamResponseHandler self-healing)
npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha --no-config --timeout 20000 \
  --require ts-node/register --require tsconfig-paths/register --require ./src/test/requires.cjs \
  src/infrastructure/ai/__tests__/AgentSwarmAuxiliary.test.ts \
  src/infrastructure/ai/__tests__/Orchestrator.test.ts \
  "src/core/task/legion/__tests__/*.test.ts" \
  src/core/task/tools/handlers/__tests__/EngageSwarmHandler.test.ts \
  src/core/prompts/system-prompt/__tests__/DietCodeToolSetSwarm.test.ts \
  src/shared/storage/__tests__/state-keys.test.ts \
  src/core/api/__tests__/openai-codex.streaming.test.ts \
  src/core/task/__tests__/StreamResponseHandler.test.ts

# 3. Settings UI (expect 7 passing tests)
(cd webview-ui && npx vitest run src/components/settings/sections/FeatureSettingsSection.test.tsx)

# 4. Lint (error level) on touched files
npx biome lint --diagnostic-level=error <files>

# 5. Protos regenerate cleanly
npm run protos

# 6. No leftovers
grep -rn "DEBUG\|console.error" src/infrastructure/ai/ | grep -v __tests__
```

## Manual (not yet performed at authoring time)
- Launch the extension; open Settings → Preferences; apply each preset; reload; confirm persistence.
- With a real task: enable Review; trigger `attempt_completion`; confirm `REMEDIATE`/`ESCALATE` block and `ACCEPT` pass through.
- With Defer enabled and a parent with children: defer, observe `suspended`, resume.
- Confirm defaults after a clean profile: Legion on; Review and Defer off. Verify an explicit Legion opt-out persists.

## Gate
All automated steps green **and** the manual smoke recorded in the PR.
