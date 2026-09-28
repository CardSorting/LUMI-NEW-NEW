# Completion results and change walkthroughs

Completed work now has one persistent result: the summary, recorded completion checks, and actions to review or explain the changes. Streaming summaries remain drafts until the completion gates accept them.

## Familiar patterns

| Reference | Applied behavior |
| --- | --- |
| [GitHub Actions: inspecting workflow progress](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph) | Show a compact status summary, then let the user expand individual check outcomes and evidence. |
| [Atlassian: success messages](https://atlassian.design/foundations/content/designing-messages/success-messages) | Lead with a short outcome and useful next actions. Keep internal gate terminology out of successful results. |
| [IBM Carbon: notifications](https://carbondesignsystem.com/components/notification/usage/) | Keep status and recovery beside the affected result. Avoid another success notification for each completed stage. |
| [VS Code: progress and cancellation](https://code.visualstudio.com/api/ux-guidelines/notifications#progress-notification) | Keep generation progress beside the result, report observed activity, and provide a Stop action. |
| [GitHub: reviewing proposed changes](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/reviewing-proposed-changes-in-a-pull-request) | Keep explanations anchored to the relevant saved file and line, with the full diff available while explanations arrive. |

The implementation uses LUMI's existing VS Code theme tokens and controls. These references inform the interaction structure; they are not visual templates.

## Findings addressed

| Finding | Change |
| --- | --- |
| Successful gate notices exposed XML and stale failure details. | Keep machine diagnostics internal; attach a typed review snapshot to the result. Render older standalone gate envelopes as readable notices. |
| Streaming output looked complete before validation. | Use “Preparing result” until acceptance; hide final controls and passed checks on drafts. Remove abandoned completion drafts before another validation attempt. |
| Skipped checks could be confused with verification. | Distinguish Passed, Not run, Running, and Not verified. Expand unresolved command evidence by default. |
| Review evidence could disappear in transport or change with current settings. | Persist a versioned snapshot in message history and protobuf transport. Validate it before rendering; old records explicitly state that details were not recorded. |
| A prior command could appear to verify a later result. | Match only command execution recorded during the current attempt. Require a completed command with exit code 0 before showing Passed. |
| Healthy readiness messages repeated the successful result. | Keep the healthy path quiet. Show readiness and recovery guidance when attention is required. |
| Repeated clicks and failed requests could leave review actions stuck. | Deduplicate in-flight requests, show busy labels, restore controls on settlement, and display contextual recovery. |
| Snapshot and generation errors could resolve as success. | Propagate failures to the result card. Give recognized unavailable-snapshot and disabled-checkpoint states specific recovery text. Keep raw provider errors in diagnostics. |
| Walkthroughs accessed private fields from the single-workspace checkpoint manager. | Both checkpoint implementations expose the same typed saved-diff API, shared by the diff viewer and walkthrough. |
| Walkthroughs with three or more files moved editor focus as comments arrived. | Open the complete diff first, then stream inline explanations without moving focus between files. |
| Narrow layouts, enlarged text, duplicate copy controls, and small targets increased friction. | Use one copy action, wrapping text, stacked actions when needed, and controls at least 44px high. |
| Check-summary text lost contrast on hover. | Use the theme's foreground token for the status summary instead of muted description text. |

## Evidence boundaries

- A task checklist records items **marked complete**; it does not prove tests ran.
- Workspace audit status comes from the actual gate decision and preserves its score and policy threshold, including zero values.
- A second review means completion was confirmed on another attempt; it is not an independent automated test suite.
- A demo command is passed only after an observed successful exit. Background commands remain Running in the saved snapshot, with instructions to check the terminal.
- The review describes the moment of completion. It is not a live monitor of later commands or settings.
- Legacy or malformed records never acquire invented passed checks.

## Verification

Regression coverage includes blocked-to-success attempts, abandoned drafts, audit-disabled results, fresh command evidence, message persistence and transport, old XML notices, keyboard disclosure, duplicate requests, errors and retries, saved snapshot selection, multi-workspace diffs, stable walkthrough focus, and interrupted generation.

| Check | Result |
| --- | --- |
| Targeted backend regression suites | 186 passed |
| Completion UI, operation store, transport, and gate-strip tests | 28 passed |
| Backend TypeScript and webview TypeScript | Passed |
| Webview production build and extension production bundle | Passed |
| Protobuf generation and lint | Passed |
| Changed-file Biome check and whitespace check | No errors |
| Design detector on completion UI and chat integration | No findings |

Browser inspection covered 320px and 700px viewports, light and dark themes, forced high contrast, long paths, mixed-direction text, and 200% text sizing. The confirmation pass found no document overflow or clipped action labels, and measured interactive targets at least 44px high. It also identified muted summary contrast on hover; the final adjustment uses the same foreground token as the passing heading. No additional screenshot round was used after that adjustment.

The browser checks exercise the component in Storybook. Host interactions are covered through controller and checkpoint tests with mocked editor and model services. This is not a full live VS Code end-to-end run or a manual screen-reader certification. Existing unrelated lint and bundler warnings are outside this pass.

The reproducible component states are in `CompletionOutputRow.stories.tsx`; behavioral tests sit beside the UI, controller, checkpoint, and completion-gate implementations.

## Walkthrough lifecycle audit

The follow-up pass found six concrete gaps. The fixes extend the established result card with contextual progress, Stop, explicit completion, and recoverable partial output.

| Severity | Verified finding | Resolution |
| --- | --- | --- |
| P1 | The unary walkthrough request timed out after 60 seconds while host generation could continue. | Add a finite progress stream and connect cancellation to the provider's abort capability. Keep the old endpoint for compatibility. |
| P1 | The parser flushed incomplete lines, allowing network chunk boundaries to corrupt comment markers. | Parse complete lines, preserve Unicode and final lines, and test every possible split of representative output. |
| P1 | Unrecognized paths and invalid line numbers could create misplaced comments; relative document identities differed between workspace roots. | Accept only known files and valid line positions. Build diff and comment URIs through one helper using absolute paths and saved content. |
| P2 | Row-local state disappeared when virtual scrolling unmounted a result, permitting duplicate generation. | Keep operations in a bounded webview store; reject concurrent walkthroughs at the host as well. Unsubscribing a row does not stop generation. |
| P2 | Opening a walkthrough changed the global Comments preference and closed the bottom panel. | Remove those side effects and respect the user's editor layout and preferences. |
| P2 | Users could not stop generation or distinguish partial output from a finished walkthrough. | Show activity, delivered explanation counts, a Stop control, explicit terminal outcomes, and a clear Explain again action. Stopping preserves delivered output. |

The review remains usable while explanations are generated. The status reports explanations delivered and files containing explanations; it does not label generated comments as human review or imply that every changed file was explained. No estimated percentage or invented completion time is shown.

### Technical score and limits

| Dimension | Score | Evidence and remaining verification |
| --- | --- | --- |
| Accessibility | 3/4 | Keyboard Stop retains focus; status uses a live region, text, and icons. Screen-reader behavior in the full extension remains untested. |
| Performance | 3/4 | One active operation, bounded session history, cleaned-up listeners and timers, and no new dependencies. No full extension performance profile was run. |
| Responsive design | 4/4 | New states fit 320px and 700px previews, including 200% text and long mixed-script paths; measured controls remain at least 44px high. |
| Theming | 3/4 | Light, dark, and forced-color previews passed the text-contrast scan. Arbitrary third-party themes were not exhaustively tested. |
| Implementation integrity | 3/4 | Transport, terminal outcomes, stream parsing, cancellation, and document identity have regression coverage. Native host behavior was verified with mocked editor services. |
| **Total** | **16/20 — Good** | Scope is the completion/walkthrough flow, not a product-wide accessibility or quality certification. |

Implementation integrity passes for this scoped flow: progress comes from observed comment events, cancellation is wired through the transport, and displayed outcomes have explicit terminal states. The design detector reported no findings. This pass resolved all six verified findings above; the score records testing limits rather than claiming universal compliance.

The browser batch exercised loading, generation, completion, Stop, and failure with partial output. It found no horizontal document overflow, clipped controls, text-contrast failures, or page errors. The Stop interaction emitted transport cancellation and preserved keyboard focus. The browser used simulated host responses; real model latency and a live VS Code editor were not exercised.

For providers exposing `abort()`, Stop requests network cancellation. For providers without that capability, the UI and comment stream stop immediately and ignore late output; the provider may continue its underlying request until it settles. Walkthrough activity is session state and is not presented as persisted review history.
