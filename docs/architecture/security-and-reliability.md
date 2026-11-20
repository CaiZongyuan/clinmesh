# 安全与可靠性

本文拥有认证、授权、字段边界、审计、请求约束、一致性和失败语义。系统总入口见[系统架构](../architecture.md)，业务验证要求见[测试策略](../testing.md)。

## 认证、授权与审计

<a id="111-认证"></a>

### 认证

首期使用 Better Auth 管理合成 User Account、登录凭证、浏览器 cookie session 和会话撤销，禁用公开注册。运行时为已实现的医院岗位及管理员幂等创建预置合成账户，入口见[部署账号](../deployment.md)。Better Auth 不拥有 Workspace Membership、Practitioner Role、地点或 Scenario 权限。

每个受保护请求先验证浏览器会话，再由 ClinMesh Identity & Access 模块重新解析 active Workspace Membership、选择的 Practitioner Role、active Epoch、组织和地点，形成受信 Actor context。浏览器写请求（POST/PUT/PATCH/DELETE）统一经 `assertTrustedMutation` 校验可信同源或 `CLINMESH_TRUSTED_ORIGINS` 白名单 Origin，防止跨站伪造；岗位切换通过服务端动作保存当前 session 的角色选择，后续业务 Command 以该 Actor context 写入审计。cookie 或请求体中的角色、Workspace 和 Epoch 不能替代数据库事实。

可选岗位和显式岗位切换要求当前 Workspace/Epoch 存在未删除的 FHIR PractitionerRole，并同时满足原 Membership 授权与有效岗位绑定。旧 Epoch 的岗位资源、Workspace 级绑定和原回执继续保留；reset 或重新安装场景不使尚未安装于新 Epoch 的旧岗位重新成为可选职责。显式选择缺少当前有效资源的岗位返回 `ROLE_NOT_ALLOWED`，不保存该选择；新 Agent Grant 只能绑定管理员当前可选的岗位。Location 名称仅是可选显示元数据，按当前 Workspace/Epoch LEFT JOIN 读取，位置不存在或已删除不会移除仍有效的岗位或改变 Actor 权限。

当前不发布 OAuth/OIDC Provider、JWKS、SMART configuration 或 backend services。DSH 浏览器仍使用当前人类 Better Auth session，execution proof 只证明真实 Tool pipeline 调用，不能替代 Actor 认证；任务 Agent 使用 ClinMesh 私有的短期 Capability Grant token，不将其声明为 OAuth、SMART 或可跨系统互操作的凭据。浏览器会话与 Grant 使用不同协议表面，但都解析为同一种 Actor context。

### 授权模型

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

