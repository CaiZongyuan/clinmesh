# Agent Note: 持久合成患者库与业务物化

Status: implemented

## Problem

Scenario Dataset 以生成批次和病例编排为中心，不能表达一个跨批次、跨 Epoch 持续存在的患者库。若管理员必须先理解 Dataset 安装才能使用生成结果，普通的“生成患者并选择进入候诊”会被场景生命周期掩盖。仅保存编译后的 CaseTruth 还会丢失 Synthea 原始 FHIR R4 Bundle，使映射修订无法回到受验证来源。本决策扩展 [issue 36](https://github.com/CaiZongyuan/clinmesh/issues/36)，并延续[场景数据集与安装快照分离](./2026-08-26-scenario-dataset-and-package.md)和[Scenario 数据编译与参考数据接入](./2026-08-21-scenario-data-compilation.md)。

## Decision

`Synthetic Patient Profile` 是 Workspace 级持久 authoring 资产，独立于活动 Epoch。每次生成仍创建 `Generation Batch` 对应的 Scenario Dataset，但同一事务还为每名编译患者创建 Profile。Profile 保存 ClinMesh 中国化展示身份、编译后的 `ScenarioPatient`、来源 Provider、mapping version 和来源哈希；Synthea Profile 另存经过运行时验证的原始 R4 Bundle。Profile ID 与展示身份由规范内容哈希和来源患者 ID 确定性派生；相同结果再次生成时复用 Profile，并追加独立的 Generation Batch provenance 关联。删除可编辑 Dataset 不级联删除 Profile。`0024_synthetic-patient-profile.sql` 将升级前已有 Dataset 一次性回填为 `legacy-compiled-profile`，明确不声称存在已丢失的原始 Bundle。

Profile 的来源病史只读，管理员可以更新展示身份和院内代码映射 overlay。每次更新使用 expected revision，并把 identity、编译患者快照、mapping version 和映射目标快照追加为不可覆盖的 `Profile Revision`；映射目标由来源资源、稳定目录项 ID、目录版本、code 与可选 code system 共同描述，当前 Profile 行只保存最新 revision。Synthea 映射更新从保存的 raw Bundle 和固定编译参数重新运行编译器，再把只允许引用已有来源资源 ID 的院内编码 overlay 应用于纵向病史与 FHIR 历史；raw Bundle 本身不改写。Condition 只能映射到当前有效诊断目录，Observation 和 MedicationRequest 只能映射到对应的当前有效门诊目录，Encounter 只接受 `AMB`；平台没有过敏目录，因此 AllergyIntolerance 保持未映射。映射后的 FHIR code 只在目录声明 code system 时写入 `Coding.system`。既有 Registration、Encounter 和历史临床资源不会因 Profile 更新而改写。

一次生成最多包含 10 名患者。外部与内置 Provider 都返回与编译患者一一对应的来源 artifact；缺少、重复或数量不一致会使整批生成回滚。原始 Bundle 不进入 Scenario Package 或普通岗位接口，只在管理员读取单个 Profile 来源时返回。

“发起门诊就诊”由 `WorkflowService` 的共享批量 Command 执行。命令接受 1 至 10 个 Profile 及 expected revision，在单个事务中按当前 Epoch 物化 FHIR Patient 和白名单历史资源，创建 Registration、Encounter、候诊 Task、Account、挂号 ChargeItem 与独立 Consultation owner，并记录 Profile Revision 到 Patient 的 Epoch 级 materialization。无脚本 Virtual Patient 绑定的 Consultation 不提供受控问答，但仍拥有结构化病历、独立诊断、处方结论、检查申请与完诊门禁，不能降级到旧病例兼容编辑器。任一 Profile 已变化、目录无效或存在活动就诊时整批回滚。Profile 本身跨 reset 保留；新的 Epoch 可以重新物化同一 Profile。若同一 Epoch 的旧就诊已经完成，后续 Profile Revision 创建新的关联 Patient snapshot 供下一次就诊使用，不更新旧 Patient；旧 Registration、Encounter、FHIR 资源及普通读取结果保持不变。

管理员默认进入 Synthetic Patient Library。Dataset 结构化编辑与 Scenario 安装保留在“高级病例编排”，不再作为生成患者的必经步骤。医生问诊工作台沿用患者库的一体化患者头部、信息带、主业务 tabs 与右侧重点摘要结构，同时保留医生专属生命体征、诊疗对话和业务 Command。TanStack Query 继续拥有列表、详情、生成任务和写操作后的失效刷新。

## Alternatives considered

**继续把 Dataset 当作患者库。** 这种方式不需要新表，但患者只能按批次浏览，删除 Dataset 会与患者保留语义冲突，来源编辑也会混入患者 overlay。

**生成后立即写入活动 Epoch。** 这种方式减少一次选择动作，但会把全部生成结果直接放入岗位业务数据，reset 会删除未使用患者，也无法在不同 Epoch 复用档案。

**由 Web 依次调用创建 Patient 和挂号两个 Command。** 这种方式复用现有 HTTP 路由，但批量操作可能留下没有挂号的 Patient 或只完成部分患者，状态机和回滚语义也会泄漏到客户端。

**只保存编译结果，不保存原始 Bundle。** 这种方式占用空间更小，但 mapping version 升级无法从固定来源产生新 revision，也无法解释哪些字段被丢弃或重建。

## Consequences

Synthetic Patient Profile、Profile Revision、来源 artifact 和 Epoch materialization 成为 SQLite 持久合同。字段或映射语义变化需要新增迁移，不能重写已经应用的迁移或重新调用当前 Provider 猜测旧来源。

患者库的读取和 overlay 更新只对管理员开放。业务物化后，Patient 和临床历史遵循现有 FHIR R5 Repository、挂号状态机、审计和 Epoch 隔离；Web 与未来 Agent adapter 不得自行复制挂号编排。

原始 Bundle 会增加数据库体积，因此列表只返回摘要，详情才返回单个来源。批量上限 10 同时约束 contract、Provider capabilities、Java Provider 和 Web 控件。
