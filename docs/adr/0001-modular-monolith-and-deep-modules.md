---
status: accepted
---

# Modular Monolith with Deep Modules and Pluggable Clinical Modules

We restructure ClinMesh from a multi-package Turborepo monorepo (`apps/web`, `apps/dsh-web`, `apps/server`, `apps/cli`, `apps/desktop`, `apps/mobile`, `apps/docs`, `apps/synthea-provider`, `packages/*`, `vendor/`) into a single-package TypeScript modular monolith modeled on `ontology-plus`: `src/packages/<name>/{index.ts, lib/, tests/}` enforced by `dependency-cruiser` (entry-point-only imports, zero circular dependencies), alongside `src/server/`, `src/web/`, `src/cli/`, and `data/packs/`. Domain capabilities split into **Mini HIS Core** (`platform`, `data-pack`, `patient-visit`, `clinical-core`) plus opt-in **Clinical Modules** implementing a uniform `ClinMeshModule` contract (`mod-lab`, `mod-pharmacy`, `mod-inpatient`, `mod-billing`, `mod-cds`, `mod-fhir-r5` in Phase 1; `mod-imaging`, `mod-pathology`, `mod-voice`, `mod-drg-cn`, and `mod-agent-mirage` strictly isolated as opt-in extensions).

## Considered Options

- **Keep a slimmed-down pnpm workspace monorepo**: Still incurs multi-tsconfig/build-graph/catalog overhead with no independent release targets once `desktop`, `mobile`, `dsh-web`, and `docs` are removed.
- **Split optional clinical domains into microservices**: Unnecessary operational complexity and incompatible with single-process local Node and Cloudflare Free deployment.

## Consequences

- Dependency direction flows strictly `Extensions / Clinical Modules -> Mini HIS Core -> Store/Platform Ports`; core code never branches on whether a regional or specialty module is installed.
- Unshipped shells (`apps/desktop`, `apps/mobile`), DSH host integration (`apps/dsh-web`, `vendor/dsh-react-surface`), `apps/synthea-provider`, and VitePress (`apps/docs`) are retired; git history preserves legacy implementations.
