# Team Resonance

Owner: team

## Context

Resonance is built on the premise that teams and individuals need **distinct but interoperable spaces**. Most tooling today either forces uniform processes on everyone (team-level rigidity) or leaves every person to figure it out alone (individual chaos). Neither is healthy.

The core insight is that there should be a **clear interface** between what the team agrees on and how individuals do their work. The team defines the boundaries, inputs, outputs, and gates. Individuals can use whatever workflow they want — as long as they comply with the team's agreements.

This decision defines that interface and provides a methodology for teams to discover, discuss, and codify their agreements. The mechanism is a `TEAM_RESONANCE.md` file at the repo root — a lightweight, schema-free Markdown document that both team and personal workspaces can discover and load.

The first team to dogfood this will be the Resonance team itself, working on the Resonance repo.

## What Team Resonance covers

A `TEAM_RESONANCE.md` file defines the agreements a team has made about how work gets done. It covers five categories:

### 1. Shared assets

Where does the team keep shared context that everyone needs access to?

- Documentation (user docs, developer docs, architecture docs)
- ADRs and architectural decisions
- Implementation decisions
- Context files and reference materials
- Agreed locations (repo paths, external systems, APIs)

### 2. Shared skills

Where are team-provided agent skills located, and how can personal workspaces load them?

- Path convention (e.g., `/skills/` at repo root)
- How personal workspaces discover and wire up team skills
- Whether skills are loaded automatically or need explicit registration

### 3. Process gates

What team processes must individual workflows comply with?

- Code review process (who, when, how)
- Architecture review process
- Security review process
- Testing requirements
- Linting and formatting standards
- Any other mandatory gates

### 4. Work item inputs

Where does the initial context for a work item come from?

- Ticket body (Jira, GitHub Issues, Linear, etc.)
- Design doc location
- Repo-based issue templates
- Required metadata or labels
- How to pull this context into a personal workspace

### 5. Work item outputs

What must a completed work item produce?

- Code changes (branch strategy, commit conventions)
- Documentation updates
- ADR creation or updates
- Evidence of passing process gates (review approvals, test results)
- How to surface this evidence back to the team space

## How it works

### File location and discovery

`TEAM_RESONANCE.md` lives at the root of the repository. Both team workspaces and personal workspaces can discover it by convention.

Personal workspaces should be able to:
1. Check for the existence of `TEAM_RESONANCE.md` at the repo root
2. Load it automatically if present
3. Use its contents to inform agent behavior without requiring per-repo edits to the personal workspace

This means a developer can use the same personal workspace across multiple repos, and each repo's `TEAM_RESONANCE.md` provides the team-specific context.

### Relationship to package contracts

The existing package contract (`src/package-contract.ts`) defines the interface between a package and the host — what tools and capabilities a package can use. Team Resonance is a **different concept**: it defines the interface between the team and the individual. They are complementary:

- **Package contract**: package ↔ host (technical)
- **Team Resonance**: team ↔ individual (social/process)

### Relationship to team workspaces

Team workspaces encapsulate shared procedures, runbooks, playbooks, and automated processes (code reviews, architecture reviews, security reviews). Team Resonance defines *what* those processes are and *where* they live. The team workspace implements them.

## Methodology: How a team adopts Team Resonance

This is the walkthrough that a team would follow. It's designed to be facilitated — a team lead or facilitator guides the team through these conversations.

### Step 1: Kickoff conversation

**Goal**: Introduce the concept and get buy-in.

- Explain the team/individual split and why it matters
- Share the `TEAM_RESONANCE.md` template
- Agree on a facilitator and timeline
- Set expectations: this is iterative, not a one-time exercise

### Step 2: Inventory existing agreements

**Goal**: Surface what the team already agrees on, even implicitly.

- What documentation do we already maintain? Where is it?
- What processes do we already follow? (code review, testing, etc.)
- What tools do we already use? (issue tracker, CI, etc.)
- What's working well? What's causing friction?
- Where do individuals feel constrained by team processes?

### Step 3: Define shared assets

**Goal**: Agree on what shared context the team maintains and where it lives.

- What documentation do we need? (user docs, dev docs, architecture docs)
- Do we use ADRs? If so, what's the process for creating and maintaining them?
- What other artifacts do we produce? (design docs, runbooks, playbooks)
- Where do they live? (repo paths, wiki, shared drive)
- How do we keep them up to date?

### Step 4: Define shared skills

**Goal**: Agree on what agent skills the team provides and how they're shared.

- What agent skills would benefit the whole team?
- Where will they live in the repo? (convention: `/skills/`)
- How will they be maintained and versioned?
- How will personal workspaces discover and load them?

### Step 5: Define process gates

**Goal**: Agree on what processes every work item must go through.

- Code review: required? When? Who reviews? What's the process?
- Architecture review: required for what kinds of changes?
- Security review: required for what kinds of changes?
- Testing: what must pass? (unit tests, integration tests, linting)
- Are there different gates for different types of work? (bug fix vs. feature vs. documentation)

### Step 6: Define work item inputs

**Goal**: Agree on where the initial context for a work item comes from.

