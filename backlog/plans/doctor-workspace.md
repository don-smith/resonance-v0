# Doctor workspace

## Decision

Create a team Doctor package and workspace for understanding the health of a viewed codebase through repeatable automated checks.

## Initial scope

- Present configured static analysis, unit, integration, and other automated test checks.
- Show check status, output, and actionable failure details in a main results panel.
- Use a left-hand panel to organize checks by type and select an individual result.
- Leave room for a package-owned agent panel that can explain results and, where explicitly supported, run checks.
- Add dependency security and freshness checks as a notification surface for the whole team.
- Treat dependency updates as intentional, reviewable operations rather than automatic background changes.

## Boundaries

The first implementation should establish the package and workspace contract without committing to a particular analyzer, test runner, dependency scanner, persistence model, or remote CI integration. Checks should be explicit package-owned adapters with bounded output, clear execution status, and safe failure handling. Any operation that changes repository files, including dependency updates, requires a separately designed and explicitly authorized mutation flow.

## Decision: target-repository onboarding and test results

Doctor always runs checks against the viewed repository (`HostContext.repositoryRoot`), never against Resonance's application root by accident. Resonance running against itself is simply the self-hosting case; another viewed repository must supply or select commands appropriate to that repository.

The first visit may discover candidate checks from repository metadata such as `package.json`, lockfiles, and known test-runner conventions. The user explicitly selects/configures a candidate. Doctor remembers the selected command in its package state, while checked-in manifest configuration remains the appropriate place for team-shared, intentional check definitions. The browser sends only a check id; it never supplies an arbitrary executable for a run.

The initial implementation targets Bun unit tests and keeps the adapter boundary open for other runners. Bun runs with its JUnit reporter (`--reporter=junit --reporter-outfile=...`); Doctor parses that XML server-side into a canonical JSON result grouped by suite/file/test. The non-zero process exit status remains authoritative. The UI renders semantic pass/fail/skipped/running states with text and icons in addition to color.

Each check stores only its latest completed result in `.resonance/state/doctor/state.json`: timestamps, duration, command metadata, repository revision/dirty state, summary counts, bounded failure details, and bounded output. No result history or unbounded raw output is retained. Local test results should not dirty the viewed repository, so the Doctor state directory is ignored unless a later team-sharing decision changes that policy.

Runs are deterministic package-owned operations, not agent actions: explicit executable/arguments, repository-root working directory, fresh child process, fixed timeout, zero retries, no randomization by default, bounded output, cancellation handling, and recorded runtime/revision metadata. A later repeatability mode may run a check multiple times to expose flakes without making retries part of the normal health result.

## Static analysis decision

Static analysis is split into two independent Doctor checks:

- **Type checking** runs the viewed repository's explicit TypeScript typecheck command, normally `tsc --noEmit` through a checked-in `typecheck` package script. The repository owns its `tsconfig.json` policy; Doctor only executes the declared command and reports its diagnostics.
- **Lint / format** runs one checked-in command that keeps formatting and linting in lockstep. The initial enrolled Resonance surface uses Prettier for the Doctor TypeScript, JavaScript, CSS, README, plan, and configuration files plus markdownlint for the Doctor README and plan. A failing formatter or Markdown lint is one failed check with bounded output. Expanding the same policy to the legacy repository-wide source and documentation is a separate baseline-migration decision, so this setup does not create a large unrelated formatting diff.

Doctor does not add cyclomatic-complexity analysis in this slice, and Architecture remains the owner of architectural verification. Other languages and analyzers should arrive as explicit repository-owned adapters rather than hidden Doctor heuristics.

## Initial implementation slices

1. Add target-repository discovery/configuration and the Bun unit-test adapter.
2. Parse JUnit into a stable Doctor result model and persist one latest result per check.
3. Render onboarding, last-run health, grouped results, failure details, and accessible status indicators.
4. Add TypeScript typecheck and lint/format command adapters as separate Doctor checks.
5. Add focused parser, runner, route/state, and browser regression tests; add streaming/cancellation UI after the result model is stable.

## Dependency security decision

For repositories using Bun, Doctor runs the package manager's read-only commands as one dependency-security check:

- `bun audit --json` supplies structured vulnerability advisories. Exit code `1` is an expected finding state, not a runner error.
- `bun outdated` supplies current, in-range update, and latest versions. Doctor parses its table output into bounded package records.

Doctor reports advisories and outdated packages as grouped results and never updates dependencies. Other package managers and dependency adapters require an explicit follow-up decision.

The Resonance repository enrolls its real server and browser coverage through the explicit `integration` script. Doctor discovers `integration` (or `test:integration`) only when the repository declares it; it does not infer integration scope from filenames.

## Follow-up design questions

- Which adapters should follow Bun, and which repository conventions are safe to discover?
- What agent capabilities are safe and useful for interpreting results without owning execution?
