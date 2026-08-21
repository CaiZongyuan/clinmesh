---
name: dsh-doc-site-sync
description: Publish, update, move, remove, or debug ClinMesh documentation pages projected from repository Markdown through apps/docs/docs.ts into the VitePress site.
---

# ClinMesh Documentation Site Sync

Repository Markdown is the only editable source. [apps/docs/docs.ts](../../../apps/docs/docs.ts) is the explicit public allowlist, and [scripts/project-doc-site.ts](../../../scripts/project-doc-site.ts) projects canonical files into disposable VitePress input.

Read [docs/AGENTS.md](../../../docs/AGENTS.md) and use [dsh-doc-standards](../dsh-doc-standards/SKILL.md) before deciding where content belongs. Read the current `DocsPage` type and manifest entries before changing fields.

## Classify the change

- **Edit a published page:** edit only its canonical Markdown source unless route or navigation metadata changes.
- **Publish a page:** create it at the owning documentation tier, then add one manifest entry.
- **Move or remove a page:** update the canonical file, manifest entry, and every inbound repository link in one change.
- **Change generated content:** edit the generator or source metadata, regenerate, and leave generated output uncommitted.
- **Change site structure:** use the manifest when its existing sidebar and section model can express the result; change VitePress configuration only for a new structural capability.

Never edit or commit `apps/docs/.generated`, `apps/docs/.cache`, or `apps/docs/.dist`.

## Manifest fields

Set each `DocsPage` field deliberately:

- `source`: repository-relative canonical Markdown path.
- `route`: public VitePress path ending in `.md`.
- `label`: sidebar label.
- `sidebar`: an existing `DocsSidebar` value or `null`.
- `section` and `order`: stable navigation grouping and order.
- `outline`: optional page-outline depth.
- `sourceAliases`: optional repository paths that resolve to the same public page; aliases do not create routes.

Keep canonical Markdown links repository-relative. The projector turns mapped targets into site routes, unmapped repository docs into GitHub links, and images into copied site assets. Missing local targets fail projection; do not write site-only routes into canonical docs to bypass the check.

## Validate

Use `pnpm docs:dev` for preview when visual navigation or rendering changes. Before treating the projection as valid, run:

```sh
pnpm doc-sync
```

`pnpm doc-sync` includes the Markdown, Agent Note, projection, and VitePress build checks. Do not rerun its component commands unless later edits invalidate the result. Report canonical files, manifest entries, affected public routes, and exact checks. Use [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md) before push.
