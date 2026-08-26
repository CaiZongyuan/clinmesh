# Agent Note: 独立处方与用药结论生命周期

Status: implemented

## Problem

[开具处方或确认无需用药](https://github.com/CaiZongyuan/clinmesh/issues/29)要求医生在同一个 Encounter 中保存处方草稿、开具正式处方，或者明确记录无需用药，并在尚未调剂时受控撤回处方。首期复诊流把诊断、Prescription、两字段文书和 Encounter 完成绑定在同一组草稿与签署动作中；继续扩展该组合无法让处方独立恢复和并发控制，也无法把无需用药和撤回表达为可审计的正式事实。

总体医生核心边界由[医生核心临床业务流](./2026-08-24-doctor-clinical-core-workflow.md)拥有；当前接口和状态机制由[门诊闭环](../../../../docs/architecture.md#81-门诊闭环)拥有。本 Note 只记录处方草稿、正式用药结论和撤回的持久化取舍。

## Decision

处方草稿是病例级 domain-native 聚合。`prescription_draft_state` 按 Workspace、Epoch 和病例保存单调版本与可空正文；正文包含一至八条药品目录引用，以及受控剂量、频次、疗程和数量。保存与删除同时校验 Encounter expected version 和 `expectedDraftVersion`，删除通过递增版本并清空正文保留 CAS 历史位置。草稿不创建 provisional MedicationRequest，也不产生费用或推进 Encounter。

正式开具重新读取当前目录、患者过敏和已确认诊断，并校验每条药品的剂量、频次、疗程、数量、组合关系和诊断适应规则。成功后创建带稳定处方号的 Prescription，在 `prescription_authorship` 保存负责 Actor 与 Practitioner Role，为每种药创建关联当前 Patient 与 Encounter 的 active FHIR R5 MedicationRequest，并清除草稿正文。authorship、草稿更新人、无需用药责任人和撤回责任人都以 workspace 级复合外键引用身份表。处方项目保存 MedicationRequest 关联和开具时的五项用药值，已开具处方在 Web 中只读，不能通过普通草稿覆盖。

独立用药结论是 v3 Scenario 目录能力。v3 blueprint 的 `medicationRulesVersion` 进入初始定义 hash，seed 的药品配置包含疗程、数量和允许诊断；临床目录返回 `prescriptionConclusionSupported=true`。v1/v2 blueprint 和药品配置保持原定义并返回 `false`，既有组合复诊流程继续使用共同的组合、剂量和频次规则，独立写入口返回稳定 `CATALOG_CONFLICT`，Web 不渲染独立用药结论面板。

`no_medication_conclusion` 是带 Actor、Practitioner Role、虚拟业务时间和版本的正式领域事实，不用空 Prescription、空 MedicationRequest 或页面布尔值代替。有效处方和无需用药结论互斥；确认无需用药会原子清除已有草稿并递增草稿版本。独立处方入口与首期复诊组合草稿互斥，防止两个编辑器同时拥有同一次用药结论。

撤回创建不可变 `prescription_withdrawal`，不删除原 Prescription，也不把撤回压入原有 `signed`、`paid`、`dispensed` 状态枚举。只有未发生任何调剂的 signed 或 paid 处方可按 Prescription 和每个 MedicationRequest 的 expected version 撤回；成功后全部 MedicationRequest 更新为 `cancelled`，Prescription 版本递增，读模型把关联撤回事实投影为 `withdrawn`。撤回后当前只允许确认无需用药，不能重新把旧处方当作可编辑草稿或开具替代处方；替代处方另立纠错流程。

撤回不删除 Charge Item、Payment Transaction 或 FHIR history，也不隐式退款。未收费的撤回处方从收费员 pending 队列排除，支付预览和确认拒绝继续收费；已收费记录仍出现在 paid 历史中。药房队列、审核和发药入口排除或拒绝撤回处方。

## Alternatives considered

**把草稿保存为 draft MedicationRequest。** 这能复用 FHIR history，却会让尚未确认的可覆盖输入进入正式临床资源读取，并让多个 MedicationRequest 自行承担处方草稿的整体 CAS。草稿因此保持 domain-native，开具后才发布 FHIR 资源。

**用空 Prescription 表示无需用药。** 空处方无法表达医生主动完成用药判断，也会让收费和药房消费者把业务结论误作异常处方。无需用药因此拥有独立、带责任人的正式事实。

**撤回时删除处方、费用和 MedicationRequest。** 这会抹除已经发生的临床与财务历史，使已收费处方无法解释，也破坏 FHIR version history。撤回改为追加事实并取消请求，是否退款留给独立逆向流程。

**把 `withdrawn` 直接加入 Prescription 原状态并覆盖。** 这实现较短，却把开具、支付或调剂的历史阶段与纠错事实压成一个可变字段。独立撤回事实保留原阶段，并让读模型按使用场景投影有效状态。

## Consequences

迁移 `0018_prescription-conclusion.sql` 扩展处方项目疗程，并新增 `prescription_authorship`、处方草稿、无需用药结论和撤回表。迁移不修改已有 Epoch 的药品目录配置，也不向历史 Prescription 增加可空 Practitioner Role 列；旧处方项目按已知药品回填疗程，未知条目保留约束内默认值。当前 v3 Scenario 在 seed 时获得固定疗程、数量和允许诊断，v1/v2 保留原配置。

处方正式开具依赖已确认诊断；目录或患者事实在保存后变化时，开具会重新校验并返回稳定目录或工作流冲突，不会把草稿值直接提升为正式资源。已开具处方、无需用药结论和撤回事实均可在刷新或重新登录后恢复。

HTTP seam 覆盖草稿 CAS、删除、五项目录约束、诊断与过敏校验、组合规则、正式 Prescription/MedicationRequest、两条用药结论互斥、撤回、FHIR history、收费和药房隔离，以及既有处方 owner 兼容。Web seam 覆盖五项受控输入、多药组合、保存、删除、开具只读态、失败后字段保留、确认撤回和撤回后无需用药。
