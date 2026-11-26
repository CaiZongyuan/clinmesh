---
status: accepted
---

# Portable Store Port, Single Normalized Model, and Per-Workspace SQLite Durable Objects

We unify persistence into a single normalized relational schema per **Workspace** (starting fresh at schema v1, dropping 50+ legacy migrations and eliminating the dual-track `fhir_resource` JSON store; FHIR R5 becomes a thin read-only projection in `mod-fhir-r5`). All domain and module code talks exclusively to a `Store` Repository Port rather than raw SQL or Drizzle tables, and follows a strict cross-database portable subset (UUIDv7 text IDs, integer minor-unit money scoped by currency precision, UTC ISO-8601 timestamps, explicit foreign/isolation keys, zero SQLite-only features in core business logic) backed by versioned logical NDJSON/JSON snapshot export/import and a shared Store Conformance Test Suite for future PostgreSQL migration. On Cloudflare Free Tier, each **Workspace** maps 1-to-1 to a SQLite-backed Durable Object (hosting both HIS tables and `pi-durable` state inside 5 GB free storage, 30 s CPU/request, and true local SQLite transactions), while local/self-hosted Node runs the identical SQLite adapter on a local file.

## Considered Options

- **Cloudflare D1 shared database for all workspaces**: Constrained by Free plan limits (50 queries per invocation, 10 ms plain Worker CPU, no interactive multi-statement transactions) and awkward for `pi-durable` crash recovery.
- **Dual-maintain `sqlite-core` and `pg-core` Drizzle schemas in Phase 1**: Doubles schema and CI maintenance before a production PostgreSQL deployment is needed.
- **Keep dual-track `fhir_resource` + relational domain tables**: Preserves high synchronization complexity and index maintenance for a read-only interoperability surface.

## Consequences

- Migrating to PostgreSQL later requires implementing a `postgres-adapter` that passes the existing Store Conformance Test Suite and importing canonical logical snapshots—without touching clinical domain logic.
- Cloudflare Workers and local Node share one isomorphic Hono application entrypoint (`src/server/worker.ts` and `src/server/node-server.ts`) with no Node-only native bindings leaked into domain packages.
