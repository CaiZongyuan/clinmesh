# AGENTS.md

ClinMesh is a global healthcare agent exploration platform built around a modular **Mini HIS Core**, dual isolated `pi-durable` agents (**Patient Agent** and **Clinician Assistant**), declarative **Hospital Data Packs**, `@ui-sdk/react` agent-ready UI, and optional voice (`mod-voice`), running isomorphically on Cloudflare Workers Free (SQLite-backed Durable Objects) and local Node (SQLite, PostgreSQL-portable).

> **Migration note on `refactor/next-gen-modular-his`**: Legacy implementations are available in Git history. New work targets the architecture below exclusively.

## Where things live

- Domain vocabulary (read before naming types, issues, or tests): [`GLOSSARY.md`](GLOSSARY.md)
- Architectural decisions (read ADRs touching your module before editing): [`docs/adr/`](docs/adr/0001-modular-monolith-and-deep-modules.md) (`0001`–`0008`)
- Issue tracker & triage labels (read before creating or triaging GitHub Issues): [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md), [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)
- Target code layout: `src/packages/<name>/{index.ts, lib/, tests/}` (deep modules), `src/server/` (`worker.ts` + `node-server.ts`), `src/web/`, `src/cli/`, `data/packs/`
- Local skills (read before touching their domain): `ui-sdk` (any `@ui-sdk/react` component or agent bridge), `voice` (Alibaba Cloud Bailian `paraformer-realtime-v2` / `sambert` or `mod-voice`), `domain-modeling` (`GLOSSARY.md` / `docs/adr/`), `writing-for-agents` (`AGENTS.md` / skills)

## Architecture contracts

- **Deep modules & unidirectional boundaries**: Import each `src/packages/<name>/` solely through its root `index.ts`; hide internals in `lib/` and test through `index.ts`. Dependency direction stays `Clinical Modules -> Mini HIS Core -> Platform/Store Ports`, enforced by `dependency-cruiser`.
- **Global & data-pack driven**: Keep region-specific catalogs, currencies, roles, clinical note templates, and payment/DRG rules inside declarative **Hospital Data Packs** (`data/packs/`) or regional modules—never hardcode country-specific logic in core.
- **Portable single-truth persistence**: Access persistence solely through the `Store` Repository Port using the cross-DB SQL portable subset (UUIDv7 text IDs, currency-aware integer minor units, UTC ISO-8601 timestamps) so the same logical model migrates cleanly from SQLite / Cloudflare DO SQLite to PostgreSQL. Treat FHIR R5 strictly as a read-only projection (`mod-fhir-r5`).
- **Dual `pi-durable` isolation & BYOK safety**: Keep **Patient Agent** strictly isolated from **Case Truth** answers and **Clinician Assistant** reasoning; keep both agents isolated in normal workbench mode unless an explicit **Evaluation Run** is started. Pass browser BYOK LLM and voice keys per request over HTTPS/WSS headers and keep them out of shared databases and logs. Surface provider failures explicitly; reserve mock responses for the explicit Demo/Mock mode and tests.
- **Agent-ready UI & visual consistency**: Build all interactive controls via `src/packages/ui-kit` wrapping `@ui-sdk/react` + versioned Theme Tokens (`--ui-*`, light/dark, 3 font scales, pure CSS glow respecting `prefers-reduced-motion`). Gate every formal clinical commit with `data-agent-confirm`, guard styles with `pnpm lint:theme`, and verify controls with `createAgent()` tests.
- **Single Operation Catalog**: Project native `pi-durable` tools, the thin TypeScript CLI (`--json` + `SKILL.md`), and optional `mod-agent-mirage` (behind `ExecutionEnvironmentPort`) from one typed **Operation Catalog**—never expose raw SQL, arbitrary URLs, or unvalidated writes.

## Engineering & hygiene standards

- **Minimize `useEffect`**: Compute derived state during render, handle user actions inside event callbacks, own server state in TanStack Query (client view state only in Zustand), and reset component state with `key`. Reserve `useEffect` strictly for genuine external subscriptions or DOM/WebSocket bridges.
- **Code as comment (near-zero comments)**: Express intent through sharp domain names, narrow types, and small cohesive functions. Write a 1–2 line comment only when a reader would otherwise get the code wrong (a non-obvious trade-off, protocol quirk, or security invariant). Omit narrating comments and redundant JSDoc on app code.
- **Schema-validate external boundaries**: Validate HTTP, WebSocket, CLI, data-pack, and storage boundaries with Zod; rely on TypeScript strict mode for typed in-process calls.
- **Current verification host**: Use native Windows, the Node.js 24.18.0 baseline and the pinned pnpm for local and CI checks. Exercise Workers with local Wrangler/workerd and deployment dry-runs; containers, Linux and live deployment are outside this phase's acceptance scope.
- **Keep docs and git worktrees clean**: Update or delete stale documentation in the same change that alters behavior—never leave archived/completed doc graveyards. After merging branches or finishing isolated tasks, run `git worktree list` and `git worktree prune` and remove stale local branches/worktrees. Never modify read-only `references/` or commit secrets, real patient data, or `.data/`.
- **Workflow & verification**: Follow [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) for GitHub Issues, work on feature/refactor branches via PRs into `main` (never push directly to `main`), write commits/issues/PRs in Simplified Chinese with standard technical identifiers, end files with one LF newline, and report only checks actually executed.
