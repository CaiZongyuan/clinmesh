---
name: clinmesh-doctor
description: ClinMesh outpatient doctor CLI workflows for consultation, diagnosis, Hospital Services, laboratory and imaging requests, medication conclusions, structured clinical documents, report acknowledgement, correction navigation, and Encounter completion.
---

# ClinMesh Doctor

Read [`../clinmesh-shared/SKILL.md`](../clinmesh-shared/SKILL.md) first. Read [references/clinical-workflows.md](references/clinical-workflows.md) before the first write in a case.

Start from the queue and current case DTO; it owns the responsible doctor, current versions, frozen dialogue turns and visible evidence. On an `awaiting-doctor` Synthetic Case, the first consultation question also starts the first visit and binds this Practitioner Role as responsible doctor. Re-read the case after every write because independent lifecycles may advance different resources.

```bash
clinmesh doctor queue list
clinmesh doctor queue list --view waiting
clinmesh doctor queue list --view active
clinmesh doctor case get --case-id <case-id>
clinmesh encounter consultation ask --input @question.json --idempotency-key <key>
clinmesh encounter consultation retry-reply --input @reply-retry.json --idempotency-key <retry-intent-key>
```

`--view waiting` selects cases awaiting first visit or revisit. `--view active` selects first visits, revisit drafts, and cases awaiting reports. Omit `--view` to list both groups. Filtering precedes pagination and the returned total belongs to the selected group. Completed Encounters use `doctor completed-cases list`.

队列和病例详情中的 `presentation: null` 表示没有分诊来源的临床表现，不能推断无症状或生命体征正常。保留病例并读取已有病历、问诊记录等可见证据；不得从 Case Truth 补造主诉、体征或分诊记录。缺失时结构化病历的主诉、现病史和查体初始为空，已有持久草稿不受影响。

## Clinical conclusions

Diagnosis and medication conclusions are independent. Save a controlled diagnosis draft and confirm it only when exactly one entry is primary. When a diagnosis is already confirmed, saving and confirming a new draft creates a new revision; re-read the case before downstream medication or completion decisions. Then either issue a valid prescription or explicitly confirm no medication. A signed, undispensed prescription may be withdrawn through its own command.

```bash
clinmesh encounter diagnosis draft set --input @diagnosis.json --idempotency-key <key>
clinmesh encounter diagnosis confirm --input @diagnosis-confirm.json --idempotency-key <key>
clinmesh encounter prescription draft set --input @prescription.json --idempotency-key <key>
clinmesh encounter prescription issue --input @prescription-issue.json --idempotency-key <key>
clinmesh encounter medication-conclusion confirm-none --input @no-medication.json --idempotency-key <key>
clinmesh prescription withdraw --input @withdrawal.json --idempotency-key <key>
```

## Laboratory and services

Laboratory draft, issue, cancellation, generation retry and report acknowledgement are separate states. Search the current case laboratory catalog before saving a draft; every returned item is an active, doctor-orderable Hospital Laboratory Service. Use its Hospital Service ID and current versioned report definition. A global Reference Concept is terminology, not an orderable service, and cannot be submitted as the catalog item. Only acknowledge a signed current report. Report correction requires an administrator Grant and creates a new immutable report chain. Other Hospital Service order and completion operations use their current ServiceRequest versions.

保存草稿或签发返回 `LABORATORY_GENERATION_UNSUPPORTED` 时，该病例缺少所选检验的结果底账，不要重复提交同一开单。已有申请的 `generationError.code` 为 `INVESTIGATION_UNSUPPORTED` 时无法通过重试恢复；`INVESTIGATION_OUTPUT_INVALID`、`AI_TIMEOUT` 和 `AI_REQUEST_FAILED` 可按当前申请版本重试生成。

```bash
clinmesh doctor case laboratory-catalog search --case-id <case-id> --query <term>
clinmesh catalog clinical get
clinmesh encounter laboratory-request draft set --input @laboratory.json --idempotency-key <key>
clinmesh encounter laboratory-request issue --input @laboratory-issue.json --idempotency-key <key>
clinmesh laboratory-request cancel --input @laboratory-cancel.json --idempotency-key <key>
clinmesh laboratory-request retry-generation --input @laboratory-retry.json --idempotency-key <key>
clinmesh laboratory-report acknowledge --input @report-acknowledgement.json --idempotency-key <key>
clinmesh laboratory-report correct --input @report-correction.json --idempotency-key <key>
clinmesh service order --input @service-order.json --idempotency-key <key>
clinmesh service complete --input @service-completion.json --idempotency-key <key>
```

## Imaging requests

放射申请（胸片、胸部 CT 平扫）与检验申请共用同一套状态，但使用各自的草稿和操作；检验操作不能作用于放射申请。先读取当前病例的放射服务目录：`available: false` 表示本院当前未开展该检查，与病例病情无关，签发会以 `CATALOG_CONFLICT` 拒绝。草稿只包含服务和检查指征，签发后由系统执行。

