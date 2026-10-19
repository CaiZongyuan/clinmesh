# Agent Note: Project initialization architecture

Status: implemented

## Problem

ClinMesh needs a working repository baseline for a Cloudflare-hosted simulation HIS, cross-platform clients, agent-assisted engineering, and a publishable documentation site. Product-specific DeepSeek Harness rules and Multica implementation details cannot serve as ClinMesh contracts.

## Decision

The repository uses pnpm workspaces and Turborepo with `apps/web`, `apps/server`, `apps/desktop`, `apps/mobile`, and `apps/docs`. Shared code is split into `contracts`, platform-free `core`, Web/Desktop `ui`, and Web/Desktop `views`.

Web and Desktop share DOM UI and business views. Mobile shares wire schemas, types, identifiers, and pure domain functions while owning React Native UI, navigation, storage, query lifecycle, and releases.

Repository Markdown remains canonical. `apps/docs/docs.ts` explicitly selects public pages, `scripts/project-doc-site.ts` projects them into a disposable VitePress source tree, and GitHub Pages publishes the build from the default branch.

Agent engineering keeps layered `AGENTS.md`, reusable skills, and lifecycle/class Agent Notes. Skills and instructions contain only ClinMesh or generic mechanisms. DSH-derived adaptations retain their prefix as lineage under the [traceable development workflow](../process/2026-08-21-traceable-agent-development-workflow.md), while external project commands, package rules, and CI assumptions are removed.

## Alternatives considered

**Keep the copied DeepSeek Harness governance layer unchanged.** It included strong documentation and agent practices, but most package, plugin, test, archive, bilingual, and release rules referred to infrastructure ClinMesh does not have.

**Copy Multica's complete frontend layout and dependencies.** Its Web/Desktop sharing model is useful, but its Next.js, Go backend, PostgreSQL migration policy, task-management domains, and mature mobile incidents are not ClinMesh requirements.

**Use one universal React Native component tree for every client.** This maximizes nominal reuse but forces desktop clinical density and mobile native interaction through one weak interface. Sharing semantics and pure logic provides better locality.

**Maintain documentation directly under the site app.** This simplifies the site but creates a second documentation hierarchy and makes repository-relative links diverge from their canonical source.

## Consequences

The project starts with more explicit packages and adapters than a single SPA, but each shared seam has at least two consumers or adapters. Mobile work must deliberately preserve semantics instead of inheriting Web behavior accidentally.

Documentation publication requires one manifest entry per public page and a one-time GitHub Pages repository setting. Generated site content stays disposable and cannot become an editable source.

Agent Notes and skills remain lightweight until actual project complexity justifies archive sealing, bilingual pairing, or more specialized gates.
