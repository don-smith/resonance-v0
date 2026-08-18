---
name: write-adr
description: Use when a user wants to record, propose, accept, supersede, or explain an architectural decision as an Architecture Decision Record (ADR).
---

# Write an architectural decision record

Use this skill when the user asks to document an architectural decision, create an ADR, capture a decision already made, or turn an architecture discussion into a durable record. ADRs belong in `architecture/decisions/` and are the narrative source for why a decision was made.

## Grounding and decision status

1. Read `architecture/decisions/` before creating a record. Do not reuse an existing number or duplicate an existing decision.
2. Inspect the relevant architecture artifacts, repository code, and documentation before describing the context or consequences. Treat evidence as support for the record, not as proof that a decision was accepted.
3. Separate **decision** from **assessment**. Never present an inferred preference as an accepted decision.
4. If the user has not confirmed the decision, write it as `Proposed` or ask a focused question before recording it as `Accepted`.
5. If one discussion contains independent choices, create separate ADRs and link their relationship rather than hiding multiple decisions in one record.

## Naming and placement

- Use the next available zero-padded number: `0001`, `0002`, ... .
- Use a short lowercase kebab-case filename, for example `architecture/decisions/0003-package-route-namespacing.md`.
- Keep an ADR immutable in spirit. To change an accepted decision, create a new ADR and mark the old record `Superseded`; do not rewrite history to make the old decision disappear.
- Keep the index in `architecture/decisions.json` synchronized with the ADR. Its `path` points to the ADR, and its `evidence` includes the ADR plus any important supporting files. Preserve the existing metadata schema and require explicit confirmation before changing an accepted decision.

## Canonical template

Copy this structure, replace every bracketed value, and remove sections that genuinely do not apply. Do not leave placeholder text in a committed ADR.

```markdown
# ADR-NNN: Short decision title

- **Status:** Proposed | Accepted | Rejected | Superseded
- **Date:** YYYY-MM-DD
- **Deciders:** Names or team
- **Technical area:** The bounded architecture area affected
- **Supersedes:** ADR-NNN, if applicable
- **Superseded by:** ADR-NNN, if applicable

## Context

What problem, constraint, or change prompted this decision? Describe the relevant forces and the scope. Link to supporting repository evidence where useful.

## Decision

State the decision directly and concretely. Describe what is in and out of scope. This section must be understandable without reconstructing the conversation.

## Alternatives considered

### Alternative: Name

Why it was considered and why it was not selected.

## Consequences

### Benefits

- Concrete benefit.

### Costs and trade-offs

- Concrete cost, risk, or constraint.

## Evidence

- `path/to/file` — What this file establishes.

## Follow-up

Outstanding work, validation, migration, or review conditions. Write `None` when there is no follow-up.
```

## Completion checklist

Before reporting the ADR as complete:

- [ ] The status matches what the user actually decided.
- [ ] The context explains the forces, not just the implementation.
- [ ] The decision is a direct, testable statement.
- [ ] At least one meaningful alternative and its rejection are recorded, or the ADR explains why no alternative was viable.
- [ ] Benefits and trade-offs are explicit.
- [ ] Evidence paths are repository-relative and exist.
- [ ] The filename is unique and the ADR number is not reused.
- [ ] `architecture/decisions.json` points to the ADR when the Architecture metadata index is in use.
- [ ] Any accepted or superseding decision change has the user's explicit confirmation.
