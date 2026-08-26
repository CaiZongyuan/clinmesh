# Agent Note: Encounter 完诊门禁与只读转换

Status: implemented

## Problem

[用临床门禁完成 Encounter](https://github.com/CaiZongyuan/clinmesh/issues/30)要求医生在独立诊断、结构化病历、检查报告和用药结论各自完成后结束同一个 Encounter。首期复诊兼容流把诊断、两字段文书、处方、费用交接和完诊放在一次组合签署中，无法复用各临床 owner 已交付的独立事实，也会让页面状态或某个下游队列错误地成为临床完成依据。

总体医生核心边界由[医生核心临床业务流](./2026-08-24-doctor-clinical-core-workflow.md)拥有；当前接口、条件语义和状态机由[门诊闭环](../../../../docs/architecture.md#81-门诊闭环)拥有。本 Note 只记录已经交付的汇总门禁、状态所有权和只读转换取舍。

## Decision

Encounter Completion Policy 是只读汇总模块，不复制诊断、文书、检查或用药状态机。它只适用于带 Consultation 的病例，并从各 owner 当前正式事实计算七项稳定条件：主诊断已确认、结构化病历已签署、必要报告已阅、用药结论已记录、无未处理草稿、处置完整和随访完整。预览同时返回稳定 code、机器状态、中文状态和目标入口，使 Web 和后续窄工具可以定位原 owner，而不必解析错误文本或了解 owner 的持久化结构。

完成 Command 在事务内重新计算全部条件并校验 Encounter expected version。预览不是授权票据，条件在预览后变化时提交必须失败。成功只更新 FHIR Encounter 的 `status` 与 `actualPeriod.end`；医生 Queue Task、病例领域状态、Registration、收费、处方、发药和 Scenario Run 都保持不变。队列消失来自查询按 Encounter 当前状态过滤，不是完成 Command 对其他聚合的隐式写入。

Web 由 TanStack Query 持有完诊预览，并在任一临床 owner 刷新后使该查询失效。每项入口聚焦真实诊断、文书、检查或用药区域。完成时先固定当前病例选择，再刷新队列与详情；队列移除该病例，详情按 Encounter 状态统一关闭问诊和全部写控件，同时保留已签病历、报告、诊断和用药事实。

## Alternatives considered

**让客户端根据病例详情自行判断能否完诊。** 这可以省去预览查询，却会把领域规则复制到 Web，并允许旧页面状态或漏读的 owner 事实启用错误提交。服务端策略是唯一规则来源，客户端只渲染返回项。

**由每个 owner 推进一个共享病例状态。** 这会让诊断确认、报告更正、处方撤回和文书签署互相知道下游步骤，并产生难以原子维护的派生状态。Completion Policy 在读取时汇总当前事实，owner 不写共享门禁投影。

**完成 Encounter 时同时完成医生 Task 和 `outpatient_case`。** 这能让现有队列自然消失，却把临床完成与排队、页面兼容状态绑定，并增加无业务依据的副作用。当前队列直接读取 Encounter 状态，保留旧聚合以支持兼容详情和后续独立归档入口。

**把药品支付、发药或 Scenario Run 完成作为门禁。** 这会使跨部门执行阻塞医生临床责任结束，也会允许药房反向改变 Encounter。完诊只要求医生记录有效处方或无需用药结论，下游流程继续独立推进。

## Consequences

共享 contract 固定七个条件 code、四个目标和严格预览/提交 schema；HTTP 提供预览查询与幂等完成 Command。无未取消检查申请时报告条件成立，已撤回处方不构成用药结论，签署结构化文书后保留的文书草稿不再阻塞，诊断、检查和处方草稿仍会阻塞。

条件缺失返回稳定 `ENCOUNTER_COMPLETION_BLOCKED`，整个 Command 无状态变化；相同幂等键重放首次成功回执，同一 expected Encounter version 的并发提交只有一个成功。成功审计只列出 Encounter effect，便于调用方和测试确认没有隐藏的 Queue Task、费用或 Scenario 副作用。

医生工作台在完成后保留本次选中详情；独立的已完诊病例检索入口和统一时间线不属于本决策，由[已完诊病例与业务时间线](https://github.com/CaiZongyuan/clinmesh/issues/31)定义。
