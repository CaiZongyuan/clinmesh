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

已选中 Persona 的合成病例也可直接登记住院。固定 PCI 病例由管理员准备后已选用合成 Persona，无需再要求手填或选择首个修订。使用就绪摘要返回的当前 `caseId`、`activeBriefRevision`、病例修订作为 `expectedCaseRevision`，以及受信 `expectedEpoch` 和接收病区 `wardId`；首例使用 `ward-general`。该动作只创建 Patient 与住院 Encounter/Account，返回 `admissionId`，预交金为零。登记完成后交给病区护士接诊；不生成门诊挂号、排队或挂号费。状态/版本冲突后刷新病例，原键回放继续保留原回执；已消费病例继续原住院，不因管理员再次准备而获得第二次入院资格。

```bash
clinmesh registration synthetic-case start-inpatient --input @inpatient-case-start.json --idempotency-key <key>
clinmesh command receipt get --operation-id registration.synthetic-case.start-inpatient --idempotency-key <key>
```

```json
{"caseId":"synthetic-case","activeBriefRevision":1,"expectedCaseRevision":2,"expectedEpoch":"epoch-1","wardId":"ward-general"}
```

## 本院跨系统患者认人隔离区

当本院第二套 LIS 等院内辅检来源以不同外部患者编号接入，但身份证号与出生日期匹配而电话/姓名细节存在偏差、置信度低于自动合并阈值时，来件记录会先进入认人隔离区，不会写入患者临床事实台账或评分；同姓同名但出生日期不同的患者始终视为不同患者并拒绝合并。由管理员或登记员核对后执行确认并档或判定不同患者，所有操作计入 `AuditEvent` 与 `ActionTrace`。

```bash
clinmesh identity-quarantine list
clinmesh identity-quarantine list --resolution-status pending-review
clinmesh identity-quarantine confirm-merge --input @quarantine-merge.json --idempotency-key <key>
clinmesh command receipt get --operation-id identity-quarantine.confirm-merge --idempotency-key <key>
```

```json
{"candidateId":"cand-1","decision":"confirm-merge","targetPatientId":"patient-1","auditNote":"核对居民身份证号与出生日期一致，确认并档"}
```
