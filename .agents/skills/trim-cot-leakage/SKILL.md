---
name: trim-cot-leakage
description: Audit or fix prose that exposes an authoring-session, review, plan, or change-history viewpoint instead of verifiable repository state.
---

# Trim reasoning-transcript leakage

A reader at the current tree must be able to resolve every reference and verify every claim without a chat transcript, PR discussion, or uncommitted plan.

Replace or remove:

- dead decision/audit item numbers and uncommitted section references;
- “this PR”, stack position, reviewer attribution and draft ordinals;
- “used to”, “now”, “no longer” and migration narration on current-state pages;
- control-flow walkthroughs, obvious test proofs and reviewer-directed correctness arguments;
- vague future residue without a tracked TODO or proposal;
- mixed working-language fragments in otherwise single-language prose.

Preserve issue links, external standards, measured bounds, suppression reasons, runtime old/new state and current counterfactual regression explanations. When a suspect passage contains a real contract, restate it from the repository viewpoint before removing the transcript.

Use `prose-standard` for proposition preservation and `doc-standards` for placement. Re-run the checks for the edited surface.
