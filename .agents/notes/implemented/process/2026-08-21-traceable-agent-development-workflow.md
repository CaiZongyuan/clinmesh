# Agent Note: Traceable Agent development workflow

Status: implemented

## Problem

Agent development needs a reliable path from user intent to implementation evidence. Repository instructions previously described safe editing and checks but did not route design clarification, specs, tickets, TDD, review, GitHub traceability, or GUI evidence. The implementation contract is tracked by [issue 1](https://github.com/CaiZongyuan/clinmesh/issues/1).

## Decision

New features, observable behavior changes, cross-package work, and non-trivial bugs pass a design gate before editing. Unsettled decisions use `grilling`; public interfaces, cross-package state, persistence, external protocols, multi-ticket work, and test-strategy trade-offs use `grill-with-docs`. Formal repository files change only after the user confirms shared understanding.

An approved GitHub issue body owns the active implementation contract. Work that fits one reviewable vertical slice uses that issue directly; larger work uses approved child tickets and native blocking relationships. Agent Notes retain decision rationale, while merged code and current-state documentation own shipped behavior.

Implementation uses pre-agreed TDD seams, observable test evidence, behavior-preserving simplification, a checkpoint commit, Standards/Spec review, diff-driven pre-push checks, and a draft PR. User-visible Web/Desktop changes add real-entry browser validation and a commit-pinned GIF. An implementation request authorizes ordinary branch, commit, push, draft-PR, and evidence operations, but not merge, force-push, release, branch deletion, or ready-for-review transitions.

Commit subjects and bodies, issue and pull-request content, comments, and review replies use Simplified Chinese while preserving technical identifiers. Non-trivial commits record the context, delivered change, actual verification evidence, and issue relationship in a structured body.

Matt skills remain byte-for-byte upstream files and are routed by repository instructions. ClinMesh-maintained adaptations retain the `dsh-` prefix to identify their DeepSeek Harness lineage, but their descriptions and workflows target ClinMesh and contain no DeepSeek Harness package, CI, bilingual, archive, or stacked-PR assumptions. Repository instructions and owner documents override generic skill defaults, including mapping ADR output to Agent Notes.

## Alternatives considered

**List every skill in the root instructions.** This makes discovery explicit but spends context on optional workflows and duplicates frontmatter descriptions. The root file names only mandatory lifecycle routes; subtree instructions and skill descriptions handle conditional work.

**Run Matt and DSH review skills in sequence.** This duplicates review effort and can produce conflicting repository standards. Matt `code-review` remains the two-axis orchestrator, while ClinMesh standards incorporate the portable DSH checks.

**Keep specs only in conversation or local files.** This avoids GitHub writes but loses durable issue, commit, PR, and evidence links. GitHub publication therefore has an explicit preview and approval boundary.

**Require the full check suite before every push.** This is easy to state but obscures test intent and wastes time on unrelated surfaces. Each change runs the narrowest evidence that can fail for its regression and expands only when the diff reaches shared contracts or repository-wide configuration.

## Consequences

Feature work has more explicit gates and external artifacts, but each gate has an observable completion criterion. Small mechanical edits remain lightweight. GitHub availability is required for work that needs a canonical issue.

Tests and checks become reviewable evidence rather than an undifferentiated pass/fail claim. Agents report test design, actual commands, durations, failures, and omissions without exposing internal reasoning or streaming unbounded logs.

Chinese, structured engineering messages make the purpose and evidence visible without opening the diff. Technical identifiers remain stable for tooling and search.

The `dsh-` prefix denotes lineage rather than runtime compatibility. Adapted skills require maintenance when ClinMesh commands or document owners change; skills that cannot execute against the repository are removed instead of retained as speculative guidance.
