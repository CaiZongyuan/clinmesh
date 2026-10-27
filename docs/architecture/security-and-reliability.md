# 安全与可靠性

本文拥有认证、授权、字段边界、审计、请求约束、一致性和失败语义。系统总入口见[系统架构](../architecture.md)，业务验证要求见[测试策略](../testing.md)。

## 11. 认证、授权与审计

### 11.1 认证

首期使用 Better Auth 管理合成 User Account、登录凭证、浏览器 cookie session 和会话撤销，禁用公开注册。运行时为已实现的医院岗位及管理员幂等创建预置合成账户，入口见[部署账号](../deployment.md)。Better Auth 不拥有 Workspace Membership、Practitioner Role、地点或 Scenario 权限。

每个受保护请求先验证浏览器会话，再由 ClinMesh Identity & Access 模块重新解析 active Workspace Membership、选择的 Practitioner Role、active Epoch、组织和地点，形成受信 Actor context。岗位切换通过服务端动作保存当前 session 的角色选择；后续业务 Command 以该 Actor context 写入审计。cookie 或请求体中的角色、Workspace 和 Epoch 不能替代数据库事实。

可选岗位和显式岗位切换要求当前 Workspace/Epoch 存在未删除的 FHIR PractitionerRole，并同时满足原 Membership 授权与有效岗位绑定。旧 Epoch 的岗位资源、Workspace 级绑定和原回执继续保留；reset 或重新安装场景不使尚未安装于新 Epoch 的旧岗位重新成为可选职责。显式选择缺少当前有效资源的岗位返回 `ROLE_NOT_ALLOWED`，不保存该选择；新 Agent Grant 只能绑定管理员当前可选的岗位。Location 名称仅是可选显示元数据，按当前 Workspace/Epoch LEFT JOIN 读取，位置不存在或已删除不会移除仍有效的岗位或改变 Actor 权限。

当前不发布 OAuth/OIDC Provider、JWKS、SMART configuration 或 backend services。DSH 浏览器仍使用当前人类 Better Auth session，execution proof 只证明真实 Tool pipeline 调用，不能替代 Actor 认证；任务 Agent 使用 ClinMesh 私有的短期 Capability Grant token，不将其声明为 OAuth、SMART 或可跨系统互操作的凭据。浏览器会话与 Grant 使用不同协议表面，但都解析为同一种 Actor context。

### 11.2 授权模型

当前权限是以下条件的交集：

```text
(
  valid browser session + active membership + selected Practitioner Role
  OR valid Agent Capability Grant + bound single Practitioner Role + operation allowlist
)
AND active Workspace/Epoch
AND Scenario Run lifecycle permits the operation
AND route/command role allowlist
AND workflow state and target references
```