- What system tracks work items? (Jira, GitHub Issues, Linear, etc.)
- What information must a work item contain? (description, acceptance criteria, labels)
- Where is the initial thinking captured? (ticket body, design doc, issue template)
- How does a personal workspace pull this context in?

### Step 7: Define work item outputs

**Goal**: Agree on what a completed work item must produce.

- What code changes are expected? (branch strategy, commit conventions)
- What documentation must be updated?
- What evidence of process gates must be provided? (review approvals, test results)
- How is completion communicated back to the team?

### Step 8: Codify into TEAM_RESONANCE.md

**Goal**: Write the team's agreements into the `TEAM_RESONANCE.md` file.

- Use the template as a starting point
- Fill in each section based on the team's conversations
- Keep it lightweight — this is a living document, not a specification
- Commit it to the repo root

### Step 9: Configure personal workspaces

**Goal**: Ensure personal workspaces can discover and use the team's agreements.

- Configure personal workspaces to check for `TEAM_RESONANCE.md` at the repo root
- Wire up shared skills from the team's skills directory
- Test that the personal workspace can load and use the team context

### Step 10: Iterate

**Goal**: Treat Team Resonance as a living document.

- Review the agreements regularly (e.g., every quarter)
- Update as the team's practices evolve
- Add new categories as they emerge
- Remove things that no longer apply

## TEAM_RESONANCE.md template

```markdown
# Team Resonance

<!--
This file defines the agreements the team has made about how work gets done.
It is the interface between team policies and individual workflows.
Update it as the team's practices evolve.
-->

## Shared assets

<!-- Where does the team keep shared context? -->

- **Documentation**: `/docs/`
- **ADRs**: `/architecture/decisions/`
- **Architecture model**: `/architecture/model.c4`
- **Runbooks**: `/docs/runbooks/`
- **Other**: <!-- add as needed -->

## Shared skills

<!-- Where are team-provided agent skills located? -->

- **Skills directory**: `/skills/`
- **How to load**: Personal workspaces should add this path to their skill configuration.

## Process gates

<!-- What processes must every work item go through? -->

- **Code review**: Required for all changes. At least one team member must approve.
- **Architecture review**: Required for changes that affect package boundaries or add new packages.
- **Security review**: Required for changes that handle user data or authentication.
- **Testing**: All unit tests must pass. Linting must pass.
- **Other**: <!-- add as needed -->

## Work item inputs

<!-- Where does the initial context for a work item come from? -->

- **Issue tracker**: <!-- e.g., GitHub Issues, Jira, Linear -->
- **Required fields**: <!-- e.g., description, acceptance criteria, labels -->
- **Design docs**: <!-- Where are design docs created and stored? -->
- **How to pull context**: <!-- How does a personal workspace fetch this? -->

## Work item outputs

<!-- What must a completed work item produce? -->

- **Code changes**: Branch from `main`, commit with conventional commits, PR to `main`.
- **Documentation**: Update relevant docs. Create ADR if architecture changes.
- **Evidence**: PR approval, passing CI, test results.
- **Completion**: <!-- How is completion communicated? -->
```

## Dogfooding: Resonance team on the Resonance repo

The Resonance team will be the first to adopt Team Resonance. This means:

1. Creating a `TEAM_RESONANCE.md` at the root of the Resonance repo
2. Going through the methodology steps as a team
3. Configuring personal workspaces to discover and load the file
4. Iterating based on what we learn

This dogfooding will surface:
- What's missing from the template
- What's over-engineered
- What's unclear in the methodology
- What personal workspace changes are needed
- What the real friction points are between team and individual workflows

## Non-goals

- A formal schema or validation for `TEAM_RESONANCE.md` (it's intentionally free-form Markdown)
- Package-to-package dependencies (packages remain isolated behind their contracts)
- Replacing the package contract (they serve different purposes)
- A CLI tool for generating or validating Team Resonance files
- Enforcing team agreements programmatically (this is about social agreement, not automation)
- Defining the internal structure of personal workspaces (that's up to each individual)

## Related decisions

- **Package contract** (`src/package-contract.ts`) — defines the technical interface between packages and the host. Team Resonance is the social/process counterpart.
- **Team workspaces** — implement the shared procedures and automated processes that Team Resonance references.
- **Arch validation** (`backlog/plans/arch-validation.md`) — defines the intended-vs-observed graph model for architecture conformance, which is one example of a team process gate.

## Completion criteria

This decision is complete when:

1. The `TEAM_RESONANCE.md` concept is defined and documented.
2. A template `TEAM_RESONANCE.md` exists at the root of the Resonance repo.
3. The methodology (Steps 1–10 above) is documented and usable by a team facilitator.
4. The Resonance team has gone through the methodology and filled in the Resonance repo's `TEAM_RESONANCE.md`.
5. Personal workspaces can discover and load `TEAM_RESONANCE.md` from the repo root.
6. Shared skills from the team's skills directory can be wired up in personal workspaces.
7. Lessons from dogfooding are captured and the template/methodology is updated accordingly.
8. The relationship between Team Resonance, package contracts, and team workspaces is documented.
