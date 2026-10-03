---
name: clinmesh-fhir
description: Read-only ClinMesh FHIR R5 CLI access for CapabilityStatement, current resource reads, version reads, resource history, and server-declared searches. Use for standards-based inspection, never for business writes.
---

# ClinMesh FHIR R5

Read [`../clinmesh-shared/SKILL.md`](../clinmesh-shared/SKILL.md) first.

Inspect CapabilityStatement before using a resource type or search parameter. The CLI validates resource types and per-resource SearchParameter names against the same registry as the Server. Follow only same-origin `Bundle.link` URLs returned by ClinMesh; all hospital writes use owning business Commands.

```bash
clinmesh fhir metadata
clinmesh fhir read --resource-type Patient --resource-id <id>
clinmesh fhir vread --resource-type Encounter --resource-id <id> --version-id <version>
clinmesh fhir history --resource-type DiagnosticReport --resource-id <id>
clinmesh fhir search --input @fhir-search.json
```

An `OperationOutcome` is returned through the shared structured error contract; treat `not-supported` as a schema/discovery correction, not a reason to construct a raw URL. Source R4 history, Case Truth, unsupported search parameters, direct PUT, arbitrary Bundle submission and nondeclared Operations are not available through this skill.
