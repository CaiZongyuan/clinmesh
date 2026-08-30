---
name: clinmesh-doctor
description: ClinMesh outpatient doctor CLI workflows for consultation, diagnosis, Hospital Services, laboratory requests, medication conclusions, structured clinical documents, report acknowledgement, correction navigation, and Encounter completion.
---

# ClinMesh Doctor

Read [`../clinmesh-shared/SKILL.md`](../clinmesh-shared/SKILL.md) first. Read [references/clinical-workflows.md](references/clinical-workflows.md) before the first write in a case.

Start from the queue and current case DTO; it owns the responsible doctor, current versions, allowed consultation questions and visible evidence. On an `awaiting-doctor` Synthetic Case, the first consultation question also starts the first visit and binds this Practitioner Role as responsible doctor. Re-read the case after every write because independent lifecycles may advance different resources.

```bash
clinmesh doctor queue list
clinmesh doctor case get --case-id <case-id>
clinmesh encounter consultation ask --input @question.json --idempotency-key <key>
```

## Clinical conclusions

Diagnosis and medication conclusions are independent. Save a controlled diagnosis draft, confirm it only when exactly one entry is primary, then either issue a valid prescription or explicitly confirm no medication. A signed, undispensed prescription may be withdrawn through its own command.

```bash
clinmesh encounter diagnosis draft set --input @diagnosis.json --idempotency-key <key>
clinmesh encounter diagnosis confirm --input @diagnosis-confirm.json --idempotency-key <key>
clinmesh encounter prescription draft set --input @prescription.json --idempotency-key <key>
clinmesh encounter prescription issue --input @prescription-issue.json --idempotency-key <key>
clinmesh encounter medication-conclusion confirm-none --input @no-medication.json --idempotency-key <key>
clinmesh prescription withdraw --input @withdrawal.json --idempotency-key <key>
```

## Laboratory and services

Laboratory draft, issue, cancellation, generation retry and report acknowledgement are separate states. Only acknowledge a signed current report. Report correction requires an administrator Grant and creates a new immutable report chain. Hospital Service order and completion use their current ServiceRequest versions.

```bash
clinmesh encounter laboratory-request draft set --input @laboratory.json --idempotency-key <key>
clinmesh encounter laboratory-request issue --input @laboratory-issue.json --idempotency-key <key>
clinmesh laboratory-request cancel --input @laboratory-cancel.json --idempotency-key <key>
clinmesh laboratory-request retry-generation --input @laboratory-retry.json --idempotency-key <key>
clinmesh laboratory-report acknowledge --input @report-acknowledgement.json --idempotency-key <key>
clinmesh laboratory-report correct --input @report-correction.json --idempotency-key <key>
clinmesh service order --input @service-order.json --idempotency-key <key>
clinmesh service complete --input @service-completion.json --idempotency-key <key>
```

## Document and completion

Use independent lifecycle Commands. A document preview binds the current draft and versions; sign from that preview, and revise a signed document by creating a new revision. Document signing never completes the Encounter. Read the completion preview, resolve every blocking condition, then submit Encounter Completion with the current Encounter version. Do not use combined revisit, combined signing/completion or old laboratory-order entrypoints.

```bash
clinmesh encounter clinical-document draft set --input @document.json --idempotency-key <key>
clinmesh encounter clinical-document sign preview --input @document-preview.json --idempotency-key <key>
clinmesh encounter clinical-document sign commit --input @document-sign.json --idempotency-key <key>
clinmesh clinical-document revise --input @document-revision.json --idempotency-key <key>
clinmesh encounter completion preview --encounter-id <encounter-id>
clinmesh encounter complete --input @completion.json --idempotency-key <key>
```

Read completed cases through their separate read model; it contains formal facts and revision timelines, not editable drafts. Completion is established when the Encounter leaves the active doctor queue and appears in the responsible doctor's completed-case library. Billing, dispensing and Scenario Run completion remain separate downstream responsibilities.

```bash
clinmesh doctor completed-cases list
clinmesh doctor completed-cases get --case-id <case-id>
```
