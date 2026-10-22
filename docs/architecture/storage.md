# 存储与事务

本文拥有 FHIR 与领域存储、标识符、SQLite 事务、outbox、附件和数据库迁移边界。系统总入口见[系统架构](../architecture.md)，业务验证要求见[测试策略](../testing.md)。

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
- 账务：Charge Record、Payment Preview 和 Payment Transaction。金额以整数分保存；当前没有退款、医保或收费员交账表。
- 库存与发药：Inventory Lot、append-only Inventory Movement 和 Dispense。当前不实现预占、追溯码、盘点或调拨。
- 文书：结构化 Clinical Document Draft、结构化与兼容 Clinical Sign Preview、Signed Clinical Document 关联和修订父链；签署的 Composition、document Bundle 和 Provenance 正文仍由 FHIR store 权威保存。
- 模型执行：患者回答尝试及请求意图关联、建议稳定阶段计划、单元成功步骤与累计请求计数；这些是私有执行状态，不是临床结论。
- 平台与仿真：Workspace/Epoch、Scenario Run/State、Synthetic Profile/Case、Patient Persona、Investigation Result Snapshot、私有 Case Truth、Command Receipt/Effect、Audit、Action Trace、Outbox、Agent Page Context、Tool call、proposal 和 review decision。

所有适用表、主键、唯一键、外键和岗位队列索引包含 `workspace_id + epoch`。新增 FHIR-native 辅助索引时必须可由权威资源重建；新增无法重建的事实时必须明确成为 domain aggregate，不能同时由 FHIR JSON 和领域表双向拥有。

#### 模型执行恢复

`consultation_reply_attempt` 保存受信 Workspace/Epoch、Encounter、待回答医生轮次、固定期限和执行终态；局部唯一索引保证每个医生轮次只有一个 `executing` 尝试。`consultation_reply_intent` 按 Actor、operation 与幂等键持久关联该尝试，各调用者仍独立授权和完成原 Command 回执。控制阻塞在持久执行上保留 `MODEL_CONTROL_BLOCKED` 并投影为 `blocked`，`model_reply_wait` 保存原期限及受信恢复输入；仅明确未派发且仍有效时自动接续。其他遗留执行启动转为 `unknown`；缺少派发证据的旧未答轮次迁移为未知，不自动补答。读取时已保存患者回答优先于尝试状态，响应丢失不触发重复推理。

`doctor_recommendation_execution`、`doctor_recommendation_execution_plan`、`doctor_recommendation_execution_unit` 与 `doctor_recommendation_execution_continue` 分别保存绑定及累计额外次数、稳定阶段计划、批次依赖及成功结果、人工继续意图。四表以 Workspace/Epoch 开头的复合主键、外键隔离，删除使用 `RESTRICT`。执行键由 Workspace/Epoch、Actor/context、病例、建议类型与 generation 身份派生，完整绑定另含输入指纹、模型和策略；持久 JSON、键与完整绑定在运行时验证，计划与单元哈希不允许恢复时改组。筛选成功步骤只有完整来源上下文、请求与受信作用域均相同时可跨任务复用，生成和核验只属于原执行。

每次外部派发前用短事务原子预占单元次数和 generation 额外次数，Provider 内部限流重发和格式修复也经过同一边界；网络请求在事务外。次数与 outbox 调度 attempt 独立持久化，重新领取及重启不清零。预占后未保存完整结果的崩溃窗口保留占用并转为未知。恢复先校验固定依赖及成功步骤，再处理未完成单元；私有候选在全部必要核验结束前不投影为可采纳结果。

人工继续意图只为一个未知、失败或因 `MODEL_RETRY_DISABLED` 等待的单元持久保存一次 `resume_available` 授权，优先选择未知单元；同一意图重放不再次授权，已有未消费授权时不开放新的继续操作。每次实际请求准入均在事务内重新读取该授权，通过双层停用、额度、权限与原次数包络检查后，与请求次数预占原子消费。授权只豁免本次请求的自动重试开关，不重置预算、不改变 `blocked_kind`，也不自动开放其他失败单元或后续内部重试。准入拒绝保留未消费授权，重启可接续；技术失败终止当前继续意图并清除剩余授权，派发前失败不增加请求次数。派发后的崩溃仍转为未知，必须有新的人工意图才能再试。

其他模型业务的 `model_task_step` 按 Workspace/Epoch、原任务与完整步骤输入指纹保存请求包络、被拒绝的实际请求种类、私有成功结果和未知状态。结果持久成功前仍保留派发中状态，崩溃不推断可重发；这些私有业务结果不进入用量账本。`model_task_wait` 关联控制阻塞的原 outbox 事件，恢复后复用成功步骤并重新验证业务有效性与权限，仍使用原并发通道。建议沿用既有执行单元及 `blocked_kind`，不另建一套成功结果缓存。

