# Improve Telemetry

Owner: team

## Context

The P1 Telemetry decision (backlog/plans/telemetry.md, recently-done) established a working OTLP/HTTP export path to self-hosted Langfuse v4. The host creates a repository-scoped telemetry controller, sanitizes fields, exports to `/api/public/otel/v1/traces`, and batches up to 100 records. Architecture, Backlog, and Pi agents allocate session IDs, emit turn spans, and mark model-stream spans as generations. Content is redacted unless capture is enabled, and secrets are masked before export.

A research audit (`docs/research/langfuse-agent-improvement-loop.md`) identified nine concrete gaps that prevent the current telemetry from being evaluable. The most critical: trace semantics and parentage are wrong for v4 analysis, exporter delivery is lossy, generation telemetry is incomplete, and tool/retry behavior is invisible. The traces are not yet a reliable source of truth for quality, reliability, or efficiency dashboards.

This decision repairs those gaps and operationalizes the full agent-improvement loop described in the research: correct traces, deterministic scores, embedded human feedback, versioned datasets, calibrated judges, and prompt experiments.

## Scope of this work

### P0 — Make traces trustworthy

Retain the telemetry facade but implement it with supported OTel/Langfuse components or equivalent semantics:

- **One trace per turn, one session per conversation.** `session()` must not reuse a trace ID across turns; allocate a fresh trace per turn and a stable session per conversation. Runtime `child()` must not allocate a second trace ID. All spans within a turn share the same trace ID.
- **Parent/child span IDs.** Every span must set `parentSpanId` correctly: root `agent` observation at the turn level, with nested `generation` (model calls) and `tool` (tool executions) as children.
- **Use real OTel events** instead of separate spans for events, and ensure logs do not become root-level spans.
- **Filterable metadata.** Map `repository`, `package`, `provider`, selected path/view, request IDs, environment, release/commit, prompt version, and evaluator version to the documented Langfuse metadata prefixes and dedicated attributes.
- **Bounded exporter retry.** Replace the lossy pending-queue approach with a bounded retry/backoff queue — do not remove from pending before `fetch` completes. Add a queue bound and do not silently drop non-2xx responses. Consider using the supported OTel/Langfuse processor.
- **Forced-failure tests.** Assert that retry does not duplicate or lose the batch, and that a fresh trace per turn renders as one nested tree.

**Acceptance:** One turn renders as one nested tree in Langfuse; exporter retry does not duplicate or lose the batch.

### P0 — Capture model and tool attempts

- **Pass a tested callback** (LangChain/DeepAgents or equivalent generic) that emits each actual LLM request as a `generation` observation and each tool call as a `tool` observation.
- **Each generation** includes: input/output, model name, output/total/cache/reasoning token buckets, cost, model parameters, time-to-first-token, finish reason, and prompt version link.
- **Each tool observation** includes: input/output, status, attempt number, duration, and cost.
- **Retries are visible.** Architecture configures up to five provider retries; record attempt number, delay, outcome, and per-attempt cost. A forced retry and tool failure must be visible once, nested correctly, with reconciled usage.

**Acceptance:** A forced retry and tool failure are visible once, nested correctly, with reconciled usage.

### P1 — Establish the baseline without new product UI

- Create the score configs from the research score contract as immutable configs in Langfuse: `task_success`, `policy_compliance`, `artifact_valid`, `regression_tests_pass`, `tool_success`, `retry_count`, `user_helpful`, `felt_flow`, `flow_moment`, `change_quality`, `groundedness`, `instruction_following`.
- Annotate 25–50 representative turns with human scores.
- Add `felt_flow` to their containing sessions.
- Build three basic Langfuse dashboards:
  - **Quality:** task_success, user_helpful, change_quality, groundedness/instruction-following distributions, hard-gate pass rates.
  - **Reliability:** turn/error counts, tool success by tool, retry attempts, provider status/rate limits, incomplete traces.
  - **Efficiency:** p50/p95 turn and generation latency, input/output/cache/reasoning tokens, USD cost, cost per successful turn.
- Keep content capture narrowly allowlisted and masked; use an allowlist by package/observation plus deterministic client-side masking.

### P1 — Embed one-tap feedback

After stable turn identity exists (P0 trace work):

- Add `👍` / `👎` for `user_helpful` and `🌊` (wave) for a positive `flow_moment`.
- Backed by one constrained, idempotent server endpoint: `POST /api/agent-feedback`.
- The browser sends an opaque feedback-target ID plus a constrained value; it never receives Langfuse credentials or chooses arbitrary score names.
- The server resolves the target to both the turn's trace ID and root observation ID, validates the score config, and upserts using a deterministic score ID so repeated clicks do not create duplicate rows.
- Show controls only after a turn completes, visibly mark the current selection, allow a mistaken selection to be changed or removed.
- Make feedback submission asynchronous so a Langfuse failure never disrupts the agent UI.
- Optional reason prompt after `👎` may collect a categorical friction cause, but the initial click must remain one step.

