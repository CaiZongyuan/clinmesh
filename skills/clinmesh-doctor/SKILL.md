---
name: clinmesh-doctor
description: ClinMesh outpatient doctor CLI workflows for consultation, diagnosis, Hospital Services, laboratory and imaging requests, medication conclusions, structured clinical documents, automatic recording controls and patient/doctor/report source attribution, report acknowledgement, correction navigation, and Encounter completion.
---

# ClinMesh Doctor

Read [`../clinmesh-shared/SKILL.md`](../clinmesh-shared/SKILL.md) first. Read [references/clinical-workflows.md](references/clinical-workflows.md) before the first write in a case and before preparing a signature.

Start from the queue and current case DTO; it owns the responsible doctor, current versions, frozen dialogue turns and visible evidence. On an `awaiting-doctor` Synthetic Case, the first consultation question also starts the first visit and binds this Practitioner Role as responsible doctor. Re-read the case after every write because independent lifecycles may advance different resources.

Use `registrationNumber` from the queue or case DTO to identify this visit. A `null` value means the legacy visit number was not recorded; report it as missing. `patient.identifier` identifies the patient and cannot replace the visit number. Preserve the full number when reading, displaying, copying or searching it, including historical formats.

```bash
clinmesh doctor queue list
clinmesh doctor queue list --view waiting
clinmesh doctor queue list --view active
clinmesh doctor case get --case-id <case-id>
clinmesh encounter consultation ask --input @question.json --idempotency-key <key>
clinmesh encounter consultation retry-reply --input @reply-retry.json --idempotency-key <retry-intent-key>
```