`model_host_wait` 仅保存已验证的 Host 任务 claims、原期限与短存活租约，不保存许可签名、医生正文或模型尝试。待办计数重新校验原页面连续性与当前授权，排除已准入、失权、过期、切走或失联的任务；该表只提供可观察状态，不授予或调度派发。Host 保持原 30 秒期限，通过认证心跳维持 1 秒租约，结束或成功准入清除。

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

#### 门诊号发行状态

门诊号标识本次就诊，保存在 Registration 和 Encounter.identifier，患者级标识保持独立。新号格式为 `CM-OP-YYYYMMDD-流水号`，业务日期使用已校验的就诊日期；流水至少六位，超过六位自然增长，以日期和数值流水排序。普通挂号、合成病例开始及 reset 后的重放都经过同一个发号边界，在原 Command 写事务内提交发行状态、Registration、Encounter 与回执；同键重放不再发行。

`registration_number_counter(visit_date, high_water)` 按日期保存全数据库共用的已提交发行高水位，作用域不含 Workspace/Epoch，业务删除和产品内 reset 不清理它。`registration_number_authority` 保存单例发行权威 ID、active/retired 状态以及全部日期计数器的规范化 SHA-256 摘要；每次分配都在写锁内验证完整状态并原子更新摘要。缺失日期只有在完整计数器清单仍匹配时才是首次使用；缺行、损坏、已退休权威和安全整数容量耗尽均拒绝发行，不从现存业务行重建。

迁移必须先证明历史完整性，再跨全部 Workspace/Epoch 汇总按日高水位。证明包含每个 Epoch 的完整审计链与头、每条审计的初始 AuditEvent 投影、正常挂号及合成病例开始的初始 Encounter 号码，并反查现存挂号和全部有号 Encounter 历史。当前最大存量号只是下界，不能独立作为迁移依据。旧版成功 reset 未保存完整重放发行清单，或必要历史证据已删除、损坏、无法关联时，迁移返回 `REGISTRATION_NUMBER_HISTORY_UNVERIFIED` 并回滚该迁移，保留原数据及旧号；不会把未确认历史视为零。跨作用域已有重复号保留原值，新发行从已证实的全局高水位继续。

