# Agent Note: 门诊工作流按处方、检验与临床文书职责拆分

Status: implemented

## Problem

门诊应用层同时承载挂号分诊、问诊与诊断、处方与药房调配、检验申请与 LIS 报告、临床文书签署修订及完诊门禁，将全部逻辑集中在单一 [`workflow-service.ts`](../../../../apps/server/src/application/workflow-service.ts) 会放大审查半径与私有辅助方法耦合，而更改外部入口路径、导出符号或持久回执 `operation` 名称又会破坏路由、Agent 工具、CLI 目录和幂等恢复合同。正式目标见 [Issue #465](https://github.com/CaiZongyuan/clinmesh/issues/465)。

## Decision

门诊应用层采用无环三层依赖图：[`WorkflowService`](../../../../apps/server/src/application/workflow-service.ts) 作为同路径门面拥有挂号、分诊、叫号、问诊、诊断与收退款编排，对外保持私有子服务封装、`WorkflowError` 与 `laboratoryServiceCodings` 导出签名及全部 49 个 `CommandExecutor` 回执 `operation` 名称。模块总览由[系统架构](../../../architecture/system.md)拥有。

底层 [`OutpatientWorkflowContext`](../../../../apps/server/src/application/outpatient-workflow-context.ts) 封装跨子域共享的行与配置校验 schema、岗位与接诊归属守卫、乐观并发版本断言、FHIR 资源与患者摘要读取、诊断与问诊快照查询、过敏读取及处方收费明细投影；该层只依赖基础基础设施与纯规则模块，不反向导入任何领域服务或门面。

中间层由三个彼此独立的领域服务组成：[`OutpatientPrescriptionService`](../../../../apps/server/src/application/outpatient-prescription-service.ts) 拥有门诊药品目录切片、处方草稿、药品目录与过敏审方规则、资金结清判定、正式开具、无需用药结论、撤回及药房审方发药；[`OutpatientLaboratoryService`](../../../../apps/server/src/application/outpatient-laboratory-service.ts) 拥有检验目录、门诊与住院共享检验单生命周期、报告生成重试、报告已阅与更正及兼容 LIS 流程；[`OutpatientClinicalDocumentService`](../../../../apps/server/src/application/outpatient-clinical-document-service.ts) 拥有初复诊类型确认、结构化与旧版病历草稿、签署预览、正式签署、修订及完诊门禁策略。三者互不直接导入，跨领域回调（场景完成检查、检验报告卡片写入、旧复诊审方规则复用、待处理检查与用药门禁汇总）统一通过窄 Host 接口由门面注入。

跨服务的同事务写入（[`DoctorRecommendationsService`](../../../../apps/server/src/application/doctor-recommendations-service.ts) 的建议采纳批处理与 [`InpatientInvestigations`](../../../../apps/server/src/application/inpatient-investigations.ts) 的住院检验转发）依赖 [`outpatient-workflow-context.ts`](../../../../apps/server/src/application/outpatient-workflow-context.ts) 声明的显式事务端口接口（`DoctorRecommendationsWorkflowPort`、`InpatientInvestigationsWorkflowPort`），由 `WorkflowService` 结构化实现并在同一 `CommandTransaction` 内原子落盘，调用方不直接依赖门面类。

## Alternatives considered

- 按读写方向拆成查询文件与命令文件：同一业务规则（如处方草稿冲突判断、检验报告状态转换、完诊门禁校验）会被迫跨读写文件重复维护，无法收敛领域边界。
- 让处方、检验与临床文书服务直接互相持有引用或反向导入 `WorkflowService`：会形成模块循环依赖，模糊事务主控方与完诊门禁的数据流向。
- 直接移除 `WorkflowService` 并让 HTTP 路由与运行时分别拼装多个细粒度服务：会扩大 `app.ts`、`runtime.ts` 与集成夹具的装配面，对领域解耦没有额外收益。

## Consequences

处方、检验、临床文书与挂号问诊主干各自拥有独立模块边界与单向依赖链，修改单一门诊子域时无需跨越其他子域的私有状态。`OutpatientWorkflowContext` 只承载跨子域共享查询与端口定义且对上层领域服务零反向依赖，跨子域协同统一通过显式 Host 或事务端口接口表达。

HTTP 路由、FHIR 资源、SQLite 表结构、Agent 工具、Operation Catalog 及持久幂等回执语义与门面公开契约保持稳定，存量回执重放与跨服务批处理在同一事务边界内运行。
