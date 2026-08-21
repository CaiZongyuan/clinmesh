---
name: dsh-find-simplifications
description: Find evidence-backed ClinMesh simplifications at an explicit maintenance request or milestone, and record durable proposals as Agent Notes without changing behavior opportunistically.
---

# Find ClinMesh Simplifications

Use this DeepSeek Harness-derived skill for a deliberate simplification survey, not as the behavior-preserving cleanup after every code task. Routine current-diff cleanup belongs to `code-simplifier`.

Read root `AGENTS.md`, [the architecture](../../../docs/architecture.md), [the test strategy](../../../docs/testing.md), relevant package instructions, `CONTEXT.md`, and applicable [Agent Notes](../../notes/README.md) before judging a surface.

## Strong candidates

A strong candidate removes or collapses real cost and has verified evidence:

- a public method, option, event, helper, package, or FHIR capability has no production consumer;
- tests or docs are its only consumers and no current contract requires it;
- two stores, projections, or status fields represent the same authoritative fact;
- a shared abstraction has only one real adapter or consumer;
- transport, FHIR Operation, UI, or Agent tools duplicate a Command state machine;
- Web/Desktop/Mobile sharing pulls platform code across an established boundary;
- a compatibility, rollback, validation, or test path protects an unused API;
- maintained platform or dependency functionality can replace hand-rolled code with meaningful net deletion.

Do not propose removing FHIR R5 constraints, runtime validation at trust boundaries, synthetic-data protections, audit and idempotency controls, platform separation, or an Agent Note decision without evidence that defeats its rationale.

## Prove or reject

1. Search exact symbols, wire strings, exports, routes, schema fields, and configuration keys with `rg`.
2. Classify production consumers separately from tests, docs, fixtures, demos, and generated output. Inspect dynamic registrations and runtime entry paths before declaring a symbol unused.
3. Trace ownership, failure, persistence, and external compatibility. A caller proves use, not that the current public abstraction is the right owner.
4. For a dependency replacement, compare covered behavior, maintenance, transitive cost, residual glue, removed tests, and net deletion.
5. Reject candidates that only relocate complexity, contradict a current consumer, or require unrelated churn without reducing behavior or surface.

Prefer a few proven candidates over a broad inventory of guesses. A small local cleanup can use a scoped `TODO`, `FIXME`, or direct issue; a decision with real alternatives, consequences, and future re-litigation risk uses one proposed Agent Note under `.agents/notes/proposed/{class}/`.

## Output

For every retained candidate state the current owner, production-consumer evidence, exact proposed reduction, behavior given up if any, affected tests and docs, risks, and validation. Do not edit production code during the survey unless the user separately authorizes implementation.

When a new proposal supersedes an active Agent Note, apply the consolidation rules in [.agents/notes/README.md](../../notes/README.md). ClinMesh has no archive lifecycle; keep implemented rationale that still guides decisions and delete rejected notes only when they no longer prevent a plausible mistake.
