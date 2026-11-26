---
status: accepted
---

# Unified Pi Durable Dual Agents, BYOK Security, and Lightweight Visitor Gate

All in-app AI agents run on `@earendil-works/pi-durable` and `@earendil-works/pi-ai`—retiring DSH, background live EMR extraction (`ConsultationRecordingService`), async clinical recommendation outbox pipelines, and heavy model quota ledgers. Two isolated durable agent roles exist: a per-**Encounter** **Patient Agent** (bound strictly to fixed **Patient Persona** and visible clinical facts, with deterministic `Case Truth` leakage checks) and a unified shell-level **Clinician Assistant** (supporting default on-demand interaction plus a toggleable **Ambient Mode** that feeds finalized dialogue/report events into the same assistant without a second pipeline). In normal workbench operation the two agents remain strictly isolated; an explicit **Evaluation Run** mode connects a test clinician agent directly to **Patient Agent** for end-to-end automated benchmarking. For public Cloudflare deployments, user BYOK LLM keys stay exclusively in browser `localStorage` and pass per-request over HTTPS headers without server persistence, alongside optional server-configured providers for self-hosted/CI runs and an explicit Demo/Mock mode (never silent fallback). We also replace `better-auth` with a lightweight WebCrypto **Visitor Gate** protecting agent/DO resources while enabling zero-auth instant **Practitioner Role** switching inside an authenticated **Workspace**.

## Considered Options

- **Keep background outbox LLM pipelines for EMR extraction and recommendations**: Maintains duplicate retry/recovery/budget machinery alongside `pi-durable` and causes redundant token spend.
- **Keep `better-auth` mandatory role-by-role login**: Adds bundle size and password-hashing CPU pressure on Cloudflare Workers Free while slowing down multi-role clinical exploration.

## Consequences

- Both agents inherit crash resumption, durable transcripts, and stream reconnection from `pi-durable`.
- External headless task agents and CLI runners continue using short-lived, single-role Capability Tokens rather than browser visitor sessions.