Read `consultation.replyAttempt` and the original Command receipt after an interrupted response. An `executing` attempt keeps its original deadline and model, including when another retry key joins it. The same ask/retry key replays its saved reply or terminal `failed`/`unknown` outcome without new inference. Missing or outdated persona bindings retain `CONSULTATION_CASE_NOT_FOUND` (404) or `CONSULTATION_PERSONA_OUTDATED` (409), respectively, including on replay; restore a valid persona binding before an explicit new retry. Only an explicit clinician retry after termination uses a new retry intent key; follow the [consultation recovery reference](references/clinical-workflows.md#consultation-and-diagnosis) before recovering an unanswered turn.

`MODEL_CONTROL_BLOCKED` (409) preserves the saved doctor question. Read the case and original receipt: a `blocked` reply can resume when model controls recover, using the original model and deadline while its authorization and case remain valid. After termination, an explicit clinician retry uses a new retry intent key. An `unknown` request requires that explicit decision and never resumes merely because controls recover.

`--view waiting` selects cases awaiting first visit or revisit. `--view active` selects first visits, revisit drafts, and cases awaiting reports. Omit `--view` to list both groups. Filtering precedes pagination and the returned total belongs to the selected group. Completed Encounters use `doctor completed-cases list`.

队列和病例详情中的 `presentation: null` 表示没有分诊来源的临床表现，不能推断无症状或生命体征正常。保留病例并读取已有病历、问诊记录等可见证据；不得从 Case Truth 补造主诉、体征或分诊记录。缺失时结构化病历的主诉、现病史和体格检查初始为空，已有持久草稿不受影响。

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

保存草稿或签发返回 `LABORATORY_GENERATION_UNSUPPORTED` 时，该病例缺少所选检验的结果底账，不要重复提交同一开单。已有申请的 `generationError.code` 为 `INVESTIGATION_TRUTH_INCOMPATIBLE` 时，精确病例真值与冻结报告定义不兼容；该错误与 `INVESTIGATION_UNSUPPORTED` 均不能重试，可按当前申请版本取消。`INVESTIGATION_OUTPUT_INVALID`、`AI_TIMEOUT` 和 `AI_REQUEST_FAILED` 仍可按当前版本重试生成，也可取消。旧 `INVESTIGATION_OUTPUT_INVALID` 单位冲突申请可以重试，由当前解析规则换算或重新分类；申请继续使用原冻结服务。取消只适用于 `issued` 或 `generation-failed`，仍须使用当前版本与新的幂等键。

模型控制拒绝时保留有效检验待办，控制恢复后接续。`MODEL_OUTCOME_UNKNOWN` 表示派发结果未知，停止自动重发；医生明确决定后才使用 `laboratory-request retry-generation`，不通过重复开单恢复。

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

`familyHistory`（家族史）与 `allergyHistory`（过敏史）各最多 4,000 字，可缺失或留空，表示未记录，签署不要求补齐。读取旧草稿或文书时保留缺失状态；不得自动填“无”。新患者自述直接记录到这两个字段，旧条目保留持久 field。过敏史文本不创建正式 AllergyIntolerance，也不替代正式用药过敏校验。保存和修订完整文书时保留当前两字段；清空使用空字符串。

Use independent lifecycle Commands. A document preview binds the current draft and versions; sign from that preview, and revise a signed document by creating a new revision. Document signing never completes the Encounter. Read the completion preview, resolve every blocking condition, then submit Encounter Completion with the current Encounter version. Do not use combined revisit, combined signing/completion or old laboratory-order entrypoints.

Draft saves accept empty fields while collecting history; keep required keys and read the current draft version before saving. Preserve field text exactly, including whitespace and punctuation. An identical save advances the draft version while retaining recommendations for unchanged clinical input. Patient, doctor and report facts passing deterministic source checks are recorded directly into all ten document fields, including independent family and allergy history. Physical examination, assessment, disposition and follow-up require explicit doctor sources; do not infer clinical decisions. There is no suggestion application, history review or undo operation. Read the current draft and consultationRecording after background progress. Entries retain ownership, currentText and ordered facts with exact patient/doctor/report sources; legacy entries use sourceTurnId and quote. Use the returned sources to trace saved evidence in the background; there is no source viewer or doctor acknowledgement step. Summaries preserve uncertainty and home/external attribution. Automatic updates replace only valid automatic ranges; manual text remains and supported corrections or contradictions are recorded separately with attribution and uncertainty. Use the normal versioned draft save for explicit text edits and preserve current fields and unsaved input.

`consultationRecording.hasSavedDraft` records whether an explicit draft save has occurred; before that save, empty fields untouched by automatic additions can still have visible triage/history prefill. Read and preserve that visible content before submitting a complete draft; after an explicit save, saved empty values are intentional.

Recording controls use `encounter.consultation-recording.control` with the current `consultationRecording.version` and Encounter version. New cases default to enabled recording when the model bridge is available. Use `activate` for an editable unsigned case with no historical sources and no recording state, passing `expectedRecordingVersion: 0`; reading the case does not activate or backfill it. An already enabled case may return `requiresContextBinding: true` after upgrade; use `activate` with its current recording version to restore the trusted doctor binding. This preserves the original version, pause, failures and source eligibility; reread after the receipt. Use pause to keep the draft stable while legal sources continue saving; resume processes unfinished patient, doctor and report sources in bounded batches; failed sources remain observable while later sources continue. A historical case reports backfill and remains unchanged until the clinician explicitly starts it. Backfill requires an existing Consultation; an Encounter without one returns `WORKFLOW_CONFLICT`. Retry actual recording failures while preserving completed sources and manual fragment ownership. Retired semantic checks have no retry action; review source meaning through current document quality control. Read `processedCount`, `remainingCount` and `failedCount` after refresh or reconnect instead of inferring progress from a model response. On a conflict, reread before choosing a new control intent; on an ambiguous write, recover its receipt using the original key.

`consultationRecording.failures` associates safe failure codes with `sourceTurnId` and retains `retrying` for interrupted server shutdown recovery. Ordinary failures do not automatically repeat whole recording attempts. `AI_TIMEOUT` or `AI_RESPONSE_INVALID` settles as failed and can be retried with the recording control; the saved original source remains available. Read that source and have the clinician complete or review the record. `AI_AUTH_FAILED` requires checking the selected model's access in settings. A patient-reply retry regenerates dialogue and does not retry history recording.

Model controls retain valid unfinished recording sources for automatic continuation and reuse completed stages. `MODEL_OUTCOME_UNKNOWN` stops automatic resending; read the saved source and retry recording only after an explicit clinician decision. Restoring controls alone does not retry this outcome.

A valid cancel-only Agent Grant can cancel a signing preparation and recover its unfinished recording. Recovery remains bound to that exact Grant; revocation, expiry or client disablement stops background recording. Follow the [clinical workflow reference](references/clinical-workflows.md#clinical-document-and-completion) for preparation, cancellation and receipt recovery.

Read `qualityControl` for document completeness, known omissions, inconsistent facts and Agent facts without supported sources. Each issue identifies its field, original evidence and a project or official rule; `needs-completion` and `needs-verification` are review categories, not clinical risk grades. Different-time facts are not automatically contradictory. Empty issues do not certify clinical safety or regulatory compliance; inspect `status`, `stale`, `notices`, `errorCode` and optional `failure.stage` / `failure.reason` before describing coverage. Failure reasons distinguish JSON, shape, source, scope, verification coverage and service errors through safe categories; a scope notice is not the cause of failure.

`doctor document-quality check` checks the saved document, or an unsaved candidate supplied together with `clientId` and `clientRevision`; it does not save the clinical draft. Poll `doctor document-quality get` using the same `clientId` for a candidate, and compare its identity and input fingerprint before using the result. The recording control version is not a quality input version. After an explicit clinician decision to retain an issue, use `doctor document-quality retain` with its current `issueId` and `expectedInputFingerprint`; `reason` is optional. The decision applies only to the related unchanged text and evidence, remains audited, and is not a new patient fact. On a version conflict, reread rather than suppressing the warning.

Identical complete clinical input shares a persistent task across saved and candidate views while each view retains its version binding. Reuse successful, pending and failed results after navigation; changing a draft version alone does not justify another model check. Retry a failed input with `refresh: true` only after the clinician explicitly requests another check. New clinical text, relevant sources, Agent authorship or authorization requires a current check; changing client identity is not a retry mechanism.

Keep Agent draft authorship through `agentGenerated: true` when setting a document; optional `agentFacts` identify the field, exact text and saved source quotes for server verification. A client citation does not prove a clinical fact, and unavailable sources remain visible for verification. The preview's `qualityControl` summarizes outstanding issues and any pending, stale or failed check; it does not add a signing gate. Existing required fields, source snapshots, version checks and final clinician confirmation still apply. Quality evidence and explicit retention belong to quality issues; automatic recording does not regain per-fragment review or source controls.

```bash
clinmesh encounter clinical-document draft set --input @document.json --idempotency-key <key>
clinmesh encounter consultation-recording control --input @recording-control.json --idempotency-key <control-intent-key>
clinmesh doctor document-quality get --case-id <case-id>
clinmesh doctor document-quality check --input @document-quality-check.json --idempotency-key <check-intent-key>
clinmesh doctor document-quality retain --input @document-quality-retain.json --idempotency-key <retain-intent-key>
clinmesh encounter clinical-document sign preview --input @document-preview.json --idempotency-key <key>
clinmesh encounter clinical-document sign commit --input @document-sign.json --idempotency-key <key>
clinmesh encounter clinical-document sign cancel --input @document-cancel.json --idempotency-key <cancel-intent-key>
clinmesh clinical-document revise --input @document-revision.json --idempotency-key <key>
clinmesh encounter completion preview --encounter-id <encounter-id>
clinmesh encounter complete --input @completion.json --idempotency-key <key>
```

Read completed cases through their separate read model; it contains formal facts and revision timelines, not editable drafts. Completion is established when the Encounter leaves the active doctor queue and appears in the responsible doctor's completed-case library. Billing, dispensing and Scenario Run completion remain separate downstream responsibilities.

```bash
clinmesh doctor completed-cases list
clinmesh doctor completed-cases get --case-id <case-id>
```

`consultationRecording.sourceResults` reports each settled source as `recorded`, `no-new-facts`, `needs-verification` or `failed`; `needs-verification` means a recording candidate failed programmatic validation, not a separate model check. Source meaning, preservation of previous facts, correction/conflict relations and rejected facts returning without new support are checked by existing `qualityControl`. Its generation and independent review keep their normal triggers and input reuse. Legacy `consultationRecording.verification` counts are zero and `issues` empty; they do not certify semantic correctness or permit retrying retired checks. Retry only actual recording failures. Review quality status, notices and issues before describing coverage; missing context or a failed check is not a pass. Existing signing completeness, permissions, snapshots and version checks still apply without per-fragment acknowledgement.
