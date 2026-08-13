# Architecture review skill

Owner: team

## Context

The Architecture package provides validation checkers that produce `pass`/`fail`/`unknown` results, and the **Arch validation** decision (`backlog/plans/arch-validation.md`) is repairing trust defects in that pipeline. However, there is currently no dedicated agent skill that produces a structured, human-readable architecture review report.

The agent can run `validate_architecture` and get raw results, but the output format is not enforced — it does not distinguish verified conformance from verified violations, unresolved questions, and qualitative agent assessment. A dedicated review skill would give the agent a consistent, repeatable way to inspect the codebase, run checkers, and produce a review that a developer (or another agent) can act on.

This skill is also a key part of the onboarding experience: when a developer enables the Architecture workspace for a new or unfamiliar repository, the agent should be able to explore the codebase, construct its understanding of the observed architecture, and produce a structured review that highlights what's verified, what's violated, what's unclear, and what the agent recommends.

## Scope of this work

### 1. Define the review skill interface

- A dedicated agent skill (tool or command) that the Architecture agent can invoke.
- The skill accepts a scope parameter (e.g., a specific package, a view, or the entire model).
- The skill produces a structured report with four distinct sections:
  - **Verified conformance** — assertions where deterministic evidence confirms the intended architecture is followed.
  - **Verified violations** — assertions where deterministic evidence confirms a deviation from the intended architecture.
  - **Unresolved questions** — assertions where no deterministic evidence was found (the `unknown` case), including what evidence was sought and what was missing.
  - **Qualitative assessment** — the agent's judgment about overall health, risk areas, and recommendations.

### 2. Implement the review workflow

- The skill runs the relevant checkers from the validation pipeline (via the checker registry).
- The skill gathers additional evidence through read-only repository inspection (package manifests, directory layout, dependency graph, source symbols).
- The skill cross-references findings against the intended graph (LikeC4 model) and the observed graph (extracted facts).
- The skill does not modify any files — it is read-only by design.

### 3. Support scoped and full reviews

- **Full review** — runs all checkers against the entire model and codebase.
- **Scoped review** — targets a specific package, view, element, or relationship.
- The skill reports which scope was reviewed and what was excluded.

### 4. Document the review format

- Document the expected report structure so developers and agents can interpret results consistently.
- Document how to request a review, how to interpret each section, and how to act on findings.

## Non-goals

- Automatic or scheduled reviews (reviews are on-demand only).
- Persisted review results treated as authoritative state.
- Modifying the codebase or model as part of the review.
- Replacing the validation checkers — the review skill consumes checker results, it does not reimplement them.
- A CLI/CI adapter for running reviews outside the workspace.

## Relationship to other decisions

- **Arch validation** (`backlog/plans/arch-validation.md`) — repairs trust defects in the validation pipeline and introduces the intended-vs-observed graph model. The review skill consumes those checker results and the graph model to produce its reports.
- **Express architecture** (`backlog/plans/express-architecture.md`) — established the checker scaffolding and the explain skill. The review skill is a complementary agent capability.
- **Architecture authoring skill** (`backlog/plans/architecture-authoring-skill.md`) — the authoring skill creates and edits model elements; the review skill inspects and reports on them. Together they form a complete agent workflow for architecture management.

## Completion criteria

This decision is complete when:

1. The Architecture agent has a dedicated review skill that can be invoked with an optional scope parameter.
2. The skill produces a structured report with four distinct sections: verified conformance, verified violations, unresolved questions, and qualitative assessment.
3. The skill runs the relevant checkers from the validation pipeline and incorporates their results.
4. The skill gathers additional evidence through read-only repository inspection (package manifests, directory layout, dependency graph).
5. The skill cross-references findings against the intended graph (LikeC4 model) and the observed graph (extracted facts).
6. The skill supports both full reviews (entire model) and scoped reviews (specific package, view, element, or relationship).
7. The report format is documented so developers and agents can interpret results consistently.
8. The skill is read-only — it does not modify any files.
9. `bun test` passes.