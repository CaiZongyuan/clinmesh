---
status: accepted
---

# Unified Operation Catalog with Native Tools, Thin TS CLI, and Opt-In Mirage Port

A single pure-TypeScript **Operation Catalog** (Zod input/output schemas, role allowlists, idempotency, and expected-version contracts) serves as the sole authoritative action surface. In the main application and Cloudflare Free Worker, **Clinician Assistant** uses lightweight native typed tools projected from the catalog alongside the `@ui-sdk/react` browser bridge; external headless agents use a thin, zero-Python TypeScript host CLI (`clinmesh ... --json`) and concise `SKILL.md` generated from the same catalog (adopting CLI-Anything's structured JSON and skill-discovery ergonomics without introducing Python/Click). Because `@struktoai/mirage-core` (`0.1.0`, experimental) bundles multiple WASM binaries and heavy SDK dependencies that threaten Cloudflare Free's 3 MiB compressed Worker limit, Mirage VFS + virtual CLI lives strictly behind an `ExecutionEnvironmentPort` in an opt-in module (`mod-agent-mirage`) for local Node or container comparative agent studies.

## Considered Options

- **Bundle Mirage into the default Cloudflare Free Worker**: Risks exceeding the 3 MiB Free Worker limit and ties core stability to an experimental dependency tree.
- **Build the CLI in Python/Click following HKUDS/CLI-Anything literally**: Splits the single TypeScript stack unnecessarily when ClinMesh owns its typed HTTP/domain API directly.

## Consequences

- Main deployments remain fast and comfortably within Cloudflare Free bundle limits.
- Researchers can benchmark Direct Tools, `ui-sdk` WebMCP, Host CLI, and Mirage VFS fairly against the exact same **Operation Catalog** and domain invariants.
