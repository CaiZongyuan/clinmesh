---
name: dsh-doc-standards
description: Place, write, move, review, or restructure ClinMesh documentation while preserving the repository hierarchy, one owner per fact, and the required documentation checks.
---

# ClinMesh Documentation Standards

Use this DeepSeek Harness-derived workflow for ClinMesh documentation. The current source of truth is [docs/AGENTS.md](../../../docs/AGENTS.md); this skill supplies the working method and does not replace that contract. Use [dsh-prose-standard](../dsh-prose-standard/SKILL.md) for proposition coverage and editorial judgment, and [dsh-doc-site-sync](../dsh-doc-site-sync/SKILL.md) when the public projection changes.

## Place the fact

1. Read every applicable `AGENTS.md` and identify the document that owns the subject.
2. Keep full detail at the owner. Other documents state only the local contract they need and link the owner.
3. Classify the content by use. A tutorial takes a reader from prerequisites to an observable result; a reference supports lookup within a declared scope.
4. Keep Agent engineering configuration under `docs/agents/`, current product and engineering reference under `docs/`, decision rationale under `.agents/notes/`, and reusable actions under `.agents/skills/`.
5. Before moving or removing a file, search all inbound links. Change the owner, projection manifest, and inbound links atomically.

Do not create a catalog that repeats a directory, package manifest, script list, skill frontmatter, or generated source. Do not edit `references/`, `apps/docs/.generated`, `apps/docs/.cache`, or `apps/docs/.dist`.

## Write current state

Preserve behavior, failure, timing, ordering, ownership, security restrictions, exceptions, and observable verification. Remove chat history, review rounds, implementation narration, stale migration instructions, and duplicated rationale. Use [dsh-trim-cot-leakage](../dsh-trim-cot-leakage/SKILL.md) when prose is written from an authoring-session viewpoint.

Agent Notes follow their own [lifecycle and format](../../notes/README.md). Implemented Notes retain decision rationale and current mechanisms, not acceptance checklists or a development diary.

## Validate

For documentation changes run the checks required by [docs/AGENTS.md](../../../docs/AGENTS.md):

```sh
pnpm verify:docs
pnpm docs:check
```

Run `pnpm verify:agent-notes` when Agent Notes change and `pnpm doc-sync` when canonical docs, public projection, or generated documentation paths change. Report only checks actually run.
