---
name: reduce-complexity
description: Simplify ClinMesh code within the current task while preserving behavior. Use for code cleanup or an explicitly requested maintenance survey across integrated work.
---

# Reduce Complexity

Use this ClinMesh-owned skill for code simplification. Apply the user's requested scope and the [collaboration rules](../../../docs/agent-development.md); an issue or PR is optional.

## Choose the scope

- **Current task, issue or PR:** follow [local simplification](references/local-simplification.md). Apply behavior-preserving improvements within the authorized scope and run affected checks.
- **Broader maintenance request or Epic:** follow [the integrated-work survey](references/epic-simplification.md). Inspect consumers and report supported proposals. Implement only candidates already covered by the user's request.

Infer the scope from the user's request; no mode argument is required. A review-only request remains read-only. Follow the [issue-tracker rules](../../../docs/agents/issue-tracker.md) when the task uses GitHub Issues.

## Establish the evidence

Read applicable AGENTS.md instructions, the agreed request or ticket/spec, and [the testing strategy](../../../docs/testing.md). Read [CONTEXT.md](../../../CONTEXT.md), [the architecture](../../../docs/architecture.md) and relevant [Agent Notes](../../notes/README.md) before judging domain or architecture choices.

Use the task's fixed starting point or verified PR merge base when one is available. For uncommitted work, inspect staged and unstaged diffs plus task-owned new files. Record the revision and scoped paths, read relevant new files explicitly, and preserve unrelated files and hunks. Ask only if the intended scope remains ambiguous.

For an Epic, use the entire integrated range or child-PR inventory described in the Epic reference. Zero search matches alone do not establish that a public or dynamically registered capability is unused.

## Finish

Report the inspected scope, meaningful simplifications or proposals, retained obligations and actual checks. No-change is a valid result; there is no deletion quota. Optional cleanup does not block delivery by itself.

Record the inspected revision and any uncommitted scope. Reuse the pass before merge if its inputs remain unchanged; inspect new changes and refresh affected tests/review if fixes or integration changed the result. Do not repeat cleanup merely because a commit or push follows.
