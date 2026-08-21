---
name: dsh-prose-standard
description: Review or edit ClinMesh Markdown, Agent Notes, JSDoc, comments, prompts, diagnostics, descriptions, tests, and visible strings for complete contracts and concise current-state prose.
---

# ClinMesh Prose Standard

Write enough to preserve the complete contract, then remove repetition, decoration, and authoring-session narration. Apply [docs/AGENTS.md](../../../docs/AGENTS.md) for document ownership and [dsh-doc-standards](../dsh-doc-standards/SKILL.md) for placement.

Scope the pass to the requested files or outgoing diff. A repository-wide audit requires an explicit request. Exclude `references/`, generated documentation directories, snapshots, fixtures, and third-party sources; edit their owner or generator instead.

## Preserve the proposition

Before changing a passage, identify every relevant:

- actor and action;
- condition, ordering, and timing;
- must, may, or never requirement;
- failure, side effect, and consequence;
- owner, security restriction, exception, and compatibility promise.

Shortening is valid only when each required proposition remains true and easier to recover. Keep non-obvious rationale when removing it could cause misuse; otherwise state the current consequence and link the rationale owner.

## Coverage by surface

- **Markdown:** state the current behavior and its scope; keep one detailed owner and link from other surfaces.
- **Agent Notes:** preserve the decision, real alternatives, consequences, unique rationale, and named verification gaps. Implemented Notes use present tense.
- **Public JSDoc:** document caller-visible return distinctions, errors, side effects, ownership, timing, cancellation, and durability that types cannot express.
- **Internal comments:** explain non-local invariants, race ordering, security boundaries, ownership, or surprising failure behavior. Delete control-flow narration and code restatement.
- **Tests:** explain only a non-obvious fixture, seam, assertion, platform accommodation, or indirect observation. Do not narrate the test body.
- **Skills and agent instructions:** state trigger scope, inputs, stopping conditions, authorization boundaries, and observable completion criteria.
- **Prompts, diagnostics, and visible strings:** treat wording as behavior. Name the subject, violated rule, and correction where useful, then run the owning behavior check.

## Workflow

1. Read the applicable `AGENTS.md`, owner document, and owning code before judging prose.
2. Classify each passage as keep, add, trim, restructure, move, or defer.
3. Update the owner before derivative artifacts and inspect analogous passages within scope.
4. Use [dsh-trim-cot-leakage](../dsh-trim-cot-leakage/SKILL.md) for dead session citations, change narration, review choreography, or planning residue.
5. Run the narrow documentation and behavior checks for every changed surface, then report changed propositions, deliberate keeps, deferred cases, and actual checks.
