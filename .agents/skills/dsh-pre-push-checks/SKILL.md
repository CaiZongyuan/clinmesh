---
name: dsh-pre-push-checks
description: Select and run the smallest ClinMesh checks that cover an outgoing diff before normal push, draft-PR update, or a claim that checks pass.
---

# ClinMesh Pre-Push Checks

Run relevant evidence once for the complete outgoing diff. Do not run the full repository suite merely because a push follows, and do not repeat a passing check unless later edits invalidate it.

## Establish scope

1. Confirm repository, branch, worktree, and staged state.

```sh
git rev-parse --show-toplevel
git status --short --branch
```

2. For an existing PR, read its live base with `gh pr view`; otherwise use the repository default branch. Fetch that exact ref and inspect committed, staged, unstaged, and untracked paths against its merge base.
3. Re-establish scope after a base update, conflict resolution, generated-file change, or review fix.

## Select evidence

Every behavior change needs the narrowest test or purpose-built check that can fail for its regression. Apply [docs/testing.md](../../../docs/testing.md) and explain the command, behavior proved, and reason broader checks are unnecessary before execution.

- **Package behavior:** run the owning test file or focused package test and the owning typecheck when types changed.
- **Shared contract or cross-package interface:** add affected consumer tests and run `pnpm check` when the root policy requires the complete cross-package evidence.
- **Mobile:** run the owning mobile test plus `pnpm check:mobile`; Web or DOM tests do not substitute.
- **Documentation, Agent Notes, or project skills:** run `pnpm verify:docs`, `pnpm verify:agent-notes` when applicable, and `pnpm docs:check` for published docs.
- **Documentation projection or release path:** run `pnpm doc-sync` and the owning projection test.
- **Build, exports, workspace configuration, or runtime entry:** run the relevant build or smoke path and expand to `pnpm check` when the change is repository-wide.
- **User-visible Web/Desktop behavior:** require real-entry browser evidence and the PR GIF contract in addition to automated regression tests.

Do not lower thresholds, use an empty-test success option, shrink source coverage to hide an affected file, or treat agent narration as evidence. Record every actual result and duration, and list checks not run with their reason.

## Handle failure

Stop before push when required evidence fails. Record the exact command, failing test or check, and key error. Prove an environment-specific explanation; do not assume CI will differ. A hook bypass, force-push, or reduced check set beyond repository policy requires explicit user authorization.

## Push and verify

1. Require the intended files to be committed and inspect any pre-commit fixer changes.
2. Push normally. This workflow never authorizes `--force` or `--force-with-lease`.
3. Fetch or inspect the remote branch and require it to match local `HEAD`.
4. For a PR, inspect `gh pr checks` and report pending checks as pending. Diagnose failures before attributing them to infrastructure.

The workflow may create or update a draft PR when the implementation request authorizes it. Marking the PR ready, merging it, deleting branches, or releasing remains a separate human decision.
