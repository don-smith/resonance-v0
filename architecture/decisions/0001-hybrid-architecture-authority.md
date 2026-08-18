# ADR-0001: Use hybrid authority for architecture validation

- **Status:** Accepted
- **Date:** 2026-08-17
- **Deciders:** Resonance maintainers
- **Technical area:** Architecture modeling and validation

## Context

Resonance needs architecture documentation that remains useful as the implementation changes. A diagram expresses intended structure, while repository code and configuration establish what is actually present. Treating either source as the sole authority would either make validation speculative or make architectural intent impossible to express. The rendered views also need to remain projections rather than becoming a second source of truth.

## Decision

Use a hybrid authority model:

- Implementation facts establish what exists.
- Authored LikeC4 models and architecture metadata establish intended structure.
- Views are projections of the authored model.
- Deterministic validation reports `pass`, `fail`, or `unknown`; an agent may explain or propose changes but cannot turn an assessment into a validation result.

This decision covers the Architecture package's model, evidence, and validation boundaries. It does not claim that every architectural relationship is currently executable or verifiable.

## Alternatives considered

### Code-only authority

This would make observed dependencies trustworthy but would discard decisions and intended relationships that are not yet mechanically discoverable.

### Diagram-only authority

This would preserve intent but could claim conformance without positive implementation evidence.

### Agent-only assessment

This would be flexible but non-deterministic and difficult to audit or reproduce.

## Consequences

### Benefits

- Intent and implementation evidence can be compared without conflating them.
- Validation remains deterministic and auditable.
- Unverifiable claims can remain visible as `unknown` instead of becoming false passes.

### Costs and trade-offs

- The model and implementation can temporarily disagree and require explicit investigation.
- Metadata and evidence links must be maintained alongside the model.
- Additional checkers are needed before authored relationships can be treated as executable constraints.

## Evidence

- `docs/architecture.md` — Defines implementation evidence, authored assertions, and views as distinct authorities.
- `docs/architecture-verification.md` — Defines deterministic `pass`, `fail`, and `unknown` semantics.
- `src/packages/architecture/architecture-checkers.ts` — Implements the validation boundary.

## Follow-up

Add deterministic observed-graph checks only when they can provide positive evidence for a meaningful architectural claim.
