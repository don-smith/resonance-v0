# Architecture authoring skill

Owner: team

## Context

The Architecture package's canonical model is authored in LikeC4 DSL and committed in `architecture/`. Currently, editing the model requires manual file editing — the developer writes or modifies `model.c4` and view files directly. The Architecture agent can use generic `write_file`/`edit_file` tools to make changes, but there is no dedicated skill that enforces schema validation, stable IDs, serialized atomic writes, or stale-write detection.

A dedicated authoring skill would give the agent a safe, consistent way to create and edit LikeC4 model elements through conversation. This is especially important for the onboarding experience: when a developer enables the Architecture workspace for a new repository, the agent should be able to help construct the initial model by exploring the codebase and authoring the C4 model elements, views, and diagrams through guided conversation.

## Scope of this work

### 1. Define the authoring skill interface

- A dedicated agent skill (tool or command) that the Architecture agent can invoke to create or edit LikeC4 model elements.
- The skill supports creating and modifying:
  - Elements (software systems, containers, components, persons, etc.)
  - Relationships between elements
  - Views (system context, container, component, deployment, etc.)
  - Metadata annotations (source bindings, verification classifications, tags, documentation)
- The skill accepts natural-language descriptions of the desired change and translates them into valid LikeC4 DSL.

### 2. Enforce schema validation

- All generated or edited LikeC4 DSL must be validated against the LikeC4 schema before writing.
- Validation errors are returned to the user (or agent) as actionable feedback, not silently swallowed.
- The skill does not write invalid LikeC4 — it must either produce valid output or explain what's wrong.

### 3. Enforce stable IDs

- Elements and views must use stable, deterministic IDs that do not change on re-authoring.
- The skill must detect ID collisions and either reject them or suggest resolution.
- Renaming an element updates its display name but preserves its ID.

### 4. Enforce serialized atomic writes

- Writes to the LikeC4 model files must be atomic: either the full change is written, or nothing is written.
- Concurrent write attempts must be serialized to prevent partial or interleaved updates.

### 5. Enforce stale-write detection

- Before writing, the skill must check that the file being edited has not been modified since it was last read.
- If the file has changed (stale base), the skill must reject the write and inform the user, who can re-read and re-apply.

### 6. Support guided model construction

- The skill should be able to explore the codebase (package manifests, directory layout, dependency graph) and suggest candidate elements for the model.
- The skill should present its suggestions to the user for confirmation before writing.
- The skill should guide the user through the C4 modeling process: start with system context, then containers, then components, then views.

## Non-goals

- Automatic or unsupervised model generation (all changes require user confirmation).
- Replacing hand-authored LikeC4 expertise — the skill is a productivity tool, not a replacement for understanding the model.
- Modifying implementation code — the skill only writes to `architecture/` files.
- A CLI/CI adapter for authoring outside the workspace.
- Persisted authoring sessions or undo history beyond what the filesystem provides.

## Relationship to other decisions

- **Arch validation** (`backlog/plans/arch-validation.md`) — repairs trust defects in the validation pipeline and introduces the intended-vs-observed graph model. The authoring skill creates the model that validation checks against.
- **Express architecture** (`backlog/plans/express-architecture.md`) — established the checker scaffolding and the explain skill. The authoring skill is a complementary agent capability.
- **Architecture review skill** (`backlog/plans/architecture-review-skill.md`) — the review skill inspects and reports on the model; the authoring skill creates and edits it. Together they form a complete agent workflow for architecture management.

## Completion criteria

This decision is complete when:

1. The Architecture agent has a dedicated authoring skill that can create and edit LikeC4 elements, relationships, views, and metadata through conversation.
2. All generated or edited LikeC4 DSL is validated against the LikeC4 schema before writing; invalid output is rejected with actionable feedback.
3. Elements and views use stable, deterministic IDs that persist across edits; ID collisions are detected and reported.
4. Writes to LikeC4 model files are atomic — either the full change is written, or nothing is written.
5. Concurrent write attempts are serialized to prevent partial or interleaved updates.
6. Stale-write detection is implemented: the skill rejects writes when the file has changed since it was last read.
7. The skill can explore the codebase (package manifests, directory layout, dependency graph) and suggest candidate model elements for user confirmation.
8. The skill guides the user through the C4 modeling process (system context → containers → components → views).
9. The skill only writes to `architecture/` files and does not modify implementation code.
10. `bun test` passes.