# Agent Note: 固定 PCI 作者来源与直接住院实体化

Status: implemented

## Problem

固定 PCI 资料包中的作者底稿不等于运行病例。原 Synthetic Case 实体化总会登记门诊并收挂号费，无法准确表达择期直接入院；另建临床事实导入入口会绕过检查检验和手术流程。

## Decision

管理员通过固定、无任意 Bundle 输入的准备命令，把版本化底稿编译为独立 `clinmesh-authored` 来源、不可变 Profile Revision 与私有 Case Truth。来源保留内容哈希、资料包版本与底稿身份，不冒充 Synthea 输出；九项基线 Observation 使用明确 LOINC 与 UCUM。作者来源不包含已执行 PCI Procedure，本院诊断、检验报告与手术由 HIS 动作形成。来源准备与目录库存准备各自拥有独立幂等命令。

门诊与直接住院共用病例准备状态、版本、Persona 选择和一次消费校验，并共用 Patient 实体化。直接住院在同一事务创建住院类型 materialization，再调用共享住院登记 apply；`inpatient_admission.source_case_id` 与 `clinical_request_source` 继续指向唯一 materialization 权威，不复制私有 Case Truth。门诊运行列只在门诊类型必填，住院类型为空；既有门诊行通过迁移完整保留。迁移事务结束前检查外键，失败回滚并恢复连接外键检查。

页面分别表达目录准备、病例准备、Persona 创建／选择与入院，不用一个按钮串联多项业务写入。目录／来源准备和入院复用现有受信写意图及 Operation Catalog 回执；未进入 Catalog 的 Persona Command 保存受信会话、病例及冻结输入，恢复时以同一幂等键重放。响应未知时阻止新意图，确定冲突后重新读取与选择，避免把一次丢响应误作新修订或第二次入院。

保留患者库的 reset 依原 Case/Persona/Profile 修订重新实体化直接住院，回到默认病区待接诊且不产生门诊记录或费用；患者库以未清账住院及未完成门诊共同判定 activeVisit。清空患者库后准备固定来源，会为同一逻辑 Profile 建立新的不可变修订和新 Case，来源哈希不变，旧 Case 保持退役；普通 Case 的跨 Epoch 一次消费规则继续生效。作者来源的精确检验结果使用 `case-truth-exact`，现有 Synthea 精确快照保留 `synthea-exact`，避免作者来源报告审计冒充生成器输出。

## Alternatives considered

先生成一次门诊再转住院会留下不存在的门诊流程和费用；将固定来源标作 Synthea 会使审计身份与真实生产方式不符。独立住院来源表会把 Case 消费、回放和检查检验来源绑定分成两份权威，增加跨入口漂移，因此扩展同一实体化表并保留门诊合同。

自动生成首个 Persona 会引入本次页面起点并不需要的模型依赖；将生成内容或固定 Case Truth 直接预填到临床入口会绕过既有资料审核与可见性边界。因此首次 Persona 使用已有人工修订 Command，登记页只读取现有安全就绪摘要，病区选择复用通用住院登记表单。

## Consequences

固定来源入口只接收预期 Epoch，直接住院入口只接收病例/Persona版本与病区，所有运行事实仍经共享 Command 审计。准备固定来源不需要模型；Persona 可通过已有手工编辑入口形成。公开 HTTP 验证使用临时 SQLite 和拒绝任何模型请求的受控 Provider。当前流程合同归 [仿真场景](../../../architecture/simulation.md#103-场景定义)，Agent 命令合同归 Operation Catalog 与对应运行时 skills。
