# ADR-0002: Keep Shell as required infrastructure

- **Status:** Accepted
- **Date:** 2026-08-17
- **Deciders:** Resonance maintainers
- **Technical area:** Package composition and browser infrastructure

## Context

Resonance packages contribute routes, assets, navigation, and browser workspaces, but those contributions need a stable browser document and coordinator. The application must also have one owner for the primary navigation, repository-title Home activation, workspace mounts, and activation rollback. Allowing an optional package to replace that frame would make package composition and lifecycle behavior ambiguous.

## Decision

Shell is required infrastructure. It owns the fixed browser bootstrap, primary navigation, repository-title Home activation, workspace mounts, shared layout, and activation lifecycle. Every valid package configuration includes Shell, and Shell cannot be disabled. Other packages remain responsible for their own routes, assets, browser entries, and workspace behavior within the shared contract.

## Alternatives considered

### Let any package provide the browser frame

This would make the bootstrap and navigation contract vary with configuration and would allow packages to disagree about lifecycle ownership.

### Make Shell optional

This would permit configurations that have package routes but no stable document or mount coordinator.

### Give Shell ownership of package behavior

This would centralize package concerns in the host frame and weaken package boundaries.

## Consequences

### Benefits

- Every configured workspace has a stable mount and navigation lifecycle.
- Package boundaries remain clear: Shell coordinates, while packages own their surfaces.
- The host can enforce a small required infrastructure contract.

### Costs and trade-offs

- Shell is a permanent composition dependency and cannot be removed from a valid manifest.
- Changes to browser bootstrap or navigation affect every workspace.
- A package that needs a different frame must work within Shell's contract rather than replacing it.

## Evidence

- `src/packages/shell/README.md` — Defines Shell's browser-frame responsibilities and required manifest entry.
- `docs/architecture.md` — Defines Shell as required infrastructure and gives it ownership of mounts and navigation.
- `src/packages/shell/index.ts` — Provides the Shell package registration.

## Follow-up

Keep new package capabilities behind the shared package contract rather than adding package-specific bootstrap paths.
