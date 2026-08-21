---
name: prose-standard
description: Review or edit ClinMesh Markdown, JSDoc, comments, prompts, diagnostics, and visible strings for complete contracts and concise current-state prose.
---

# Prose standard

Require an explicit scope. Exclude `references/`, generated docs directories, recorded fixtures, and any frozen historical artifacts.

Before editing, enumerate every factual proposition: actor, action, condition, ordering, modality, failure, ownership, exception and consequence. A shorter sentence is better only when all required propositions survive.

- Public documentation states configuration, behavior, failure, limitations and safe use.
- Comments explain non-obvious invariants, race ordering, security or ownership; they do not restate code.
- Tests explain only non-obvious fixture or observation choices.
- Prompts and visible strings are behavior and require behavior-level verification.
- Diagnostics identify the subject, violated rule and correction without exposing secrets.
- Agent Notes retain real rationale, alternatives, consequences and verification; implemented notes use present tense.

Write the owner first, then update projections or summaries. Run the narrow checks for the touched surface and `git diff --check`.
