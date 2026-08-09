# Doctor package

## Responsibilities

- Provide the Doctor workspace through `/api/doctor`, `/api/doctor/results`, `/api/doctor/configure`, and `/api/doctor/run`.
- Discover and onboard the viewed repository's Bun unit and explicitly named integration-test commands.
- Discover Bun dependency security checks using read-only `bun audit --json` and `bun outdated` commands.
- Run checks against `HostContext.repositoryRoot`, never the Resonance application root by accident.
- Parse bounded JUnit and Bun dependency output into grouped results with status, timing, output, and failure details.
- Persist only the latest bounded result and selected check configuration in package state.
- Remember the Doctor agent-panel visibility and selected check in Doctor's browser local-storage namespace.
- Present navigation for Unit tests, Type checking, Lint / format, Integration tests, and Dependency security.
- Provide a shared, toggleable agent panel without allowing the agent to own test execution.
- Render only inside Shell's supplied private mount and serve its registered browser entrypoint and stylesheet.

## Configuration

Add this explicit entry to the viewed repository's `.resonance/config.json` package allowlist:

```json
"doctor": { "module": "src/packages/doctor/index.ts" }
```

The module path is application-root-relative. Doctor stores local onboarding and last-run state under `.resonance/state/doctor/`.

## Ownership boundary

Keep reusable code here. Validate repository paths with `HostContext.resolveRepositoryPath()` before reading under `HostContext.repositoryRoot`.
