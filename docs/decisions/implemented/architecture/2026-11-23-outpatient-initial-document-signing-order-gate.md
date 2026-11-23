# Agent Note: 前置门诊首版结构化病历正式电子签名与主诊断确认作为开单门禁

Status: implemented

## Problem

在现代 `Consultation` 普通门诊闭环中，原先仅处方签发局部要求已确认诊断，而检验、功能检查、放射与病理四类医技申请及无需用药结论均可在尚未签署首版结构化病历甚至尚未确认主诊断时直接签发，门诊医生工作台页签也按 `检验检查 -> 诊断 -> 处方` 排列。这与公立医院《病历书写基本规范》及电子病历应用水平分级评价中“先完成问诊查体与首版门急诊病历正式电子签名、明确初步主诊断，再据以签发医技申请与处方”的临床责任链脱节。同时，首版病历一旦提前签署，进行中就诊的 `encounter.clinical-document.draft.set` 即被锁死，后续检验检查回报或开方后补充辅助检查、评估、处置与随访时缺少受控的签后修订草稿机制，且完诊门禁对已签根文书后的未提交修订草稿不设拦截。

## Decision

1. **统一门诊开单前置门禁与判定次序**：在 `ClinicalRequestContext.assertOutpatientOrderPrerequisites` 中对现代 `Consultation` 门诊病例统一执行两级服务端硬门禁——先校验 `signed_clinical_document` 是否存在根文书（`revision_of_document_id IS NULL`，缺失返回 `409 CLINICAL_DOCUMENT_UNSIGNED`），再校验最新 `diagnosis_confirmation` 是否含有效主诊断（缺失返回 `409 DIAGNOSIS_UNCONFIRMED`）。门禁统一覆盖 `encounter.laboratory-request.issue`、`encounter.examination-request.issue`、`encounter.imaging-request.issue`、`encounter.pathology-request.issue`、`encounter.prescription.issue`、`encounter.medication-conclusion.confirm-none` 六个单项 Command，以及 `doctor.recommendations.confirm` 的 `laboratory`、`imaging`、`pathology`、`prescription` 四类工作台集中确认入口（位于逐项 savepoint 之前整批校验）。
2. **保留门禁前准备能力与历史兼容边界**：门禁生效前，病历、诊断、四类医技与处方的草稿保存和删除、专病医嘱组套预填、门诊病历完备性质控、四关口 AI 诊疗建议生成以及诊断确认本身全部保持开放；住院医技（`InpatientInvestigations`）与无 `Consultation` 聚合的首期兼容门诊路径不受该门禁影响，历史回执中的 `PRESCRIPTION_DIAGNOSIS_UNCONFIRMED` 枚举保留只读兼容。
3. **进行中签后病历修订草稿与完诊一致性门禁**：根文书签署后只要 `Encounter.status = 'in-progress'`，主接诊责任医生仍可通过 `encounter.clinical-document.draft.set` 保存签后病历修订草稿（包括将新回报的放射／病理报告摘要插入“辅助检查”草稿），不直接改写已签署 FHIR R5 `Composition`。`clinical_document_draft` 保持单调递增版本号以维持实时整理偏移量与质控指纹稳定；正式提交 `clinical-document.revise` 生成线性替代 `Composition` 时同步对齐 `clinical_document_draft` 正文。完诊预览与 `encounter.complete` 的 `no-pending-drafts` 门禁（见[门诊完诊策略与病例库决策](../feature/2026-08-25-encounter-completion-policy.md)及[准备临床确认决策](2026-10-18-prepared-clinical-confirmation.md)）对比 `clinical_document_draft` 与最新已签 `Composition` 的规范化十二字段：凡存在未签署差异均以 `target = 'clinical-document'` 阻断完诊，直至医生提交修订签名或将草稿恢复为最新已签正文。
4. **工作台动线与受控 Agent 工具面对齐**：门诊医生工作台页签与 `doctorCaseSectionSchema` 统一调整为 `问诊记录 -> 病历记录 -> 诊断 -> 检验检查 -> 处方`；前置条件未满足时在各开单／无需用药主操作旁就地禁用按钮并提供一键跳转至「病历记录」或「诊断」的引导，开方或确认无需用药后通过「补充病历评估/处置/随访」自动写入修订草稿并展开修订表单，DSH 对应 `*.issue.propose` 与 `outpatient.medication.none.propose` 工具保持启用并在执行前返回明确前置校验提示。

## Alternatives considered

- **仅在前端工作台调整页签顺序并软提示，服务端不设硬门禁**：被拒绝。HTTP API、CLI 与受控 Agent 工具均可绕过前端顺序直接调用签发 Command，无法保证真实医疗责任链与审计事实一致。
- **首版病历签署或修订签署时物理删除 `clinical_document_draft` 行**：被拒绝。删除草稿行会重置单调 `version` 并破坏 `consultation_history_addition` 的字符偏移锚点与病历质控基线；保留单调草稿行并与最新已签 `Composition` 正文做规范化比对，既能准确识别签后未提交修订，又允许通过保存最新已签正文无副作用地放弃修订草稿。
- **每次保存签后草稿时自动静默创建新的 `Composition` 修订**：被拒绝。正式病历修订属于需明确修订原因与医生签名的法律文书行为，自动生成不可变 `Composition` 会污染签署历史与 `Provenance` 审计链。

## Consequences

- 现代 `Consultation` 门诊测试夹具、CLI 剧本与端到端验收流在正式开立医技申请、开具处方或确认无需用药前，必须先完成首版结构化病历签署与主诊断确认（确认诊断会推进 `Encounter` 版本）。
- 医生在首版病历签署后点击放射／病理报告「摘要插入病历」或手工编辑病历草稿时，变更会进入受保护的签后修订草稿并在完诊前由 `no-pending-drafts` 兜底拦截，彻底消除“屏幕已插入摘要但完诊归档文书漏载”的静默丢失风险。
