---
name: clinmesh-administrator
description: ClinMesh administrator CLI workflow for inspecting Reference Releases and publishing bounded Laboratory Service batches from orderable LOINC candidates. Use for Laboratory Service configuration, enrichment status, publication retries, and publication job inspection; use scenario-data workflows for synthetic patient generation instead.
---

# ClinMesh Administrator

Read [`../clinmesh-shared/SKILL.md`](../clinmesh-shared/SKILL.md) first. Work only with synthetic ClinMesh data and the configured local Reference Release.

The complete LOINC Reference catalog and the hospital's published Laboratory Services have different identities. Search candidates through the administrator operation, then publish only the selected `conceptId` values with their current candidate versions. A publication batch contains at most 50 roots and may atomically add dependency-only panel members. Do not submit a global Reference Concept ID to a doctor Laboratory Request.

```bash
clinmesh admin laboratory-services candidates search --query <term>
clinmesh admin laboratory-services publish --input @publication.json --idempotency-key <key>
clinmesh admin laboratory-services job get --job-id <job-id>
```

Publication completion requires a `succeeded` job and `published` candidate state. `queued` and `running` jobs remain in progress. On `failed`, read the structured error and current candidate version before forming a new intent; a retry uses a new idempotency key and the returned version. Catalog Enrichment failures never authorize a doctor-visible service.

Reference Candidate files are operator-supplied local inputs. This workflow does not upload, publish, or expose those artifacts.
