# 存储与事务

本文拥有 FHIR 与领域存储、标识符、SQLite 事务、outbox、附件和数据库迁移边界。系统总入口见[系统架构](../architecture.md)，业务验证要求见[测试策略](../testing.md)。

临床申请使用 `clinical_request_context` 绑定门诊 case XOR 住院 admission，Workspace/Epoch 复合外键保证唯一真实 owner；旧申请的 `case_id` wire 字段与原 ID 保持不变。新门诊登记和住院登记在各自原 Command 事务创建 context，不由查询补写。`clinical_request_source` 只读投影门诊 materialization 或住院固定来源，正式资源仍使用 context 的本次 patient/encounter。0071迁移保真重建申请、检验/影像草稿与影像 study 的 owner 外键，保留请求、各专用明细、快照、报告修订/确认、回执和outbox；外键开关只在迁移事务外切换，失败回滚并恢复保护，提交前执行完整 foreign_key_check。动机见[住院检查与转科决策](../decisions/implemented/architecture/2026-10-21-inpatient-investigations-and-transfer.md)。

## 9. 数据架构

### 9.1 FHIR Resource Store

当前使用统一 current/history 表，而不是按资源类型拆表。

```text
fhir_resource
  workspace_id
  epoch
  resource_type
  resource_id
  version_id
  last_updated
  deleted
  owner_kind
  content_json
  content_hash

fhir_history
  workspace_id
  epoch
  resource_type
  resource_id
  version_id
  last_updated
  deleted
  content_json
  content_hash
```

主键：

- `fhir_resource(workspace_id, epoch, resource_type, resource_id)`
- `fhir_history(workspace_id, epoch, resource_type, resource_id, version_id)`

当前写时 Search 索引只有：

```text
fhir_sp_string(workspace_id, epoch, resource_type, resource_id, param, normalized, exact)
```