申请状态为 `generation-failed` 时本次检查没有取得结果，不会有报告：`IMAGING_RESULT_UNAVAILABLE` 表示该病例没有可用影像，`IMAGING_RESULT_FAILED` 表示系统连续执行失败；两者都可按当前申请版本重试或取消，重试不会改变已固定的影像。报告包含检查技术、所见、印象和本院检查标识，CLI 不提供影像像素；需要阅片时在医生工作台打开影像。确认已阅返回 `IMAGING_STUDY_UNAVAILABLE` 时影像暂不可读，报告仍可读取，待影像恢复后再确认。CLI 的确认已阅表示医生已阅读报告，不代表影像曾在人面前显示；需要阅片时由医生在工作台打开影像。报告更正需要管理员 Grant，只能选择同一检查另一份已核对的报告内容，更正后当前报告需要重新确认。

```bash
clinmesh doctor case imaging-services list --case-id <case-id>
clinmesh encounter imaging-request draft set --input @imaging.json --idempotency-key <key>
clinmesh encounter imaging-request draft delete --input @imaging-draft-delete.json --idempotency-key <key>
clinmesh encounter imaging-request issue --input @imaging-issue.json --idempotency-key <key>
clinmesh imaging-request cancel --input @imaging-cancel.json --idempotency-key <key>
clinmesh imaging-request retry --input @imaging-retry.json --idempotency-key <key>
clinmesh imaging-report acknowledge --input @imaging-acknowledgement.json --idempotency-key <key>
clinmesh imaging-report correct --input @imaging-correction.json --idempotency-key <key>
```

## Pathology consultation requests

乳腺切片病理会诊面向既往做过乳腺手术的患者：患者携带既往手术的 H&E 切片，由本院病理科出具会诊报告。它与检验、放射申请共用同一套状态，但使用各自的草稿和操作；检验和放射操作不能作用于病理申请。先读取当前病例的会诊服务目录：`available: false` 表示本院当前未开展，与病例病情无关；`sourceProcedures` 是该病例可见既往病史中可以送检的手术。草稿包含服务、`sourceProcedureReference`（取自 `sourceProcedures` 的 `sourceReference`）和会诊目的；所选手术不在清单内时以 `PATHOLOGY_SOURCE_PROCEDURE_UNAVAILABLE` 拒绝。同一服务同时只能有一条进行中的会诊。

申请受理表示已收片，开始表示阅片中。状态为 `generation-failed` 时本次会诊没有取得结果，不会有报告：`PATHOLOGY_RESULT_UNAVAILABLE` 表示该病例没有可用切片，`PATHOLOGY_RESULT_FAILED` 表示系统连续执行失败；两者都可按当前申请版本重试或取消。报告包含标本信息（所选既往手术、切片数量、染色）、镜下所见、病理诊断、既有免疫组化结果和备注，CLI 不提供切片像素；需要阅片时由医生在工作台打开切片。确认已阅返回 `IMAGING_STUDY_UNAVAILABLE` 时切片暂不可读，报告仍可读取。CLI 的确认已阅表示医生已阅读报告，不代表切片曾在人面前显示。报告更正需要管理员 Grant，只能选择同一切片另一份已核对的报告内容，更正后当前报告需要重新确认。

```bash
clinmesh doctor case pathology-services list --case-id <case-id>
clinmesh encounter pathology-request draft set --input @pathology.json --idempotency-key <key>
clinmesh encounter pathology-request draft delete --input @pathology-draft-delete.json --idempotency-key <key>
clinmesh encounter pathology-request issue --input @pathology-issue.json --idempotency-key <key>
clinmesh pathology-request cancel --input @pathology-cancel.json --idempotency-key <key>
clinmesh pathology-request retry --input @pathology-retry.json --idempotency-key <key>
clinmesh pathology-report acknowledge --input @pathology-acknowledgement.json --idempotency-key <key>
clinmesh pathology-report correct --input @pathology-correction.json --idempotency-key <key>
```

## Document and completion

Use independent lifecycle Commands. A document preview binds the current draft and versions; sign from that preview, and revise a signed document by creating a new revision. Document signing never completes the Encounter. Read the completion preview, resolve every blocking condition, then submit Encounter Completion with the current Encounter version. Do not use combined revisit, combined signing/completion or old laboratory-order entrypoints.

Draft saves accept empty fields while history is still being collected. Keep every required document key, use an empty string for unfinished content, and read the current draft version before saving. Sign preview still requires complete clinical content. In DSH, new consultations automatically record sourced patient history; read `consultationRecording` and the current draft before making changes, and leave pending additions for human review. `consultationRecording.hasSavedDraft` records whether an explicit draft save has occurred; before that save, empty fields untouched by automatic additions can still have visible triage/history prefill. Read and preserve that visible content before submitting a complete draft; after an explicit save, saved empty values are intentional.

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
