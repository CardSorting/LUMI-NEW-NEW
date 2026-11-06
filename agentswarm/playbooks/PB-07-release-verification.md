# PB-07 — Release verification checklist

```bash
# 1. Types
npx tsc --noEmit && npx tsc -b webview-ui --pretty false

# 2. Backend suites (expect 455 passing tests via npm run test:swarm, and 465 passing tests via npm run test:execution)
npm run test:swarm
npm run test:execution

# 3. Settings UI (expect 7 passing tests; 32 passing in full execution reliability suite)
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