它承载当前注册的 Patient `name`、Patient `identifier` 和 [5.5 节](fhir-and-commands.md#55-fhir-search-最小实现)列出的 reference SearchParameter；reference 与 string/token 参数复用同一张表，不另建 reference index。每次资源变更在同一事务删除该资源旧索引并插入完整新索引；数据库 CLI 的 `reindex` 重建索引并验证完整性。运行时不执行任意 FHIRPath，也没有尚未使用的 date/quantity 或 compartment 索引表。

当前 FHIR 授权上下文由已认证 session 或 Agent Capability Grant 解析出的 Workspace/Epoch 隔离。标准 Patient compartment、Encounter care-team 和字段级策略尚未发布为 FHIR 能力；增加这些能力时必须在 SQL 查询中应用，不能查询后过滤。

### 9.2 领域表

当前领域表只覆盖首期闭环：

- 身份与岗位：Better Auth 的 user/session/account，加 Workspace Actor、Human Membership、Agent Client/Capability Grant、Practitioner Role binding 和当前 session context。
- 门诊：Consultation、append-only Consultation Record、目录、outpatient case、Registration、分诊记录、临床草稿、诊断草稿状态与确认分组、检查申请草稿状态、正式检查申请、处方草稿状态、Prescription 与处方项目、无需用药结论和处方撤回事实。
- 住院：独立 Admission、住院证、病区与床位目录、带时间段的床位占用、预交金、逐项费用及关联冲正、诊断确认与编码快照、医嘱、校对、执行计划和实际发药关联，出院/出区/召回/清床事件、不可覆盖的结算预览快照与关联原预交金的补退款交易，以及独立手术申请、两个准备确认、唯一实际实施、耗材使用和术后医嘱引用。运行事实均绑定 Workspace/Epoch，住院合成来源以可空复合外键固定；院内手术与耗材目录由 Scenario 补缺式安装，临床分类身份与收费定义分别冻结。
- 门诊账务：Charge Record、Payment Preview 和 Payment Transaction。金额以整数分保存；当前没有门诊退款、医保或收费员交账表。住院结算快照、补缴及关联原入金的退款由上述住院表保存，流程见[住院出院与结算](clinical-workflows.md#住院出院与结算)。
- 库存与发药：Inventory Lot、append-only Inventory Movement 和 Dispense。库存余额始终归 Inventory Lot；每次库存移动恰好关联门诊处方或住院实际发药单，不能同时关联两种来源，旧门诊来源和外键保留。当前不实现预占、追溯码、盘点或调拨。
- 文书：结构化 Clinical Document Draft、结构化与兼容 Clinical Sign Preview、Signed Clinical Document 关联和修订父链；签署的 Composition、document Bundle 和 Provenance 正文仍由 FHIR store 权威保存。
- 模型执行：患者回答尝试及请求意图关联、建议稳定阶段计划、单元成功步骤与累计请求计数；这些是私有执行状态，不是临床结论。
- 平台与仿真：Workspace/Epoch、Scenario Run/State、Synthetic Profile/Case、Patient Persona、Investigation Result Snapshot、私有 Case Truth、Command Receipt/Effect、Audit、Action Trace、Outbox、Agent Page Context、Tool call、proposal 和 review decision。

所有适用表、主键、唯一键、外键和岗位队列索引包含 `workspace_id + epoch`。岗位枚举扩展使用前向迁移保真重建 SQLite CHECK 约束；关闭外键的表重建仅在该迁移事务周边执行，提交前检查全部外键，失败恢复保护并保留原岗位、Membership 和 Session 引用。启动时在当前活动 Epoch 幂等补齐住院环境，不要求清空或 reset。

新增 FHIR-native 辅助索引时必须可由权威资源重建；新增无法重建的事实时必须明确成为 domain aggregate，不能同时由 FHIR JSON 和领域表双向拥有。

#### 模型执行恢复

`consultation_reply_attempt` 保存受信 Workspace/Epoch、Encounter、待回答医生轮次、固定期限和执行终态；局部唯一索引保证每个医生轮次只有一个 `executing` 尝试。`consultation_reply_intent` 按 Actor、operation 与幂等键持久关联该尝试，各调用者仍独立授权和完成原 Command 回执。启动时遗留执行转为 `unknown`；缺少派发证据的旧未答轮次迁移为未知，不自动补答。读取时已保存患者回答优先于尝试状态，响应丢失不触发重复推理。

`doctor_recommendation_execution`、`doctor_recommendation_execution_plan`、`doctor_recommendation_execution_unit` 与 `doctor_recommendation_execution_continue` 分别保存绑定及累计额外次数、稳定阶段计划、批次依赖及成功结果、人工继续意图。四表以 Workspace/Epoch 开头的复合主键、外键隔离，删除使用 `RESTRICT`。执行键由 Workspace/Epoch、Actor/context、病例、建议类型与 generation 身份派生，完整绑定另含输入指纹、模型和策略；持久 JSON、键与完整绑定在运行时验证，计划与单元哈希不允许恢复时改组。筛选成功步骤只有完整来源上下文、请求与受信作用域均相同时可跨任务复用，生成和核验只属于原执行。

每次外部派发前用短事务原子预占单元次数和 generation 额外次数，Provider 内部限流重发和格式修复也经过同一边界；网络请求在事务外。次数与 outbox 调度 attempt 独立持久化，重新领取及重启不清零。预占后未保存完整结果的崩溃窗口保留占用并转为未知；人工继续意图只开放一次未知单元，重放不重复开放。恢复先校验固定依赖及成功步骤，再处理未完成单元；私有候选在全部必要核验结束前不投影为可采纳结果。

上述记录不创建 FHIR 临床资源、不替换 Command Receipt 或审计，也不保存平台密钥。面向合成病例的恢复数据遵循既有数据边界；公开状态只返回安全错误码、阶段和次数。行为与人工恢复条件见[临床业务流程](clinical-workflows.md#81-门诊闭环)，取舍见[请求复用与持久恢复决策](../decisions/implemented/architecture/2026-10-19-model-request-reuse-recovery.md)。

### 9.3 FHIR 投影

当前 `domain-projection` 只有 InventoryItem 和 AuditEvent。它们使用稳定 logical id 与拥有它们的库存或审计事实关联，不维护额外 `domain_resource_link` 表。

规则：

- 领域写入与 FHIR 投影、Search 索引、历史版本在同一数据库原子提交。
- 投影失败时整个 command 失败，不能接受“稍后最终一致”作为默认。
- 投影资源 `owner_kind=domain-projection`，FHIR generic PUT/PATCH/DELETE 被拒绝。
- 外部异步事件只处理模拟系统调用，不负责修复核心投影一致性。

新增投影时必须在能力注册表声明 owner，并记录权威事实、稳定引用、唯一写 Command、事务边界、重建方式和一致性检查。没有实现的 Slot、床位、Invoice、电子票据、医保和完整 Account 余额投影不属于当前能力。

### 9.4 标识符

- 在线新建的 FHIR logical id 使用 UUIDv7 文本；scenario fixture 的稳定 ID 使用预分配 ID 或由 scenario version + logical key 派生的 UUIDv5。二者都满足 FHIR id 长度和字符要求。
- 业务号放对应主体的 `Identifier`，不把患者号、就诊号或处方号当数据库主键。
- 每个 identifier 有稳定 `system` URI、用途、分配机构和有效期。
- 患者合并保留源 Patient，并通过 link/状态表达；禁止改写所有历史 ID。
- 场景 fixture 使用稳定逻辑 key，运行时 ID 可由 scenario seed + logical key 确定性生成。

### 9.5 SQLite 类型规则

- 主键：`TEXT` UUIDv7；确定性 fixture 可使用 UUIDv5。对外引用只暴露 FHIR logical id，不暴露 workspace 复合键。
- UTC 时间：ISO 8601 `TEXT`；显示层转换 `Asia/Shanghai`。
- 虚拟业务时间与真实提交时间分列。
- 布尔：`INTEGER CHECK(value IN (0,1))`。
- 枚举：`TEXT CHECK(...)` 或术语外键。
- RMB 金额：整数分 `INTEGER`；更高精度医保金额使用定点整数和 scale。
- 数量：基准单位定点整数，不使用 JavaScript 浮点累加余额。
- JSON：`TEXT CHECK(json_valid(...))`，只用于 FHIR 正文、外部快照和不可检索文档内容。
- 关系集合：关联表，不使用逗号串。
- 所有 Workspace/Epoch 运行事实表的主键和唯一键以 `(workspace_id, epoch, ...)` 开头；运行事实之间使用 `(workspace_id, epoch, target_id)` 复合外键，禁止只引用裸 ID，删除默认 `RESTRICT`。跨 Epoch 的不可变 Profile/Case 资产遵循[Workspace 隔离](simulation.md#101-workspace-隔离)。
- registry 声明的 reference Search 路径在写入时解析目标、验证 Workspace/Epoch，并写入包含隔离键的 `fhir_sp_string`。
- migrations 固定并记录最低 SQLite 版本；依赖 JSON 函数、`RETURNING` 或其他版本相关能力前，以真实 file-backed 数据库测试证明目标运行时支持。

### 9.6 SQLite 事务

SQLite 连接启用 foreign keys、WAL 和有界 `busy_timeout`。首期只允许一个服务端进程写入数据库；Command 使用短 `BEGIN IMMEDIATE` 事务，在获得 write lock 后读取依赖并提交完整 write plan。请求不得在事务中等待浏览器、调用外部模拟器或执行不受界限的计算。

每个 Command 流程：

1. 认证、workspace 和权限检查。
2. 网络 schema 与业务规则校验。
3. 查询 idempotency receipt。
4. 开启 `BEGIN IMMEDIATE` 并重新读取 active Epoch、receipt、资源版本和所有并发敏感依赖。
5. 应用服务读取并校验命令依赖，生成确定性 Effect。
6. 通过复合 foreign key、unique/check constraint、expected-version 条件更新和余额下限约束保护不变量。
7. 在一个事务写入当前资源、历史、Search 索引、领域事实、outbox、Audit Event、Action Trace 和 receipt。
8. 提交后唤醒 dispatcher；外部模拟或通知始终在事务之外执行。

数据库约束是并发正确性的最终保护：幂等 receipt key 唯一，库存以带 version 和 `quantity_on_hand >= delta` 的条件更新扣减，Workspace 内关系使用含 Epoch 的复合 foreign key。任何条件更新零行、约束错误或审计写入失败都使事务回滚，并被转换为稳定的 conflict、invariant 或 transient 错误。

SQLite 连接以五秒 `busy_timeout` 提供有界锁等待；CommandExecutor 当前不在应用层叠加事务重试。已经发出外部副作用或得到 ambiguous outcome 的操作不能通过重跑整个 Command 解决。持续竞争无法满足交互延迟时需要重新评估数据库和部署方案。

同步业务 Command 的真实 SQLite 合约要求单次事务持续时间小于一秒。五秒 `busy_timeout` 是锁等待上界，不是允许业务事务占用 writer 五秒；网络调用、dispatcher 处理和预览后的人工等待都必须留在事务外。

### 9.7 Outbox

`outbox_event` 状态：

```text
queued -> claimed -> completed
                  -> failed -> claimed
                  -> ambiguous
queued/claimed    -> abandoned
```

每个事件具有 event ID、Workspace/Epoch、Scenario Run、kind、dedup key、correlation ID、attempt、next attempt、`lease_owner/lease_version/leased_until` 和 payload hash。lease 以真实时间通过短事务条件抢占，支持过期回收、固定有界延迟和最大尝试；达到最大尝试后保持 `failed`，当前没有人工 dead-letter 管理 API。

- 服务启动时扫描可恢复事件；Command 提交后只负责唤醒同进程 dispatcher，内存通知丢失不会丢事件。
- dispatcher 在外部调用前持久化 claim、lease 和 correlation ID，在提交结果前重新验证 Workspace/Epoch 仍 active。
- LIS consumer 按 event ID 幂等；独立检查申请由开具、受理和开工 Command 依次产生受理、执行和报告 outbox，报告 consumer 对不同 event ID 的重复投递也按申请关联去重。支付 Command 只有成功时才产生兼容检验报告或药房 outbox。支付结果未知保持 `ambiguous`，不直接退回 queued。
- dispatcher 崩溃后由过期 lease 恢复；当前没有公开人工重放入口。
- 不承诺 exactly-once；使用 at-least-once delivery、幂等 consumer 和 ambiguous outcome 对账。

<a id="98-文书与附件边界"></a>

### 9.8 文书与附件边界

首期只保存通过运行时 envelope 与业务规则验证的结构化 FHIR JSON。已签署 document Bundle、Composition、Provenance 和 Clinical Document Revision 与其他 FHIR 资源一起进入 current/history store，不写本地散落文件。病历修订创建新的 logical resource 和明确 `replaces` 关系；同一病例的唯一根约束和最新版本检查禁止分叉或第二个签署根。

首期不提供 Binary、图片、PDF、扫描件、OCR、报告附件或对象存储。未来加入附件时必须另行设计内容校验、授权、版本不可变性、备份恢复和对象生命周期，不能把 SQLite 文件路径直接写入 FHIR 资源。

影像检查的像素不是附件，也不进入 SQLite、Git、日志或模型输入。像素保存在数据库之外的本地素材目录，由影像读取边界按本院检查标识读取；FHIR 正文、临床读模型和阅片描述都不包含文件路径。数据库只保存本院检查与素材的私有对应关系和报告内容，见 [10.7 节](simulation.md#107-影像素材与病例影像准备)。

### 9.9 数据库迁移边界

首期只有 SQLite Repository adapter。Drizzle schema 和迁移以 SQLite 为真实目标，不维护 D1 或 PostgreSQL 方言的虚假兼容层。Workspace 级 Profile、Case、Brief 和 Investigation Snapshot 使用稳定逻辑 key 和显式 revision，不依赖本地自增 ID。

未来选择 D1、PostgreSQL 或 Supabase 时必须：

- 新增目标数据库的真实 Repository adapter 与双端 contract tests。
- 设计并演练 schema、FHIR history、领域事实、审计和 outbox 的显式迁移。
- 验证 canonical state hash、引用完整性、金额和数量守恒、history/version 与 active Epoch。
- 单独定义目标运行时的事务、并发、备份、恢复和部署约束。

Repository 边界降低业务代码耦合，但不承诺直接复制 `.sqlite` 文件或零成本切换。