**Acceptance:** Feedback is attached to the intended root turn, can be changed without duplication, and cannot cross sessions or select arbitrary scores.

### P1 — Publish deterministic scores idempotently

- Add a host-owned score sink or a small external analysis job.
- For each target: compute a stable score ID (UUIDv5 over `project | target-kind | target-id | score-name | evaluator-version`), set `name`, `configId`, target IDs, data type, value, comment/reasoning, and a stable timestamp (the target observation timestamp).
- Before writing, query Scores API v3 by ID; skip an identical payload, overwrite only the same evaluator version, and fail closed on target/config mismatch.
- Publish bounded batches with retry/backoff and flush before exit.
- Start with: `policy_compliance`, `artifact_valid`, `regression_tests_pass`, `tool_success`.
- A rerun must not increase score row count.

### P2 — Create one regression dataset per agent

- Begin with 15–30 cases each for Architecture and Backlog, including successes, known failures, permission/confirmation edges, malformed artifacts, provider/tool failures, and multi-turn context.
- Execute against temporary repository fixtures and pin dataset/fixture versions.
- Use Langfuse datasets with versioned dataset items (input, expected output, metadata, production-trace links).

### P2 — Calibrate one LLM judge

- Start with `groundedness`, because Architecture already has explicit evidence.
- Write anchored rubrics with counterexamples; label a representative, stratified set twice by two humans and adjudicate disagreements.
- Run the judge blind on a held-out subset. Inspect confusion matrices, Cohen's kappa, F1, and severe-failure recall.
- **Do not add more judge dimensions** until human agreement and severe-failure recall pass the stated policy: at least "substantial" agreement on the local rubric and severe-failure recall at least 90%.
- Version judge prompt, model, rubric, and mappings together; recalibrate on any change and periodically against fresh human labels.

### P3 — Version prompts and automate experiments

- Move only behavioral system prompts to Langfuse prompt management with a checked-in fallback.
- Link prompt versions to generations.
- Compare `candidate` against `production` labels using disposable fixtures.
- Leave promotion human-approved; prompt retrieval must never override Resonance's manifest or tool/write boundaries.
- Use immutable versions, movable labels, cached retrieval, and per-version metrics.

## Score contract

Create immutable score configs with descriptions and category anchors. Attach per-turn scores to the root agent observation, tool checks to the tool observation, whole-conversation judgments to the session, and experiment aggregates to the dataset run. Use favorable polarity for quality (true/larger is better); keep operational quantities explicitly lower-is-better.

| Score | Type | Producer | Meaning |
|---|---|---|---|
| `task_success` | Boolean; true better | Deterministic or human | Requested end state is present and all explicit acceptance criteria hold. |
| `policy_compliance` | Boolean; true better; hard gate | Deterministic | No disallowed path/credential/network action; required confirmation occurred. |
| `artifact_valid` | Boolean; true better; hard gate | Deterministic | Post-turn LikeC4/schema/YAML/link validation succeeds for the affected package. |
| `regression_tests_pass` | Boolean; true better; hard gate | Deterministic | The case's declared test/validation command completes successfully. |
| `tool_success` | Boolean on each tool; true better | Deterministic | Tool returned its declared success shape and did not throw or return a recoverable error. |
| `retry_count` | Numeric, min 0; lower better | Deterministic telemetry | Number of provider/tool attempts after the first within one turn. |
| `user_helpful` | Boolean; true better | Human/end user | User would accept the result without asking for a redo. |
| `felt_flow` | Categorical: smooth, mixed, frustrating | Human/end user (session) | The user's subjective experience of momentum and friction. |
| `flow_moment` | Boolean, positive-only | Human/end user | The user clicked the in-product flow control at this moment. |
| `change_quality` | Categorical: approve=1, revise=0.5, reject=0 | Human reviewer | Repository changes are correct, minimal, maintainable, and appropriate. |
| `groundedness` | Categorical: supported=1, partly=0.5, unsupported=0 | LLM judge (calibrated) | Material claims are supported by the supplied repository evidence/tool results. |
| `instruction_following` | Categorical: pass=1, minor=0.5, major=0 | LLM judge (calibrated) | Response follows explicit user requirements not already covered by deterministic checks. |

### Embedded feedback controls

- `👍` / `👎` map to `user_helpful` boolean on the root agent-turn observation.
- `🌊` writes `flow_moment=true` on the current root turn observation.
- Use one endpoint (`POST /api/agent-feedback`), not one per icon.
- Show controls only after a turn completes; allow change/removal; make submission async.

## Dashboards and operating loop

After dimensions are filterable, build three dashboards segmented by repository, package, environment, release, model, and prompt version:

1. **Quality:** task_success, user_helpful, change_quality, groundedness/instruction-following distributions, hard-gate pass rates, judge-vs-human coverage and disagreement.
2. **Reliability:** turn/error counts, tool success by tool, retry attempts, provider status/rate limits, incomplete traces, and no-data periods.
3. **Efficiency:** p50/p95 turn and generation latency, input/output/cache/reasoning tokens, USD cost, and cost per successful turn.

