# ADR-0004: Keep browser composition in Shell and workspace state in packages

- **Status:** Proposed
- **Date:** 2026-08-17
- **Deciders:** Resonance maintainers
- **Technical area:** Front-end composition and workspace lifecycle

> This ADR records the front-end architecture that is already implemented and proposes that we explicitly ratify it. Its status should become `Accepted` only after review.

## Context

Every browser-capable package needs to appear in one application without replacing the document, navigation, theme, or lifecycle of the other packages. The browser also needs a stable way to load package-owned JavaScript and stylesheets from the server manifest, give each package a private mount, activate one workspace at a time, and recover when activation fails.

At the same time, package-specific state is not interchangeable. Documentation owns its selected document and tree state; Architecture owns its selected view and diagram state; Backlog owns its selected plan and agent state. Shared browser modules can standardize interaction mechanics, but they must not know package routes, prompts, domain identifiers, or persistence semantics.

## Decision

Ratify Shell as the browser composition module and each package browser entry as the owner of its workspace:

- Shell owns the fixed HTML document, theme bootstrap, global theme preference, primary navigation, repository-title Home activation, package mounts, package activation/deactivation, and activation rollback.
- Shell reads the host manifest, loads each registered stylesheet and browser entry, creates one private mount per package, and passes the package browser factory its transport adapters such as `fetchFn` and `eventSourceFactory`.
- A browser contribution provides an `id`, `entry`, and `stylesheet`. Its module returns the small workspace interface `mount(root)`, `activate()`, and `deactivate()`.
- Shell coordinates visibility and lifecycle but does not own package data, route names, agent prompts, domain rendering, or package persistence. A package owns its own browser state and refreshes it through its package-owned routes and event streams.
- Workspace packages render inside the private mount supplied by Shell. They use Shell's semantic design tokens and keep page-specific selectors scoped below their workspace root.
- Shared modules in `src/ui/` are infrastructure adapters for repeated interaction mechanics, such as agent panels and collapsible sections. They remain domain-agnostic; package browser entries adapt domain state to those interfaces.
- Shared team-package modules are bundled into team browser entries, while Shell serves the shared stylesheet. Member-package access to shared browser modules is intentionally not implicit and must wait for an explicit distribution seam.
- Home is a deliberate Shell integration: it is opened from the repository title rather than treated as workspace navigation. Resonance Actions is another deliberate Shell surface whose generic transport is hosted by Shell while Tasks remain package-owned.

## Alternatives considered

### Let each package own the application frame

This would duplicate bootstrap, navigation, mount, theme, and activation behavior and make packages compete for document ownership.

### Put all workspace state in Shell

This would make Shell understand package routes, domain models, agents, and persistence, turning the composition module into a shallow dispatcher with high coupling.

### Use global shared browser modules or styles without a distribution contract

This would make member packages depend on the viewed application checkout implicitly and would make version compatibility unclear.

### Render package HTML directly from the server

This would bypass the browser package lifecycle, private mounts, and package-owned interaction state, and would make server and browser responsibilities harder to separate.

## Consequences

### Benefits

- The document and lifecycle model is stable while package workspaces remain replaceable adapters.
- A failed package activation can be rolled back without taking down the Shell or other package modules.
- Package state and domain behavior stay local, while repeated interaction mechanics gain shared implementations.
- The manifest is the explicit bridge between server contributions and browser loading.

### Costs and trade-offs

- Shell is a permanent front-end composition dependency and changes to its interface affect every browser package.
- Packages must implement a lifecycle interface even when their surface is small.
- Shared UI improvements require careful compatibility and bundling decisions for team and member packages.
- CSS and browser asset reuse across package roots is constrained until a supported distribution seam exists.

## Evidence

- `src/packages/shell/index.html` — Defines the fixed document and Shell mount region.
- `src/packages/shell/app.js` — Loads the manifest, browser entries, stylesheets, mounts, and initial activation.
- `src/packages/shell/shell.js` — Owns navigation, private mounts, activation, deactivation, and rollback.
- `src/package-contract.ts` — Defines the browser contribution interface.
- `src/ui/` — Contains domain-agnostic shared browser modules.
- `docs/design-system.md` — Defines the shared-module seam, workspace slots, and member-package distribution limitation.
- `src/packages/browser-integration.test.ts` — Verifies manifest-driven loading, mounts, activation, and Home integration.

## Follow-up

- Review and ratify or amend this ADR.
- Explore a versioned shared browser-module and asset distribution mechanism for member packages.
- Keep package-level browser tests at the adapter seam when shared UI modules change.
