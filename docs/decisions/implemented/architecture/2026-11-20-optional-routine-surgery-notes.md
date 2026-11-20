# Agent Note: 常规无差异手术路径免填文字依据与偏离强制留痕

Status: implemented

## Problem

住院手术在申请、知情同意、护士术前核对及已确认术前耗材清单中已经记录了正式临床依据，但 `start`、`execute`、`record-material`、`preview-completion` 和 `complete` 的契约仍无条件要求非空 `note`。按原计划开始手术、消耗本台已确认预留耗材或零差额核实完术时，医生或 CLI 调用方仍必须提交一段机械同义文字；而若把完成核实简化为前端一律用规则模板代填，又会在现场改量（`deltaQuantity !== 0`）或存在未用预留处置时静默绕过需要医生解释的真实差异。正式范围见[常规手术留痕规格](https://github.com/CaiZongyuan/clinmesh/issues/512)。

## Decision

只在常规无差异手术记录与耗材核实路径放宽输入 `note`（升级 `start` v2、`record-material` v2、`preview-completion` v2、`complete` v3、`execute` v3），由服务端共享 Command 与预览逻辑统一裁决是否允许省略，并在省略或空白时生成非空结构化默认留痕写入数据库、审计、读取 DTO 和 FHIR `Procedure.note`，保持持久化与历史回看契约不出现空值：

- 医疗文书与事后纠偏节点（`request`、`confirm-consent`、`check-preop`、`cancel`、`supplement-material`、`correct-material`）继续保持 Schema 层 `note` 非空必填。
- `start` 仅在实际术式与计划一致时允许省略 `note`；`record-material` 仅在显式绑定本台手术有效预留（`reservation.requestId === requestId`）且不超过余量时允许省略 `note`，无预留或仅绑定全住院通用预留（`reservation.requestId === null`）仍须说明原因。
- `execute` 仅在实际术式一致、全部耗材绑定本台有效预留、无遗留未消耗本台预留且与已确认 `InpatientMaterialPlan` 一致时允许省略 `note`。
- `preview-completion` 与 `complete` 仅在无数量增减差额（`deltaQuantity === 0`）、无本台未用预留且无未解释术前清单少用／冲突时允许省略 `note`（含纯无耗材手术与术中已逐笔说明原因的额外使用），并按同一归一化 `resolvedNote` 计算与重验 `fingerprint`；任何偏离条件缺省 `note` 均由服务端确定性拒绝并返回 `400 INPATIENT_SURGERY_NOTE_REQUIRED`。
- Web 与 DSH Surface 在常规无差异态默认将说明输入折叠在次级“添加备注”后，偏离态自动展开空白输入并要求医生手填；完成核实仅在术中已说明原因且零差额完术时自动带出原多用登记理由，不在需要人工解释差额或未用预留时用规则模板代填。详细业务与界面合同分别见[临床业务流程](../../../architecture/clinical-workflows.md#住院手术最小闭环)和[UI 设计](../../../ui/design.md)。

本决策部分演进[最终耗材核实](2026-10-30-surgery-final-material-reconciliation.md)与[手术流程指引](2026-11-13-surgery-flow-assistance.md)中的输入说明要求，保留其预览指纹、差额事务、版本并发与回执恢复边界。

## Alternatives considered

- 仅在前端用隐藏默认文案代填而不改后端契约：CLI 与 Agent 仍被迫拼接机械文案，且客户端默认文案容易掩盖服务端对真实偏离的校验职责。
- 将所有手术命令的 `note` 一律改为无条件可选并允许数据库保存空串：会丢失术式变更、通用预留借用、现场改量与术后纠偏的可审计原因，也会破坏既有非空读取与 FHIR 留痕语义。
- 在完成核实遇到数量差额或未用预留时继续预填规则汇总句：医生无需解释真实变更原因即可直接提交，违背异常留痕初衷。

## Consequences

常规按计划手术与零差额完术在 Web、DSH Surface 和 CLI 均无需重复输入同义备注，同时所有术式变更、计划外或通用预留耗材、遗留未消耗预留、完术差额及事后补登／更正均由服务端单一规则强制留痕。预览与完成的指纹对省略 `note` 与空白 `note` 保持确定性一致，既有携带显式 `note` 的调用、历史数据与原幂等键回执恢复完全兼容。