Create monitors only after a stable baseline: any `policy_compliance=false`, validity/test failures, sustained provider error rate, and statistically meaningful drops in task success or rises in p95 latency/cost. Keep alert thresholds and minimum useful sample sizes explicit; route alerts to investigation, not automatic prompt mutation.

The iterative loop:
1. Instrument one turn as a correct trace and collect usage/tool/retry telemetry.
2. Apply deterministic scores to all eligible turns; sample human and judge scores.
3. Triage failures and disagreements; add corrected outputs and minimal reproducible cases to a versioned dataset.
4. Run baseline and candidate code/model/prompt versions on disposable fixtures. Compare the score vector and operational budgets; block on any hard-gate regression.
5. Human-review changed outputs and patches. Promote a candidate prompt label only after approval.
6. Monitor live slices, roll back the label/config on regression, and feed novel failures into the dataset.

## Sampling policy

- **Tracing:** 100% while local volume is small and trace correctness is being established.
- **Offline experiments:** evaluate every item; pin the dataset version and fixture Git revision.
- **Live deterministic checks:** run on every eligible root/tool observation when cheap.
- **Live LLM judge:** begin at 5–10% of eligible root observations, using separate evaluator rules for important strata.
- **Human review:** each cycle annotate a stratified batch: all user-negative/policy/validity failures up to capacity, high-cost/retried and judge-uncertain cases, plus an untouched random control slice.

## Idempotent analysis-agent publication

Run the analysis agent out of process with read-only access to Langfuse observations/metrics and write access only to scores (and, after review, dataset candidates). For each target:
1. Select one immutable target (root turn observation) and one immutable score config.
2. Compute a stable score ID (UUIDv5 over `project | target-kind | target-id | score-name | evaluator-version`).
3. Set name, configId, target IDs, data type, value, complete comment/reasoning, and a stable timestamp (the target observation timestamp).
4. Before writing, query Scores API v3 by ID; skip an identical payload, overwrite only the same evaluator version, and fail closed on target/config mismatch.
5. Publish bounded batches with retry/backoff and flush before exit.

## Non-goals

- A single weighted `overall_quality` score. Decide releases with a vector of hard gates, utility non-inferiority, and cost/latency budgets.
- Replacing the telemetry facade with a Langfuse-only SDK. The facade remains authoritative for domain safety rules.
- Automatic prompt mutation based on metric regression. All prompt promotion is human-approved.
- Replacing human annotation with LLM judges for safety or deployment gates.
- Symbol-level agent callbacks beyond the model/tool observation scope described here.
- Automatic architecture discovery or inference (covered by the Arch validation decision).

## Relationship to "Telemetry" (recently-done)

The P1 Telemetry decision established the initial OTLP/HTTP export path, session IDs, and turn spans. This decision repairs the trace semantics that make those traces unevaluable, adds model/tool/retry capture, implements the score contract, embeds human feedback, creates datasets and experiments, calibrates judges, and versions prompts. The two decisions are sequential: Telemetry built the pipeline; Improve Telemetry makes it trustworthy and actionable.

## Completion criteria

This decision is complete when:

1. One agent turn renders as one nested tree in Langfuse with a single trace ID, correct parent/child span IDs, and a stable session ID across turns.
2. Exporter retry does not duplicate or lose batches; forced-failure tests pass.
3. Each LLM request is emitted as a `generation` observation with exclusive token buckets, cost, model parameters, finish reason, and prompt version link.
4. Each tool call is emitted as a `tool` observation with input/output, status, attempt number, duration, and cost.
5. Provider retries (attempt number, delay, outcome, per-attempt cost) are visible as nested observations; a forced retry and tool failure are visible once.
6. `repository`, `package`, `provider`, environment, release/commit, and prompt version are filterable Langfuse attributes.
7. Score configs for all 12 scores in the contract exist as immutable configs in Langfuse.
8. `POST /api/agent-feedback` exists and supports `user_helpful` (👍/👎) and `flow_moment` (🌊) with idempotent upsert, cross-session rejection, and async submission.
9. Deterministic scores (`policy_compliance`, `artifact_valid`, `regression_tests_pass`, `tool_success`) are published idempotently; a rerun does not increase score row count.
10. At least one regression dataset exists per agent (Architecture, Backlog) with 15–30 cases each, executed against disposable fixtures.
11. The `groundedness` LLM judge is calibrated with human agreement at least "substantial" and severe-failure recall at least 90%.
12. Three Langfuse dashboards (Quality, Reliability, Efficiency) are built and filterable by repository, package, environment, release, model, and prompt version.
13. At least one behavioral system prompt is managed via Langfuse prompt management with a checked-in fallback, linked to generations, and comparable via experiment.
14. `bun test` passes.
15. Documentation explains the trace model, score contract, feedback controls, and how to interpret dashboards.