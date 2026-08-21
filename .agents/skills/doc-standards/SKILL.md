---
name: doc-standards
description: Place, write, review, or restructure ClinMesh documentation while preserving one owner per fact and the repository documentation hierarchy.
---

# Documentation standards

Read `docs/AGENTS.md` before judging content. This skill is guidance, not a mechanical shortening pass.

## Structure first

1. Identify the document subject and owning tier.
2. Choose tutorial or reference based on reader intent.
3. Keep full detail about the subject; summarize children and link their owners.
4. Split substantial mixed tutorial/reference content.
5. Do not publish maintainer instructions, research notes, Agent Notes, or postmortems unless the user explicitly expands the public manifest.

## Editorial rules

- Describe current state, not PR or authoring history.
- Preserve behavior, failure, timing, ownership, security limits and exceptions.
- Delete duplicated catalogs, control-flow narration and code restatement.
- Keep one physical line per paragraph.
- Use relative repository links; `references/` paths may be named as research inputs but are not link targets.

Run `pnpm verify:docs` and `pnpm docs:check`. Agent Note changes also run `pnpm verify:agent-notes`.
