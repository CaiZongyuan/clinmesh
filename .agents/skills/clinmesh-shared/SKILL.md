---
name: clinmesh-shared
description: ClinMesh CLI shared routing for authentication, trusted context, operation discovery, structured errors, idempotency, and ambiguous Command recovery. Use before any other clinmesh-* skill or whenever a ClinMesh CLI call fails.
---

# ClinMesh CLI Shared

Use `clinmesh` only against a synthetic ClinMesh environment. Complete one operation at a time through this loop: read trusted context, select the Skill matching `actor.roleCode`, inspect current state and versions, inspect an unfamiliar operation schema, execute once, then branch on the structured result. Completion means the returned state or receipt proves the intended Effect; exit code zero alone is insufficient.

## Identity

Human sessions use an explicit profile. Agent tasks receive `CLINMESH_SERVER_URL`, `CLINMESH_TOKEN`, and task identity from the runner; in Agent context omit `--profile` because the CLI fails closed instead of reading human profiles. One Agent Grant represents one Practitioner Role. A cross-role handoff requires the runner to issue a different Grant, not a role flag.

```bash
clinmesh auth login --profile <profile> --server-url <url> --email <email> --password-stdin
clinmesh auth status --profile <profile>
clinmesh auth role use --profile <profile> --practitioner-role-id <role-id>
clinmesh context show
```

Use local discovery before an unfamiliar call. `operations schema` owns flags, nested input, expected versions, risk and output; Skills do not cache those fields.

```bash
clinmesh operations list
clinmesh operations schema reference.diagnoses.search
```

## Writes

- Read the current resource and draft versions first.
- Give each business intent one idempotency key and reuse that key only for an identical retry.
- Supply nested clinical input through `--input @<workspace-file>` or `--input -`.
- On `validation`, correct the named input before another call. On `authentication` or `authorization`, stop and request a valid Grant or human context.
- On `conflict`, read current state and form a new intent; keep stale input as evidence but do not replay it.
- On `ambiguous_outcome`, query `command receipt get` with the original operation ID and idempotency key. A completed receipt is success; a missing or executing receipt is a stop condition for immediate resubmission.
- Preserve `error.correlationId` when present. It identifies the Server response and its runtime log; it is neither an idempotency key nor proof that a write completed.
- Human high-risk commands require `--yes`. Agent commands rely on the server-bound Capability Grant and do not add `--yes`.

```bash
clinmesh command receipt get --operation-id <operation-id> --idempotency-key <key>
```

The CLI has no raw URL, method/body, SQL, FHIR write, Bundle write, or Case Truth command.
