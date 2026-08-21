---
name: pre-push-checks
description: Select and run the smallest ClinMesh checks that cover an outgoing diff before push or review readiness.
---

# Pre-push checks

Inspect the actual diff and applicable `AGENTS.md` files. Report only commands that ran.

Choose evidence by surface:

- one package: its `typecheck` and focused tests;
- shared contracts/core: affected consumers plus package tests;
- Web/Desktop shared views: both builds or typechecks and UI evidence when behavior is visible;
- Mobile: `pnpm typecheck:mobile` and mobile-owned tests;
- Worker/FHIR: Worker tests, schema parsing and typecheck;
- docs/manifest: `pnpm doc-sync`;
- workspace, dependency or build graph: `pnpm check` plus `pnpm typecheck:mobile`.

Do not repeat a passing command for ceremony. CI owns the exhaustive platform matrix; local checks must still cover every changed acceptance path. Always run `git diff --check` before claiming readiness.