新增业务写入默认要求 active Scenario Run；当前 Workspace/Epoch 内的人类收费会话可在 completed Run 通过[结算后的财务更正](clinical-workflows.md#结算后的财务更正)执行窄财务 Command，也可按[门诊退款合同](clinical-workflows.md#85-收费支付与退款)查询恢复已有退款；门诊新冲减、新退款仍要求 active Run，closed Run 拒绝新写。当前 Epoch 的人类会话可在 Run 完成后读取住院归档及其工作台依赖查询，保留原岗位、科室、病区授权和各岗位字段隔离，具体只读入口见[病案归档合同](clinical-workflows.md#病案首页与归档)。Agent Capability Grant 仍要求 active Run，不因这些人类会话例外放宽。既有 Command receipt 依照[幂等合同](fhir-and-commands.md#65-idempotency)无写重放，不重新执行业务状态变更。

当前没有 SMART/resource scope、标准 Patient compartment 或通用字段策略引擎。Agent Capability Grant 是 ClinMesh task authority，不等同于通用 delegation grant；未来引入标准 scope 或字段策略时只能继续收窄以上权限。

```text
workspace membership
AND role permission
AND SMART/resource scope
AND organization/location context
AND patient/encounter compartment
AND scenario policy
AND delegation constraint
AND field policy
```

典型角色：

- registrar
- outpatient-doctor
- triage-nurse
- pharmacist
- cashier
- inpatient-doctor
- ward-nurse
- medical-records
- administrator
- lis-system

只有 `administrator` 能 reset Scenario 或管理 Agent Client/Grant。`lis-system` 不具有交互式登录或任意患者搜索能力；允许的检验结果 Command 只能由受控 outbox context 调用，报告更正还可由窄 HTTP adapter 在验证 administrator 后由服务端绑定同一系统 context。请求正文不能声明系统角色或提交任意 FHIR 内容。DSH Agent 代表当前已登录人类岗位，任务 Agent 通过一个 Grant 承担现有单一 Practitioner Role；两者都不新增医院岗位代码。住院医生、病区护士和病案人员按[住院合同](clinical-workflows.md#82-住院闭环)参与当前闭环；医保、完整库存和审计员等尚未实现的岗位不进入 seed、导航或授权矩阵。

查询授权必须下推 SQL。不能先查 100 个患者，再在 JavaScript 中删掉 90 个；否则 total、排序、include 和时间差都可能泄漏信息。

### 11.3 字段级边界

- Synthetic Patient Profile 保存明确标记为合成的身份证号、电话、邮箱、地址和保险展示文本；只有管理员详情接口返回完整 Profile，患者库列表不返回联系方式。Profile 物化后，普通岗位仍只通过岗位读模型或现有 FHIR Patient 权限读取完成业务所需字段，保险展示文本不是医保凭证且不参与结算。
- 每个岗位使用独立的窄响应 schema，只返回完成当前工作所需字段；DSH Agent 只能读取 Page Context 和当前页面 action 明确返回的进一步窄化结果，Agent CLI 复用岗位 DTO，不增加跨岗位聚合响应。
- 普通岗位不能读取 session secret、外部原始凭证、Case Truth、Brief answer points 或其他 Scenario 私有状态。
- read-only/hidden 边界由服务端路由和 Repository 强制，不能只靠前端隐藏。
- 当前没有 break-glass；未来模拟时必须使用独立 Command、理由、短有效期和高等级审计。

### 11.4 Provenance、AuditEvent 和日志

Audit Event、Provenance、Action Trace 和应用日志职责分开：

- Provenance：某个资源版本由谁、代表谁、通过什么活动生成。
- AuditEvent：谁在何时访问或操作了什么，结果如何。
- Action Trace：某个 Scenario Run 的观察、Command 尝试、结果和 Effect 顺序，用于重放与过程分析。
- 应用日志：排障和性能，不承载完整医疗审计。

`audit_log` 是权威 append-only 事件表，FHIR AuditEvent 是只读投影。当前日志包含：

- Workspace/Epoch、sequence、previous hash、current hash
- real timestamp、Actor、Practitioner、Practitioner Role 和 role code
- Scenario Run ID、operation、success/failed outcome 和规范化 request hash

Command Effect 引用和版本保存在 `command_effect` 与 Action Trace；AuditEvent 投影把 Effect 映射为 entity。门诊退款账、住院首次资金账及后续财务差异读取通过同一审计链记录成功与进入业务授权边界后的拒绝，只保存查询引用的 hash，不保存账目正文；读取审计不参与业务账目指纹或金额计算。其他普通读取，以及 duration、request ID、organization/location 字段、客户端、delegator 或错误码当前不进入审计，也没有审计查询 UI。新增这些能力前不能宣称完整医疗审计覆盖。

Agent Tool 读取和草稿动作不伪装成 AuditEvent。`agent_tool_call` 保存 DSH Session/call ID、context、operation、input hash 和结果；proposal/review 另表保存。人类批准产生正式 Command 时，Tool call 通过 Command `requestId`、`auditId` 和 `action_trace.request_id` 关联既有审计与 Effect，不复制 Command 状态机。

`audit_head(workspace_id, epoch, audit_domain, sequence, hash, version)` 通过条件更新推进，sequence 唯一。并发冲突使整个关键业务事务回滚，服务端重新读取 head 并有界重试；禁止两个事件共享父 hash。若该成本不可接受，则取消线性链承诺，只保留独立不可变事件 hash，不能接受静默分叉。

CommandExecutor 覆盖成功 Command 和进入执行边界后的失败尝试，包括 direct start 与 reset/replay；在 active Epoch 校验前被 HTTP 层拒绝的认证、CSRF 或输入解析错误当前不写 `audit_log`。审计按 Epoch 保留，不随 reset 删除。

hash chain 只能提供防篡改线索，不能在单一管理员控制的 demo 环境中宣称正式防抵赖。关键写操作的审计必须与业务状态同事务提交；审计写失败则业务写失败。普通应用日志不得记录 token、密码、完整身份证、完整病历正文或原始医保凭证。

## 12. 可靠性与性能边界

### 12.1 请求约束

- 所有列表分页。
- `_count` 和所有查询 limit 有硬上限。
- Bundle、transaction、operation 输入限制 entry 数和总字节数。
- 首期不接收 Binary 或附件。影像像素只读，按帧或不超过 2 MiB 的块读取。
- 报表使用预定义 SQL 和小结果集，不接受客户端提交任意聚合表达式。
- Command 的事务持续时间和数据库 statement 数设置预算，超出时拆短 Command 或移出首期。

### 12.2 一致性

- 单个 Command 的完整 dependency set、业务事实、FHIR current/history/search、Audit Event、Action Trace、receipt 和 outbox 在一个 SQLite 事务中强一致。
- 外部模拟器通过 outbox 最终一致。
- 核心 FHIR 投影与领域状态同事务强一致。
- Search 索引与当前资源同事务强一致。
- 同一 SQLite 实例提供提交后的 read-after-write；Web Query 在 mutation 成功后精确失效并重新读取服务端事实。

### 12.3 失败语义

稳定区分：

- validation：输入或 profile 错误，不重试。
- authorization：权限不足，不重试。
- conflict：版本或状态冲突，重新读取后决定。
- transient：数据库忙或模拟器临时失败，可有界重试。
- ambiguous：外部结果未知，先查询/对账，禁止直接重做。
- invariant：违反医疗/财务/库存规则，不重试，需改变业务动作。

### 12.4 可观测性

每个 HTTP 请求由 Server 生成不可由客户端指定的 correlation ID，并通过 `X-Correlation-Id` 响应头返回。HIS JSON 错误同时返回可选 `error.correlationId`；FHIR R5 保持标准 `OperationOutcome`，只通过响应头关联。未知异常返回稳定通用诊断，原始 message、stack、请求正文、查询内容和认证信息不进入响应或日志。Server 为未知请求异常和后台 dispatch failure 输出结构化 stderr 记录，字段限制为时间、受控 scope、HTTP method、匹配 route template、correlation ID 和内建错误类别；非内建错误名统一记录为 `UnknownError`。

成功 Command 响应返回 `requestId` 和 `auditId`，持久表通过 Workspace/Epoch、Scenario Run、idempotency key、Audit ID、Action Trace ID 和 outbox event ID 建立关联。Agent proposal 再通过 DSH Session/call ID、proposal ID、review decision 和同一 `requestId` 串联 Tool、Command、Audit 与 Trace。CLI 在结构化错误中保留服务端 correlation ID，但该 ID 不表示 Command 已经提交，写操作的恢复仍以 idempotency key、ambiguous outcome 和 receipt 为准。`/api/health` 只报告服务状态与 FHIR 版本。

首期没有生产 metrics exporter、分布式 trace、成功 request log 或管理仪表盘，因此不宣称在线采集 API latency、SQLite busy/transaction duration、Search 规模或 outbox backlog 指标。独立 performance runner 可以在临时 sandbox 重复执行固定工作负载并输出分位数、SQL/存储和 Trace 指标，但不改变生产请求或持久化路径。运行诊断仍依赖 database CLI、correlation ID、结构化错误、失败日志和持久审计/outbox 状态；任何后续日志或指标都不得把患者姓名、身份信息、完整临床正文、token 或自由文本作为标签。

### 模型用量查询

总览接口的 `totals`、每日 `trend` 与功能 `features` 同时返回 `knownInputTokens`、`knownOutputTokens`、`unknownInputTokenRequests` 和 `unknownOutputTokenRequests`；日期、功能、Provider、模型、结果与病例筛选共同作用于这些指标。设置页分别展示已知输入和输出，分项不完整时保留提示；没有已知数量且存在缺失时显示未知，完整的零计数显示为零。计量与历史汇总口径由[明细保留与长期汇总](storage.md#明细保留与长期汇总)拥有。

ClinMesh 设置中的模型用量页通过已认证 Session 读取 `/api/model-usage/overview`、`/api/model-usage/requests` 与单次请求详情。当前 Workspace 成员可读跨 Epoch 汇总；明细及计数共用服务端 SQL 授权条件，管理员可读本 Workspace 既有功能的历史记录；新增住院 DRG 耗材建议与核验明细仍须具有当前病例读取岗位。门诊医生只读活动 Epoch 内有 `outpatient_case_responsibility` 责任关系的临床请求；住院医生和病区护士只读活动 Epoch 内当前责任科室与病区匹配的住院检验生成、DRG 耗材建议及独立核验请求，转科或岗位切换后按当前住院归属重新授权。病案岗位可读取当前 Epoch 内有真实住院归属的 DRG 建议与核验明细，此权限不扩展至既有检验或其他模型功能。其他岗位不能借相同 Actor、猜测尝试 ID 或汇总下钻读取临床明细；行政人设和目录补全明细仅管理员可读。查询不接受客户端指定 Workspace、Epoch 或角色；无权和不存在的单次请求都返回 404。

用量总览与列表接受 `taskId`、`stage` 筛选；任一字段存在时必须同时提交 `caseId`，任务查询仅归集 DRG 耗材建议与核验，总览与明细均按当前住院的医生、护士或病案读取范围授权；单纯管理员汇总权限不授予病例下钻。无权与不存在的病例统一返回 404，不显示零消费。任务筛选只匹配服务端记录的任务身份，阶段筛选只匹配实际调用步骤，不以同一患者、相同模型或功能推定归属。任务总览另返回完整账本的 `stages` 阶段累计，包含仍留存明细及长期汇总，不从当前明细分页推断阶段有无调用。未提供病例、任务或阶段筛选的工作区汇总继续沿用原有成员权限；旧功能的病例汇总维持既有合同，DRG 的病例筛选与任务筛选使用同等授权，不能通过省略任务筛选读取无权病例的新 DRG 用量。任务停止或页面关闭不清零已发生用量，明细是否仍可查由留存合同决定。

监控覆盖 Server 直接模型调用、经 DSH bridge 的调用和 Host 独立医生代问识别，不覆盖整个 DSH 原生聊天或其他插件。部署与 Workspace 默认启用，请求、Token、人民币额度分别无限，保留既有有界自动重试。成员通过 `/api/model-usage/control` 读取自身 Workspace 政策、各维度余量、生效开关与重试状态、控制拒绝和待办状态；普通成员的 `deployment` 为 `null`，不公开部署总上限及跨工作区累计量。当前选中管理员岗位可只读部署政策，并通过该路径的 `PUT` 修改本 Workspace 的开关、三项累计额度与自动重试；省略 `tokens` 或 `cny` 保留原值，显式 `null` 才切为无限。总览 `policy` 只投影自身 Workspace 上限。更新要求可信 Origin、幂等键和 `expectedVersion`，通过共享 Command 同事务写入审计和回执；请求不能指定其他 Workspace 或部署政策。部署维护者通过[部署配置](../deployment.md#模型用量)管理总限制，Workspace 无法放宽。

三类实际派发均在准入前提供版本化计量边界；全部适用维度原子通过才发出外部请求。剩余量不足返回对应维度、剩余量与所需预占量；缺少可信边界或计价时返回 `MODEL_METERING_UNAVAILABLE`，不可核算的需要量为 `null`。不自动降低输出上限、截断输入或改变推理策略。目前三个入口都能限制请求次数；直接调用没有硬输出 Token 上限，DSH SDK 也未公开绑定实际 wire adapter 的可信计量保证，因此有限 Token 与非零金额保护会拒绝这些入口的新派发。明确全零人民币价表能给出金额上界零，仍须同时满足其他有限维度。SDK `contextWindow`、`maxTokens` 配置及字符启发式不能作为计量保证，具体原因与版本随尝试记录；能力与配置见[部署说明](../deployment.md#模型用量)。取消、失联、超时和崩溃不释放未知维度，不因期限到期恢复额度；持久累计、部分结算与原始证据见[存储合同](storage.md#910-模型调用账本)。

所有当前 Workspace 成员可通过 `GET /api/model-usage/pricing` 查看部署统一价表与汇率，界面及 Workspace 接口均不提供价表写权限。费用是配置口径下的估算，总览分别显示已知金额、未知请求数与未决预占，不把已知部分当作完整账单。管理员可向 `/api/model-usage/requests/:attemptId/reconcile` 提交 `expectedRevision`、受限依据标识 `evidence` 及已核实的 `totalTokens`、`cny` 中至少一项；仅当请求已结束、派发未知、两项有效消费均已知且没有既有核对修订时，可只提交依据确认一次请求消费，或向同一请求的 `/reprice` 提交 `expectedRevision` 与 `evidence` 显式补算。两种 POST 均要求可信 Origin、幂等键、当前有效成员和当前选中的管理员岗位；只能处理自身 Workspace 的授权明细，管理员可处理旧 Epoch 请求。依据不得包含患者正文、凭证或自由格式账单正文。服务端校验修订版本、可处理状态及尚未知维度，同事务保存审计与回执；核对与补算不修改原始服务商用量、不覆盖调用时快照、不触发未知请求重发。

当前 Workspace 成员可通过 `GET /api/model-usage/retention` 读取本工作区的 `days`、`version`、`compactedRequests` 和 `lastCompactedAt`；后两项分别表示已清理明细数量及最后一次实际清理时间。当前选中的管理员岗位可通过同一路径 `PUT` 提交正安全整数或 `null` 的 `days` 及 `expectedVersion`，要求可信 Origin、幂等键、当前有效成员和共享 Command 审计；普通成员不能修改，客户端不能指定其他 Workspace、Epoch 或部署策略。清理继续使用服务端 Workspace 隔离，跨 Epoch 汇总权限及留存明细的病例责任授权不变。已清理请求仅参与汇总，详情返回 404，旧核对／补算回执也不能重新返回完整明细；独立必要审计不开放为明细查询或恢复入口。保留期限、未结算保护及事务合同见[明细保留与长期汇总](storage.md#明细保留与长期汇总)，界面操作见[部署说明](../deployment.md#模型用量)。

Host 自发识别先由 SDK 准备并绑定模型配置，再通过 `/api/model-usage/host/doctor-delegation/admit` 取得一次性准入，最后派发该准备句柄的 stream。接口拒绝浏览器 Origin，要求 Host bridge 凭证和已签发的医生输入来源证明；Workspace、Epoch、Actor、岗位、任务与病例从 Server 持久 Page Context 恢复，重新校验活动成员、岗位、病例权限与任务连续性。先查同 client 的最新绑定，再核对原身份，不能按旧身份过滤并忽略后续身份或岗位切换。同病例内容、栏目更新或续签保留原任务，切走再返回不恢复旧许可。模型路由来自受信 Host 的实际请求配置；请求不能声明功能、身份、病例、输出上限或任意生成正文。同一任务在账本事务中只能准入一次，账本故障或无有效准入响应时 stream 次数为零。

准入响应中的回执仅能向 `/api/model-usage/host/doctor-delegation/observe` 为该尝试上报窄用量和终态，或通过 `/api/model-usage/host/doctor-delegation/status` 查询是否应取消原尝试，不能授权新生成或修改其他入口的记录。结算不依赖仍有效的临床岗位或输入许可期限，避免任务失权后丢失已发生的消耗；回执与 bridge 凭证不进入账本、日志或监控。Host 的用量帧和终态写入同一 Server 账本，Host 不维护独立余额或持久账本，也不因取消、失联、结算失败或 Server 重启自动重发未知请求。

明确被控制拒绝的 Host 准入可在原期限内等待；`/api/model-usage/host/doctor-delegation/wait` 使用同样的 Host 凭证和原输入许可，仅维护或结束待办租约，每次维持重新验证上下文。该接口不建立模型尝试或放宽原期限；租约过期不释放任何已派发预占。Host 每 250 毫秒查询原尝试取消状态，查询失败时也尽力取消并保留未知结果。
