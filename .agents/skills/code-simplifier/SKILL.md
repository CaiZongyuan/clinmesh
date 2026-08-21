---
name: code-simplifier
description: Simplify recently changed ClinMesh code after target behavior is green and before review, preserving every external behavior, contract, and test seam. Do not use for architecture changes or broad cleanup surveys.
---

# Simplify the Current Diff

Refine recently changed code for clarity and maintainability without changing behavior. Scope the pass to the current task diff unless the user explicitly names a wider surface.

Read the applicable `AGENTS.md`, owning interface, tests, and current documentation before editing. Preserve public APIs, wire formats, FHIR behavior, Command invariants, validation boundaries, persistence, audit effects, error distinctions, timing, accessibility, and platform-specific behavior.

## Simplify safely

- Remove redundant branches, local duplication, unnecessary indirection, dead helpers introduced by the change, and comments that only restate code.
- Prefer clear names, explicit control flow, and cohesive functions over dense expressions, nested ternaries, clever abstraction, or fewer lines.
- Consolidate logic only when the resulting owner is clearer. Do not create a shared abstraction without the real consumers required by repository rules.
- Keep useful boundaries between contracts, core, UI, views, adapters, and platform code. Do not move behavior across a boundary merely to shorten a file.
- Preserve non-obvious rationale, failure behavior, security constraints, and race ordering that code cannot express.
- Do not weaken or rewrite tests to accommodate the simplification. A test that exposes a behavior change means the change is outside this skill.

If a worthwhile simplification changes behavior, removes a public capability, alters an architecture decision, or reaches beyond the current diff, stop and route it to `dsh-find-simplifications` or an Agent Note instead.

## Finish

Inspect the final diff for accidental scope growth. Run the smallest tests and checks invalidated by the edits, then report the material clarity changes, preserved behavior, actual commands, results, and durations. Continue to `code-review` only when the affected evidence remains green.

This ClinMesh workflow is independently adapted from Anthropic's Apache-2.0 [code-simplifier agent](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-simplifier/agents/code-simplifier.md).