新增业务写入默认要求 active Scenario Run；当前 Workspace/Epoch 内的人类收费会话可在 completed Run 执行结算后窄财务更正或查询恢复已有退款，但门诊新冲减、新退款仍要求 active Run，closed Run 拒绝新写，见[收费、结算与医保](billing-and-insurance.md)。当前 Epoch 的人类会话可在 Run 完成后读取住院归档及其工作台依赖查询，保留原岗位、科室、病区授权和各岗位字段隔离，见[住院与手术流程](inpatient-workflows.md)。Agent Capability Grant 仍要求 active Run，不因这些人类会话例外放宽。既有 Command receipt 依照[幂等合同](fhir-and-commands.md#65-idempotency)无写重放，不重新执行业务状态变更。

当前没有 SMART/resource scope、标准 Patient compartment 或通用字段策略引擎。Agent Capability Grant 是 ClinMesh task authority，不等同于通用 delegation grant；未来引入标准 scope 或字段策略时只能继续收窄以上权限。

典型角色包括 `registrar`、`outpatient-doctor`、`triage-nurse`、`pharmacist`、`cashier`、`inpatient-doctor`、`ward-nurse`、`medical-records`、`medical-insurance`、`administrator` 与 `lis-system`（及放射、病理受控系统执行者）。

只有 `administrator` 能 reset Scenario 或管理 Agent Client/Grant。`lis-system` 及放射、病理受控系统执行者不具有交互式登录或任意患者搜索能力；允许的检查结果 Command 只能由受控 outbox context 调用，报告更正还可由窄 HTTP adapter 在验证 administrator 后由服务端绑定对应系统 context。请求正文不能声明系统角色或提交任意 FHIR 内容。DSH Agent 代表当前已登录人类岗位，任务 Agent 通过一个 Grant 承担现有单一 Practitioner Role；两者都不新增医院岗位代码。住院医生、病区护士、病案人员与医保办按[住院与手术流程](inpatient-workflows.md)参与当前闭环；完整库存、财务交账和独立审计员等尚未实现的岗位不进入 seed、导航或授权矩阵。

查询授权必须下推 SQL。不能先查 100 个患者，再在 JavaScript 中删掉 90 个；否则 total、排序、include 和时间差都可能泄漏信息。

### 字段级边界

- Synthetic Patient Profile 保存明确标记为合成的身份证号、电话、邮箱、地址和保险展示文本；只有管理员详情接口返回完整 Profile，患者库列表不返回联系方式。Profile 物化后，普通岗位仍只通过岗位读模型或现有 FHIR Patient 权限读取完成业务所需字段，保险展示文本不是医保凭证且不参与结算。
- 每个岗位使用独立的窄响应 schema，只返回完成当前工作所需字段；DSH Agent 只能读取 Page Context 和当前页面 action 明确返回的进一步窄化结果，Agent CLI 复用岗位 DTO，不增加跨岗位聚合响应。
- 普通岗位不能读取 session secret、外部原始凭证、Case Truth、Brief answer points 或其他 Scenario 私有状态。
- read-only/hidden 边界由服务端路由和 Repository 强制，不能只靠前端隐藏。
- 当前没有 break-glass；未来模拟时必须使用独立 Command、理由、短有效期和高等级审计。

### Provenance、AuditEvent 和日志

Audit Event、Provenance、Action Trace 和应用日志职责分开：Provenance 记录某个资源版本由谁、代表谁、通过什么活动生成；AuditEvent 记录谁在何时访问或操作了什么及结果；Action Trace 记录某个 Scenario Run 的观察、Command 尝试、结果和 Effect 顺序，用于重放与过程分析；应用日志用于排障和性能，不承载完整医疗审计。

`audit_log` 是权威 append-only 事件表，FHIR AuditEvent 是只读投影。当前日志包含 Workspace/Epoch、sequence、previous hash、current hash、real timestamp、Actor、Practitioner、Practitioner Role、role code、Scenario Run ID、operation、success/failed outcome 和规范化 request hash。

Command Effect 引用和版本保存在 `command_effect` 与 Action Trace；AuditEvent 投影把 Effect 映射为 entity。门诊退款账、住院首次资金账及后续财务差异读取通过同一审计链记录成功与进入业务授权边界后的拒绝，只保存查询引用的 hash，不保存账目正文；读取审计不参与业务账目指纹或金额计算。其他普通读取，以及 duration、request ID、organization/location 字段、客户端、delegator 或错误码当前不进入审计，也没有审计查询 UI。新增这些能力前不能宣称完整医疗审计覆盖。

Agent Tool 读取和草稿动作不伪装成 AuditEvent。`agent_tool_call` 保存 DSH Session/call ID、context、operation、input hash 和结果；proposal/review 另表保存。人类批准产生正式 Command 时，Tool call 通过 Command `requestId`、`auditId` 和 `action_trace.request_id` 关联既有审计与 Effect，不复制 Command 状态机。

`audit_head(workspace_id, epoch, audit_domain, sequence, hash, version)` 通过条件更新推进，sequence 唯一。并发冲突使整个关键业务事务回滚，服务端重新读取 head 并有界重试；禁止两个事件共享父 hash。若该成本不可接受，则取消线性链承诺，只保留独立不可变事件 hash，不能接受静默分叉。

CommandExecutor 覆盖成功 Command 和进入执行边界后的失败尝试，包括 direct start 与 reset/replay；在 active Epoch 校验前被 HTTP 层拒绝的认证、CSRF 或输入解析错误当前不写 `audit_log`。审计按 Epoch 保留，不随 reset 删除。

hash chain 只能提供防篡改线索，不能在单一管理员控制的 demo 环境中宣称正式防抵赖。关键写操作的审计必须与业务状态同事务提交；审计写失败则业务写失败。普通应用日志不得记录 token、密码、完整身份证、完整病历正文或原始医保凭证。

## 可靠性与性能边界

### 请求约束

- 所有列表分页；`_count` 和所有查询 limit 有硬上限。
- Bundle、transaction、operation 输入限制 entry 数和总字节数。
- 首期不接收 Binary 或附件；影像像素只读，按帧或不超过 2 MiB 的块读取。
- 报表使用预定义 SQL 和小结果集，不接受客户端提交任意聚合表达式。
- Command 的事务持续时间和数据库 statement 数设置预算，超出时拆短 Command 或移出首期。

### 一致性

- 单个 Command 的完整 dependency set、业务事实、FHIR current/history/search、Audit Event、Action Trace、receipt 和 outbox 在一个 SQLite 事务中强一致。
- 外部模拟器通过 outbox 最终一致；核心 FHIR 投影与领域状态、Search 索引与当前资源同事务强一致。
- 同一 SQLite 实例提供提交后的 read-after-write；Web Query 在 mutation 成功后精确失效并重新读取服务端事实。

### 失败语义

稳定区分六类失败：`validation`（输入或 profile 错误，不重试）、`authorization`（权限不足，不重试）、`conflict`（版本或状态冲突，重新读取后决定）、`transient`（数据库忙或模拟器临时失败，可有界重试）、`ambiguous`（外部结果未知，先查询/对账，禁止直接重做）和 `invariant`（违反医疗/财务/库存规则，不重试，需改变业务动作）。

### 可观测性

每个 HTTP 请求由 Server 生成不可由客户端指定的 correlation ID，并通过 `X-Correlation-Id` 响应头返回。HIS JSON 错误同时返回可选 `error.correlationId`；FHIR R5 保持标准 `OperationOutcome`，只通过响应头关联。未知异常返回稳定通用诊断，原始 message、stack、请求正文、查询内容和认证信息不进入响应或日志。Server 为未知请求异常和后台 dispatch failure 输出结构化 stderr 记录，字段限制为时间、受控 scope、HTTP method、匹配 route template、correlation ID 和内建错误类别；非内建错误名统一记录为 `UnknownError`。

成功 Command 响应返回 `requestId` 和 `auditId`，持久表通过 Workspace/Epoch、Scenario Run、idempotency key、Audit ID、Action Trace ID 和 outbox event ID 建立关联。Agent proposal 再通过 DSH Session/call ID、proposal ID、review decision 和同一 `requestId` 串联 Tool、Command、Audit 与 Trace。CLI 在结构化错误中保留服务端 correlation ID，但该 ID 不表示 Command 已经提交，写操作的恢复仍以 idempotency key、ambiguous outcome 和 receipt 为准。`/api/health` 只报告服务状态与 FHIR 版本。

首期没有生产 metrics exporter、分布式 trace、成功 request log 或管理仪表盘，因此不宣称在线采集 API latency、SQLite busy/transaction duration、Search 规模或 outbox backlog 指标。独立 performance runner 可以在临时 sandbox 重复执行固定工作负载并输出分位数、SQL/存储和 Trace 指标，但不改变生产请求或持久化路径。任何后续日志或指标都不得把患者姓名、身份信息、完整临床正文、token 或自由文本作为标签。

### 模型用量查询

已认证成员跨 Epoch 可读本 Workspace 的模型用量总览、统一价表与保留期设置，但不接受客户端指定 Workspace、Epoch 或角色，普通成员的部署政策字段固定为 `null`。请求明细与病例／任务／阶段下钻在 SQL 中强制校验当前责任关系：门诊医生限活动 Epoch `outpatient_case_responsibility` 病例，住院医生与病区护士限活动 Epoch 当前责任科室与病区的住院检验、DRG 建议及核验，病案人员仅限当前 Epoch 有真实住院归属的 DRG 建议与核验明细，行政人设与目录补全仅管理员可读；单纯管理员汇总权限不授予 DRG 病例或任务下钻，无权或不存在的请求／病例统一返回 404。

策略更新（开关、三项额度、自动重试、保留天数）及留存明细的 `reconcile`／`reprice` 仅向当前有效管理员开放，要求 `assertTrustedMutation` 可信 Origin、幂等键与 `expectedVersion`／`expectedRevision`，经共享 Command 同事务写审计与回执；DRG 明细核对与补算须同时具备管理员资格与当前住院读取岗位，每次回放旧回执前重新校验当前资格与病例范围，依据不得含患者正文或凭证，且 Workspace 无法放宽部署总上限（见[部署指南](../deployment.md#模型用量)）。

Host 独立医生代问准入（`/api/model-usage/host/doctor-delegation/*`）拒绝浏览器 Origin，要求 Host bridge 凭证与已签发医生输入来源证明；服务端从持久 Page Context 先查同 client 最新绑定再核对活动成员、岗位、病例权限与任务连续性，单任务在账本事务中只能准入一次，无有效准入则零次流式派发。准入回执仅能上报该尝试的窄用量／终态或查询取消状态（结算不依赖仍有效的临床岗位，失联或重启不自动重发未知请求），被控制拒绝时 `/wait` 仅在原期限内维持待办租约。逐次记账、计量预占、核对补算与保留期压缩的状态机见[模型调用账本](storage.md#模型调用账本)与[明细保留与长期汇总](storage.md#明细保留与长期汇总)。
