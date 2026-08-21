---
name: dsh-trim-cot-leakage
description: Audit or fix ClinMesh prose that exposes a design session, review, plan, draft, or change-history viewpoint instead of verifiable repository state.
---

# Trim Authoring-Session Leakage

Apply the complete-proposition rule from [dsh-prose-standard](../dsh-prose-standard/SKILL.md). For each suspect passage ask whether a reader at `HEAD`, without chat, review threads, or an uncommitted draft, can resolve every reference and verify every claim.

## Rewrite targets

- Replace dead decision numbers, audit codes, plan sections, and draft labels with a committed owner or a standalone factual clause.
- Replace PR, stack, commit, reviewer, and implementation chronology with current behavior, ownership, or an issue-backed follow-up.
- Replace `used to`, `now`, `this cut`, and similar change narration with present behavior or a present-tense counterfactual.
- Replace reviewer-addressed claims of correctness with the invariant that makes the behavior valid; delete them when code already shows it.
- Delete control-flow walkthroughs, obvious derivations, and test-body narration while preserving non-obvious contracts.
- Turn actionable planning residue into a scoped issue, `TODO`, `FIXME`, or explicit current bound; delete empty hedges.

Keep resolvable issue references, standards citations, suppression reasons, measured bounds, runtime old/new state, and unique decision history inside Agent Notes or postmortems. Do not remove a factual proposition merely to eliminate historical wording.

## Workflow

1. Limit the audit to the requested scope or outgoing prose diff; exclude `references/`, generated artifacts, snapshots, and fixtures.
2. Search session-shaped phrases and read the densest prose in scope without relying only on patterns.
3. Enumerate each passage's propositions before editing, then rewrite owner-first.
4. Re-read the result from repository state and verify every remaining citation.
5. Run the checks required for the touched Markdown, Agent Note, comment, prompt, diagnostic, or visible string.
