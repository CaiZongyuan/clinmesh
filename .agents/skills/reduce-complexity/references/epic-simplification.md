# Integrated-work simplification survey

Read for an explicitly requested maintenance survey or Epic review. Adapted from DeepSeek Harness's [simplification survey](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/.agents/skills/dsh-find-simplifications/SKILL.md), with ClinMesh's ownership and compatibility rules.

## Establish the scope

Read the agreed scope, CONTEXT.md and applicable Agent Notes. When the request covers an Epic, also read its parent spec, child acceptance criteria and implementation PRs. Verify integration from commits and current code; closed issues alone do not prove delivery.

Record the relevant base and integrated head, then inspect the full range and current consumers. A module-wide maintenance request can use current code and an explicit path inventory instead of a historical base. For an Epic without a recoverable base, use a child-PR/commit inventory. State scope gaps; an empty diff against a merged branch or a single final child PR cannot establish whole-Epic coverage.

Consider the combined hospital workflows, shared Command and Query consumers, Agent tools, platform adapters and documentation. Distinguish missing required behavior from opportunities to reduce future maintenance.

## Search for removable maintenance

Follow the Epic's actual modules and dependencies, including production machinery, tests, configuration, build/deployment scripts and documentation. Use these questions where relevant:

- Does a field or feature have a complete producer → transformation → provider/endpoint → observable consumer path? A declaration or test alone does not prove a production effect.
- Do multiple public states, APIs or configuration options change a consumer's action? Preserve distinctions that govern permissions, durability, ownership or recovery.
- Can a consumer read an authoritative value instead of maintaining a copied history, cache or projection? Establish when it needs that value and what consistency is required.
- Do repeated wrappers, parallel app trees or pass-through configuration own behavior, or only duplicate maintenance? Include remaining glue in the cost comparison.
- Would a smaller explicit behavior remove a subsystem? Name the lost capability; this is a product decision rather than an automatic cleanup.
- Can an existing dependency replace owned infrastructure with less total maintenance? Include dependency cost, failure behavior and residual adapters, not just removed lines.

Start with `rg`, then read the matches. Search symbol uses, writes as well as reads, wire/config strings, registrations, manifests/exports, generated consumers, scripts and relevant external extension contracts. Zero repository callers alone does not justify deleting a public capability. Trace dynamic assembly and code generation before declaring code dead.

## Evaluate each candidate

Record the owner and concrete file/symbol evidence, the effective producer/consumer path, the code/state/configuration/tests/docs that disappear, what remains, and the strongest reason to keep it. Classify it as:

- **Behavior-preserving candidate:** evidence supports removing unused or duplicated obligations.
- **Behavior/architecture decision:** a public capability, accepted ADR or product behavior would change; identify the exact trade-off.
- **Retain or defer:** the distinction serves a required behavior, merely moves complexity, or has insufficient evidence.

Preserve FHIR R5 capability accuracy, synthetic-data protections, Command ownership, platform boundaries, authorization, audit and idempotency. Preserve transaction and recovery semantics, persisted-receipt compatibility and independent regression evidence. Collapsing code while losing those obligations is not simplification.

## Deliver a bounded report

Report a small candidate table with evidence, removed maintenance, retained obligation or capability loss, validation needed and recommendation. Include meaningful rejected/deferred candidates and unreviewed areas; no candidate quota or deletion target is required.

Reuse existing decisions and issues where applicable; durable architecture decisions belong in Agent Notes. Execute authorized candidates as bounded changes with affected checks. Required behavior defects affect acceptance; optional simplifications can be deferred without withholding completion. A well-supported finding that no worthwhile simplification remains is valid.
