# Agent Note: 门诊应用层无环子域拆分与院后复诊来源冻结及住院摘要读取

Status: implemented

## Problem

门诊应用层同时承载挂号分诊、问诊诊断、处方与药房调剂、检验与报告、临床文书签署修订及完诊门禁，单文件 `workflow-service.ts` 耦合过重放大修改半径，但直接拆散公开入口或更改 49 个 `CommandExecutor` 持久回执 `operation` 名称又会破坏路由、CLI 目录与幂等重放。同时，合成患者在住院出院后再次挂普通门诊随访时，新创建的门诊 Encounter 仅凭新病例 ID 无法关联原 `Patient Persona`、可见外部病史与分阶段检查真值；而若直接把完整住院读模型并入门诊完诊病例库，又会突破门诊责任医生边界并暴露病区护理、财务结算等内部住院状态。

## Decision

以三层无环依赖图拆分门诊领域服务，并通过显式来源关系表与临床白名单住院摘要打通院后门诊复诊，模块与业务合同分别见[系统边界](../../../architecture/system.md)及[门诊业务流程](../../../architecture/outpatient-workflows.md)：

1. **门面保兼容的三层无环领域拆分**：顶层 [`WorkflowService`](../../../../apps/server/src/application/workflow-service.ts) 保留原路径、公开签名与全部 49 个持久回执 `operation` 名称，负责挂号、分诊、叫号、问诊、诊断与收退款编排；中间层拆分为互不直接导入的 `OutpatientPrescriptionService`（处方草稿、审方、开具、无需用药、撤回与门诊药房调剂）、`OutpatientLaboratoryService`（检验目录、申请生命周期、重试、已阅与报告修订）和 `OutpatientClinicalDocumentService`（初复诊分类、病历草稿、签署预览／提交、修订与完诊门禁），跨子域联动统一经窄 Host 回调注入；底层 [`OutpatientWorkflowContext`](../../../../apps/server/src/application/outpatient-workflow-context.ts) 封装共享守卫、版本断言、只读资源查询及跨服务同事务端口（`DoctorRecommendationsWorkflowPort`、`InpatientInvestigationsWorkflowPort`），对上层服务保持零反向依赖。
2. **`outpatient_case_source` 院后复诊来源冻结**：普通门诊新挂号在当前 Workspace/Epoch 内检测到同患者具有唯一合法合成来源 materialization 时，通过带复合外键的独立关系表 `outpatient_case_source` 原子冻结该来源引用并初始化新 Consultation（分阶段 `follow-up` 真值解析与已完诊无需用药病例解除活动挂号阻塞见[通用 Authored Case Pack 编译器](2026-11-19-authored-case-pack-compiler.md)）；外部可见历史、Persona 与共享检查来源投影统一读取该冻结关联，绝不在后续查询时按患者动态猜测最近来源。
3. **按当前接诊责任授权的已出院住院临床白名单摘要**：门诊 `local-completed` 本院历史以医生对当前门诊病例的接诊责任为授权入口，纳入同患者同 Workspace/Epoch 已实际出院住院记录的显式临床白名单摘要（判别字段 `record.kind = 'inpatient'`，保留标题、日期与医嘱停用／完成状态，不暴露床位护理或内部账务；门诊完诊病例库列表继续只承载门诊记录）。该摘要作为诊疗建议必读安全证据参与 `12 KiB` UTF-8 字节拆包，支持在完整复查报告成员间切分，避免多份住院报告超单包上限导致整次住院记录丢失。

## Alternatives considered

- **按 Query／Command 读写方向横切文件，或让子服务互相持有引用**：读写横切迫使处方审方、检验状态与完诊规则跨文件重复维护；子服务互引则制造循环依赖并模糊事务主控权。
- **院后复诊在每次读取时按 Patient 动态查找最近来源，或复制一份新 `Synthetic Case`／`Persona`**：动态查找会被后续物化漂移且无法处理多义来源，复制病例则违背单次消费与真值唯一权威原则。
- **直接向门诊暴露完整住院详情 DTO 或改造门诊完诊病例库**：越界暴露病案与财务字段并破坏既有门诊病例库职责。

## Consequences

单一门诊子域演进局限在独立服务文件内，外部 HTTP、FHIR、CLI 与历史幂等回执零迁移成本兼容；合成专病患者从住院出院进入门诊随访时自动延续同一 Persona、分阶段随访真值与已出院住院临床摘要，人工建档或多义来源患者则保持普通挂号行为不变。
