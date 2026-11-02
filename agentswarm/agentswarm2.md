Critical Completion Review

Purpose

Introduce an optional, configurable post-completion review capability that subjects completed agent tasks to rigorous adversarial scrutiny.

The purpose is to improve correctness, reliability, and execution quality by requiring an agent to challenge its own conclusions, examine the implementation against the original requirements, identify concrete failure modes, and make a decisive recommendation.

This feature must encourage intellectual honesty and decisive corrective action, not perpetual skepticism, speculative criticism, or infinite task generation.

1. Configuration

Expose a user-controlled setting:

Critical Completion Review

Enabled / Disabled

Default: Disabled

Scope: Configurable per agent, with the ability to override per task.

Trigger: After the agent reports its delegated task as complete.

Manual invocation: Allow the coordinator or user to request a review independently.

When disabled, the agent follows its normal completion and reporting behavior without additional adversarial review.

When enabled, the agent initiates one bounded critical review after completing its work.

2. Review mandate

The reviewing agent must independently examine:

Whether the original task requirements were satisfied.

Whether implementation decisions are consistent with the requested architecture and constraints.

Whether tests and verification actually demonstrate the claimed behavior.

Whether concrete defects, regressions, edge cases, or unaddressed failure modes remain.

Whether any remaining concerns materially affect correctness, security, reliability, or the requested outcome.

The review must challenge the implementation rather than merely validate the worker's confidence.

It must distinguish between:

Demonstrable defects.

Reproducible failures.

Requirements that were not satisfied.

Material risks supported by evidence.

Unverified assumptions.

Optional improvements.

Subjective architectural preferences.

These categories must never be conflated.

3. Evidence and criticism under pressure

The reviewing agent must not accept an implementation simply because tests pass or a worker reports success.

Conversely, it must not manufacture deficiencies to justify its review.

For every alleged defect, provide:

The affected component or implementation.

The relevant input or triggering condition.

Expected behavior.

Actual behavior or reproducible evidence.

Root cause, when established.

Recommended corrective action.

Hypothetical risks must be identified as hypothetical. Unverified behavior must be explicitly identified as unverified.

The agent must be willing to conclude that the implementation is correct.

4. Decisive resolution

Following review, the agent must reach one explicit decision:

A. ACCEPT
The implementation satisfies the requirements. No material defects warrant further work. Close the review.

B. REMEDIATE
One or more concrete defects or requirement failures justify corrective action. Produce a finite list of actionable corrections.

C. ESCALATE
A material uncertainty, architectural conflict, missing dependency, or decision outside the agent's authority prevents a defensible conclusion. Explain exactly what decision or evidence is required.

D. ACCEPT WITH DISCLOSED LIMITATIONS
The implementation satisfies the requested requirements, but certain non-blocking limitations remain. Document them without turning them into mandatory work.

The agent must justify its decision using evidence.

5. Corrective execution

When REMEDIATE is selected:

Convert confirmed findings into specific corrective tasks.

Prioritize by severity and impact.

Avoid expanding the scope beyond the original task without authorization.

Delegate corrective work where appropriate.

Verify the corrections.

Return for one final bounded review of the corrections.

Do not create new work merely because additional improvements are imaginable.

6. Coordinator orchestration

Maintain strict separation between coordinator, parent agent, and worker streams.

Workers operate in their own independent execution streams and inboxes.

Delegated workers report results to their designated coordinator.

Workers do not assume access to, or convergence with, other workers' inboxes.

The coordinator observes reports, evaluates alignment, and delegates actionable work.

The coordinator maintains the task roadmap and synchronization of delegated work.

The coordinator must not directly perform delegated implementation work when operating under a coordinator-only mandate.

The coordinator should incorporate confirmed review findings into the existing roadmap rather than automatically creating an unlimited chain of new tasks.

7. Termination conditions

The review must be bounded.

One initial adversarial review per completion event.

One corrective verification pass after remediation.

Further review requires a material new finding or explicit authorization.

No repetitive self-criticism.

No speculative defect generation.

No automatic reopening of accepted requirements.

No endless architectural reconsideration.

If the implementation passes review, the agent must declare completion and stop.

8. Final reporting

The coordinator receives a concise report containing:

Original task status.

Review decision.

Confirmed findings.

Corrective actions taken, if any.

Verification evidence.

Remaining limitations.

Final completion status.

The final report must distinguish verified results from unverified aspects.

Governing principle

Criticism must converge toward a decision.

The objective is not to make an agent permanently skeptical of its own work. The objective is to make it capable of defending its work under scrutiny, admitting when it is wrong, correcting demonstrated failures, and confidently declaring completion when the evidence supports it.

Challenge assumptions. Demand evidence. Correct actual defects. Make a decision. Stop.