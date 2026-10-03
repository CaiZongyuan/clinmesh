# Local simplification

Read for current-task, issue or PR cleanup. Adapted from Anthropic's [code-simplifier](https://github.com/anthropics/claude-plugins-official/blob/ceb9b72b4c4c20ad39efce780edd0aabe80ebce3/plugins/code-simplifier/agents/code-simplifier.md): preserve behavior, focus on scoped code, and prefer clarity over brevity. Apply ClinMesh's TypeScript conventions and package boundaries.

## Bound the edit

Start from the task's agreed outcome and working behavior. Inspect its scoped code plus the immediate callers needed to understand it. Apply improvements within the same task; discoveries elsewhere become follow-up proposals.

- Flatten unnecessary nesting and make names, conditions and error paths explicit.
- Remove redundant intermediate state, duplicate logic or pass-through abstractions when their consumers demonstrate no distinct responsibility.
- Keep useful domain boundaries and ownership visible. Similar-looking code with different reasons to change need not share an abstraction.
- Remove comments that merely narrate code while retaining non-obvious behavior, failure, ordering and ownership facts. Update the owning source before regenerating derived artifacts.

The result should be easier to understand or maintain. A line-count reduction, generic helper or new dependency alone does not establish an improvement. Preserve existing features, outputs, public types, errors, authorization, persistence, transaction behavior and relevant timing/resource guarantees. A capability reduction is a proposal, even if it deletes substantial machinery.

## Protect required behavior

Read relevant Agent Notes before removing an architectural distinction. Preserve Command ownership, FHIR R5 contracts, the contracts/core/ui/views dependency direction, and Mobile's independent platform adapters. A single caller alone does not prove that an ownership boundary is redundant.

Keep validation at untrusted inputs and persistence/wire boundaries. Preserve expected versions, idempotency receipts, audit, transaction behavior, cancellation/cleanup and permission enforcement where touched. Edit owners and regenerate their derived artifacts.

Keep behavior tests independent of implementation structure. Refactoring may simplify fixtures, but must retain distinct regression evidence. Add a test only for a meaningful uncovered risk, not to mirror a renamed helper.

## Finish the pass

Explain significant changes and deferred trade-offs, or state that no worthwhile local simplification was found. Run checks that cover affected behavior. Large refactors and optional cleanup do not become mandatory work merely because this pass found them.
