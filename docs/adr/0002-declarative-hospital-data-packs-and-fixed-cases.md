---
status: accepted
---

# Declarative Hospital Data Packs and Fixed Clinical Cases

ClinMesh shifts from a China-specific public hospital simulator to a global healthcare agent exploration platform: all facility configuration, roles, terminology catalogs (with explicit `codeSystem` URIs and currency minor-unit precision), optional clinical knowledge/rules, and fixed **Clinical Cases** live in versioned declarative JSON/YAML **Hospital Data Packs** (`manifest`, `organization`, `catalog`, `knowledge`, `cases`) validated by Zod. We retire `apps/synthea-provider`, runtime `cn-health` downloads (~1.68 GB local caches/SQLite), offline DRG tarballs (~330 MB), and LLM runtime case/persona generation so the repository runs zero-download out of the box and switches hospitals or countries by swapping data packs rather than modifying core code.

## Considered Options

- **Retain `cn-health` national reference SQLite and Synthea generation**: Keeps multi-gigabyte setup friction and couples the entire codebase to China-specific catalogs and fragile generation pipelines.
- **Distribute data packs as prebuilt SQLite binaries**: Harder to diff, review, author, and validate in Git compared with declarative JSON/YAML files compiled into the workspace store on load.

## Consequences

- The repository ships one lean global bilingual (`en-US` / `zh-CN`) default data pack plus a second curated specialty/cardiology pack to prove hospital hot-swapping without core code changes.
- China-specific payment/DRG rules move entirely out of core into optional data packs and `mod-drg-cn`.
- Every **Clinical Case** ships pre-authored **Prior History**, immutable **Patient Persona**, and deterministic staged **Case Truth**, eliminating runtime case synthesis and unsourced normal fallbacks.
