---
name: clinmesh
description: Discover and run ClinMesh operations for a synthetic clinical workspace, complete an outpatient encounter, or recover an uncertain command receipt.
---

# ClinMesh

Discover the installed contract offline. The schema gives the HTTP method, path fields, role capabilities, version preconditions and JSON input/output shapes.

```sh
clinmesh operations list --json
clinmesh operations schema lab.issue --json
```

Use `CLINMESH_SERVER_URL` and a short-lived `CLINMESH_TOKEN` supplied by the workspace administrator. Request the named operations for one Practitioner Role. A write grant includes recovery of its own receipts. The active Hospital Data Pack and the responsible role determine which operations are available. `visitorOnly` entries require the browser. For interactive use, keep `serverUrl` and `token` together in a private per-user `~/.clinmesh/config.json` and use `--output table` when appropriate. Use HTTPS for remote servers.

Read the current Epoch and versions before writing. Use scalar flags such as `--expected-version`, or pass one UTF-8 JSON object with `--input -` or `--input @relative-file.json` from the current workspace (at most 1 MiB). Respect `uniqueItems` and the item property named by `x-clinmesh-uniqueBy`. Use one idempotency key per intent and reserve the `patient-reply:` prefix for the Patient Agent. The server checks the current role, versions, clinical facts and funds when it applies the command. Review the exact inputs and obtain the operator's authorization before adding `--yes` to a formal action.

Start the Encounter, save and sign the Clinical Record, then draft and confirm the Diagnosis. For investigations, read the lab catalog and saved draft, issue its frozen quote, accept and start the order, then review the issued report and acknowledge its exact version. Record the permitted medication decision and read the Completion Gate before completing the Encounter. Each example below reads its operation-specific input from stdin.

```sh
clinmesh encounter start --input - --yes
clinmesh record sign --input - --yes
clinmesh lab order issue --input - --yes
clinmesh encounter complete --input - --yes
```

Read a successful JSON envelope from stdout. On failure read stderr. For `ambiguous_outcome`, stop writes and query `recovery.input` using the original token. `applied` includes the committed result. If the receipt is unavailable, reconcile with the responsible operator before taking further action. Never automatically resend an uncertain write.

```sh
clinmesh command receipt get --input -
```
