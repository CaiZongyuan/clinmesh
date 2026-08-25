# Agent Note: 结构化临床文书独立生命周期

Status: implemented

## Problem

[医生核心临床业务流](https://github.com/caizongyuan/clinmesh/issues/24)要求医生把 Consultation Record 手工整理为正式 Clinical Document，并支持可恢复草稿、并发控制、签署和签署后修订。首期复诊流把诊断、Prescription、两字段文书和 Encounter 完成放在同一个预览与提交动作中；继续扩展该组合会让文书生命周期依赖处方和完诊状态，也无法表达签署件不可覆盖、修订替代关系和六字段共享合同。

总体医生核心边界由[医生核心临床业务流提案](../../proposed/feature/2026-08-24-doctor-clinical-core-workflow.md)拥有；本 Note 只记录已经交付的结构化 Clinical Document 持久化和协议决策。

## Decision

结构化 Clinical Document 以主诉、现病史、查体、评估、处置和随访六个字段作为共享 strict schema。未签署正文是 `clinical_document_draft` 中按 Workspace、Epoch 和病例唯一的 domain-native 草稿；保存同时校验 Encounter expected version 和 `expectedDraftVersion`，冲突不覆盖较新的正文。医生病例查询恢复草稿正文、更新时间和版本，Web 使用 TanStack Query 重新读取服务端状态。

签署采用独立的预览与提交协议。预览保存 Actor context HMAC、Encounter version、草稿版本、正文摘要、token hash 和按服务端真实时间计算的五分钟过期时间；提交重新校验这些绑定。成功提交创建不可变 FHIR R5 Composition、带稳定 identifier 且以 Composition 为首 entry 的自包含 document Bundle，以及同时引用二者的 Provenance，并写入 `signed_clinical_document` 关联；它不改变 Encounter、病例或 Queue Task 状态。

Composition 使用稳定 section code 重建六字段正文，关系表不复制已签正文。每个 Workspace、Epoch 和病例只有一个 `revision_of_document_id IS NULL` 的签署根文书。修订只能引用没有后继版本的最新 Composition，创建新的 amended Composition、document Bundle 和 Provenance，以 `Composition.relatesTo.type=replaces` 和关系表父链指向上一版本；修订原因由 Provenance 保存。FHIR `_history` 仍只表达同一 logical resource 的技术版本，不承担临床修订链。

`revise` 接口继续接受首期两字段文书输入，也接受新的六字段文书输入，由同一个修订 Command 创建不可变资源；两字段输入只修订首期文书，六字段输入只修订结构化文书，不能跨格式破坏历史重建。Command 在读取修订后继或创建资源前校验当前 Practitioner Role 与病例的持久责任岗位一致，普通医生不能修订其他医生负责的病例。首期 `preview-sign` 与 `sign-and-complete` 兼容流只适用于尚无结构化签署根文书的病例；已有根文书时两个入口都返回稳定 `WORKFLOW_CONFLICT`，不会依赖 SQLite 唯一索引错误作为外部协议。

## Alternatives considered

**继续扩展复诊 `clinical_draft` 和 `sign-and-complete`。** 这可以复用首期页面和两字段 Composition，但会把病历草稿、诊断、处方、费用和 Encounter 完成继续锁在一个版本集合中，无法独立保存或签署文书。

**把未签署草稿直接保存为可更新的 Composition。** 这减少一种领域表，却让同一 FHIR resource 同时承担可变编辑状态和不可变签署事实，并使 FHIR generic history 看似成为业务修订链。草稿因此保持 domain-native，签署后才发布 FHIR 文书。

**用同一 Composition logical id 的新 FHIR version 表达修订。** 这能复用 `_history`，但会覆盖业务文书实例的独立身份，无法清楚表达替代关系，也混淆服务器技术版本、Provenance 和 Clinical Document Revision。

**允许每次签署产生独立根或从旧版本分叉。** 这便于并行更正，却使“当前有效文书”不再唯一，读取方必须在多个根和分支间自行裁决。当前普通门诊病例采用一个根和 latest-only 线性修订链。

## Consequences

医生可以在 Encounter 仍为 `in-progress` 时保存、预览和签署病历；签署成功不代表 Encounter Completion。调用方必须分别读取病历历史和 Encounter 状态，不能从 Composition 存在推断完诊。

迁移 `0011_structured-clinical-document.sql` 新增结构化草稿、签署预览和每病例唯一根索引；`0012_structured-clinical-document-preview-binding.sql` 为预览补充 Encounter version 和 Actor context 绑定，旧预览迁移后不可提交。旧库升级保留已有 `signed_clinical_document` 根文书，并允许在其后追加修订。

Web 只向最新签署版本显示修订表单，所有历史版本只读；已完诊结构化文书只有从病例库中标记为 `correctionSupported` 的事实显式进入病历更正模式时显示该表单，首期两字段文书继续可读但不提供空导航。保存或修订冲突后重新读取病例 detail，修订成功同时失效病例库详情和时间线查询。HTTP 和 Web 公共入口覆盖缺失必填字段、草稿 CAS、旧预览、不可变 FHIR 资源、Encounter 不变、最新版本修订和历史恢复。

同一病例不能先走独立结构化签署，再走首期组合签署完诊；组合入口会返回已有文书冲突。这项互斥保证避免第二个根文书，Encounter Completion 仍由独立的业务事实判断，不能通过覆盖或重复签署绕过。
