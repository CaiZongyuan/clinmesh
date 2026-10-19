# Agent Note: Traceable Agent development workflow

Status: implemented

## Problem

Agent development needs a reliable path from user intent to implementation evidence. Repository instructions previously described safe editing and checks but did not route design clarification, specs, tickets, TDD, review, GitHub traceability, or GUI evidence. The implementation contract is tracked by [issue 1](https://github.com/CaiZongyuan/clinmesh/issues/1).

## Decision

The fixed development lifecycle and DSH skill orchestration are superseded by [Task-scoped Agent skills](2026-10-02-task-scoped-agent-skills.md). This Note retains the rationale for task ownership, engineering evidence and public-content authorization.

New implementation contracts belong to [repository-owned specs](2026-10-06-repository-owned-specs.md); existing approved Issues retain their contracts until explicitly migrated. GitHub Issues for repository specs track execution and link to the spec; Agent Notes retain decision rationale, while merged code and current-state documentation own shipped behavior.

Observable verification evidence covers the actual changed behavior. External writes follow the user's authorization, and public artifacts are checked for sensitive content before publication.

Commit subjects and bodies, issue and pull-request content, comments, and review replies use Simplified Chinese while preserving technical identifiers. Engineering messages record delivered behavior and actual verification, with issue relationships when applicable.

Repository instructions and owner documents override generic skill defaults, including mapping ADR output to Agent Notes. Skills supply reusable methods rather than owning product or architecture facts.

## Alternatives considered

**List every skill in the root instructions.** This makes discovery explicit but spends context on optional workflows and duplicates frontmatter descriptions. Task-specific pointers and skill descriptions handle conditional work.

**Run Matt and DSH review skills in sequence.** This duplicates review effort and can produce conflicting repository standards. Matt `code-review` remains the two-axis orchestrator, while ClinMesh standards incorporate the portable DSH checks.

**Keep cross-session specs only in conversation or temporary files.** This loses durable issue, commit, PR, and evidence links. Repository-owned specs provide a versioned contract; GitHub publication retains an explicit authorization boundary when a task chooses that tracking surface.

**Require the full check suite before every push.** This is easy to state but obscures test intent and wastes time on unrelated surfaces. Each change runs the narrowest evidence that can fail for its regression and expands only when the diff reaches shared contracts or repository-wide configuration.

## Consequences

GitHub availability is required only for tasks using that issue tracker or publication surface.

Tests and checks become reviewable evidence rather than an undifferentiated pass/fail claim. Agents report test design, actual commands, durations, failures, and omissions without exposing internal reasoning or streaming unbounded logs.

Chinese, structured engineering messages make the purpose and evidence visible without opening the diff. Technical identifiers remain stable for tooling and search.

Repository-owned skills require maintenance when ClinMesh commands or document owners change; local links and instructions must execute against this repository.