发行状态随一致备份保存并纳入 canonical state hash。受控恢复要求保留可信最新发行权威库；恢复在停用旧权威后，将备份和最新权威的每日期高水位取大值，再启用一个恢复目标。缺少最新权威、身份不一致或状态无法验证时拒绝恢复发号；退休后的失败也不自动重新启用旧库。操作入口与恢复失败处理见 [Demo 数据库运维](../demo-architecture.md#database-operations)，证明边界与替代方案见[发行完整性决策](../decisions/implemented/architecture/2026-10-20-registration-numbering-integrity.md)。摘要用于检测发行状态的意外缺失和损坏，不抵抗管理员同时篡改事实与校验值；应用不自动识别任意文件复制或保证独立克隆双写后的全历史唯一。

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

模型控制拒绝使用独立的 `model-blocked` 完成语义，事件持久为等待中的 `failed`，返还本次 claim 的调度 attempt，并关联 `model_task_wait`；它不消耗技术重试机会。控制恢复后只唤醒原事件，业务服务仍负责当前性校验。已派发结果未知使用 `ambiguous`，不会随控制恢复重新领取。

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

### 9.10 模型调用账本

`model_usage_attempt` 保存 Server 直接 Provider、DSH bridge 与 Host 独立医生代问识别的逐次尝试，按 Workspace 长期归属并记录原 Epoch，不随 Epoch 重置清空。每次实际生成、格式纠错和限流重发先持久创建 UUID 尝试；桥接沿用该身份，Host 的同一次 stream 不重复创建记录。Host 自发识别固定记为 `doctor_delegation`，医生输入任务 ID 的首次准入与记录创建在同一事务中完成，重放不再返回可派发许可。账本创建与已有建议单元次数预占同事务提交，外部请求在事务后派发；即使额度无限，账本写入失败也停止请求。

记录仅包含任务、阶段、病例、明确来源及触发/支持关系、实际 Provider/模型、推理策略、可知输出上限、时间、结果、服务商请求 ID 和经过映射的 Token 元数据。合批保存多个来源，不把全部消耗归给首项；患者人设的合成病例来源与本院门诊病例授权标识分开。提示词、临床正文、模型正文、原始错误和凭证不进入账本。OpenAI 的输入包含缓存、输出包含推理；DSH SDK 的未缓存输入与缓存读取/写入先合并为输入，推理仍是输出子集，不能再加到总量。窄 `raw` 计数保留服务商原始分项，包含 DSH 未缓存输入及独立缓存读写；缺少完整输入时仍保留可信分项，已知 Token 汇总只累计可信下界，并同时显示未知请求数。日期筛选、趋势和显示使用 `Asia/Shanghai`，持久时间仍使用 UTC。

未知用量使用 `null`，缺价费用使用 `price-not-configured`，不转换为零。派发证据区分已派发、确认未派发和未知：已准入后可确认未派发的拒绝保留可查询明细，但不计入实际请求；无法证明未派发时保守计入。DSH bridge 与 Host 自发识别均先由 SDK 准备并锁定模型配置；bridge 的 SDK 预检拒绝记为确认未派发，Host 自发识别的预检失败不创建尝试。桥接用量帧和终态返回准备后的推理策略及输出上限，包括 SDK 应用的默认值；旧帧省略这些元数据时保留已有记录。DSH 用量帧到达后以短事务持久保存可信量、实际配置和已派发证据，请求保持在途且不设置结束时间；取消、断流和启动恢复均保留已观察的计数与配置，启动只将前一 writer 留下的在途尝试转为未知，不据此自动重新派发。多帧快照按已报告分项覆盖，省略项保留已知值；DSH 输入、缓存及总量随合并后的分项重算，旧总量仅作为原始证据保留。新帧的可信归一化计数不会被旧原始分项覆盖，全未知帧不改变已有计数及其可信状态。终态重复送达幂等；已知实际模型不会随当前路由设置改变。

建议任务的手动重新生成或继续意图随受信 outbox 事件持久化，后续请求标记为手动触发并关联该事件；继续保留原任务及批次身份，不能仅因存在旧任务就推断用户发起了继续。外层格式纠错与限流重发分别沿用 `format-repair`、`rate-limit-retry` 分类，不重新标记为首次尝试。权限与查询范围见[模型用量查询](security-and-reliability.md#模型用量查询)；决策见[逐次计量决策](../decisions/implemented/architecture/2026-10-21-server-model-usage-ledger.md)。

Host 独立识别的期限固定为 30 秒，Host 在该期限内停止识别；Server 依据持久化开始时间，在用量读取、Host 准入或上报时将超期在途记录持久转为未知，覆盖 Host 完全失联而无法发送终态的情况。进度上报只更新用量证据，不延长期限或把未知状态改回在途。超期不释放消耗、不删除去重身份，也不授予新派发；迟到的可信终态仍可结算原尝试。

已保存成功、失败或取消终态的状态、结束时间和模型等元数据不再改写。迟到可信用量只可补齐未知计数和费用，原已知计数、原始分项及费用必须保持一致；矛盾报告整体忽略。成功回执丢失后的未知报告不降级终态，补齐消费也不授权重发。

`model_usage_control` 持久保存部署及各 Workspace 的开关、请求上限、自动重试和版本；`model_usage_dimension` 保存各层 Token 与人民币维度的上限、独立累计起点和已结算量。每层的每个维度首次设为有限时建立起点，只将此后派发计入该维度额度；起点之前的明细仍进入监控。调整上限、切换无限、重启与 Epoch reset 都不重置起点或累计，无限期间仍持续累计。`model_usage_request_reservation` 与 `model_usage_dimension_reservation` 将每次尝试绑定到已建立起点的适用层，和尝试创建、建议单元或任务包络检查原子提交；网络等待在事务外。全部维度同时通过才能派发，拒绝事件不冒充实际调用。

尝试的 `priceSnapshot` 在准入时冻结 Provider、请求路由、单价版本、原币种、各计量项单价与人民币汇率版本；匹配键是受信派发前的 Provider 与 `requestedModel` 精确值，DSH 使用完整固定路由，响应 `actualModel` 不替换快照。`cost` 保留调用时依据及原币、人民币估算，缺价、缺汇率、缺用量与明确零价格分别表示。单价按每百万 Token 配置；输入包含缓存，输出包含推理，计价按互不重复的分项拆分。中间乘除使用整数运算，持久金额为百万分之一货币单位的安全整数；配置最多六位小数，缩放后的值和累计不得超过 `Number.MAX_SAFE_INTEGER`。预占向上取整，结算按实际分项四舍五入到百万分之一；人民币从未舍入原币计算后只舍入一次。详细配置见[模型用量部署](../deployment.md#模型用量)。

`reservationBoundary` 保存每次派发的适配器入口、边界版本、包含缓存的输入上界、包含推理的输出上界及不可核算原因。有限 Token 须有可信总量上界，有限人民币须有完整计价与可信金额上界；缓存与推理按可能的最高单价保守预占。可确认未派发才整体释放；已派发或无法证明未派发的取消、超时、断流、进程退出与期限到期都保留未知维度的占用。可信用量或管理员核对可幂等结算对应维度，只释放该维度可确认的剩余预占；部分核对不释放其他维度。此前在无限期间留下的未知记录不会单独阻止无限模式的后续调用，切为有限后不能忽略同一起点之后的未决消费。

管理员核对与缺价／缺汇率补算作为独立 `corrections` 修订保存序号、当前管理员、时间、依据及所补维度；通过共享 Command 同事务写入审计、回执、有效计量与额度结算。原始服务商 `usage`、调用时 `priceSnapshot` 与 `cost` 保留，`accounting`、`effectiveCost` 投影叠加有效修订。核对只接受尚未知的 Token 总量或人民币金额，可先核对一项再处理另一项；派发未知的已结束请求经显式核对且两项有效消费均已知后，将请求预占保守转为一次已用请求，包括核对为零消费的情况，不恢复请求额度，也不改写原始派发与结果状态。部分核对继续保留未决请求预占。补算只适用于仍留存、原本缺价或缺汇率且尚无有效人民币金额的请求。缺汇率补算沿用原单价，只补新汇率依据；已有完整调用时快照不按当前价表重算。重复提交不重复累计，核对或补算也不授予模型重新派发机会。计价与核对取舍见[计价控制决策](../decisions/implemented/architecture/2026-10-21-model-usage-pricing-control.md)，待办恢复沿用[双层准入与恢复](../decisions/implemented/architecture/2026-10-21-model-request-control-recovery.md)。

#### 明细保留与长期汇总

`model_usage_retention` 按 Workspace 保存明细保留天数、设置版本、已清理明细数量及最后一次实际清理时间；默认 90 天，正安全整数表示天数，`null` 表示永久。保留设置、长期汇总和累计额度均跨 Epoch 保存。到期以真实 UTC `started_at` 加保留天数计算，恰好到期即符合时间条件；一天为 24 小时，不使用仿真时间或上海自然日零点作为清理边界。Server 启动、每小时、当前 Workspace 的总览／列表／详情读取及保存保留设置时执行清理。

清理只选择已经结束、消费可结算的记录。在途、派发未知且未完成全部消费核对、实际 Token 总量未知、费用因用量未知而无法确认，或任一层任一维度仍有 `reserved` 的明细继续保留；取消、失联、超时和重启不使它们提前过期。已明确未派发的记录可清理；已知实际消费但仅缺价或缺汇率，且没有未决预占的记录也可清理，其未知费用统计继续保留。派发未知的请求经管理员显式核对、Token 与人民币均已知且全部预占已结算后，也可按期清理，长期汇总仍保留结果未知计数。未知明细及必要计价依据可能超过设置天数，取得可信用量或管理员核对后才重新参与到期判定。

同一个 SQLite 事务先将候选明细的有效计量合并到 `model_usage_daily`，再删除候选的已结算预占关联和逐次明细。日汇总按 `Asia/Shanghai` 日期、Workspace、Epoch、病例、功能、Provider、请求模型、实际模型和结果共同分组，保留请求数、已知 Token、未知请求与未知 Token 计数、已知人民币微单位及缺价请求数。总览将长期汇总与仍留存明细合并后应用原有筛选；请求模型和实际模型仍分别参与模型匹配。金额未知与零费用保持不同，已知部分不代表完整总额。事务回滚不留下半份汇总，重复清理不重复累计；清理不修改 `model_usage_control`、`model_usage_dimension` 的累计量、预占量或独立起点。

有核对或补算修订的到期记录，将原始 `status`、`dispatch`、必要原始 `usage`、`cost`、`priceSnapshot` 与 `corrections` 保存在独立 `model_usage_correction_audit`，不保留完整任务、来源或临床上下文。相关 Command 回执的完整明细响应替换为过期标记，原审计与幂等身份继续保留；修订入口在回执重放前确认明细仍留存，旧幂等键不能恢复已清理明细。长期汇总和必要审计不是逐次明细备份，不提供历史恢复、逐次核对或补算接口；之后延长天数或改为永久也不会恢复已删除记录。查询与设置权限见[模型用量查询](security-and-reliability.md#模型用量查询)，取舍见[明细保留决策](../decisions/implemented/architecture/2026-10-21-model-usage-retention.md)。
