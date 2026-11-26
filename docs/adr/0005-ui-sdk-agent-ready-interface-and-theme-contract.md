---
status: accepted
---

# UI-SDK Agent-Ready Interface and Enforced Theme Consistency Contract

We replace AG-UI (`PageContext`, `execution proof v3`, 32-tool broker), `@base-ui/react`, `shadcn`, and `ai-motion` with `@ui-sdk/react` so every interactive control is natively discoverable and operable through `createAgent()` (`snapshot`, `act`, `query`), declarative boundaries (`data-agent-confirm`, `data-agent-secret`, `data-agent-hidden`), and WebMCP (`registerTools`). Because `@ui-sdk/react` renders unstyled behaviors, all clinical views and opt-in **Clinical Modules** consume components exclusively from one deep module (`src/packages/ui-kit`), which preserves ClinMesh's calm high-density clinical visual language, maps a single versioned Theme Token contract onto `@ui-sdk/core/web.css`'s `--ui-*` variables (light/dark, 3 font scales, pure CSS agent-activity glow respecting `prefers-reduced-motion`), and enforces visual and agent-readiness consistency in `pnpm check` via `pnpm lint:theme` and `createAgent()` contract tests.

## Considered Options

- **Gradually mix `@ui-sdk/react` with existing `@base-ui/react` / `shadcn` controls**: Leaves half the interface invisible to `createAgent()` and risks conflicting focus/dialog layers and styling drift.
- **Allow each clinical module to style raw `@ui-sdk/react` primitives directly with utility classes**: Causes control heights, borders, focus rings, and semantic colors to diverge across modules.

## Consequences

- Every formal clinical commit control carries `data-agent-confirm` so **Clinician Assistant** and external WebMCP agents can stage **Draft** edits while explicit human **Clinical Confirmation** remains mechanically enforced.
- Direct raw palette classes or unapproved color literals in business UI fail `pnpm lint:theme`.
