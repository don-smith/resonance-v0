# ADR-0003: Use the package contract as Resonance's extension seam

- **Status:** Proposed
- **Date:** 2026-08-17
- **Deciders:** Resonance maintainers
- **Technical area:** Package composition and extensibility

> This ADR records the extension architecture that is already implemented and proposes that we explicitly ratify it. Its status should become `Accepted` only after review.

## Context

Resonance needs one extension mechanism for both repository-selected team packages and developer-selected member packages. A package may need to contribute server routes, static assets, navigation, a browser entrypoint, package state, Tasks, and cleanup as one coherent feature. The host must compose these contributions without allowing a package to bypass route, asset, repository, or lifecycle safeguards.

The two package origins are different: team packages are loaded from the Resonance application checkout and selected by the viewed repository's checked-in `.resonance/config.json`; member packages are loaded from one external repository and selected by the viewed repository's ignored `.resonance/member-config.json`, subject to the member repository's checked-in `member-packages.json`. They nevertheless need the same runtime interface.

## Decision

Ratify `src/package-contract.ts` as the primary extension seam:

- A package exports a `PackageDefinition` containing metadata and a `register(context, input)` function.
- Registration returns one contribution bundle: method-aware routes, static assets, navigation, a browser entry and stylesheet, optional Tasks, and optional disposal.
- `loadConfiguredPackages()` is the explicit loading adapter. It reads allowlists, resolves modules only inside their package repository, binds configuration input, and adapts member navigation into the Personal Workspaces scope.
- `createHost()` is the composition root. It validates contributions transactionally, wraps route handlers with the package-specific `HostContext`, tracks the package root for assets, rejects duplicate IDs and contributions, and assembles the manifest consumed by the browser and server.
- Both team and member packages use this contract. Team definitions load before member definitions; a member package cannot reuse a team package ID. Shell is required and its failure is fatal; optional package failures are isolated, with member failures also surfaced as diagnostics.
- Routes are namespaced under `/api/<package-id>/...`; assets are namespaced under `/assets/<package-id>/...`. Shell alone has the fixed document and root-level bootstrap assets.
- Package handlers receive package-safe request and response capabilities and a host-owned context. Repository files must go through `HostContext.resolveRepositoryPath()`; package code does not receive Node HTTP objects or arbitrary host filesystem access.
- Package implementations must not import another package's implementation. Shared behavior crosses the package contract or an explicitly supported shared-module distribution seam. Member packages must not import the viewed application root.

The current contract requires every package registration to provide a browser entry and stylesheet, even if a package has little or no visible workspace. Keep that uniform contribution shape for now; revisit it only if headless packages become a real use case.

## Alternatives considered

### Convention-based package discovery

Scanning directories or importing every available package would make local files implicitly active, weaken the repository's authoritative allowlist, and make member-package selection unpredictable.

### Separate server and browser package contracts

Separate registration systems would duplicate identity, configuration, namespacing, loading, and failure rules while making it easier for a route and its browser surface to drift apart.

### Direct package-to-package imports

Direct imports would create hidden coupling across package roots, make member packages depend on the viewed application checkout, and bypass a deliberate shared-module seam.

### One host-owned registry for all package behavior

This would simplify composition at the cost of moving package routes, state, agent behavior, and domain semantics into the host. The package contract keeps the host deep as a composition module while leaving package behavior local.

## Consequences

### Benefits

- Team and member packages have one discoverable, testable interface.
- A package's server and browser contributions are composed and validated together.
- Namespacing, containment, state ownership, and lifecycle rules are enforced at one host seam.
- Explicit manifests make package selection auditable and prevent accidental activation.
- Package implementations remain replaceable adapters behind a small host interface.

### Costs and trade-offs

- The contract is a pivotal compatibility surface: changing it affects the host, built-in packages, scaffolds, member repositories, and tests.
- Every package currently carries a browser contribution, even a future headless package.
- Team and member package roots require two loading paths while preserving one runtime contract.
- Shared functionality must wait for an explicit distribution seam rather than taking a convenient direct dependency.

## Evidence

- `src/package-contract.ts` — Defines the package interface and contribution types.
- `src/packages/index.ts` — Loads allowlisted team and member package definitions and binds their inputs.
- `src/host.ts` — Validates and composes routes, assets, navigation, browser entries, Tasks, contexts, and cleanup.
- `src/member.ts` — Defines the viewed-repository member selection and external member manifest contract.
- `src/server.ts` — Loads the manifests, creates the host registry, and dispatches the composed routes and assets.
- `docs/architecture.md` — Describes package boundaries, explicit allowlists, namespaces, and package-safe capabilities.

## Follow-up

- Review and ratify or amend this ADR.
- Decide whether a headless package should be supported before changing the required browser contribution.
- Design a versioned shared UI/asset distribution seam for member packages without granting them imports into the viewed application root.
