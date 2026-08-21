---
name: doc-site-sync
description: Publish, move, remove, or debug ClinMesh documentation pages projected from repository Markdown into the VitePress site.
---

# Documentation site sync

Repository Markdown is the only editable source. `apps/docs/docs.ts` explicitly selects public pages; `scripts/project-doc-site.ts` rewrites them into disposable `apps/docs/.generated`; VitePress builds `apps/docs/.dist`.

## Workflow

1. Read `docs/AGENTS.md` and the current `DocsPage` interface.
2. Edit the canonical Markdown under its owning docs tier.
3. Add or update one manifest entry only when publication metadata changes.
4. Moving or removing a page also repairs inbound links in the same change.
5. Never edit or commit `.generated`, `.cache`, or `.dist`.
6. Run `pnpm verify:docs`, `pnpm docs:check`, and `git diff --check`.

A manifest entry deliberately sets `source`, `route`, `label`, `sidebar`, `section`, `order`, and optional `outline/sourceAliases`. A mapped target becomes a site route; an existing unmapped target becomes a repository source link; missing targets fail projection. Local images must be regular files inside the repository.

GitHub Pages deployment is separate from content synchronization. `.github/workflows/docs.yml` publishes only after the repository enables Pages for GitHub Actions.
