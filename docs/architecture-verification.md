# Architecture verification

This document is the verification contract for the Architecture workspace. It describes what the **Run validation** button can prove today and what it deliberately cannot prove.

## Authority model

Architecture validation is deterministic. It does not ask an LLM to decide whether the architecture is correct.

- **Intended structure** is authored in the LikeC4 sources under `architecture/` and in the executable checker declarations in `architecture/rules.json`.
- **Observed facts** come from repository files, the package manifest, the host contract, and the Git working tree.
- A result is `pass` only when the checker has positive evidence for the claim.
- A result is `fail` when deterministic evidence contradicts the claim.
- A result is `unknown` when the checker cannot establish the claim. Unknown is not a pass and is not a failure.

The Architecture agent may explain a result or suggest a model/rule change. Its assessment never changes a deterministic result; validation must be run again after an accepted change.

## Validation snapshot

Each run uses one artifact revision. The revision hashes:

- `model.json`, `views.json`, `rules.json`, `patterns.json`, and `decisions.json`;
- every `.c4` and `.likec4` source below the configured artifact root.

The canonical LikeC4 model is parsed, reference-checked, and laid out before the authored checks run. Parser and reference errors appear as the **Canonical LikeC4 model** finding. A changed `model.c4` therefore cannot leave a stale green validation revision.

The compatibility `model.json` remains available to the agent and older routes, but package ownership and evidence containment use the canonical LikeC4 traversal and its links. The rendered model and the validation model are consequently the same source.

## Current findings

The screen shows one canonical-model finding followed by the six authored rules in `architecture/rules.json`:

| Finding | Deterministic evidence | `unknown` means |
| --- | --- | --- |
| Canonical LikeC4 model | LikeC4 parses, resolves references, lays out, and has repository-contained source bindings | The source could not be loaded or the validator was not given a LikeC4 loader |
| Authoritative package configuration | `.resonance/config.json` is version 1 and has a package object | The manifest cannot be read |
| Shell is required | Shell exists in the manifest and is not disabled | The manifest cannot be read |
| Configured package ownership | Canonical package containers have matching manifest entries and linked `index.ts`/`index.js` module paths, and enabled manifest packages are represented by canonical containers | The canonical model or package allowlist is unavailable |
| Namespaced package contributions | Package entry files and the host registration path were inspected; concrete route/asset literals are below the package namespace | The registration has no statically inspectable positive contribution evidence, or the host path cannot be inspected |
| Repository evidence is contained | Canonical LikeC4 links and `metadata.source` bindings resolve through `HostContext.resolveRepositoryPath` | The canonical model is unavailable or a linked path cannot be established |
| Reviews identify a Git revision | `.git/HEAD` is readable and non-empty | Git is unavailable; this is review context, not an architecture failure |

The canonical model finding is a validation gate, not an authored rule. The six authored checks remain deliberately small. They protect the current package and repository seams; they do not claim to verify every relationship, pattern, data flow, or implementation detail in the diagram.

The response also reports summary counts and verification coverage:

- passed, failed, and unknown findings;
- LikeC4 elements with and without a source binding, plus the elements that declare a `symbol` or `declaration_kind`;
- relationships with a verification method, authored-only relationships, and relationships marked `required`.

Coverage is not conformance. An unbound element is authored/unverified, not a failure and never evidence of a pass.

## Checker registry

The checker dispatch is an explicit registry in [`architecture-checkers.ts`](../src/packages/architecture/architecture-checkers.ts). Every checker name in the rule schema maps to exactly one function:

```ts
const architectureCheckerRegistry = {
  'authoritative-config': checkAuthoritativeConfig,
  'shell-required': checkShell,
  'package-ownership': checkOwnership,
  'route-asset-namespacing': checkRoutes,
  'repository-containment': checkContainment,
  'git-revision': checkGit,
}
```

A missing registry entry is a recognizable failed finding. It cannot silently fall through to an unrelated checker. Add a new checker by updating the schema, the registry, its regression test, and this table together.

## Source bindings and relationship verification

LikeC4 metadata is the mapping seam between authored architecture and implementation evidence. Coarse bindings should be added first:

```c4
architecture = container "Architecture" {
  metadata {
    source "src/packages/architecture/index.ts"
    symbol "architecturePackage"
    declaration_kind "package"
  }
}

architecture -> host "Uses package-safe host capabilities" {
  metadata {
    verification "runtime-registration"
    required true
  }
}
```

Supported metadata names are:

- element bindings: `source`, `symbol`, `declaration_kind`;
- relationship classification: `verification`, `required`.

`required` is currently reported as coverage metadata. It is not interpreted as a pass by itself. A future observed-graph checker may use `verification = "static-dependency"` to compare a required relationship with a dependency graph. Human, HTTP, SSE, data-flow, and ownership relationships should remain authored-only until they have a deterministic verifier.

The `source` value must be repository-relative and is checked through the host containment seam. A binding proves where to look, not that the implementation still satisfies the authored responsibility. That second claim requires a checker appropriate to the declared verification method.

## Deliberate limits and next slice

The current implementation does not infer architecture from source, use an LLM as an oracle, or treat absence of a regex match as proof. The next planned deterministic slice is an observed TypeScript package/module graph behind a narrow adapter. It can then verify selected forbidden imports, cycles, and explicitly classified required static dependencies. Until that exists, those relationships should be displayed as authored-only or unknown rather than green.

The research and delivery plan are recorded in [`docs/research/architecture-validation.md`](research/architecture-validation.md) and [`backlog/plans/arch-validation.md`](../backlog/plans/arch-validation.md).
