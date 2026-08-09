# Dependency security for Doctor

## Question

Which open-source dependency tool should Doctor use to report vulnerable dependencies and available updates, and does Resonance already have integration tests to enroll?

## Recommendation

Keep **Dependency security** as the product name and as a Doctor check. The closest single-tool match to the remembered TypeScript project is [inup](https://github.com/donfear/inup): it is MIT-licensed TypeScript, supports npm, Yarn, pnpm, and Bun, reports outdated packages, and cross-references known vulnerabilities against its in-range and latest upgrade targets. Its `--json` and `--check` modes are documented as read-only.

For the first Doctor adapter, however, prefer package-manager-owned commands for repositories that use Bun:

- `bun audit --json` supplies structured vulnerability data and an exit status.
- `bun outdated` supplies current, in-range update, and latest versions.
- Doctor should normalize both into its own bounded result model and keep any update operation separate and explicitly authorized.

This avoids adding a dependency scanner to the host and fits Resonance's current `packageManager: bun@1.3.13` policy. `inup` is a good optional adapter when one command and vulnerability-to-update correlation are more valuable than a Node runtime prerequisite and an additional tool supply-chain dependency.

## Findings

### The likely remembered tool: inup

The project's first-party README describes `inup` as an interactive dependency upgrader for npm, Yarn, pnpm, and Bun. It advertises vulnerability auditing beside each package and says that its JSON report includes vulnerability advisories plus whether an in-range or latest target fixes them. The same README documents `--json` and `--check` as read-only, and `--apply` as the separate mutating mode.

The published package metadata identifies the package as MIT-licensed and requires Node `>=22.19.0`. GitHub's repository language breakdown identifies TypeScript as its primary language. That Node requirement is materially newer than the runtime contract currently documented by Resonance, so Doctor should not make `inup` mandatory without an explicit runtime decision.

Sources:

- [inup README](https://github.com/donfear/inup/blob/main/README.md)
- [inup package metadata](https://registry.npmjs.org/inup/latest)
- [inup repository language metadata](https://api.github.com/repos/donfear/inup/languages)

### Bun's built-in commands

Bun's official `bun audit` documentation says it requires a `bun.lock` file, sends installed package names and versions to npm, skips packages from non-default registries, and reports advisory severity, descriptions, and links. It supports `--audit-level`, CVE ignores, production-only scanning, and `--json`. The documented exit code is `0` with no vulnerabilities and `1` when any are reported, including JSON mode.

Bun's official `bun outdated` documentation defines three useful columns: `Current`, the installed version; `Update`, the latest version satisfying the manifest range; and `Latest`, the latest published version. It supports package and workspace filters, but its documented output is a table rather than a stable JSON schema. Doctor should therefore treat the command as an adapter boundary, not expose its text format as the Doctor API.

Bun also has `bun pm scan`, but that is a configurable install-time security-scanner hook. Bun's official documentation says it requires a scanner package configured under `[install.security].scanner`; the command is not a standalone vulnerability-and-freshness report. It should not be the initial Doctor implementation.

Sources:

- [Bun: bun audit](https://bun.com/docs/pm/cli/audit.md)
- [Bun: bun outdated](https://bun.com/docs/pm/cli/outdated.md)
- [Bun: Security Scanner API](https://bun.com/docs/pm/security-scanner-api.md)

### Other candidates considered

- [Sandworm Audit](https://github.com/sandworm-hq/sandworm-audit) is MIT-licensed and supports npm, Yarn, pnpm, and Composer. Its first-party README focuses on vulnerabilities, licenses, metadata, and dependency visualizations; it does not provide the update-availability and vulnerability-fix correlation needed here. It also writes a report directory by default.
- [audit-ci](https://github.com/IBM/audit-ci) is an Apache-2.0 policy wrapper for npm, Yarn, pnpm, and audit output. Its first-party README describes failing CI on advisories and allowlisting them, not checking package freshness. Its Bun support requires exporting a Bun lockfile to Yarn v1, which makes it a poor fit for a local Bun-native Doctor check.

## Current Resonance state

Dependency security is already documented in the Doctor plan's initial scope and in the Doctor package README. It is also already represented by the `dependency-security` check ID in `src/packages/doctor/index.ts`; this is not a missing backlog concept. The plan deliberately leaves the dependency data source and freshness policy as a follow-up design question.

### Local validation snapshot

On 2026-08-08, `bun audit --json` against the current worktree returned two advisories for `postcss`: one high and one moderate. The reported vulnerable package was `postcss@8.5.14`, reached through the `@pandacss/*` dependency tree; the lockfile also contains a newer hoisted `postcss@8.5.26` entry, so this should be handled as a transitive dependency update investigation rather than an immediate direct-dependency edit. `bun outdated --no-save` also reported newer versions for seven direct packages, including patch updates for React and major versions available for several others. These network-backed results are a snapshot, not a persisted Doctor result.

Sources:

- [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849)
- [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp)
- [Bun lockfile](../../bun.lock)

Resonance has integration-style coverage, although it does not have a dedicated integration-test command:

- `src/packages/browser-integration.test.ts` explicitly tests browser module coordination using Linkedom, temporary module loading, mocked fetch responses, navigation, and package activation.
- `src/server.test.ts` starts a real HTTP server, performs network requests against it, and verifies routes, assets, package registration, transport behavior, and lifecycle cleanup.
- `package.json` currently exposes only `test: bun test`; the suite is not separated into unit and integration scripts. The existing `typecheck` and `lint` scripts are separate, but no `integration` script is discovered by Doctor today.

Therefore, do **not** remove Integration tests from Doctor. Keep the category, but enroll it only after adding an explicit repository-owned integration command (or an explicit Doctor configuration) that selects the real server/browser integration files. Do not infer it merely from filenames; a checked-in command makes the scope reviewable and prevents Doctor from silently redefining the repository's test policy.

Sources:

- [Doctor workspace plan](../../backlog/plans/doctor-workspace.md)
- [Doctor package README](../../src/packages/doctor/README.md)
- [Doctor package implementation](../../src/packages/doctor/index.ts)
- [Browser integration tests](../../src/packages/browser-integration.test.ts)
- [HTTP server tests](../../src/server.test.ts)
- [Resonance package scripts](../../package.json)

## Suggested implementation slices

1. Add a package-manager-specific dependency-security adapter interface to Doctor, with Bun as the first implementation.
2. Parse `bun audit --json` into vulnerability records, preserving advisory IDs, severity, URL, package, and bounded raw output.
3. Decide whether freshness uses a robust `inup --json` adapter or a narrowly version-pinned parser for `bun outdated`; do not silently install or update dependencies.
4. Add an explicit Resonance integration-test script and discovery/configuration path, then run it through the existing bounded Doctor runner.
5. Add parser and route regression tests with fixture command output; keep network calls out of deterministic tests.
