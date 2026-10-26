---
name: clinmesh-registration
description: ClinMesh registrar CLI workflows for finding or creating synthetic patients, registering outpatient visits, and starting a ready Synthetic Case Instance. Use for registrar work and the registration-to-triage handoff.
---

# ClinMesh Registration

Read [`../clinmesh-shared/SKILL.md`](../clinmesh-shared/SKILL.md) first.

Start with the registration catalog, then search by the strongest available synthetic identifier before creating a Patient Identity. A new patient and a new Registration are separate intents with separate idempotency keys. Use the returned Patient and Encounter versions rather than inventing them.

```bash
clinmesh catalog registration get
clinmesh patient search --query <name-or-identifier>
clinmesh patient create --input @patient.json --idempotency-key <key>
clinmesh registration create --input @registration.json --idempotency-key <key>
clinmesh registration list
```

For a generated case with an active successful Patient Brief, search the registrar queue by name or medical record number, then start the normal outpatient flow. The queue returns the identity and Case/Brief/Profile revisions required for registration; it does not expose Case Truth, source Bundles, or generation configuration. Do not use the retired Virtual Patient or Scenario Dataset entrypoints.

```bash
clinmesh registration synthetic-case list --search <name-or-mrn>
clinmesh registration synthetic-case start --input @case-start.json --idempotency-key <key>
```

The ordinary and Synthetic Case paths converge on the same Registration, Encounter, and triage Queue Task. After a conflict, refresh the Synthetic Case queue before forming a new intent.

`registrationNumber` identifies this outpatient visit; `patient.identifier` identifies the patient. After either registration command, including an idempotent replay, use its returned `registrationId` or `encounterId` to find the matching row in `registration list`, paging as needed. Command receipts supply those references; the matching list row supplies `registrationNumber`. Registration work is complete when that row confirms the visit; hand its references and complete number to a triage-nurse Grant and stop acting as registrar. Keep the date and full serial value, including historical formats.

For `REGISTRATION_NUMBER_STATE_INVALID`, `REGISTRATION_NUMBER_EXHAUSTED`, or `REGISTRATION_NUMBER_AUTHORITY_RETIRED`, stop issuance and ask the administrator to preserve and verify the authority database using the [storage and recovery contract](../../docs/architecture/storage.md#94-标识符). Keep the original intent and key for retry after recovery. Do not replace the date, manufacture a number, reset the Scenario, or send a new intent to bypass the error.

住院登记与预交金使用 [住院工作流](../clinmesh-inpatient/SKILL.md)，与门诊登记相互独立。

已选中 Persona 的合成病例也可直接登记住院。使用当前 `caseId`、`activeBriefRevision`、`expectedCaseRevision`、受信 `expectedEpoch` 和接收病区 `wardId`；首例使用 `ward-general`。该动作只创建 Patient 与住院 Encounter/Account，返回 `admissionId`，预交金为零。登记完成后交给病区护士接诊；不生成门诊挂号、排队或挂号费。状态/版本冲突后刷新病例，原键回放继续保留原回执。

```bash
clinmesh registration synthetic-case start-inpatient --input @inpatient-case-start.json --idempotency-key <key>
clinmesh command receipt get --operation-id registration.synthetic-case.start-inpatient --idempotency-key <key>
```

```json
{"caseId":"synthetic-case","activeBriefRevision":1,"expectedCaseRevision":2,"expectedEpoch":"epoch-1","wardId":"ward-general"}
```
