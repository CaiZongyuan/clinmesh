---
name: clinmesh-administrator
description: ClinMesh administrator CLI workflow for inspecting automatically enabled laboratory-cn services and explicitly configuring bounded laboratory publication batches. Use for Laboratory Service configuration, source or panel filtering, publication status, retries, and job inspection; use scenario-data workflows for synthetic patient generation instead.
---

# ClinMesh Administrator

Read [`../clinmesh-shared/SKILL.md`](../clinmesh-shared/SKILL.md) first. Work only with synthetic ClinMesh data and the configured local Reference Release.

ClinMesh automatically enables every active laboratory-cn panel and test at startup. Ordinary clinical use requires no selection or publication step. The default Reference Release excludes the standalone LOINC Dataset; LOINC publication is available only with an explicitly configured Reference Release and source filter. The Reference catalog and the hospital's published Laboratory Services have different identities. Search candidates through the administrator operation, optionally filtering with `--source-dataset laboratory-cn` or `--source-dataset loinc-zh-cn` and `--panel-only`. Candidate output owns the Dataset Release, member count, specimen, adult applicability, and reference-source summary. For explicit configuration changes, publish only selected `conceptId` values with their current candidate versions. A publication batch contains at most 50 roots and may atomically add dependency-only panel members. Do not submit a global Reference Concept ID to a doctor Laboratory Request.

```bash
clinmesh admin laboratory-services candidates search
clinmesh admin laboratory-services candidates search --source-dataset laboratory-cn --panel-only
clinmesh admin laboratory-services publish --input @publication.json --idempotency-key <key>
clinmesh admin laboratory-services job get --job-id <job-id>
```

Publication completion requires a `succeeded` job and `published` candidate state. `queued` and `running` jobs remain in progress. On `failed`, read the structured error and current candidate version before forming a new intent; a retry uses a new idempotency key and the returned version. `laboratory-cn` panels and tests use their frozen Dataset definition without a Catalog Enrichment provider. LOINC candidates still require valid Catalog Enrichment before they become doctor-visible.

Reference Candidate files are operator-supplied local inputs. This workflow does not upload, publish, or expose those artifacts.
