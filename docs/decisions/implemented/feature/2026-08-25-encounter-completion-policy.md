# Agent Note: 门诊多岗位核心诊疗生命周期、七项完诊门禁与已完诊病例时间线

Status: implemented

## Problem

门诊 HIS 既需要多岗位协作闭环（挂号、分诊、接诊、检查收费与报告、处方收费与药房调剂），又需要医生在同一个 `Encounter` 内独立恢复并并发控制问诊、结构化病历、检查申请与报告确认、主次诊断、处方或无需用药结论。若把草稿直接存为临时 FHIR 资源，会让未确认编辑混入正式临床读取与历史版本；若沿用早期单次组合签署将诊断、两字段文书、处方和完诊绑死在一个动作中，或用 `DiagnosticReport.status=final` 推定医生已阅、用修改同一逻辑资源版本代替签发后更正、从可变排队 `Task` 推断完诊病例归属，则会导致各临床事实耦合锁死、报告修订后漏读以及只读病例库权限漂移。

## Decision

以单一门诊 `Encounter` 串联跨岗位交接、各领域独立持久草稿与不可变修订链、只读汇总完诊门禁及责任绑定的已完诊病例库，当前完整合同见[门诊业务流程](../../../architecture/outpatient-workflows.md)、[处方、医嘱与药事](../../../architecture/orders-and-pharmacy.md)及[检验、检查与报告](../../../architecture/examinations-and-reports.md)：

1. **单 Encounter 多岗位闭环、直达接诊与双主体超级管理员代理**：一次门诊由同一个 FHIR R5 `Encounter` 贯穿挂号（原子创建 `Patient`、`Registration`、`Encounter`、候诊 `Task`、`Account` 与挂号 `ChargeItem`）、分诊、医生接诊与完诊；药品支付与药师审方、批次发药在 `Encounter` 完成后继续独立推进并将 `Scenario Run` 置为 `completed`，绝不反向改写临床完诊状态。Virtual Patient 直达接诊原子建立挂号、队列任务与病例责任而不伪造分诊或收费记录；Super Administrator 切换 `Acting Practitioner Context` 时，Command、`AuditEvent` 与 `Provenance` 同时记录真实管理员 Actor 与所代表的 `PractitionerRole`。所有纠错 Command 在校验预期版本前先执行岗位与责任预检，并以结构化 `conflict` 字段返回可本地化冲突原因。
2. **领域原生草稿与四类不可变临床事实生命周期**：所有未确认草稿均作为 domain-native 表按 `Encounter` 版本与 `expectedDraftVersion` 做 CAS 保护，正式确认后才发布标准 FHIR R5 资源：
   - **结构化临床文书**：签署采用 5 分钟 HMAC 绑定预览与提交两步协议，创建不可变 `Composition`、自包含文档 `Bundle` 与 `Provenance`（每病例唯一根文书，签署后更正仅允许针对最新后继创建新逻辑资源并以 `Composition.relatesTo.type=replaces` 构成线性修订链，与旧版两字段组合签署互斥）。
   - **主次诊断**：草稿支持 1–8 条非重复目录项并要求恰有一条 `primary`；确认创建 `encounter-diagnosis` `Condition`、更新 `Encounter.diagnosis` 双向引用并写入 `Provenance`（完诊前再次修订创建新确认版本并将被替代 `Condition` 标为 `entered-in-error`，见[统一直接记录与草稿修订](../architecture/2026-10-15-unified-direct-document-recording.md)）。
   - **处方与无需用药结论**：正式开具重验目录、过敏与已确认诊断后创建带处方号的 `Prescription`、`prescription_authorship` 与 `MedicationRequest`（院内与外延分轨见[门诊外延处方分轨](../architecture/2026-11-05-outpatient-external-prescription-split.md)）；`no_medication_conclusion` 作为独立带责任人的正式事实与有效处方互斥；未调剂处方撤回追加不可变 `prescription_withdrawal` 并将 `MedicationRequest` 置为 `cancelled`，不物理删除账项或历史（已缴费撤方经收费员原款退款处理）。
   - **报告已阅与不可变报告修订**：`ReportAcknowledgement` 按 `DiagnosticReport` 逻辑 ID 独立记录责任医生已阅事实而不改动报告版本；受控 `lis-system`（由具备 administrator 资格的会话经服务端受信绑定触发）更正已签发报告时，为 `DiagnosticReport` 与全部 `Observation` 创建全新逻辑 ID 并以 `Provenance.entity.role=revision` 串成线性链，将申请退回 `reported` 强制医生重阅新版报告。
3. **只读七项完诊门禁与独立已完诊病例库**：`Encounter Completion Policy` 作为纯只读汇总器，不复制子域状态机，实时核验带 Consultation 病例的七项条件（主诊断已确认、结构化病历已签署、未取消检查报告均已阅、有效处方或无需用药已记录、无未处理诊断／检查／处方草稿、处置完整、随访完整），缺项返回稳定 `ENCOUNTER_COMPLETION_BLOCKED` 与定位入口；完成事务重验全部条件后仅更新 `Encounter.status='completed'` 与 `actualPeriod.end`。`outpatient_case_responsibility` 一对一持久化首次接诊责任岗位；已完诊病例库使用不含任何草稿或编辑版本的独立 strict DTO，在 SQL 层合并责任岗位与完成条件分页查询，并由服务端按确定性顺序组装统一业务时间线与保守的 `correctionSupported` 更正导航。

## Alternatives considered

- **复诊另建第二个 `Encounter`，或等药房发完药才允许医生完诊**：拆散同次挂号下的检验与文书归属，或让跨部门收费发药阻塞医生临床收尾。
- **把未确认草稿存为 `provisional`/`draft` FHIR 资源，或用空处方代表无需用药**：污染正式 FHIR 查询与患者既往史，空处方则无法区分“医生明确判定无需用药”与异常空单。
- **在原 `Composition`／`DiagnosticReport` 逻辑 ID 上递增 FHIR `_history` 表示临床修订，或从当前排队 `Task` 推断完诊病例库权限**：混淆技术存储版本与临床替代责任，且排队 `Task` 随流转变化无法充当长期病历归属依据。

## Consequences

门诊各临床子域拥有清晰的草稿隔离、乐观并发与不可变修订历史，任何报告更正或处方撤回都会通过实时汇总自然反映到完诊门禁与已完诊时间线中，无需维护易失步的冗余聚合状态位。
