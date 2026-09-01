# 中国公立医院仿真 HIS 详细架构设计

- 状态：standalone Web、DSH React Surface 与 Agent CLI 已实现
- 日期：2026-09-01
- 适用范围：Web 产品演示、DSH 原生 Agent 协作、Agent CLI 与技术验证
- 首期运行决策：[Web Demo 运行与部署架构](./demo-architecture.md)
- 领域词汇：[ClinMesh 仿真医院领域](../CONTEXT.md)
- 参考实现：`references/openhis-itai-pro/`、`references/medplum/`

## 0. 执行摘要

本系统不是生产医院信息平台，也不是完整 FHIR Server 产品。它用可重复、可审计的合成医院场景，让人类岗位通过 standalone Web 或 DSH React Surface、交互式 Agent 通过 DSH 页面 Tools、任务 Agent 通过 CLI 完成同一业务交接。当前发布证明多岗位普通门诊发热闭环、DSH Surface adapter、Agent CLI 和支撑这些能力的基础设施；Agent adapter 只开放已经实现的业务能力。

首期是一个运行于 Node.js 的 TypeScript 模块化单体：

```text
React SPA
   |
   +-- /fhir/R5/* -------- FHIR R5 互操作 API
   +-- /api/his/v1/* ----- 非 FHIR 业务命令 API
   +-- /api/sim/v1/* ----- 场景、时钟与管理员重置 API
   +-- /api/auth/* ------- Web 会话与岗位上下文
            |
            v
     Application Services
            |
     Domain Command Handlers
            |
      Repository Interfaces
       |                |
       v                v
FHIR Resource Store   HIS Domain Tables
       |                |
       +------ file-backed SQLite ------+
                         |
                         +-- persistent outbox

DSH Web -- React Surface --> same React application/runtime
        -- browser Tools --> /api/agent/v1/*
        -- /clinmesh-api --> fixed loopback Hono
```

核心决策如下：

1. **FHIR 版本采用 R5 `5.0.0`。** 截至本文日期，R5 是最新已发布稳定版本；R6 仍是 CI build。Medplum 5.1.30 仍以 R4 `4.0.1` 为正式服务版本，因此借鉴其架构，不直接依赖其 R4 类型和服务端实现。
2. **标准接口和业务命令分层。** 当前 FHIR API 用于标准资源读取、版本历史和白名单搜索；所有业务写入由 `/api/his/v1` 或 `/api/sim/v1` 的显式 Command 完成。禁止让客户端通过多个通用 CRUD 自行编排挂号、医嘱签发、发药或支付。
3. **按资源确定唯一权威数据源。** 标准临床和主数据以 FHIR JSON 为权威记录；库存、医保、收银交账、仿真运行等领域以规范化关系表为权威，并生成只读 FHIR 投影。禁止同一事实被两个模型双向修改。
4. **不追求完整 FHIR Search。** 只实现资源能力注册表列出的 SearchParameter canonical，并由 CapabilityStatement 引用同一清单；本服务器首期固定采用严格处理，不支持的参数返回 `OperationOutcome`。
5. **首期只交付 Web 和 SQLite。** standalone Web 与 DSH React Surface 复用同一 Web application interface；Hono 在单个 Node.js 进程中运行，一个本地 SQLite 文件持久化所有业务状态。Desktop、React Native、Cloudflare/D1、PostgreSQL/Supabase 和多实例部署均后置。
6. **仿真能力是一等领域，但评分不是首期基础设施。** 每个 Scenario Run 绑定 Workspace/Epoch、虚拟时钟、不可变 Synthetic Case Instance、私有 Case Truth、Patient Brief、冻结的 Investigation Result Snapshot 和 Action Trace；首期没有 Evaluation Spec、评分规则或 evaluator runtime。
7. **SQLite 是首期真实数据库。** 所有关系约束、迁移、备份恢复、幂等竞争、outbox 恢复和 reset 都在 file-backed SQLite 上验证。未来数据库通过新 adapter 和显式迁移接入，不维护未使用的兼容路径。
8. **一个 Encounter 贯穿首期门诊。** 结构化病历签署拥有独立生命周期，不推进 Encounter；带 Consultation 的病例由独立完诊门禁汇总正式临床事实，首期复诊兼容流仍可在尚无结构化签署根文书时组合签署与完诊。药品支付和发药随后发生，发药完成 Scenario Run，而不是再次推进 Encounter。
9. **Agent adapter 不拥有第二套业务内核。** DSH 拥有模型 Session、transcript、Tool 调度和 Surface 宿主，ClinMesh 拥有 Page Context、前端 action、proposal、人工审阅、共享 Command 和审计关联；`clinmesh` CLI 从业务 Operation Catalog 生成命令树，通过受信 Actor context 调用同一 Query 与 Command。两条入口都不能绕过授权、CAS/expected version、状态机、审计或各自声明的人工确认边界。

## 1. 背景与目标

### 1.1 产品定位

当前消费者包括通过 standalone Web 或 DSH Surface 扮演挂号员、分诊护士、门诊医生、收费员和药师的人类用户，以及通过 `clinmesh` CLI 使用单岗位短期授权的任务 Agent；LIS 作为受控系统 Actor 参与同一 Scenario Run。DSH 原生 Agent 可以读取当前页面状态、导航、填写草稿并准备正式动作，但最终医院 Command 仍由登录人类审阅和提交。任务 Agent 通过显式业务命令和只读 FHIR R5 操作执行 Grant 允许的受限动作。系统应有足够真实的中国医院业务约束，但不复制生产 HIS 的全部工程和监管复杂度。

当前不提供自治 Agent Run、评测或评分。DSH Session 中的交互式 Agent 只通过动态窄 Tools 使用当前人类岗位已有能力；CLI 只适配当前 Query、Command 与 FHIR read/search owner，不增加通用 HTTP、FHIR write 或数据库入口。

### 1.2 必须满足

- 支持普通门诊发热场景所需的患者、组织、科室、挂号、分诊、就诊、检验、处方、药房、收费和病历语义。
- 对外提供版本明确、能力可发现、错误可解析的 FHIR R5 JSON API。
- 为 Web 岗位提供由服务端解析的受信 Actor context 和共享 Command。
- 为 Agent 提供可发现、schema 驱动、可恢复且按岗位授权的完整 HIS CLI。
- 在单个 Node.js 进程中使用 file-backed SQLite，支持显式迁移、备份恢复和容器持久卷。
- 数据规模小、可快速 seed、可创建隔离运行、可重置、可回放。
- 所有数据均为虚构或合成数据，不连接真实医保、支付、短信、邮件、LIS、PACS 或电子票据平台；LIS 与支付均为确定性模拟器。
- 业务写入具备状态机校验、幂等、乐观并发、历史版本和审计。
- 一个 Encounter 覆盖挂号、分诊、首诊、检验和复诊；药品支付与发药在 Encounter 完成后继续推进 Scenario Run。

### 1.3 应当满足

- 前后端和共享契约使用 TypeScript。
- 单 Node.js 进程部署，核心运行不依赖 Redis、微服务或外部队列。
- FHIR current/history/search、领域事实、审计、Action Trace 和 outbox 保存在同一 SQLite 文件。
- 外部模拟器支持成功、拒绝、超时、重复、结果未知等情形。
- 在实际发布对应验证器和定义后，FHIR profile、术语和自定义 operation 可形成版本化的轻量 Implementation Guide。

### 1.4 明确不做

首期不实现：

- 生产级 HIS、真实诊疗、真实费用结算或真实个人健康信息存储。
- Desktop、React Native Mobile、离线写入和多端语义 parity。
- 自治 Agent runtime、模型 runner、AG-UI Gateway thread、MCP、OAuth/SMART Agent 凭证、Evaluation Spec 和评分基础设施；DSH 原生 Session/browser Tool broker 与私有 Capability Grant CLI 是已实现例外。
- Cloudflare Worker、D1、R2、Queues、Cron Trigger、Durable Objects、PostgreSQL、Supabase 和多数据库 adapter。
- 全国各省医保协议的完整兼容。
- 完整 LIS、RIS/PACS、DICOM 归档、手术麻醉、输血、院感、病理、ICU、消毒供应或财务 ERP。
- 完整 FHIR R5 资源集合、完整 Search、Bulk Data、跨库事务或正式合规认证。
- 高并发号源抢占、大规模报表、实时协作编辑和大文件在线处理。
- 图片、PDF、扫描件或其他临床附件；签署文书仅保存受验证的结构化 FHIR JSON。
- 将 OpenHIS 的 124 张核心表和全部扩展模块机械迁移到 SQLite。

## 2. 参考项目评估

### 2.1 OpenHIS 的参考价值

OpenHIS 2.0.5 是 Java 17、Spring Boot、JPA/Hibernate、Flyway 和 PostgreSQL 构建的模块化单体。其价值主要在中国医院业务覆盖，而不是技术实现。

值得保留的业务知识：

- 门诊预约、挂号、到诊、接诊、完诊和取消。
- 住院申请、入科、分床、转床、转科、出院、召回和清床。
- 西药、中药、检查、检验、治疗和耗材医嘱。
- 医嘱草稿、签发、护士校对、执行、停嘱和停嘱校对。
- 门诊与住院发药、汇总摆药、退药、批号、效期和追溯码。
- 挂费、支付、退款、预交金、日结、交账和审批。
- 吉林医保人员查询、费用上传、预结算、结算、撤销、清算和审核。
- 电子病历模板、文书版本、病案首页、质控、归档和借阅。

关键事实可从以下迁移和源码看到：

- `whale-health/health-infrastructure/.../V2__adm_ddl.sql`
- `whale-health/health-infrastructure/.../V3__cln_ddl.sql`
- `whale-health/health-infrastructure/.../V4__fin_ddl.sql`
- `whale-health/health-infrastructure/.../V5__med_ddl.sql`
- `whale-health/health-infrastructure/.../V6__wkf_ddl.sql`
- `whale-module-chs-jilin/.../V1__chs_ddl.sql`
- `health-domain/.../encounter/command/`
- `health-domain/.../medicationrequest/command/`

不应继承的实现：

- 动态扫描全部 `*AppService` 公共方法并注册成统一 POST API。
- 全局 AOP 将所有 AppService 包进默认读写事务。
- `service_table + service_id`、`item_table + item_id` 等任意表名多态引用。
- `charge_item_ids`、`encounter_diagnosis_ids` 等字符串化 ID 集合。
- 业务表之间极少数据库外键，大量状态和关联只能由应用约定维护。
- PostgreSQL 专属数组、JSONB、trigram、函数索引和 Quartz 表。
- 将外部密码、client secret 和私钥作为普通业务表字段。
- 把菜单、类名或表存在误认为业务闭环已经可执行。

OpenHIS 中大量实体使用 FHIR 名称，但仓库没有 FHIR Server 实现。它是“受 FHIR 启发的领域模型”，不是可直接互操作的 FHIR 服务。

### 2.2 Medplum 的参考价值

Medplum 5.1.30 是 TypeScript、Express、PostgreSQL、Redis、BullMQ 和对象存储构成的完整平台，其正式 FHIR API 固定为 R4 `4.0.1`。

值得借鉴：

- FHIR Router 与 Repository 解耦。
- 完整 FHIR JSON 是权威表示，Search 列和 lookup table 是写时索引。
- 当前资源、历史版本、tombstone、ETag 和 `If-Match`。
- CapabilityStatement 根据真实能力生成。
- FHIR Search 先编译为中间表示，再生成参数化 SQL。
- 授权条件与业务查询合并到同一 SQL，而不是查询后过滤。
- SMART scope、项目成员、AccessPolicy 和 compartment 权限求交集。
- Repository 层统一记录 AuditEvent。
- transaction Bundle 的 ID 预分配、本地引用重写和整体回滚语义。
- Agent SQLite durable queue 对 queued、claimed、inflight、failed、ambiguous outcome 的区分。
- MCP FHIR 代理中的同源校验和出站请求 SSRF 防护。

不应照搬：

- 每种 FHIR 资源独立当前表、历史表和多组 PostgreSQL 索引表。
- PostgreSQL UUID 数组、range/multirange、GIN、GiST 和 trigram 查询。
- Redis 缓存、Pub/Sub 和 BullMQ 常驻 worker。
- reader/writer pool、多 shard、savepoint 和复杂事务重试框架。
- AWS/Azure/GCP 部署层和 Node VM Bot 执行环境。
- 允许任意 method、path、body 的全能 `fhir-request` Agent 工具。

结论是借鉴 Medplum 的协议边界、Repository、Search 索引、授权和审计，不移植其物理架构。

## 3. 总体架构决策

### 3.1 模块化单体

沿用[Web Demo 运行与部署架构](demo-architecture.md)的单进程决策，不拆微服务。模块之间只能通过公开应用服务或领域端口交互，不允许跨模块直接查询私有表。

```text
HTTP Adapters
  - React static assets
  - FHIR R5 Router
  - HIS Command Router
  - Simulation Admin Router
          |
Application Layer
  - use-case orchestration
  - auth context and policy checks
  - transaction/write-plan boundary
          |
Domain Layer
  - aggregates and state machines
  - invariant checks
  - deterministic effects
          |
Infrastructure
  - FHIR repository
  - domain repositories
  - file-backed SQLite
  - in-process outbox dispatcher
```

### 3.2 多种 adapter、一个业务内核

| 接口 | 消费者 | 用途 | 是否作为业务权威入口 |
| --- | --- | --- | --- |
| FHIR R5 REST | 标准客户端、集成测试 | 标准资源读取、查询和历史 | 只读互操作面，不是业务写入口 |
| HIS Command API | Web 工作台、内部编排 | FHIR 难以表达的业务聚合和动作 | 是 |
| DSH React Surface + Agent API | DSH Web 原生 Session | 完整 Web 工作台、Page Context、受控前端 action 和 proposal 审阅 | adapter；正式写入仍调用 HIS Command |
| `clinmesh` CLI | 人类运维、任务 Agent、合约测试 | Catalog 发现、HIS Query/Command、只读 FHIR 和 receipt 恢复 | 不是；适配现有 HTTP 与 Command owner |

standalone Web、DSH Surface 和 CLI 最终调用相同的 Query 与 Command handler。当前不发布 FHIR Operation；未来若增加，必须调用同一个 handler，不能复制状态机或在路由层直接写库。后续 MCP 或其他 AG-UI adapter 同样只能调用已有查询与 Command，不成为业务权威入口。

### 3.3 权威数据所有权

系统以四个互不混写的边界拥有数据：本地化的完整 FHIR R4 Bundle 及其 Synthetic Patient Profile Revision 是不可变来源档案；Index Encounter 及其关联资源形成私有 Case Truth；参与者在 ClinMesh 本次就诊中创建的事实属于 operational SQLite 中的本院 FHIR R5 与领域表；全国疾病、药品和检验目录属于独立、全局 Reference SQLite。来源 R4 不复制或转换为本院 R5，参考目录行也不复制进 operational SQLite。

每类对外 FHIR R5 数据必须在资源能力注册表中声明一种所有权：

- `fhir-native`：FHIR JSON 是唯一权威记录。
- `domain-native`：规范化领域表是唯一权威记录，FHIR 是只读投影。
- `simulation-private`：仅 Scenario Runtime 与受控场景维护入口可见，不进入普通 FHIR API；具有 reset 权限不自动获得读取权。

同一个资源不能同时接受 FHIR CRUD 和领域表写入。`owner_kind` 决定 API 写策略。业务 command 可以修改 `fhir-native` 资源，但仍只写 FHIR Resource Store，不另建一份同义领域事实。

当前 ownership 注册表与领域事实：

| 所有权 | 资源/聚合 | 写入方式 |
| --- | --- | --- |
| `fhir-native` | Patient、AllergyIntolerance、Organization、Location、Practitioner、PractitionerRole、Encounter、Task、Account、ChargeItem、Observation、ServiceRequest、Specimen、DiagnosticReport、Condition、Medication、MedicationRequest、MedicationDispense | 只由 Case 开始或业务 Command 创建和更新；FHIR API 只读 |
| `fhir-native-immutable` | 已签署的 Composition、document Bundle、Provenance | 业务 Command 只创建新资源；更正创建显式修订关系，不覆盖已签实例 |
| `domain-native` | Workspace Actor、Agent Client/Grant、Synthetic Patient Profile 与 Profile Revision、Synthetic Case Instance、Patient Brief Revision、Investigation Result Snapshot、Consultation 与 Consultation Record、Registration、Diagnosis Draft 与 Diagnosis Confirmation、Prescription、PaymentTransaction、库存账、临床草稿、Scenario Run、Action Trace、audit_log | 只通过 `/api/agent/v1`、`/api/his/v1`、`/api/sim/v1` 或内部 Command 写入 |
| `domain-projection` | AuditEvent、InventoryItem | 从领域事实同事务生成；FHIR API 只读 |
| `simulation-private` | Index Encounter、Case Truth、隐藏来源资源和生成模型输入 | 仅 Simulator 内部解析器可访问；普通 HIS、FHIR、来源历史详情和角色 Agent 均不可读取 |

账务边界特别约定：Account、ChargeItem、Invoice 是标准交换事实并保存在 FHIR Resource Store；实际收款、退款、医保基金分配和收费员交账由领域账务表负责。两者通过明确引用关联，不把“账单”和“支付流水”混成一个资源。

### 3.4 部署拓扑

首期硬依赖只有浏览器、一个 Node.js 服务端进程和一个本地文件系统上的 SQLite 文件。开发环境可以让 Vite 单独提供静态资源并代理 API；可部署构建由 Node.js 服务同时提供静态资源、SPA fallback、HTTP API 和 FHIR API。

数据库文件必须放在提供 SQLite 锁语义的本地磁盘或单实例容器持久卷中。首期不支持多个服务实例或多个进程同时写入同一文件。outbox dispatcher 与服务同进程，但待处理状态必须持久化；正确性不能依赖内存 timer 或进程持续存活。

D1、PostgreSQL 或 Supabase 只在出现公开托管、多实例、持续写竞争或独立运维需要时重新评估。迁移时新增真实 adapter 与迁移工具，不修改业务 Command contract 来迁就数据库。

### 3.5 深模块与 seam

模块的 interface 同时是调用者和测试的主要表面，必须包含输入、状态前置条件、错误、幂等和顺序约束；HTTP/FHIR adapter 不暴露内部 repository 或状态机细节。

当前深模块：

- `IdentityService`：隐藏 Better Auth、Membership、Agent Client、Agent Capability Grant、岗位选择与 active Workspace/Epoch 解析，向调用者返回受信 Actor context。
- `CommandExecutor`：以受信 context 执行强类型 Command，内部隐藏事务、幂等、expected version、审计、Action Trace 和 Effect receipt。
- `FhirRepository`：提供内部创建/更新与公开 read、history、受控 search；首期只有 SQLite 实现，不伪造第二数据库 adapter。
- `ScenarioDataService`：拥有 Synthea 生成任务、Profile/Case 原子创建、患者库与来源历史授权读取。
- `ScenarioService`：拥有 building/active Epoch 切换与 reset/replay 协调；病例物化委托给共享 Workflow 内核。
- `WorkflowService`：拥有 Case direct start、首期门诊状态转换、预览 token、支付/LIS/文书/药房规则和岗位读模型。
- `AgentIntegrationService`：隐藏 Page Context 签发、execution proof 校验、防重放、proposal/review 生命周期以及 Tool call 到 Command/Audit/Trace 的关联。
- `OutboxRepository` 与 `OutboxDispatcher`：隐藏 claim/lease/retry/ambiguous/abandoned 恢复协议。

当前没有通用 `PolicyEvaluator`、`ExternalOperationPort`、checkpoint/replay Runtime 或独立领域包；未来只有出现第二个实际策略/外部系统/数据库消费者时才提取相应 interface。

删除任一模块时，其复杂度应重新散落到多个调用者，说明模块确实提供 leverage；只做参数透传的浅模块应合并。

## 4. 领域边界

| 领域 | 主要职责 | 权威模型 | 首期 |
| --- | --- | --- | --- |
| Identity & Access | Web 用户、岗位、Workspace Membership、会话和策略 | 关系表 + Better Auth | 必须 |
| Workspace & Simulation | Profile/Case 生成、Scenario Run、隔离、时钟、Case Truth、Brief、Investigation Snapshot、Action Trace 和管理员重放 | 领域表 + 私有 Case Store | 必须 |
| Virtual Patient | 版本固定的合成病例表现、可接诊状态与医生接诊映射 | 可见状态 domain native；隐藏事实 simulation private | 必须 |
| Organization & Workforce | 医院、科室、病区、诊室、床位、人员、岗位 | FHIR native | 必须 |
| Terminology | 全局 Reference Release、搜索与业务 coding/display 快照 | 独立 Reference SQLite + domain snapshot | 必须 |
| Patient Identity | 患者、标识、联系人、合并 | FHIR native + 唯一性辅助表 | 必须 |
| Registration & Queue | 持久挂号、候诊与岗位工作队列 | Registration domain native；Task FHIR native | 必须 |
| Encounter | 一个普通门诊 Encounter 的分诊、首诊、检验、复诊和完诊 | FHIR native | 必须 |
| Clinical Ordering | 检验请求、药品请求和签发 | FHIR native + Task | 必须 |
| Prescription | 处方号、药品请求归组、审核、收费与调剂边界 | domain native | 必须 |
| Medication & Pharmacy | 药品目录、最小库存移动、调剂和发药 | FHIR native + domain native 库存 | 必须 |
| Clinical Results | 生命体征、标本、结构化检验结果和报告 | FHIR native | 必须 |
| EMR & Medical Record | 草稿编辑、结构化 FHIR 文书签署和修订 | 草稿 domain native；签署件 FHIR native | 必须 |
| Charging & Billing | Account、ChargeItem、支付及费用分配 | Account/ChargeItem 为 FHIR native；支付为 domain native | 必须 |
| Insurance Simulation | 人员查询、上传、结算、撤销 | domain native | 后续 |
| Inventory | 首期最小发药移动；完整批号、效期、盘点和调拨 | domain native | 最小子集 |
| Integration & Outbox | 模拟 LIS 与支付调用、恢复和幂等 | domain native | 必须 |
| Audit & Provenance | 安全审计、事实来源和 Action Trace 引用 | audit_log 为 domain native 并投影 AuditEvent；Provenance 为 FHIR-native 新事件 | 必须 |
| Agent Integration | DSH React Surface、Page Context、窄 Tools、proposal/review/execution proof，以及 CLI、Operation Catalog、Capability Grant 与领域 Skills | Web action 和现有 Query/Command/FHIR read 的 adapter | 必须 |

## 5. FHIR R5 策略

### 5.1 版本决策

统一基路径：

```text
/fhir/R5
```

FHIR API base 是部署 origin 下的 `/fhir/R5`。CapabilityStatement、当前本地 identifier/extension URL 以及未来可能发布的 IG、Profile、ValueSet、CodeSystem、SearchParameter 和 OperationDefinition 共用固定 canonical base：

```text
https://caizongyuan.github.io/clinmesh/fhir
```

Canonical URL 是定义身份，不要求该地址承担运行中 API。`CapabilityStatement.fhirVersion` 固定为 `5.0.0`。一个端点内禁止混用 R4、R4B 和 R5 资源。

选择 R5 的理由：

- 它是当前最新已发布稳定版本，符合为未来 Agent 工具建立长期标准契约的目标。
- 相比 R4，R5 在 workflow、subscription、medication、inventory 和 financial 等领域继续演进。
- 仿真系统没有既有 R4 客户端包袱，可以避免先建 R4 再整体迁移。

代价与应对：

- Medplum 和多数成熟生态仍以 R4 为主：只借鉴实现模式，不使用 `@medplum/fhirtypes` 作为本项目 R5 契约。
- CN Core 公开参考主要是 R4：提取中国语义和术语要求，在本项目 R5 IG 中重新定义，不宣称直接兼容 CN Core R4。
- 若未来必须接入 R4，在独立 `/fhir/R4` adapter 做显式版本转换；转换必须有测试并标记信息损失，不能让 R4 写入绕过 R5 业务命令。

### 5.2 只声明真实能力

当前提供：

- `GET /fhir/R5/metadata`
- `GET /fhir/R5/{ResourceType}/{id}`
- `GET /fhir/R5/{ResourceType}/{id}/_history/{vid}`
- `GET /fhir/R5/{ResourceType}/{id}/_history`
- `GET /fhir/R5/{ResourceType}?search-params`

资源能力注册表中的每种资源只声明 `read`、`vread`、`history-instance` 和 `search-type`。当前注册 Patient、AllergyIntolerance、Organization、Location、Practitioner、PractitionerRole、Encounter、Task、Account、ChargeItem、Observation、ServiceRequest、Specimen、DiagnosticReport、Condition、Medication、MedicationRequest、MedicationDispense、Composition、Bundle、Provenance、InventoryItem 和 AuditEvent。

逐资源 SearchParameter 白名单见 5.5 节。所有资源共享 `_count`、`_cursor` 和 `_total=none|accurate` 三个结果控制参数。

首期不声明：

- FHIR `POST`、通用 `PUT`、`PATCH` 或 `DELETE`
- 自定义 FHIR Operation
- conditional create/update、`HEAD`、`_format` 或 `Prefer: return=`
- system history
- Bulk Data export
- GraphQL
- 全资源 transaction Bundle
- 任意条件 delete
- 任意 `_include:iterate` 或无限 chained search
- XML

`CapabilityStatement` 从资源能力注册表生成，不能手写一份与实现漂移的静态 JSON。当前注册表逐资源记录 ownership、interaction 和实际 SearchParameter canonical；尚未实现的 profile、terminology、conditional interaction、custom operation 或 reference target 约束不进入 metadata。

### 5.3 资源映射

#### 5.3.1 直接作为 FHIR native

下表是领域到 FHIR R5 的架构映射，不是当前 CapabilityStatement 清单。只有 5.2 节列出的资源和 interaction 可由当前 FHIR API 访问；其他映射在对应业务实现并加入同一能力注册表后才构成公开能力。

| 中国 HIS 概念 | FHIR R5 资源 | 说明 |
| --- | --- | --- |
| 患者主索引 | `Patient` | 院内患者号、MPI 号等身份标识使用 Patient.identifier；门诊号、住院号、病案号按真实业务主体建模 |
| 联系人/监护人 | `RelatedPerson` 或 `Patient.contact` | 需要独立权限时用 RelatedPerson |
| 医院、科室、病区组织 | `Organization` | 科室类型用 profile 和本地 CodeSystem |
| 诊室、病区、床位、药房、库房 | `Location` | 用 `partOf` 形成层级 |
| 医务人员 | `Practitioner` | 工号、医保人员编码、资格证使用 identifier/qualification |
| 岗位及科室分配 | `PractitionerRole` | 替代 OpenHIS `adm_pr_assign` |
| 医疗服务 | `HealthcareService` | 普通门诊、专家门诊、检查服务等 |
| 排班 | `Schedule` | actor 指向 PractitionerRole、Location 或 HealthcareService |
| 号源 | `Slot` | 容量扩展和并发计数由辅助表维护 |
| 预约 | `Appointment` | 不再与候诊队列混为一表 |
| 候诊/受控执行任务 | `Task` | 候诊 Task 的 `focus` 指向 Encounter；独立检验执行 Task 的 `focus` 指向 ServiceRequest |
| 门诊/住院就诊 | `Encounter` | 门诊和住院主要由 class、type、serviceType、profile 和业务上下文区分 |
| 疗程 | `EpisodeOfCare` | 跨多次就诊的照护周期 |
| 诊断 | `Condition` | Encounter.diagnosis 引用 Condition |
| 过敏 | `AllergyIntolerance` | 不作为普通 Observation |
| 生命体征/检验结果 | `Observation` | 数值、单位和参考范围必须结构化 |
| 报告 | `DiagnosticReport` | result 引用 Observation |
| 操作/治疗执行 | `Procedure` | 与 ServiceRequest 关联 |
| 检查、检验、治疗医嘱 | `ServiceRequest` | 业务校对由 Task/Operation 表达 |
| 药品医嘱 | `MedicationRequest` | 一种药一个资源 |
| 本次请求编排 | `RequestOrchestration` | 表达一组请求或建议之间的组合、选择、条件和顺序；intent/status 与所引用请求一致，不等同组套模板或处方单据 |
| 药品产品 | `Medication` | 可被请求或发放的药品定义/产品，不默认等同具体库存批次 |
| 药品知识 | `MedicationKnowledge` | 限制、规则、包装和知识属性 |
| 发药 | `MedicationDispense` | 引用 MedicationRequest；实际批次在调剂时确定，部分/多批次发药可形成多个 Dispense |
| 用药执行 | `MedicationAdministration` | 一次实际或未发生的给药事件，与发药和执行计划不是同一事实 |
| 耗材申请/发放 | `DeviceRequest`、`DeviceDispense` | 仅表达临床申请与发放 |
| 标本 | `Specimen`、`SpecimenDefinition` | 与 ServiceRequest、Observation 关联 |
| 收费目录/费用 | `ChargeItemDefinition`、`ChargeItem` | 挂费由业务命令产生 |
| 费用归集上下文 | `Account` | 关联费用归集范围，不作为自费/医保资金账本 |
| 账单 | `Invoice` | 向付款方汇总的账单，不等同中国财政电子票据或税务发票 |
| 临床文书 | `Bundle`、`Composition` | 签署件发布为 `Bundle.type=document`，首 entry 为 Composition；后续修订创建新业务资源，首期不包含附件 |
| 数据来源 | `Provenance` | 谁生成/修改了哪些资源 |
| 安全访问事件 | `AuditEvent` | 与 Provenance 职责不同 |
| 模板/表单 | `Questionnaire`、`QuestionnaireResponse` | 病案首页补充字段可采用 profile |
| 本地术语 | `CodeSystem`、`ValueSet`、`ConceptMap` | 显式版本化 |

#### 5.3.2 后续 FHIR Profile/Extension 边界

适合扩展的事实必须满足：主体仍是一个标准 FHIR 资源，只是缺少中国场景字段。

典型扩展：

- 患者民族、证件类型、临时建档标记和院内标识用途。
- 挂号号别、初复诊、医保医疗类别、就诊渠道。
- 科室、病区、护理单元和床位的本地分类。
- 长期/临时医嘱、护士校对、停嘱校对和首日执行次数。
- 中药饮片剂数、煎法、代煎、服法和处方分组。
- 药品五类单位换算、批准文号、国家药品编码、医保编码和限制等级。
- 号源容量、渠道配额和超售策略。
- 病案首页的国家上报字段。
- 电子票据号码和平台状态。

规则：

1. extension 使用稳定 canonical URL，不使用部署域名动态生成。
2. canonical 根在实现前确定，例如 `{canonicalBase}/StructureDefinition/...`，一经发布不可随环境变化。
3. extension 有明确 value[x] 类型、基数、上下文和 ValueSet 绑定。
4. 会改变资源或元素解释的内容才允许 `modifierExtension`；处理者不能理解时，不得依赖受影响内容作临床或业务决策，服务器的拒绝策略由 profile 明确。
5. 不得用一个巨大 JSON extension 装载完整业务对象。
6. 不得新增非 FHIR status code；本地子状态放 `businessStatus`、extension 或独立 Task。
7. 对要求遵循项目 profile 的写入，服务器按对应 profile 校验，并可在 `meta.profile` 记录 canonical URL。`meta.profile` 是一致性声明，不是验证结果，不能机械加到所有外部资源。

当前没有发布项目 Profile 或 IG，也不在 CapabilityStatement 中宣告 profile conformance。运行时只验证最小 FHIR resource envelope 和业务 Command 的窄 schema；上述规则约束后续定义与当前已使用的本地 extension，不等于正式 Profile 验证。

签署临床文书的业务实例不可原地覆盖。每个病例最多有一个签署根文书，后续更正或修订只能从最新版本创建新的 document Bundle、Composition 和 Provenance，并通过 `Composition.relatesTo` 表达 `replaces`。FHIR `_history` 只记录同一 logical id 的服务器版本，不作为临床修订链、Provenance 或 AuditEvent 的追加机制；结构化病历历史从 Composition 的稳定编码 section 重建，不在关系表复制正文。

#### 5.3.3 不强行映射为 FHIR CRUD

| 业务 | 处理方式 | 可选 FHIR 投影 |
| --- | --- | --- |
| 医保 11xx/22xx/23xx/31xx/32xx 等协议调用 | `/api/his/v1/insurance/*` 命令 + 原始快照 | 仅在语义成立时投影 Coverage、Claim、ClaimResponse、EOB |
| 医保签到、会话、游标和平台调用日志 | 领域表 | AuditEvent/Task 摘要 |
| 收银支付、现金补差、退款和结果未知 | PaymentTransaction 领域聚合 | Invoice、Account；只有付款方通知收款方已付款时才用 PaymentNotice |
| 收费员日结/交账/审批 | CashierShift 领域聚合 | Task 或 DocumentReference 摘要 |
| 药库采购、入库、调拨、盘点、损益 | Inventory ledger | InventoryItem、SupplyRequest、SupplyDelivery |
| 库存锁定、批号余额和追溯码拆零 | Inventory 领域表 | InventoryItem 只读投影 |
| EMR 编辑器实时草稿和模板布局 | EMR 领域 API | 签署后发布 Composition/DocumentReference |
| 打印模板和打印审计 | Print 领域 API | AuditEvent/DocumentReference |
| Case Truth 与隐藏来源资源 | Simulation private API | 不进入普通 FHIR、HIS 或历史详情 |

FHIR `Basic` 不是默认逃生口。只有概念确实没有资源、无需复杂行为且短期只需交换时才考虑，并应优先定义正式 profile 或本地 API。

医保投影必须遵守资源原义：Coverage 表达保障资格，不表示一次人员查询；Claim 表达向付款方提出的费用申报；ClaimResponse 表达付款方裁决；ExplanationOfBenefit 是面向受益人的裁决结果表达，不是接口调用日志。签到、查询、上传批次、游标、重试和原始报文不得机械转换为 Claim 系列资源。一次结算、多次申报、撤销和重结算之间使用稳定 identifier 和明确 replacement 关系。

### 5.4 中国术语与参考数据策略

独立 Reference SQLite 通过显式 CLI 一次性导入和验证版本固定的疾病、药品与检验来源。每个成功发布的 Reference Release 固定来源版本、许可、artifact checksum、记录数、导入诊断和 content hash；失败导入不改变当前 Release。Server 只读打开一个系统级全局当前 Release，使用索引和 FTS 为疾病、药品、检验提供有界分页搜索，不把全国目录载入内存或复制进 Workspace、Epoch 和 operational SQLite。医生打开选择器时默认浏览稳定排序的第一页；显式提交的两字符查询使用只读 substring 检索，至少三个字符时使用 trigram FTS，并从第一页开始。Reference 不可用或无查询目录为空时才回退到本院常用项。

目录搜索返回稳定的 `system + version + code + display`。诊断、医嘱等本院 R5 业务事实在创建时保存所选 coding/display 快照，因此切换全局当前 Release 不会改写既有病历。Synthea R4 来源 coding 仅用于呈现 Visible Source History 和解析同 LOINC 的隐藏 Observation；不以显示文本匹配，不建设 Synthea 到本院疾病或药品目录的通用映射。

检验目录保存值类型、LOINC 和 UCUM 单位；参考范围来自项目 metadata 或版本固定的 LOINC 本院检验映射。全局 Reference 搜索只表达项目定义；医生开立前通过病例级检验目录读取 Investigation Generation Capability。完全相同的 LOINC system 与 code 能命中 Case Truth Observation 时使用 `synthea-exact`；未命中时，只有数值项目具备 UCUM 单位与受控合成参考范围且运行时配置了受限 Investigation Agent 才标记为 `investigation-agent` 可生成。Agent 输入最多包含最近 20 条 Visible History 和 20 条相关 Case Truth 证据。Web 展示查询结果，但只允许选择 capability 支持的项目，开具后的 ServiceRequest 与执行 Task 属于本院运行事实。两种成功路径都形成不可变 Investigation Result Snapshot；不得为缺少证据、生成 profile 或运行能力的项目制造正常 fallback。

当前不发布 CodeSystem、ValueSet、ConceptMap 或 terminology operation；术语是接口兼容性的一部分，不是 UI 字典。

至少维护：

- 院内患者标识、就诊类型、科室类型、床位状态、队列状态。
- 中国身份证件类型、行政区划、民族、职业等基础编码。
- 中国临床版 ICD-10、手术操作编码及本地诊断目录。
- 药品国家编码、批准文号、剂型、用法、频次、单位和医保目录编码。
- 医疗服务、收费项目、医保医疗类别、险种和基金类别。
- 中医疾病、证候、治法和煎服法。

实现原则：

- FHIR 绑定使用 canonical URL + version，不只保存 display；每个 coded 元素明确 `required`、`extensible`、`preferred` 或 `example` binding strength。
- 外部编码映射键必须包含 `system + version + code`；相同 code 不得跨 system 碰撞，显示文本不得作为正式映射 fallback。
- 数值单位转换由审核映射明确保存源 UCUM code、目标 UCUM code 与换算因子；不允许只替换单位标签而不转换数值。
- 院内码、国家码、医保码只有在表达同一个语义概念时才可并列于同一个 `CodeableConcept.coding`；属性、分类和价格目录号不得混入同一概念。
- 本地到国家/医保编码映射使用 `ConceptMap`，不在业务代码中写 switch；ConceptMap 不代表映射天然无损、双向或可自动应用。
- 编码导入保留来源、版本、生效期和停用状态；运行时区分未知 code、inactive code、版本不匹配和 display 不一致。
- 若 CapabilityStatement 宣告 `$validate-code`、`$expand`、`$lookup` 或 `$translate`，实现必须满足所声明的范围；首期做不到就不宣告 terminology operation。
- 对有许可限制的术语，只提交合法的最小演示子集或生成的虚构术语，不把未授权全量码表放入仓库。

### 5.5 FHIR Search 最小实现

每个受支持参数必须引用一个 R5 `SearchParameter` canonical 定义。标准参数采用 R5 定义；项目自定义参数在 IG 中发布固定 `url`、`version`、`base`、`code`、`type`、`expression`、target 以及 modifier/chain 范围。CapabilityStatement 的 `rest.resource.searchParam.definition` 引用该 canonical，并只声明真实实现的参数；不得从 profile 字段名自行猜测搜索语义。

实现前维护逐资源矩阵：`ResourceType + SearchParameter.code + canonical URL + modifier + chain + sort support`。`patient`、`subject`、`encounter` 等不是跨所有资源的自动同义词；日期参数也必须使用对应 R5 SearchParameter 的真实 code。

当前通用结果控制参数：

- `_count`，默认 20，上限 100
- `_cursor`，服务端签名的 keyset cursor
- `_total=none|accurate`；默认 `none`，首期不伪造 `estimate`

当前业务 SearchParameter：

- Patient `name`：NFKC 归一化、小写化后的前缀匹配。
- Patient `identifier`：归一化后的精确匹配。
- `patient` 精确引用匹配：AllergyIntolerance、Condition、Encounter、Task、Account、ChargeItem、Observation、ServiceRequest、Specimen、DiagnosticReport、MedicationRequest、MedicationDispense 和 Composition。
- `encounter` 精确引用匹配：Condition、ChargeItem、Observation、ServiceRequest、DiagnosticReport、MedicationRequest、MedicationDispense 和 Composition。
- Task `focus`：接受 Encounter 或 ServiceRequest 引用。
- MedicationDispense `prescription`：只接受 MedicationRequest 引用。
- Provenance `target`：接受 Bundle、Composition、Condition、DiagnosticReport、Encounter、Observation、ServiceRequest、Specimen 或 Task 引用。

reference 参数只索引本地相对引用。资源写入时 Repository 按 registry 中的路径和 target 校验引用格式、目标资源类型以及当前 Workspace/Epoch 中的目标存在性；任一引用失败会使包含它的 Command 整体回滚。

约束：

- 使用 HMAC 签名的 keyset cursor，不暴露数据库 offset。cursor 绑定 Workspace、Epoch、resource type、规范化查询 hash、`lastUpdated` 排序键、resource ID tie-breaker 和五分钟有效期；客户端不得解析或跨上下文重放。
- 明确分页是弱一致 keyset 语义：并发更新可能造成重复或遗漏，客户端按 resource id/version 去重；需要快照语义的评测使用 checkpoint。
- 当前不实现 modifier、chain、`_include`、`_revinclude`、`_has`、`_sort`、`_summary`、`_elements` 或任意 FHIRPath filter。
- 本服务器首期固定使用严格搜索处理：未知参数、未知 modifier 和不支持的组合返回 `400 OperationOutcome`；不支持 `Prefer: handling=lenient`。这是本服务器策略，不宣称是规范唯一允许行为。
- 授权过滤必须参与 SQL，而不是拿到结果后再过滤。
- Bundle link 返回可直接调用的完整 `self` 和 `next`，Agent 只能跟随服务端给出的同源 URL。
- `_total=accurate` 只在受控查询中计算并返回 `Bundle.total`；默认 `none` 时不返回 total。

### 5.6 版本与并发

每个 FHIR 资源具有：

- `meta.versionId`：在同一 resource type + logical id 内单调递增的整数，以字符串表示；它不是业务修订号。
- `meta.lastUpdated`：真实提交时间，不使用虚拟业务时间替代。
- 业务发生时间：写入各资源对应时间字段，来自 simulation clock。

HTTP 行为：

- read 与 vread 返回 `ETag: W/"{versionId}"`；当前不返回 `Last-Modified`。
- 业务 Command 的 expected version 在应用层验证，冲突返回稳定应用错误；FHIR API 不提供更新入口或 `If-Match` 写语义。
- 对任意注册资源的 generic `PUT` 返回 `405 OperationOutcome`，并提示使用 owner Command；未注册资源同样返回 `405 OperationOutcome`。
- 当前不提供 FHIR `POST`、`PATCH` 或 `DELETE`，也不创建 tombstone。
- 资源实际内容未变化时不创建新版本。
- expunge 不属于首期公开能力。

### 5.7 校验与 Implementation Guide

当前仓库没有 SUSHI 工程、生成的 IG package 或官方 FHIR Validator 流程。`packages/contracts` 的 Zod schema 只验证 Resource 基础 envelope、CapabilityStatement、Bundle 和 OperationOutcome 的当前 wire shape；临床、支付、库存和引用不变量由拥有它们的 Command 验证。

Server 合约测试保存了一组覆盖首期资源类型的合成 R5 示例实例，并通过当前运行时 schema 验证。这些 fixture 是可执行的接口示例，不是 StructureDefinition、正式 Profile、IG package 或官方 Validator 的验证证据。

Scenario 创建的 Patient 使用固定 `synthetic-data` extension 标记合成数据。这是稳定的本地 canonical URL，但当前服务器没有发布对应 StructureDefinition，也不宣称该资源通过项目 Profile 校验。

后续只有在仓库同时交付 FSH/StructureDefinition、固定版本的生成包、官方 Validator 合约测试和运行时所需校验后，才能在 CapabilityStatement 中加入 `profile` 或 `supportedProfile`。TypeScript 类型与 `meta.profile` 本身都不能证明 profile conformance。

## 6. 接口设计

### 6.1 路径规划

`docs/demo-architecture.md` 中“业务 API 使用 `/api`”继续适用，但 FHIR 标准端点作为明确例外使用独立根路径。

| 路径 | 说明 |
| --- | --- |
| `/fhir/R5/*` | FHIR R5 |
| `/api/his/v1/*` | 非 FHIR 领域命令和查询 |
| `/api/sim/v1/*` | 合成患者生成、Case/Brief 管理、Scenario Run 查询和管理员 reset/replay |
| `/api/auth/*` | Web 登录、注销、会话和岗位上下文 |
| `/api/agent/v1/page-contexts` | 从白名单 claim、DSH Session 和 client revision 签发短期受信 Page Context |
| `/api/agent/v1/tool-calls` | 用 DSH execution proof 与 context token 授权一次 Tool call |
| `/api/agent/v1/tool-calls/review` | 在正式 Command 前记录并线性化当前人类的 proposal 决定 |
| `/api/agent/v1/tool-calls/result` | 完成 Tool call，并关联 proposal、review、Command、Audit 与 Trace |
| `/api/agent/v1/clients*`、`/api/agent/v1/grants*` | human-admin 管理 Agent Client/Grant，以及 Agent 读取受信 context |

当前路由表不包含通用 `/api/tools/v1`、`/mcp`、SMART discovery 或 Agent OAuth 端点。`/api/agent/v1` 同时拥有私有 Agent Client/Grant 控制面和同源 DSH Surface 的 Page Context/调用关联，不是开放 Tool Gateway；后续增加传输协议时按实际实现的版本和能力扩展，不能提前发布空路由或虚假元数据。

### 6.2 FHIR 写入策略

当前 FHIR API 是只读互操作面。所有注册资源都拒绝 generic write；`PUT /fhir/R5/{ResourceType}/{id}` 明确返回 `405 OperationOutcome`，其他 FHIR 写 method 没有路由。内部写权限仍按 owner 分开：

| 写策略 | 资源示例 | 行为 |
| --- | --- | --- |
| Command-owned FHIR native | Patient、Encounter、Observation、ServiceRequest、MedicationRequest、MedicationDispense 等 | Case 直接开始或拥有该状态变化的业务 Command 可创建/更新，HTTP FHIR API 只读 |
| Read-only projection | AuditEvent、InventoryItem | 领域 Command 同事务投影，generic FHIR write 被拒绝 |
| 业务不可变 | 已签署文书 Bundle/Composition、Provenance | 更正创建新的 logical resource 与修订关系，不能覆盖已签业务实例 |
| Hidden | Case Truth、隐藏来源资源、内部 command receipt 和 Action Trace | 普通 FHIR API 不暴露 |

### 6.3 后续自定义 FHIR Operation

当前不提供或宣告自定义 FHIR Operation。未来业务主体明确对应某个 FHIR 资源时，可优先定义 OperationDefinition：

```text
POST /fhir/R5/Appointment/{id}/$check-in
POST /fhir/R5/Encounter/{id}/$start-reception
POST /fhir/R5/Encounter/{id}/$assign-bed
POST /fhir/R5/Encounter/{id}/$transfer-department
POST /fhir/R5/Encounter/{id}/$discharge
POST /fhir/R5/MedicationRequest/{id}/$sign
POST /fhir/R5/MedicationRequest/{id}/$verify
POST /fhir/R5/MedicationRequest/{id}/$stop
POST /fhir/R5/MedicationRequest/{id}/$verify-stop
POST /fhir/R5/MedicationRequest/{id}/$dispense
```

发药 Operation 以待满足的 MedicationRequest、处方组或药房 Task 为输入，成功后创建一个或多个 MedicationDispense，并通过 `authorizingPrescription` 回指请求。部分发药、多批次和多次发药不能被一个含糊占位资源掩盖；只有已经存在且处于 `preparation` 的 MedicationDispense 才可定义实例级完成操作。

每个 OperationDefinition 明确 `system`、`type`、`instance` 适用层级、`affectsState`、输入输出基数、profile 和错误语义。定义前先检查 R5 标准 operation；修改状态只允许 POST。跨 Account、多个 Invoice/ChargeItem、医保和患者支付的结算使用 HIS command，不随意挂在一个 Invoice 实例上。

输入和输出使用 `Parameters`，但内部立即转换为强类型 command。Operation 名称、输入、输出、幂等和错误在 IG 中发布。

### 6.4 HIS Command API

FHIR 没有稳定等价物的聚合使用显式 API。当前写路由为：

```text
POST /api/his/v1/patients
POST /api/his/v1/registrations/actions/register
POST /api/his/v1/doctor/virtual-patients/{id}/actions/start
POST /api/his/v1/encounters/{id}/actions/ask-consultation-question
POST /api/his/v1/encounters/{id}/actions/record-triage
POST /api/his/v1/encounters/{id}/actions/start-first-visit
POST /api/his/v1/encounters/{id}/actions/start-revisit
PUT  /api/his/v1/encounters/{id}/drafts/first-visit
PUT  /api/his/v1/encounters/{id}/drafts/revisit
PUT  /api/his/v1/encounters/{id}/diagnosis/draft
POST /api/his/v1/encounters/{id}/diagnosis/actions/confirm
PUT  /api/his/v1/encounters/{id}/prescription/draft
DELETE /api/his/v1/encounters/{id}/prescription/draft
POST /api/his/v1/encounters/{id}/prescription/actions/issue
POST /api/his/v1/encounters/{id}/medication-conclusion/actions/confirm-no-medication
PUT  /api/his/v1/encounters/{id}/clinical-document/draft
PUT  /api/his/v1/encounters/{id}/laboratory-request/draft
DELETE /api/his/v1/encounters/{id}/laboratory-request/draft
POST /api/his/v1/encounters/{id}/laboratory-request/actions/issue
POST /api/his/v1/laboratory-requests/{id}/actions/cancel
POST /api/his/v1/encounters/{id}/actions/issue-laboratory-order
POST /api/his/v1/encounters/{id}/actions/preview-sign
POST /api/his/v1/encounters/{id}/actions/sign-and-complete
POST /api/his/v1/encounters/{id}/clinical-document/actions/preview-sign
POST /api/his/v1/encounters/{id}/clinical-document/actions/sign
POST /api/his/v1/encounters/{id}/actions/complete
POST /api/his/v1/clinical-documents/{compositionId}/actions/revise
POST /api/his/v1/payments/actions/preview
POST /api/his/v1/payments/{previewId}/actions/confirm
POST /api/his/v1/prescriptions/{prescriptionId}/actions/withdraw
POST /api/his/v1/prescriptions/{prescriptionId}/actions/dispense
POST /api/sim/v1/scenario-runs/{id}/actions/reset
GET  /api/sim/v1/scenario-providers
POST /api/sim/v1/scenario-generation-jobs
GET  /api/sim/v1/scenario-generation-jobs/{id}
GET  /api/sim/v1/synthetic-patients
GET  /api/sim/v1/synthetic-patients/{id}
GET  /api/sim/v1/synthetic-cases/{id}/history
GET  /api/sim/v1/synthetic-cases/{id}/history/detail?sourceReference=...
POST /api/sim/v1/synthetic-cases/{id}/patient-brief-jobs
GET  /api/sim/v1/patient-brief-jobs/{id}
GET  /api/sim/v1/synthetic-cases/{id}/patient-brief-revisions
PUT  /api/sim/v1/synthetic-cases/{id}/patient-brief-revisions/active
POST /api/his/v1/synthetic-cases/{id}/actions/start-outpatient-visit
```

`GET /api/his/v1/doctor/virtual-patients` 按 `page/pageSize` 分页，只返回当前 Workspace/Epoch 中仍可接诊的 Virtual Patient 名称、性别、出生日期、临床可见摘要、协议 ID 和固定长度的 opaque `version`。姓名、性别和出生日期读取自绑定的 `fhir-native` Patient，Virtual Patient 领域表不重复保存 Patient Identity；响应不返回 Patient logical ID、Case Truth、病原体、运行时状态、底层资源引用或确定性回答规则。`version` 的绑定和冲突语义由[门诊闭环](#81-门诊闭环)定义。

Command 写请求使用同源 session 与 CSRF 校验，并通过以下 header 提供幂等键：

```http
Idempotency-Key: 018f...
```

Workspace、Epoch、Scenario Run、Actor 和 Acting Practitioner Context 只从服务端 session 或 Agent Capability Grant 解析。幂等 receipt、预览 commit token、audit、cursor 和 outbox 只使用服务端解析值；请求体不接受客户端自报的 Actor、Practitioner、Practitioner Role、Workspace 或 Epoch。

命令请求包含：

```json
{
  "expectedVersions": {
    "Encounter/018f...": "7",
    "MedicationRequest/018e...": "3"
  },
  "input": {}
}
```

`virtual-patient.start-consultation` 的公开 `expectedVersions` 固定为空对象，`input.expectedVersion` 提交列表返回的 opaque `version`。服务端从该引用恢复依赖版本后再进入 `CommandExecutor`；客户端不能读取或覆盖底层 dependency set。

`consultation.ask-question` 在 `expectedVersions` 中提交当前 Encounter 和医生 Task 版本，并在 `input` 中提交 Consultation expected version 与受控问题代码。成功追加一轮不可变记录并递增 Consultation 版本；相同幂等键重放原回执，旧版本返回稳定冲突。病例详情只返回可选问题的代码和文本、有序问答记录及当前 Consultation 版本，不返回 Patient Brief 的隐藏 answer points 或 Case Truth。

成功响应包含：

```json
{
  "data": {},
  "effects": [
    { "kind": "updated", "reference": "MedicationRequest/018e...", "versionId": "4" },
    { "kind": "created", "reference": "Task/018d...", "versionId": "1" }
  ],
  "warnings": [],
  "requestId": "req-...",
  "auditId": "audit-..."
}
```

错误使用稳定错误码。FHIR 端点返回 OperationOutcome；HIS 端点使用统一错误 envelope，不把堆栈和内部 SQL 返回给客户端。后续 Tool Gateway 只能映射这两类既有错误。

### 6.5 Idempotency

Web mutation、outbox dispatcher 和模拟器处理都可能重试。CommandExecutor 以 `(workspace_id, epoch, actor_id, operation, idempotency_key)` 唯一识别业务请求，并保存规范化请求 hash、Acting Practitioner Role、完整响应与 Effect 引用。请求 hash 同时绑定 expected versions、业务输入以及服务端解析的 Practitioner、Practitioner Role、role code、Organization 和 Location；相同 Actor 切换 Acting Practitioner Context 后重用 key 会得到稳定冲突，公开 receipt 查询也要求当前 Practitioner Role 与原 Command 一致，不能读取上一岗位的回执。升级前 receipt 从对应成功 Audit Event 回填岗位，无法可靠解析的旧记录保持不可由有岗位 context 查询。

Command receipt 的 `executing` 插入与业务写处于同一个 `BEGIN IMMEDIATE` 事务，成功时在提交前变为 `completed`。相同 key 和相同 hash 读取并返回第一次完整响应；相同 key 和不同 hash 返回稳定冲突。事务失败时业务事实、FHIR、receipt、审计、Action Trace 和 outbox 一起回滚，失败尝试另写不包含请求正文的审计记录。

外部模拟工作不复用 Command receipt 状态机。持久 outbox 独立使用 `queued`、`claimed`、`completed`、`failed`、`ambiguous` 和 `abandoned`；claim 带 owner、lease version、过期时间、attempt 和 correlation ID。可重试失败在达到最大尝试前按 `next_attempt_at` 重新领取，结果未知保持 `ambiguous`，Epoch 关闭变为 `abandoned`。结果未知不得当作普通失败盲目重做。

### 6.6 预览与提交

当前临床文书签署和支付使用预览/提交协议。结构化病历预览绑定 Actor context、独立草稿版本和 Encounter 版本；首期复诊兼容预览同时绑定旧文书、诊断、Prescription 和 Encounter；支付预览绑定 Charge Item。预览从服务端事实计算文书摘要或金额分配并返回按服务端真实时间计时、五分钟有效的签名 `commitToken`，不修改权威临床、费用或支付状态。

提交验证 token、Actor context、Workspace/Epoch、过期时间和 expected versions，然后重新读取并校验依赖。客户端不能回传或修改预览 effects。发药使用 Prescription expected version 与库存批次条件写直接提交；退药、退款、医保、库存调拨、出院和病案归档不属于当前能力，也不宣称已有预览协议。

## 7. Agent 适配器与能力边界

当前 DSH 集成只服务 Web Profile 中的原生 Session。`dsh-react-surface` 提供 React Surface、布局和 Session-scoped capability lease，`dsh-ag-ui/browser-tools` 提供 always-on browser Tool broker；AG-UI Gateway 不参与该链路，也不需要单独的 model route 或 shared secret。DSH 拥有模型 transcript，ClinMesh 不复制 Assistant message 或 reasoning。

### 7.1 Surface 与 Host 边界

`apps/dsh-web` 把完整 `apps/web` application 作为第二个 adapter：

- Surface 使用 Memory Router，应用位置不修改 DSH document pathname。
- 每个 mount 创建独立 QueryClient；服务端状态仍只由 TanStack Query 拥有。
- 主题和 locale 作用于 Surface root，所有浮层通过注入 Portal 留在 ShadowRoot。
- 默认 `workspace` 布局，宽度不足时退化到 `full-frame`；隐藏时保留未提交 UI 状态。
- `/clinmesh-api` Host 代理只连接配置固定的 loopback Hono，保留 Cookie/Origin，限制路径、方法、请求体、响应体和超时，不记录患者正文。

该模式只信任安装在同一 DSH Web Profile 的插件，并只处理合成数据。它不是不可信 marketplace 插件或真实患者数据的安全边界。

### 7.2 Page Context

浏览器提交由 `packages/contracts` 验证的 `PageContextClaim`，以及当前 DSH Session、Surface client ID 和单调递增的 client revision。Claim 只包含 view、active section、单个选择、草稿引用、加载/错误状态和受限搜索文本。Hono 从当前 session 重新解析 User Account、Actor、Practitioner Role、Workspace/Epoch、Scenario Run 和岗位允许 view，并在同一个 SQLite 写事务中重新读取 selection、Patient/Encounter 版本和资源状态，再签发五分钟 `PageContextSnapshot` 与不可伪造 token。旧请求晚于新 revision 到达时返回 superseded，不撤销较新的 context。

snapshot 包含短期 context ID、DSH Session 和 page scope。Actor、岗位、Workspace/Epoch、DSH Session、view、active section、selection 或受信资源版本变化会改变 scope 并移除旧 Tools；其他页面状态或 TTL 续签只替换 context，但同样关闭绑定旧 context 的 pending review。首次 Page Context 和 registration 不等待 capability status，因为 registration 是 DSH bridge 开始可用性探测和 lease 获取的前提。lease 曾进入 `active` 后，`contended`、`error`、`unavailable` 或 `idle` 会撤下当前 binding，并以同一 Surface client 的下一 revision 重签和重新注册；publisher 自身替换 registration 产生的 `connecting` 只关闭 pending review，不再次重签刚发布的 context。每条 Surface client revision 链只撤销自己的旧 context；浏览器 Web Lock 与 DSH lease 决定哪个 client 可以取得 execution proof，因此尚未取得 leadership 的 contender registration 不会撤销 leader context。前端在到期前一分钟携带 AbortSignal 续签，失败时有界重试，并在真实到期时主动注销 Tools。普通已授权 pending call 可以在旧 context 被正常替换后提交结果；人工批准必须先在线性化的 decision gate 中重新验证 active context、当前资源、当前人类身份和 active Epoch。

Claim 和 snapshot 不包含 DOM、Query cache、浏览器存储、任意页面 dump、其他患者标签页、完整患者档案、Case Truth、Hidden Fact、Reveal Policy、Scenario authoring truth 或生成 prompt。

### 7.3 Tool 目录与风险

`packages/contracts/src/agent.ts` 是 Tool 名称、operation、岗位、view、模式和风险的可执行目录，`agent-tool-input.ts` 拥有每项 operation 的完整输入 schema。每个岗位动态获得不超过 32 个 Tools：通用读取/导航/真实聚焦，加上当前管理员、挂号、分诊、医生、收费或药房页面的窄动作。管理员只能读取 Scenario Run、Provider 可用性和当前 generation job 状态；导航 enum 只包含当前岗位主页和共享设置页。

| 模式 | 当前行为 |
| --- | --- |
| `query` | 读取当前 Page Context、岗位队列或当前受权对象；不返回隐藏真值 |
| `ui` | 在允许页面内导航、选择对象或聚焦区域 |
| `draft` | 填写或保存未提交患者、分诊、临床、收费或药房草稿；页面 action 保留完整格式与范围校验 |
| `preview` | 调用既有只读 preview，不提交正式业务 Effect |
| `proposal` | 打开 ClinMesh 原生人工审阅；Agent 不提交正式 Command |

不提供通用 `execute_action`、任意 method/path/body、FHIR write、Bundle、SQL、URL、DOM selector、JavaScript、JSON Patch 或 `runAs`。DSH Tool runtime 只接受其强制 JSON Schema 子集；Surface adapter 投影 broker 支持的关键词，Web action 和 Hono 在 authorization 持久化前都使用同一 operation/input schema 执行完整长度、格式、数组和数值范围校验。

### 7.4 Execution proof 与调用记录

DSH Host 监听真实 `tools/pre-execute` 事件，为一个 pending call 签发一次性 execution proof。proof 绑定 DSH Session、call ID、Tool 名、Page Context ID、page scope、签发时间和过期时间；浏览器不能自行签名。Hono 要求 proof 的 Context ID 与当前 token 精确一致，并同时验证 Tool catalog、岗位/view 允许 operation、防重放和当前人类 session，再创建 `agent_tool_call` 与可选 `agent_proposal`。

读取、UI 和草稿动作完成后写入结构化 Tool result。proposal Tool 在打开审阅框后立即向 DSH 返回 `awaiting-human-review`，不让人工等待占用 browser lease；Hono 中的 Tool call 与 proposal 保持 pending。人类点击决定时，浏览器先用原 receipt 调用 decision gate；Hono 只在 context、DSH Session、当前资源和 Tool 仍有效时原子记录 `approved` 或 `rejected`，随后 Web 才能调用既有 Command。

批准 completion 必须引用同一个已完成 Command receipt 中显式保存的 `requestId`、`auditId` 和 `traceId`。Hono 联结该 receipt、Audit、Action Trace 和 review decision，要求 Actor、Acting Practitioner Role、Workspace/Epoch、Scenario Run、operation、outcome、标识和决定时序全部一致；拼接两个 Command 的标识、切换岗位后执行 Command、使用 proposal 不允许的 operation 或引用决定前的 Command 都会被拒绝。持久表的主键和外键均携带 Workspace/Epoch，不保存 DSH transcript。

### 7.5 人工审阅语义

正式挂号、分诊、临床、支付、药房和 Scenario Command 始终由 ClinMesh 原生审阅框提交，最终 Actor 是登录人类，Agent 只记录为 proposal 来源。明确点击取消写入人类 `rejected` decision；批准执行既有 Command，并保留其 idempotency、expected version、preview token、审计和状态机语义。

Surface 隐藏、DSH Session/lease 失效、page scope、selection、资源版本、页面 revision 或 context ID 改变，以及 context/receipt 过期或 action 错误，都会关闭尚未决定的 review，并把 proposal 标记为 `stale`，不伪造人类拒绝。签名有效且明确 `ok:false` 的 completion 可以越过 receipt 到期或旧 Epoch 只执行这项清理；它不能关联 Command 或产生 Effect。decision gate 是批准的线性化点；gate 失败时不会调用 Command。Agent call 已失败或 stale 时不能留下仍可提交的孤立审阅框。拒绝、stale、冲突和取消都不自动重放，也不产生正式业务 Effect。

### 7.6 内容与能力边界

病历、患者备注、术语 display、历史 Tool result、外部错误和模拟器消息都是不可信数据，不能改变 Tool catalog、岗位权限、page scope 或 Command 状态机。当前结果只返回完成动作所需的结构化可见事实，不返回 server prompt、secret、access token、reasoning 或仿真私有事实。

共享 bridge secret 至少 32 bytes，只存在于 DSH Host 与 Hono 环境，不进入浏览器、日志、Tool result 或版本库。当前没有 MCP、Agent OAuth/SMART、自治 Agent Run、跨进程 DSH Session 恢复、Evaluation Spec、评分或 Agent 专用医院角色；这些能力不能从 React Surface 的存在推断出来。
### 7.7 Agent CLI 与 Operation Catalog

`apps/cli` 发布可安装的 `clinmesh` 命令。它是现有 HTTP/FHIR adapter 的 schema 驱动消费者，不直接访问 Repository、SQLite 或业务状态机。模型 runner、AG-UI、MCP、Agent OAuth/SMART、Evaluation Spec 和评分入口仍不属于当前能力。

### 7.8 HIS Operation Catalog

`packages/contracts/src/his-operations.ts` 导出的 `hisOperationCatalog` 是 CLI/Capability Grant 直接 HIS 操作面的唯一合同 owner。每项 operation 显式声明稳定 ID、版本、`cliPath`、`query/draft/preview/command` mode、输入/输出/错误 Zod schema、HTTP method/path adapter、唯一 handler owner、human/agent identity、岗位 allowlist、风险、幂等、expected version 与 preview token 要求；既有 Command 的持久 operation 名称不同时，Catalog 还保存 receipt adapter 名称。DSH 页面 Tools 由独立的 `agentToolCatalog` 拥有，并在当前人类 Session 内投影 UI action 与 proposal，不能作为 Capability Grant operation 使用。两个 Catalog 都不依赖 Hono、Node.js、环境变量或 handler。

CLI 命令树、`operations list/schema`、服务端 Agent route matching、Grant 的 Catalog hash 和 Skill 命令示例测试都读取同一 Catalog。HIS route coverage test 要求每条 `/api/his/v1` route 恰好属于 canonical operation 或带原因的兼容排除项。医生病例级检验目录是独立 canonical query，返回当前 Case 的 Investigation Generation Capability；全局 Reference 检验目录不能替代这项开具前门禁。病例级查询没有 Reference 项目时可显式读取本院 clinical catalog，已有 Reference 项目返回 unsupported 时不能用本院同名项目绕过。FHIR 部分只投影 metadata、read、vread、instance history 和资源能力注册表允许的 search；资源类型与 SearchParameter 白名单和 CapabilityStatement 共用一份注册表。包括 metadata 在内的每个 FHIR 入口都先解析受信身份，Agent 还必须在 Grant allowlist 中拥有对应 operation。

CLI 没有通用 invoke、任意 URL、method/path/body、SQL、JSON Patch、FHIR write 或 Bundle write。兼容组合 route 不进入命令树，Agent 使用独立 diagnosis、prescription、laboratory request、clinical document 和 Encounter Completion 生命周期。

### 7.9 输入、输出与恢复

标量、ID、分页和查询条件使用 typed flags；嵌套临床输入使用 `--input @<workspace-file>` 或 `--input -`。文件路径必须留在当前 workspace，单次输入上限为 1 MiB，同一 operation 不能同时使用 typed flags 和结构化输入。所有输入和服务端结果在边界通过 Catalog schema 验证。

成功默认向 stdout 写版本化 JSON envelope；`--output table` 只为 human mode 渲染成功结果。错误只向 stderr 写版本化 JSON，调用者按稳定 `type/code/outcome` 分支。FHIR `OperationOutcome` 映射到同一错误合同。Commander、配置、文件和 schema 错误不混入非结构化诊断文本。

每个 write 要求调用者提供同一业务意图稳定复用的 idempotency key；修改既有事实还要提供 Catalog 声明的 expected versions。CLI 不自动重发 write。连接在结果返回前中断或 write 收到 5xx 时返回 `ambiguous_outcome`，调用者用公开 operation ID 和原 key 执行 `command receipt get`；服务端把公开 ID 映射到既有持久 Command receipt 名称，并保持 Actor、Acting Practitioner Role、Workspace 和 Epoch 隔离。receipt 示例只能指向实际产生 Command receipt 的 write operation。

### 7.10 Human 与 Agent 身份

Human mode 使用 Better Auth profile。登录密码只从 stdin 读取，不进入 argv 或 profile；profile 只保存 Server origin 和 session cookie，配置目录使用 `0700`，文件通过同目录原子替换并保持 `0600`。human write 发送同源 `Origin`，高风险命令还要求本地显式 `--yes`；服务端仍重新执行岗位、状态与版本授权。

Human administrator 通过 `/api/agent/v1` 和对应 CLI 命令创建、查看、禁用 Agent Client，创建、查看和撤销 Agent Capability Grant。账户拥有 administrator 岗位不自动授权控制面；请求时选中的 Acting Practitioner Role 必须是 administrator，并以该岗位审计。每个控制面 mutation 使用幂等键并通过共享 CommandExecutor 原子写 receipt、AuditEvent 和 Action Trace；控制面响应丢失或返回 5xx 时 CLI 返回 ambiguous 并要求先检查当前状态。Grant 创建的原 token 只返回一次，持久 receipt 脱敏且重放被拒绝；若创建结果未知，管理员必须检查并撤销可能已经创建的 Grant，再用新幂等键签发替代 Grant。SQLite 只保存 token SHA-256。Grant 主事实以 Workspace/Epoch/Grant 复合键保存，operation allowlist 使用同一隔离键下的关系行，operation ID 在 contracts 边界按当前 Catalog 验证。每个 Grant 绑定一个 Agent Client、Workspace、Epoch、Scenario Run、一个 Practitioner Role、Catalog hash、Workspace policy version 和真实过期时间；write allowlist 自动加入 receipt 查询。

Agent task 由 runner 注入 `CLINMESH_SERVER_URL`、`CLINMESH_TOKEN` 和 task 标识。CLI 只接受完整短期 token，缺失或格式错误时在发网前失败；Agent context 不能读取、创建或选择 human profile。服务端从 token hash 重新解析 Actor context并忽略客户端自报的 Actor、Workspace、Epoch、Scenario Run 或岗位。Agent Client 与 Human Membership 都投影到 `workspace_actor`，领域事实因此保留真实 Agent Actor，而不伪造 User Account。撤销、过期、Client 禁用、Epoch reset、Scenario Run 关闭、岗位停用、Catalog hash 或 policy version 变化都会使 token 失效。

Agent 高风险 command 不使用 `--yes` 作为授权；operation 必须在单岗位 Grant allowlist 中，Command handler 仍重新验证业务状态和 expected versions。跨岗位流程由 runner 签发多个不同 Grant，不能在一个 token 内切换 Practitioner Role。

### 7.11 Agent Skills

仓库提供七个 model-invoked Skills：`clinmesh-shared`、`clinmesh-registration`、`clinmesh-triage`、`clinmesh-doctor`、`clinmesh-billing`、`clinmesh-pharmacy` 和 `clinmesh-fhir`。`clinmesh-shared` 拥有 context、Catalog discovery、幂等、结构化错误和 ambiguous receipt 恢复；领域 Skills 只说明意图路由、前置状态、岗位交接、风险和反例，并在执行前读取 shared Skill。

Skills 不复制 flags、输入 schema 或完整命令目录，Agent 对不熟悉的 operation 使用 `operations schema` 读取当前合同。临床 Skills 不包含 Agent Client/Grant 控制面。测试收集每个 bash 示例并要求其命令路径存在于真实 Catalog 或共享 CLI manifest，从而让命令重命名和文档漂移直接失败。

### 7.12 后续 Agent 传输与内容安全

后续嵌入式助手、AG-UI、tool adapter 或 MCP 只能投影同一 Catalog 并保留受信 context、幂等、expected version、receipt 与审计语义。MCP 是可选传输协议，不是业务领域模型；新增 adapter 不能提供比 CLI 更宽的 raw escape hatch。

病历、患者备注、术语 display、历史命令结果、外部错误和模拟器消息都是不可信数据。调用侧用固定指令隔离这些字段，权限与状态机只接受结构化参数和服务端解析的资源引用；自由文本不能决定 operation、role、URL、SQL 字段或授权范围。Case Truth、token、内部 prompt 和未授权字段不进入 CLI schema、Skill 示例或普通结果。

## 8. 核心业务状态机

### 8.1 门诊闭环

```text
Registration + Encounter + Account + 挂号 Charge Item
  -> 分诊 Observation + Queue Task ready
  -> 医生受控问诊 + 首诊 + 独立检验 ServiceRequest/Task，或兼容 ServiceRequest/ChargeItem
  -> 兼容检验支付；独立检查申请不计费
  -> LIS Specimen / Observation / DiagnosticReport
  -> 医生复诊 + Condition + Prescription/MedicationRequest，或记录无需用药结论并跳过药品交接
  -> 签署 document Bundle / Composition
  -> Encounter completed
  -> 药品支付
  -> MedicationDispense + Inventory Movement
  -> Scenario Run completed
```

首期只实现现场普通门诊。Registration 是持久领域事实；挂号 Command 在同一事务中创建或关联 Registration、Encounter、Queue Task、Account 和挂号 Charge Item。Appointment 表达未来预约承诺，Slot 表达可预约时段，不承担挂号事实、排队序号或挂号费语义，二者不属于首期闭环。

门诊医生也可从版本固定的 Virtual Patient 直接建立接诊上下文。候选列表返回的 opaque `version` 由服务端认证加密并固定长度，绑定 Workspace、Epoch、Virtual Patient ID、内部版本，以及列表读取时已有活动病例的 Encounter 和可用 Queue Task 引用与版本。`virtual-patient.start-consultation` 在进入 `CommandExecutor` 前解密并校验该引用，以 Virtual Patient 版本、依赖版本与可用状态作为前置条件；篡改、跨上下文、旧候选或依赖已变化都返回稳定冲突，客户端不能解码技术状态或自行提交底层 expected versions。

Patient 没有活动门诊病例时，Command 在同一事务中创建 Registration、进行中 Encounter、Account、医生 Queue Task、`first-visit` outpatient case 和版本为 `1` 的 Consultation；Patient 已有 `awaiting-triage`、`awaiting-doctor` 或 `first-visit` 病例时，Command 复用该病例的 Registration、Encounter、Account 和可用 Queue Task，并把尚未开始的 Task 转入医生首诊，同时为病例建立 Consultation。成功后 Virtual Patient 不可再次接诊；这条入口不伪造分诊 Observation、分诊级别或费用事实，相同幂等键重放第一次回执，其他活动状态或已消费候选患者返回稳定冲突。

Consultation 是病例级领域聚合，Consultation Record 是按序号追加的不可变问答事实；Synthetic Case 开始或 replay 时把活动 Patient Brief 的 `symptomTopics` 确定性物化为 case-scoped question rules，旧 Virtual Patient 继续使用自己的 reveal rules。首次问诊可在同一 Command 中把 `awaiting-doctor` Task 转入 first visit、绑定负责 Practitioner Role 并追加回答；后续问诊只追加记录。每次追加以旧聚合版本作为记录序号，通过 SQL expected-version 条件更新递增版本，并保存当时的问题文本、回答、提问 Actor、Acting Practitioner 和虚拟业务时间。公开响应不暴露 Case Truth 或内部答案规则。

结构化 Clinical Document 草稿包含主诉、现病史、查体、评估、处置和随访六个共享必填字段，按病例保存在 `clinical_document_draft`，以 `expectedDraftVersion` 和 Encounter expected version 做 CAS 更新。签署预览固定 Actor context、Encounter 版本、草稿正文和草稿版本；提交重新校验这些依赖与 token 后创建不可变 FHIR R5 Composition、带稳定 identifier 且首 entry 为该 Composition 的自包含 document Bundle，以及同时引用二者的 Provenance，但不改变 Encounter 或病例状态。`signed_clinical_document` 只保存 FHIR 资源关联、签署者、时间和修订父链；每个病例只允许一个根文书，修订只接受最新 Composition 并创建线性替代版本。首期复诊 `sign-and-complete` 是兼容入口，只能用于尚无结构化签署根文书的病例；已有根文书时预览和提交都返回稳定业务冲突。

诊断是病例级独立聚合。版本化 `diagnosis_catalog` 为当前 Workspace/Epoch 提供受控 ICD-10 条目；`diagnosis_state` 保存一至八条目录引用、主次角色和可选备注，草稿以 Encounter expected version 与单调 `expectedDraftVersion` 做 CAS。保存草稿不创建 Condition 或其他 FHIR 资源；已确认状态可以重新进入草稿，但不会改写既有确认。重复目录项、停用目录项、过期版本和已有首期复诊组合草稿分别返回稳定目录或业务冲突。

确认诊断要求草稿恰有一个主诊断。Command 为每条主诊断或次诊断创建关联当前 Patient 与 Encounter 的 FHIR R5 Condition，以标准 `encounter-diagnosis` category 标识本次就诊诊断，把主次角色写入 `Encounter.diagnosis.use`，并创建同时覆盖全部 Condition 与更新后 Encounter 的 Provenance。`diagnosis_confirmation.revision_number` 与 `supersedes_confirmation_id` 形成不可覆盖的线性确认历史；再次确认把上一 revision 的 Condition 标记为 `verificationStatus=entered-in-error`，Encounter 当前诊断引用只保留新 Condition。领域事实、Condition、Encounter、Provenance、草稿清除、Command receipt、审计和 Action Trace 在同一事务提交。病例详情返回最新确认和可选的新草稿，并与既往 Condition 分区；病例库筛选、处方适应规则和完诊门禁只读取最新 confirmation revision。

处方草稿是病例级 domain-native 聚合，保存一至八条受控药品、剂量、频次、疗程和数量，并以 Encounter expected version 与单调 `expectedDraftVersion` 做 CAS。保存或删除草稿不创建 MedicationRequest；正式开具时重新读取目录和已确认诊断，校验药品组合、诊断适应规则、患者过敏、剂量、频次、疗程和数量，然后在同一 Command 创建稳定处方号、Prescription、每种药一个的 active FHIR R5 MedicationRequest、Medication ChargeItem 和 Charge Record。`prescription_authorship` 通过 `workspace_actor` 与 Practitioner Role 复合外键保存负责身份，草稿正文同时清除且版本递增。收费预览只有在 Encounter 已完诊、处方仍 signed 且未撤回时可用；支付成功把病例移交药房。独立处方入口与首期复诊组合草稿互斥，已存在正式用药结论时不能继续普通编辑。

临床目录响应以 `prescriptionConclusionSupported` 显式声明当前 Epoch 是否具有独立用药结论能力。v3 药品目录同时提供疗程、数量和诊断适应规则并返回 `true`；保留的 v1/v2 目录只提供组合、剂量和频次规则并返回 `false`，其组合复诊流程保持可用，独立处方与无需用药 Command 返回稳定目录冲突，Web 不显示独立用药结论面板。

无需用药结论是独立的 domain-native 正式事实，记录负责 Actor、Practitioner Role 和虚拟业务时间，不用空 Prescription 或空 MedicationRequest 代替。有效处方与无需用药结论互斥；处方撤回后可确认无需用药。确认动作也清除处方草稿并递增草稿版本。

处方撤回使用不可变 `prescription_withdrawal` 事实表达，不删除或覆盖原 Prescription。只有未发生任何调剂的 signed 或 paid 处方可按 Prescription expected version 和全部 MedicationRequest expected versions 撤回；成功后各 MedicationRequest 进入 `cancelled` 并保留 FHIR history，Prescription 版本递增且读模型投影为 `withdrawn`。未收费的已撤回药品费用不再进入收费员待收费队列，已收费历史仍可查询且不会隐式退款；药房队列、审核、支付和发药入口都拒绝已撤回处方。

带 Consultation 的病例使用独立检验申请 owner。`laboratory_request_state` 保存一个病例级草稿及单调递增版本；保存和删除都以当前 Encounter 与草稿版本做 CAS，删除或开具只清空草稿而不复用旧版本。病例级目录在全局当前 Reference Release 结果上投影 Investigation Generation Capability，Web 禁用但不隐藏当前病例不可生成的项目，只提交 capability 支持的项目；保存草稿、开立申请和重试生成的 Command 都重新校验同一 capability，不能通过绕过选择器提交不可生成项目。单一内部适应证 `clinical-evaluation` 不要求医生选择。没有病例责任人的 `awaiting-doctor` 病例必须先由接诊 Command 分配责任并推进状态，Web 才开放检验、诊断、处方和病历写入。开具时保存 coding/display 快照并创建 `ServiceRequest.status=active` 和 `Task.status=requested`，Task `focus` 指向该 ServiceRequest。该流程不创建 ChargeItem，也不推进 Encounter 或医生 Queue Task。

独立申请开具后由持久 outbox 绑定 `lis-system`，依次把领域状态和执行 Task 从 `issued/requested` 推进到 `accepted/accepted` 与 `in-progress/in-progress`。Simulator 优先复用同 LOINC 的隐藏来源结果，否则异步生成 Investigation Result Snapshot；失败进入可重试的 `generation-failed` 且不创建报告。成功后才创建 Specimen、Observation、DiagnosticReport 和 Provenance，并完成 ServiceRequest、执行 Task 与申请；重复投递返回同一冻结结果，不重复调用模型或创建资源。

Report Acknowledgement 是按报告版本独立保存的领域事实，只能由原检查申请的开具医生对当前 `DiagnosticReport.status=final` 且申请为 `reported` 的报告创建。成功确认把申请推进到 `acknowledged` 并递增申请版本，但不更新 DiagnosticReport 或其 FHIR `meta.versionId`；确认 Command 以 `ReportAcknowledgement/<id>` effect 进入审计和 Action Trace。每个报告版本至多有一条确认事实，不同幂等键的重复确认返回第一次确认的 ID、时间和当时的申请版本。

报告更正只接受当前 `reported` 或 `acknowledged` 报告、申请 expected version、原 DiagnosticReport expected version、原因、结论，以及覆盖既有结果代码全集且不重复的数值。每次更正为 DiagnosticReport 和全部 Observation 创建新的 logical ID，旧资源和旧 Report Acknowledgement 保持可读；新的 Provenance 以 `entity.role=revision` 引用被替代报告和结果，领域修订表以 latest-only 唯一约束维持线性链。更正后申请指向新报告并回到 `reported`，当前确认投影清空，医生必须对新版本重新确认；并发更正只有一次能通过申请 CAS。FHIR R5 DiagnosticReport 没有 Composition 式 `relatesTo`，因此替代关系由标准 Provenance 与领域修订链共同表达，不添加伪标准字段。公开 HTTP adapter 只接受登录账户具有 administrator 能力的受信 session，再把调用绑定为受信 `lis-system` Command context，同时保留该 session 当前选择的 Practitioner、Practitioner Role 和 Location 供 receipt 与 Audit 关联；其他账户和请求正文不能声明或伪造该系统角色。

`issued` 申请和永久 `INVESTIGATION_UNSUPPORTED` 的 `generation-failed` 申请可由原开具医生取消；取消把 ServiceRequest 改为 `revoked`、执行 Task 改为 `cancelled`，并递增正式申请版本。取消与受理竞争时由版本和条件更新决定唯一结果，已取消申请收到晚到受理事件时以无副作用完成。医生病例详情读取草稿版本、可选草稿和全部正式申请；报告 DTO 从已签发的 DiagnosticReport 和 Observation 还原，不从当前目录或结果模板重建。Web 对永久不支持显示取消和重新选择，对瞬时或输出校验失败显示重试，对当前 `reported` 报告显示确认已阅；内部 Agent 错误文案不直接暴露给医生。

没有 Consultation 的既有挂号病例继续由 Web 使用 `issue-laboratory-order` 兼容入口和 `lab-fever-panel`，该命令绑定首诊草稿、Encounter 与医生 Queue Task，创建 ServiceRequest、ChargeItem 和待缴状态。独立草稿入口的请求 schema 不接受 `lab-fever-panel`；两条路径不共享草稿版本、正式申请领域状态或执行 Task 状态机。

带 Consultation 的病例通过 `GET /api/his/v1/encounters/{id}/completion` 读取完诊门禁。预览固定返回主诊断已确认、结构化病历已签署、必要报告已阅、用药结论已记录、无未处理草稿、处置完整和随访完整七个稳定 code，并为每项返回 `complete/incomplete`、中文状态和 `diagnosis`、`clinical-document`、`laboratory` 或 `medication-conclusion` 目标。没有未取消检查申请时“必要报告已阅”成立；存在申请时必须全部为 `acknowledged`。有效正式处方或无需用药事实满足用药结论，已撤回处方不满足。已存在签署结构化文书时保留的文书草稿不再视为未处理；诊断、检查或处方草稿仍会阻塞。

`encounter.complete` Command 在同一个 `BEGIN IMMEDIATE` 事务中重新计算门禁并校验唯一的 Encounter expected version，不能信任此前预览。任一条件缺失时返回 `ENCOUNTER_COMPLETION_BLOCKED` 并回滚；成功只把 FHIR Encounter 更新为 `status=completed` 并写入虚拟业务时间 `actualPeriod.end`，同时生成 Command receipt、FHIR AuditEvent 和 Action Trace。它不修改医生 Queue Task、`outpatient_case.status`、Registration、收费、处方、发药或 Scenario Run。医生队列按当前 Encounter JSON 状态排除已完成病例；当前诊疗中保留的已选病例详情默认关闭问诊、草稿、确认、撤回、修订和完诊控件，签署文书、报告、诊断和用药结论继续只读展示。只有从病例库详情的 capability 显式导航回当前诊疗时，页面才恢复对应 owner 的纠错控件，Command 仍重新校验责任、状态和版本。

病例主接诊责任由 `outpatient_case_responsibility` 按 Workspace、Epoch 和病例唯一保存，引用实际 Practitioner Role，并记录首次分配的虚拟业务时间。医生直接建立病例或从既有队列开始接诊时都通过同一责任分配逻辑写入；已存在同一责任时保持不变，另一医生尝试接管时返回岗位错误。旧库升级时，Virtual Patient 直达接诊病例优先从成功 Command receipt 与匹配审计记录恢复实际 Acting Practitioner Role，其他既有病例从医生 Task `owner` 回填；完成后的授权不再从可变化的 Task 状态或页面选择重建。

医生通过 `GET /api/his/v1/doctor/completed-cases` 查询当前 Practitioner Role 负责且 `Encounter.status=completed`、具有 `actualPeriod.end` 的病例。查询支持 Patient logical ID、完诊业务日期闭区间和诊断目录项筛选，按 `actualPeriod.end` 降序、病例 ID 升序稳定分页。`GET /api/his/v1/doctor/completed-cases/{caseId}` 对未完诊、未分配或属于其他医生的病例统一返回业务冲突，只读取各 owner 的正式事实：Consultation Record、不可变 Clinical Document 修订链、检查申请与报告修订及确认、诊断确认、处方或无需用药结论、Patient 和已完成 Encounter；活动草稿、编辑版本和页面状态不进入病例库合同。

病例库详情的业务时间线由服务端从各 owner 的正式事实和成功草稿删除 Action Trace 组装，按虚拟业务时间升序排列，相同时间依次按主资源引用和事件 kind 排序。活动草稿正文和编辑版本不进入病例库；只有 Effect 引用当前病例 `LaboratoryRequestDraft` 或 `PrescriptionDraft` 的成功删除 trace 进入时间线，以 ActionTrace 为主引用并关联对应 Draft。检查取消以 LaboratoryRequest 为主引用并关联 ServiceRequest 和执行 Task；处方撤回以 PrescriptionWithdrawal 为主引用并关联原 Prescription，因此原始开具与逆向事实分别形成事件。每个事件返回稳定 kind、主资源引用和关联资源引用；Web 只按响应顺序展示，不重新推断事件、当前版本或临床状态。医生工作台以“当前诊疗”和“已完诊病例”页签分隔写入与查询入口；病例库页只提供受控筛选、分页、只读事实展示和受控 owner 导航。详情为每个 Clinical Document 和检查申请返回 `correctionSupported`，为处方返回 `withdrawalSupported`，缺失字段按 `false` 处理；只有能在活动病例读模型中恢复并由现有 Command 执行的结构化病历和独立检查申请标记为可更正，只有当前 Epoch 支持独立用药结论且处方为 signed 或 paid、未发生任何调剂时才标记为可撤回，首期两字段病历与兼容检验事实继续可读但不显示更正导航。病历更正从病例库显式跳转后才显示最新版本修订表单，修订 Command 重新校验当前 Practitioner Role 是该病例的持久责任岗位；报告更正要求当前门诊医生岗位或登录 session 具有 administrator 能力，并使用结构化字段和提交前确认；处方撤回从病例库跳转到活动病例的用药结论区，复用对象预览和显式确认。三个动作都调用各自 owner 的受控 Command，成功后同时失效活动病例与病例库详情查询，使新版本和时间线从服务端正式事实重新读取；完诊成功还会失效病例库列表。任何动作都不能在病例库 DTO 上普通覆盖。

医生工作台对未开具草稿删除、未受理检查取消、未调剂处方撤回、病历修订和报告更正统一采用对象预览、显式确认和结果反馈。页面只在 owner 读模型声明的可逆窗口显示入口，确认时仍提交当前 expected version 与新的幂等键；服务端独立重新校验岗位、责任、状态和资源版本。成功 Command 都生成 AuditEvent；病历和报告更正还创建新的正式资源、Provenance 与替代关系，原事实保持可读。冲突响应说明当前状态或版本，包括空草稿、已受理或执行中的检查、已撤回或已开始调剂的处方、已替代文书和并发报告版本；Web 刷新 owner 查询后只展示服务端当前事实。

关键约束：

- 一个 Encounter 贯穿挂号、分诊、首诊、检验和复诊，不为复诊新建 Encounter。
- 一个普通门诊 Encounter 同时只能有一个主接诊者。
- LIS 是受控系统 Actor；独立检查申请在开具后进入受理/执行 outbox，兼容收费检验在支付成功后进入报告 outbox，二者都可在服务重启后恢复。
- 正式开具独立处方时必须按当前已确认诊断、有效药物过敏和药品目录规则校验诊断适应范围、组合、剂量、频次、疗程与数量。
- Prescription 是带处方号的持久领域聚合，归组 MedicationRequest 并拥有审核、收费和调剂边界；它不等同 RequestOrchestration。
- 独立结构化病历签署不完成 Encounter；带 Consultation 的病例必须由完诊门禁汇总各临床 owner 的正式事实，首期复诊兼容命令只在尚无结构化签署根文书时组合旧文书签署与 Encounter 完成。收费员只处理已进入待缴状态的药品费用，药师再调剂发药；Encounter 完成与 Scenario Run 完成是两个事实。
- 药房只处理已签处方且药品支付成功的项目；发药完成 Scenario Run，但不修改已完成 Encounter。
- 签发后的请求不得通过无约束 update 改写已生效临床意图。停止、撤销、纠错、替代和补充分别使用适用的标准 status/statusReason、关系字段、受控 Operation 和 Provenance；只有形成新临床请求时才创建新 logical resource。
- 退费必须关联原 ChargeItem、PaymentTransaction 和发药/执行状态。
- 已发药项目退费前先完成退药或明确豁免。
- 医嘱签发、费用生成、支付和执行不是统一线性顺序。不同目录项目在签发、确认执行、发药、耗材领用或人工补记时生成 ChargeItem。
- ChargeItem 取消不自动删除临床请求，临床撤销也不自动等价退款；每类目录项目声明计费触发点、数量来源、可退条件和原始业务引用。

后续预约、急诊、退号和取消就诊必须作为不同业务动作设计，不能从首期现场挂号状态推断其语义。

### 8.2 住院闭环（后续）

```text
Admission request
   -> pre-admission
   -> registration
   -> admit to department
   -> assign bed
   -> active inpatient Encounter
   -> long/temporary orders
   -> nurse verification
   -> execution / dispense / charging
   -> discharge order
   -> nurse discharge
   -> financial settlement
   -> clear bed
   -> medical record archive
```

住院状态不能只压缩到一个 Encounter.status。使用：

- `Encounter.status` 表达标准 Encounter 生命周期。
- `Encounter.subjectStatus` 只在 code 确实描述患者相对于本次 Encounter 的当前状态时使用，不能充当通用住院行政状态容器。
- 入科、转科、待出院、已出区、待清床和召回使用有明确 ValueSet/invariant 的 extension、Encounter.location 状态/period 和独立 Task 表达。
- `Encounter.location` 记录实际参与就诊的诊室、病区、床位等 Location 及时间段；Organization 科室责任归属通过 participant、serviceProvider、careTeam 或明确扩展表达，不能把科室伪装成 Location。
- 床位预占、实际占用、暂离、转床、借床和清床由领域互斥表维护，Encounter.location 只是互操作投影。

关键约束：

- 床位同一时刻只能被一个有效 Encounter 占用。
- 转床和互换床是原子命令，不能由两个独立 Location PUT 完成。
- 医嘱执行必须引用已签发、有效且完成校对的请求。
- 出院、财务结算、清床和病案归档是不同动作。
- 召回只在规定状态窗口内允许，并生成完整审计和逆向事件。

### 8.3 医嘱生命周期

领域子状态建议：

```text
DRAFT
  -> SIGNED
  -> VERIFIED
  -> IN_EXECUTION
  -> COMPLETED

SIGNED / VERIFIED / IN_EXECUTION
  -> STOP_REQUESTED
  -> STOP_VERIFIED
  -> STOPPED

DRAFT -> REMOVED
SIGNED -> REVOKED       # 尚未执行且满足撤销条件
ANY    -> ENTERED_IN_ERROR  # 受限纠错
```

FHIR 映射：

- MedicationRequest/ServiceRequest.status 保持 R5 标准值。
- SIGNED、VERIFIED、STOP_REQUESTED 等本地步骤由 Task、Provenance.activity 和 profile extension 表达。
- 每次签发、校对、停嘱和停嘱校对都是独立 command 和审计事件。
- 草稿到签发可更新同一 logical id；签发后的纠错、替代和停止使用标准 status/statusReason、replaces/basedOn 等适用字段及 Provenance，不能一概“停止后新建”。

明确区分四层：

1. 组套/路径模板：PlanDefinition 或本地模板，不是已下达医嘱。
2. 本次请求编排：RequestOrchestration，描述请求或建议之间的组合、选择、条件和顺序，其 intent/status 必须与所引用请求一致。
3. 单项医嘱：MedicationRequest、ServiceRequest、DeviceRequest 等。
4. 处方业务边界和执行计划：使用稳定 prescription identifier/groupIdentifier、profile 与领域聚合；长期医嘱的频次展开、首日次数、班次和停止生效时间不能只靠 Task 状态表达。

同组关联不使用 CSV ID。处方号、医嘱组号、长期执行计划分别建模，RequestOrchestration 不作为所有中国处方的标准等价物。

### 8.4 发药与退药

```text
requested -> reserved -> prepared -> dispensed
                       -> cancelled
             dispensed -> return-requested -> returned
```

约束：

- reserve、prepare、dispense 分开，避免把“已占库存”误认为“已交付患者”。
- 处方阶段引用目录 Medication，不绑定库存 lot；批号、效期、追溯码和位置由库存领域在调剂时分配。
- 批号按先到期先出或场景策略分配；一次发药跨多个批次时拆为多个 MedicationDispense，或用 IG 定义的重复批次明细扩展并校验数量合计。
- 每次库存变化生成不可变 InventoryMovement。
- 追溯码有独立状态，不能只保存在一个超长文本字段。
- 退药是反向移动并引用原 dispense，不修改原移动记录。
- MedicationRequest 表达用药请求；待执行排班使用 Task 或领域执行计划；MedicationAdministration 每个资源表达一次实际或未发生的给药。漏给、拒绝、暂停和未执行原因使用标准 status/statusReason 或 profile，不预建 completed Administration 充当计划。

### 8.5 收费、支付与退款

```text
ChargeItem billable
   -> payment preview
   -> payment pending
   -> confirmed
   -> invoiced

confirmed -> refund requested -> refunded
confirmed -> ambiguous external result -> reconciled/failed
```

重要建模：

- `ChargeItem` 表达可计费活动及其状态，不等同最终确认费用或支付。
- `Invoice` 表达向付款方汇总的账单，不等同财政电子票据、税务发票或收款流水。
- 财政电子票据的开具、红冲、换开、票号和平台状态由领域模型管理；DocumentReference 可引用其版式文件。
- 院内收款使用本地 PaymentTransaction，不滥用 FHIR PaymentNotice 或 PaymentReconciliation；前者仅用于付款方通知，后者仅用于确有付款方对账语义的投影。
- 金额分配使用关联表，不保存 `charge_item_ids` 字符串。调价、减免、四舍五入、医保拒付和自费转医保使用独立调整/分配记录。
- 收款退款、账单红冲和医保结算撤销是不同交易链，均通过反向记录或 replacement 关系处理，不覆盖原账。

### 8.6 医保模拟

```text
person query
  -> encounter registration
  -> fee upload
  -> pre-settlement
  -> settlement
  -> payment allocation
  -> reconciliation

settlement -> reversal -> reversed
```

每次平台调用保存：

- 业务接口号和 adapter 版本
- request/response 摘要和受控原始快照
- correlation/message ID
- idempotency key
- 尝试次数
- 状态：pending/success/rejected/timeout/ambiguous/reversed
- 虚拟业务时间与真实执行时间

模拟器不能把吉林接口号当成全国通用领域名。领域命令使用通用名称，吉林或其他地区协议由 adapter 映射。

### 8.7 检验检查与报告修订

检验检查区分：申请、预约/执行 Task、标本采集、标本接收、结果项、报告签发、危急值通知和报告更正。ServiceRequest、Specimen、Observation 和 DiagnosticReport 分别保留自身状态；更正报告创建新的业务修订关系，不能覆盖原事实而丢失签发链。首期只模拟结构化检验报告，不实现检查附件、影像归档或 DICOM Study。

### 8.8 患者主索引与合并

MPI 合并是受控高风险 command。被合并 Patient 保留原 logical id，更新 active/link 状态；既有临床资源不批量重写 subject。读取、搜索、授权和审计定义 canonical Patient 与历史 Patient 的解析规则，并支持受控取消合并。院内患者号属于 Patient；门诊号、住院号通常属于 Encounter.identifier；病案号属于病案/照护周期聚合；医保人员编号按其真实主体建模，不能全部笼统塞入 Patient.identifier。

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

它承载当前注册的 Patient `name`、Patient `identifier` 和 5.5 节列出的 reference SearchParameter；reference 与 string/token 参数复用同一张表，不另建 reference index。每次资源变更在同一事务删除该资源旧索引并插入完整新索引；数据库 CLI 的 `reindex` 重建索引并验证完整性。运行时不执行任意 FHIRPath，也没有尚未使用的 date/quantity 或 compartment 索引表。

当前 FHIR 授权上下文由已认证 session 或 Agent Capability Grant 解析出的 Workspace/Epoch 隔离。标准 Patient compartment、Encounter care-team 和字段级策略尚未发布为 FHIR 能力；增加这些能力时必须在 SQL 查询中应用，不能查询后过滤。

### 9.2 领域表

当前领域表只覆盖首期闭环：

- 身份与岗位：Better Auth 的 user/session/account，加 Workspace Actor、Human Membership、Agent Client/Capability Grant、Practitioner Role binding 和当前 session context。
- 门诊：Virtual Patient 候选状态与接诊映射、Consultation、append-only Consultation Record、目录、outpatient case、Registration、分诊记录、临床草稿、诊断草稿状态与确认分组、检查申请草稿状态、正式检查申请、处方草稿状态、Prescription 与处方项目、无需用药结论和处方撤回事实。
- 账务：Charge Record、Payment Preview 和 Payment Transaction。金额以整数分保存；当前没有退款、医保或收费员交账表。
- 库存与发药：Inventory Lot、append-only Inventory Movement 和 Dispense。当前不实现预占、追溯码、盘点或调拨。
- 文书：结构化 Clinical Document Draft、结构化与兼容 Clinical Sign Preview、Signed Clinical Document 关联和修订父链；签署的 Composition、document Bundle 和 Provenance 正文仍由 FHIR store 权威保存。
- 平台与仿真：Workspace/Epoch、Scenario Run/State、Synthetic Profile/Case、Patient Brief、Investigation Result Snapshot、私有 Case Truth、Command Receipt/Effect、Audit、Action Trace、Outbox、Agent Page Context、Tool call、proposal 和 review decision。

所有适用表、主键、唯一键、外键和岗位队列索引包含 `workspace_id + epoch`。新增 FHIR-native 辅助索引时必须可由权威资源重建；新增无法重建的事实时必须明确成为 domain aggregate，不能同时由 FHIR JSON 和领域表双向拥有。

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
- 所有 Workspace/Epoch 运行事实表的主键和唯一键以 `(workspace_id, epoch, ...)` 开头；运行事实之间使用 `(workspace_id, epoch, target_id)` 复合外键，禁止只引用裸 ID，删除默认 `RESTRICT`。跨 Epoch 的不可变 Profile/Case 资产遵循[Workspace 隔离](#101-workspace-隔离)。
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

### 9.8 文书与附件边界

首期只保存通过运行时 envelope 与业务规则验证的结构化 FHIR JSON。已签署 document Bundle、Composition、Provenance 和 Clinical Document Revision 与其他 FHIR 资源一起进入 current/history store，不写本地散落文件。病历修订创建新的 logical resource 和明确 `replaces` 关系；同一病例的唯一根约束和最新版本检查禁止分叉或第二个签署根。

首期不提供 Binary、图片、PDF、扫描件、OCR、报告附件、模拟影像或对象存储。未来加入附件时必须另行设计内容校验、授权、版本不可变性、备份恢复和对象生命周期，不能把 SQLite 文件路径直接写入 FHIR 资源。

### 9.9 数据库迁移边界

首期只有 SQLite Repository adapter。Drizzle schema 和迁移以 SQLite 为真实目标，不维护 D1 或 PostgreSQL 方言的虚假兼容层。Workspace 级 Profile、Case、Brief 和 Investigation Snapshot 使用稳定逻辑 key 和显式 revision，不依赖本地自增 ID。

未来选择 D1、PostgreSQL 或 Supabase 时必须：

- 新增目标数据库的真实 Repository adapter 与双端 contract tests。
- 设计并演练 schema、FHIR history、领域事实、审计和 outbox 的显式迁移。
- 验证 canonical state hash、引用完整性、金额和数量守恒、history/version 与 active Epoch。
- 单独定义目标运行时的事务、并发、备份、恢复和部署约束。

Repository 边界降低业务代码耦合，但不承诺直接复制 `.sqlite` 文件或零成本切换。

## 10. 仿真架构

### 10.1 Workspace 隔离

每次人类演示或 Agent 任务运行使用一个 Scenario Run，并在 Workspace 内以不可复用的 Epoch 标识具体数据世代。所有运行资源、索引、领域表、session/Grant context、Command、outbox、callback 和 Action Trace 都绑定 `workspace_id + epoch`；审计保留域独立，不随 reset 删除。生成任务、Synthetic Patient Profile/Revision、Synthetic Case Instance、Brief Revision、来源 R4 artifact 和冻结的 Investigation Result Snapshot 是 Workspace 级不可变资产，故意跨 Epoch 存续。直接开始或管理员 reset/replay 才把同一 Case Revision 物化为新 Epoch 的本院 Patient、Registration、Encounter、Queue Task 和 Consultation；Visible Source History 保持来源投影，不进入本院 R5 store。

首期所有 Workspace 共用一个 SQLite 文件并按行隔离。数据库文件不是 Workspace 边界；任何查询和约束都必须显式携带 Workspace/Epoch。

安全要求：

- workspace/epoch 由认证上下文注入 repository，业务调用者不能选择；`X-Workspace-Id` 最多作为必须与 token 一致的断言，不能用于切换上下文。
- 每次请求重验 active epoch、membership、delegation grant 和 policy version，不能只信 token 中可能陈旧的角色/location claims。
- 运行事实的表、唯一键、外键、索引和 SQL 都包含 Workspace/Epoch；schema/query lint 拒绝缺少隔离键的租户运行关系和查询。Workspace 级 Case 资产只使用 Workspace 隔离，开始或 replay 时才创建绑定新 Epoch 的运行事实。
- Search total、include/revinclude、cursor、history、outbox lease、Action Trace 和 FHIR 投影同样执行隔离。
- FHIR Reference 写入解析目标并拒绝跨 workspace/epoch 引用。

### 10.2 虚拟时钟

每个 Scenario Epoch 在 `scenario_epoch_state` 保存：

```text
virtual_time
clock_revision
```

当前 `virtual_time` 在 Case 开始或 replay 时固定，业务发生时间由应用服务从该字段读取。首期没有推进、缩放或回拨时钟的 API，也不提供 `simulation.get_time`、`simulation.advance_time` 或 `simulation.run_due_events` 工具。

真实提交时间仍用于：

- `meta.lastUpdated`
- token 过期
- lease
- 审计接收时间
- 系统性能指标

### 10.3 场景定义

固定 commit 的 Synthea Provider 默认运行全部模块，也可接受有界模块过滤、人数、年龄、性别、时间范围和 seed。Web 每次打开生成抽屉时随机提供双 seed，管理员仍可手动修改以复现。每个患者最多尝试十次；系统确定性选择最后一个包含临床资源或明确 reason 的 Encounter，跳过纯行政、账单和单纯疫苗 Encounter。没有合格 Encounter 时本次患者生成失败且不留下部分 Profile 或 Case。

一次成功生成原子保存不可变 Synthetic Patient Profile Revision、本地化 R4 Bundle 和 Synthetic Case Instance。固定 catalog 未命中的 clinical display 保留来源英文，并把有界 translation warning 与 Profile 一起保存供管理员校对；缺译不阻塞患者，FHIR 结构、引用、身份、catalog hash 或 provenance 无效仍阻塞。Index Encounter 之前的闭包构成按临床时间排序的 Visible Source History；授权临床岗位可以分页查看摘要和经过可见性检查的原始 R4 详情。Index Encounter 与当前 episode 的关联资源构成 Case Truth，保存在私有边界，不进入普通 HIS/FHIR/history/tool 响应。Case 类型由来源时间线推断为 new-problem、follow-up 或 preventive。

管理员显式请求异步 Patient Brief。Server-owned OpenAI-compatible transport 只接受启动配置的 HTTPS endpoint、模型和凭证，使用固定版本 prompt 与严格 schema；客户端不能覆盖 URL、模型、header 或请求体。成功结果经过结构校验和隐藏诊断泄漏检查后成为不可变 Brief Revision，失败或拒绝不会覆盖既有成功 revision。Case 必须选择一个成功 Brief Revision 才能开始。

开始是带 expected revision 和幂等键的一次性 Command，直接创建本院 R5 Patient、Registration、Encounter、Queue Task 与所需工作流状态，不复制来源历史或参考目录。管理员 reset 在新 Epoch replay 同一不可变 Case Revision，并复用所选 Brief、Case Truth 和全部成功 Investigation Result Snapshot；replay 不重新调用 Synthea 或模型。

### 10.4 确定性与故障注入

- 生成请求固定 Provider commit、profile/localization hash、模块模式、人口参数和 seed；相同来源 Bundle 的 Index Encounter 选择、历史/真值闭包和 case type 保持确定。
- Investigation resolver 先匹配 Case Truth 中完全相同 LOINC 的 Observation；缺失时才调用受限模型。首次验证成功的结果按 input hash 冻结，重试、reset 和 replay 复用 snapshot。
- 支付规则可确定地产生 success、declined 或 ambiguous；LIS 规则确定地产生结构化报告。outbox 通过测试 handler 验证 retryable failure、lease 恢复、重复消费和结果未知。
- 数据库备份的 canonical state hash 覆盖 FHIR current/history 以及除派生 Search 索引、schema migration 和 runtime metadata 外的全部持久领域表；`*_json` 按 JSON 值规范化，递归排除 FHIR `lastUpdated` 和存放 hash 自身的列。它用于同一 schema 下的备份/恢复等价校验，不宣称是跨版本 replay hash。
- 当前 replay 是 Case Revision 到新 Epoch 的重新物化，不是 command-log replay；当前没有逐步 state hash 或通用故障编排 API。

### 10.5 Case Truth、Brief 与 Action Trace

Case Truth 表示普通岗位不能直接读取、只能通过问诊和合规业务观察发现的本次病例事实。Patient Brief 控制患者开场与受控问答；Investigation Result Snapshot 控制已成功解析的检查结果。三者都不进入普通 FHIR Search、Visible Source History 或 HIS 查询。

Action Trace 按 Scenario Run 记录 Command 尝试、结果、Effect 引用和资源版本，事件时间使用当前 Epoch 的 Virtual Time；Audit Event 继续保存真实接收时间。它不记录普通读取，不保存模型 chain-of-thought，也不代替 Audit Event 或 Provenance。首期不定义评分规则、Evaluation Spec、分数变化或 evaluator service account。

### 10.6 重置与 Epoch 隔离

`workspace_epoch` 当前使用 `building`、`active`、`closing` 和 `closed` 状态；没有 purge 入口。直接开始或 reset/replay 协议：

1. 普通开始只能消费一次具有活动成功 Brief 的 Case；只有管理员可以 reset/replay。Command 以新 Epoch 的 `building` 状态写入本院运行事实。
2. 同一事务把仍为 `active` 的旧 Scenario Run 转为 `closed`，保留已 `completed` Run 的状态与 `completed_at`；随后关闭旧 Epoch、把旧 queued/claimed outbox 标记为 `abandoned`、激活新 Epoch，并切换 `workspace.active_epoch`。
3. 既有浏览器 session 在每个请求重新解析 `workspace.active_epoch` 和当前 Scenario Run，因此下一次读取自动进入新 Epoch；已选岗位仍由 membership 校验。旧预览、receipt、cursor 和业务引用因绑定旧 Epoch 不能在新运行复用。
4. dispatcher 的结果提交重新验证 active Epoch；reset 后返回的旧 claim 变为 `abandoned`，不产生新 Epoch 业务 Effect。

当前没有 checkpoint、command-log replay 或旧 Epoch 清理 API。旧 Epoch、审计和 Action Trace 保留在同一 SQLite 文件中；普通查询只读取 active Workspace/Epoch，Case replay 只复用不可变 Case 资产。

## 11. 认证、授权与审计

### 11.1 认证

首期使用 Better Auth 管理合成 User Account、登录凭证、浏览器 cookie session 和会话撤销，禁用公开注册。运行时为挂号员、分诊护士、门诊医生、收费员、药师和管理员幂等创建预置合成账户。Better Auth 不拥有 Workspace Membership、Practitioner Role、地点或 Scenario 权限。

每个受保护请求先验证浏览器会话，再由 ClinMesh Identity & Access 模块重新解析 active Workspace Membership、选择的 Practitioner Role、active Epoch、组织和地点，形成受信 Actor context。岗位切换通过服务端动作保存当前 session 的角色选择；后续业务 Command 以该 Actor context 写入审计。cookie 或请求体中的角色、Workspace 和 Epoch 不能替代数据库事实。

当前不发布 OAuth/OIDC Provider、JWKS、SMART configuration 或 backend services。DSH 浏览器仍使用当前人类 Better Auth session，execution proof 只证明真实 Tool pipeline 调用，不能替代 Actor 认证；任务 Agent 使用 ClinMesh 私有的短期 Capability Grant token，不将其声明为 OAuth、SMART 或可跨系统互操作的凭据。浏览器会话与 Grant 使用不同协议表面，但都解析为同一种 Actor context。

### 11.2 授权模型

当前权限是以下条件的交集：

```text
(
  valid browser session + active membership + selected Practitioner Role
  OR valid Agent Capability Grant + bound single Practitioner Role + operation allowlist
)
AND active Workspace/Epoch/Scenario Run
AND route/command role allowlist
AND workflow state and target references
```

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
- administrator
- lis-system

只有 `administrator` 能 reset Scenario 或管理 Agent Client/Grant。`lis-system` 不具有交互式登录或任意患者搜索能力；允许的检验结果 Command 只能由受控 outbox context 调用，报告更正还可由窄 HTTP adapter 在验证 administrator 后由服务端绑定同一系统 context。请求正文不能声明系统角色或提交任意 FHIR 内容。DSH Agent 代表当前已登录人类岗位，任务 Agent 通过一个 Grant 承担现有单一 Practitioner Role；两者都不新增医院岗位代码。住院、医保、完整库存、病案和审计员角色在相应能力实施前不进入 seed、导航或授权矩阵。

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

Command Effect 引用和版本保存在 `command_effect` 与 Action Trace；AuditEvent 投影把 Effect 映射为 entity。当前审计不记录普通读取、duration、request ID、organization/location 字段、客户端、delegator 或错误码，也没有审计查询 UI。新增这些能力前不能宣称完整医疗审计覆盖。

Agent Tool 读取和草稿动作不伪装成 AuditEvent。`agent_tool_call` 保存 DSH Session/call ID、context、operation、input hash 和结果；proposal/review 另表保存。人类批准产生正式 Command 时，Tool call 通过 Command `requestId`、`auditId` 和 `action_trace.request_id` 关联既有审计与 Effect，不复制 Command 状态机。

`audit_head(workspace_id, epoch, audit_domain, sequence, hash, version)` 通过条件更新推进，sequence 唯一。并发冲突使整个关键业务事务回滚，服务端重新读取 head 并有界重试；禁止两个事件共享父 hash。若该成本不可接受，则取消线性链承诺，只保留独立不可变事件 hash，不能接受静默分叉。

CommandExecutor 覆盖成功 Command 和进入执行边界后的失败尝试，包括 direct start 与 reset/replay；在 active Epoch 校验前被 HTTP 层拒绝的认证、CSRF 或输入解析错误当前不写 `audit_log`。审计按 Epoch 保留，不随 reset 删除。

hash chain 只能提供防篡改线索，不能在单一管理员控制的 demo 环境中宣称正式防抵赖。关键写操作的审计必须与业务状态同事务提交；审计写失败则业务写失败。普通应用日志不得记录 token、密码、完整身份证、完整病历正文或原始医保凭证。

## 12. 可靠性与性能边界

### 12.1 请求约束

- 所有列表分页。
- `_count` 和所有查询 limit 有硬上限。
- Bundle、transaction、operation 输入限制 entry 数和总字节数。
- 首期不接收 Binary 或附件。
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

当前成功 Command 响应返回 `requestId` 和 `auditId`，持久表通过 Workspace/Epoch、Scenario Run、idempotency key、Audit ID、Action Trace ID 和 outbox event ID 建立关联。Agent proposal 再通过 DSH Session/call ID、proposal ID、review decision 和同一 `requestId` 串联 Tool、Command、Audit 与 Trace。`/api/health` 只报告服务状态与 FHIR 版本。

首期没有生产 metrics exporter、分布式 trace、request log 或管理仪表盘，因此不宣称在线采集 API latency、SQLite busy/transaction duration、Search 规模或 outbox backlog 指标。独立 performance runner 可以在临时 sandbox 重复执行固定工作负载并输出分位数、SQL/存储和 Trace 指标，但不改变生产请求或持久化路径。运行诊断仍依赖数据库 CLI、结构化 API 错误和持久审计/outbox 状态；任何后续日志或指标都不得把患者姓名、身份信息、完整临床正文、token 或自由文本作为标签。

## 13. 代码结构

```text
.
├── apps/
│   ├── web/                 # Vite React SPA
│   ├── dsh-web/             # DSH Host proxy、execution proof 与 React Surface adapter
│   ├── server/
│   │   ├── src/application/ # Identity、Scenario、Workflow、Command、Agent 与 Outbox
│   │   ├── src/fhir/        # FHIR 能力注册表
│   │   ├── src/infrastructure/sqlite/ # 数据库生命周期与 Repository
│   │   └── drizzle/         # 有序 SQLite migration
│   ├── cli/                 # Catalog 驱动的 HIS/FHIR CLI 与凭据 adapter
│   ├── desktop/             # 现有工程壳；首期不开发
│   ├── mobile/              # 现有 Expo 工程壳；首期不开发
│   └── docs/                # VitePress 投影与公开页面 manifest
├── packages/
│   ├── contracts/           # Zod schema、DTO、FHIR 辅助类型
│   ├── core/                # 无平台领域函数和客户端规则
│   ├── ui/                  # DOM primitives 与 token
│   └── views/               # 当前 Desktop 工程壳；保留未来共享业务视图边界
├── docs/                    # canonical Markdown
├── scripts/                 # 文档投影、验证和 seed 工具
├── vendor/dsh-react-surface/ # 固定 commit 的 React Surface submodule
└── .agents/                 # skills 与 Agent Notes
```

跨端包职责和未来 Mobile 共享限制见[跨端前端架构](frontend-architecture.md)。当前 Server 以少量深模块组织：`IdentityService` 解析受信 Actor context，`ScenarioService` 拥有 Epoch 转换，`WorkflowService` 拥有首期门诊状态流，`CommandExecutor` 统一事务/幂等/审计，`AgentIntegrationService` 拥有 Page Context 与 Tool/proposal/review 关联，FHIR/Workspace/Outbox Repository 封装 SQLite 读写。Insurance、住院、完整库存、IG 和外部 Scenario package 在进入实际范围时再增加。

依赖规则：

- Application 模块不依赖 Hono Request、React、DSH、CLI、Agent runner 或未来 MCP SDK；当前直接组合 SQLite Repository 与数据库事务，不宣称已有第二数据库的抽象实现。
- Hono route 只解析/验证 HTTP 输入并调用应用服务，不能复制 Workflow 状态机。
- standalone Web、DSH Surface 与 CLI adapter 调用应用层 Query/Command；Agent HTTP adapter 只签发/校验 context、Grant 和结果关联，不能直接访问业务 Repository 或复制状态机。未来 MCP 或其他 AG-UI adapter 同样只能调用应用层。
- `packages/contracts` 不导出 SQLite driver、表定义或应用私有类型。
- `contracts/core` 只放真正跨端的 schema、类型和纯函数，不形成无归属工具箱。

## 14. 测试策略

### 14.1 应用与 Web 测试

- Hono 与真实临时 SQLite 的场景测试覆盖认证、角色、Scenario、挂号、分诊、医生首诊/复诊、签署/修订、支付三结局、LIS、发药和 Epoch 隔离。
- Command 与 Repository 聚焦测试覆盖幂等、expected version、事务回滚、审计链、outbox lease/retry/ambiguous 和 SQLite 生命周期。
- React 组件测试覆盖认证缓存隔离、五岗位 wiring、加载/空/错误/冲突/无权限状态、分页、支付拒绝重试、长中文文本和 locale/theme 控件。
- DSH adapter 测试覆盖 proxy 限制、Cookie/Origin、proof 防重放、单文件 artifact、Page Context 续签、动态 Tool schema、detached review 和 ShadowRoot/Memory Router composition。

### 14.2 FHIR 合约测试

- CapabilityStatement 与实际 resource ownership、interaction 和 SearchParameter registry 一致。
- HTTP 黑盒测试覆盖 read、vread、instance history、白名单 search、完整 `self`/`next` link、`_total=none|accurate` 和弱 ETag。
- 两个 Workspace/Epoch 的 current、history、total 和签名 cursor 互不泄漏，cursor 不能跨 query、resource type、Workspace 或 Epoch 重放。
- 未知资源、未知参数、坏 cursor 和 generic `PUT` 返回稳定 OperationOutcome。
- 当前没有官方 R5 Profile Validator、OperationDefinition、create/update、If-Match、tombstone 或 `Prefer` 合约测试，因为服务器不宣告这些能力。

### 14.3 Repository 合同测试

首期 Repository contract suite 运行于真实临时 SQLite 文件。未来增加数据库 adapter 时，同一套外部行为测试必须同时运行于新旧 adapter，不能用 mock 声称可迁移。

覆盖：

- 当前资源 + 历史 + Search 索引原子更新与索引重建。
- transaction/约束失败整体回滚、条件 update 零行识别和错误分类。
- idempotency key 并发首请求、完成重放和不同 payload 冲突。
- Workspace/Epoch 复合 foreign key、Registration、Prescription 和库存条件写。
- outbox lease 竞争、过期回收、重复消费、retryable failure、ambiguous 和 Epoch abandon。
- audit head 并发推进不分叉，审计与关键业务同事务提交。
- reset 与晚到 callback 并发时旧 epoch 不得影响新数据。

### 14.4 场景测试

每个业务能力必须以可执行场景验收，而不是以类、页面或表存在验收。

首期病例轨迹从 generation、Visible Source History、Brief、direct start、分诊、首诊、Investigation、复诊、处方与文书签署、Encounter 完诊、药品支付到发药和 Scenario Run 完成。自动化故障矩阵覆盖无合格 Index Encounter、Brief 泄漏拒绝、重复开始、模型失败、过敏拦截、旧版本冲突、支付拒绝/ambiguous、LIS 重试、未支付处方禁止发药、已签文书禁止覆盖、部分发药和 reset 后晚到结果隔离。

### 14.5 Agent 安全测试

当前自动化覆盖：

- Page Context 严格 schema、岗位/view 不匹配、Hidden Fact/任意字段拒绝和 Epoch reset 失效。
- execution proof 篡改、过期、Tool/operation/scope 不匹配、call replay 和重复 completion。
- 动态岗位/view Tool 目录、32 Tool 上限、岗位导航收窄、DSH JSON Schema 子集和 context 到期注销。
- 草稿 action 更新 context 但保持 page lease；proposal 立即返回 pending，明确批准关联 Command/Audit/Trace，取消或 scope 变化不产生 Effect。
- 固定 loopback proxy、Cookie/Origin、body/response/timeout 限制和非 loopback 拒绝。

Catalog seam 验证 operation、CLI path、HTTP mapping、岗位、风险、schema、canonical HIS route 覆盖和 FHIR 白名单。Identity seam 使用真实 SQLite 与 HTTP 验证 token hash、单岗位 allowlist、伪造 context header、Client 禁用、撤销、过期、Epoch reset、Catalog hash 和 policy version 失效。CLI process seam 验证 stdout/stderr/exit、stdin/file、human profile、Agent fail-closed 和 request shape；真实 Node listener 测试在服务端已提交但响应丢失后通过 receipt 恢复，并证明相同 idempotency key 不重复 Effect。Skill seam 要求每个命令示例存在于当前 Catalog。

当前没有附件/OCR、Agent OAuth、MCP、自治 Agent Run 或不可信插件。模型内容安全仍需在引入具体 runner 或嵌入式助手时增加针对 prompt injection、恶意病历、术语 display、附件/OCR、历史结果和出站网络的运行时测试；CLI 的结构化 schema、DSH Tool schema 与服务端授权不能替代该层验证。

## 15. 首期实现状态

首期 Web 发布已经形成一个可执行纵向闭环：

```text
登录与受信岗位上下文
  -> 患者检索/合成患者建档与挂号，或 Virtual Patient 直达接诊
  -> 分诊生命体征与医生候诊，或复用 Virtual Patient 的活动病例
  -> 医生受控问诊、首诊草稿与检验申请
  -> 检验费用预览及 success/declined/ambiguous 支付
  -> 持久 outbox 驱动 LIS 结构化报告
  -> 医生复诊诊断、处方和文书草稿
  -> 预览签署、不可变 Composition/Bundle/Provenance 与 Encounter completed
  -> 药品费用支付
  -> 药师部分或完整发药、MedicationDispense 与库存移动
  -> 全部处方行完成后 Scenario Run completed
```

### 15.1 运行与持久化

- Node.js Hono 同时提供 Web SPA、认证、HIS/Scenario API、FHIR R5 只读 API 和健康检查。
- file-backed SQLite 启用 foreign keys、WAL 和五秒 busy timeout；四十四个有序 migration 建立身份、FHIR、Scenario、Command、审计、outbox、门诊事实、结构化病历、诊断与处方、持久生成任务、Synthetic Patient Profile/Revision、Synthetic Case Instance、Brief Revision、Investigation Result Snapshot、来源 R4 artifact、Visible Source History、Epoch materialization、Agent Client/Grant/Workspace Actor/receipt role，以及 DSH Page Context/Tool/proposal/review 关联。
- 数据库 CLI 提供 migrate、verify、reindex、backup 和 restore；已有旧版数据库执行 migrate 时先在同目录创建并验证升级前备份，Server 进程只验证 migration。
- CommandExecutor 统一 `BEGIN IMMEDIATE`、expected versions、幂等 receipt、FHIR current/history/search、领域事实、AuditEvent、Action Trace 和 outbox 原子提交。
- 同进程 dispatcher 持久化 claim/lease/attempt/correlation，支持失败重试、ambiguous、重复消费和旧 Epoch abandon。
- Docs 开发与预览入口使用 `51898/51899`，Web 开发入口使用 `51888`，Synthea Provider 默认在宿主与容器内使用 `51878`，内部 cn-health localizer 使用 `51879`，Server 本地、宿主与容器内统一使用 `51868`。standalone Provider 仅绑定宿主回环地址，宿主端口可覆盖；localizer 不发布宿主端口。默认 Dockerfile 与 Compose 固定单实例和命名持久卷，不包含 Java 或 Synthea；`compose.synthea-provider.yaml` 启动两个非 root、只读服务并只读挂载版本化 Candidate，`compose.synthea.yaml` 复用它们并为一键部署注入容器内 URL。Server 通过可选 URL adapter 调用固定协议，不把 Provider 健康状态作为启动门禁。

### 15.2 协议与业务

- Better Auth 禁止公开注册，并幂等 seed 六个合成账户；Human 请求重新解析 Membership、Practitioner Role 和 active Workspace/Epoch。Agent 请求从短期 Capability Grant 重新解析同一 Actor context，原 token 不持久化。
- FHIR 固定 R5 `5.0.0`，当前资源只声明 read、vread、instance history 和 search-type；Search 白名单与负面保证见 5.2 节。
- `clinmesh` CLI 从 Catalog 生成全部 canonical HIS 命令和五个只读 FHIR 操作，提供离线 list/schema、JSON/table 输出、human profile、Agent Grant、结构化错误和 Command receipt 恢复；七个领域 Skills 与真实命令路径共同受测。
- 五个岗位通过真实 API 推进同一个 Encounter。医生完成 Encounter 与药师完成 Scenario Run 是独立状态变化。
- 支付支持 success、declined 和 ambiguous；LIS 通过持久 outbox 推进独立检查申请的受理、执行和结构化报告签发，兼容收费检验仍只在支付成功后生成报告；药房只处理已签且成功支付的处方。
- 结构化病历草稿使用 CAS 版本并可在 Web 恢复；独立签署不完成 Encounter。签署件不可普通覆盖，修订只能从最新版本创建新的 Composition、document Bundle、Provenance 和 Clinical Document Revision。
- 诊断草稿使用受控目录和独立 CAS 版本；确认时恰有一个主诊断，并原子创建 Condition、更新 Encounter.diagnosis 和记录 Provenance。确认后仍可重新进入草稿，再次确认创建线性 revision 并保留旧 Condition 历史；既往 Condition 不进入本次诊断编辑状态。
- v3 处方草稿使用受控目录和独立 CAS 版本，草稿不发布 FHIR；开具时重新校验诊断、过敏、药品组合和五项用药字段，再创建 Prescription、带 Actor/Practitioner Role 外键的 authorship 与 MedicationRequest。无需用药是带责任人的互斥正式结论；未调剂处方可追加撤回事实，取消 MedicationRequest，但不抹除已收费历史或触发退款。v1/v2 保留原药品目录与组合复诊入口。
- Synthea Profile、Case Truth 和本院 R5 事实保持独立 owner；来源 R4 coding 不通过疾病或药品 mapping gate 转为本院编码。

### 15.3 Web 与明确边界

- Web 提供挂号员、分诊护士、门诊医生、收费员、药师和管理员入口；管理员可生成 Synthetic Profile/Case、浏览 Visible Source History、生成并选择 Brief、直接开始病例和 reset/replay。医生工作台从全局 Reference Release 分页搜索诊断和药品，从病例级目录搜索可生成结果的检验；诊断、检验和处方有效修改自动保存，已创建事实固定 coding/display 快照。Investigation 区分永久不支持的取消和可恢复失败的重试。病例库继续提供责任范围内的已完诊 Encounter 与受控更正入口。服务端状态只由 TanStack Query 缓存，退出或跨账户登录会清除非 session 查询。
- 可见字符串具有中文和英文 catalog；主题支持 system、light 与 dark。岗位页面具有分页、加载、空、错误、冲突、无权限和成功状态，并覆盖长中文文本与窄视口。
- DSH Web 可从统一 launcher 打开同一完整工作台，使用 Memory Router、ShadowRoot 和动态岗位 Tools；Agent 可执行读取、导航、选择、草稿和 preview，正式动作只进入 detached 人工审阅。
- `clinmesh` CLI 通过 Operation Catalog、单岗位 Capability Grant 和领域 Skills 开放当前 Query、Command 与只读 FHIR 能力。
- 首期不包含 Desktop/Mobile 产品行为、模型 runner、AG-UI Gateway/MCP、自治 Agent、评分、附件、真实外部系统、完整医保/住院/库存、远程数据库、多实例或高可用。
- 当前没有 FHIR generic write、自定义 FHIR Operation、正式 Profile/IG、官方 Validator、标准 compartment、metrics exporter 或公开在线 SLA。

## 16. 关键风险与缓解

| 风险 | 后果 | 缓解 |
| --- | --- | --- |
| 把“支持 FHIR”理解成实现全服务器 | 范围失控、边缘性能不可控 | CapabilityStatement 白名单，按场景增量实现 |
| FHIR 与领域表双向写 | 数据漂移 | 每类数据唯一 owner，domain projection 只读 |
| 强行 FHIR 化医保/库存/交账 | 语义错误、事务被客户端拆散 | 本地 command API + 标准只读投影 |
| R5 生态不如 R4 成熟 | 类型、validator、CN profile 复用困难 | 自有精简 R5 IG；保留独立 R4 adapter 边界 |
| SQLite 单 writer 出现持续竞争 | 岗位轮询或写入超时 | 短 `BEGIN IMMEDIATE`、组合索引、有界锁等待和迁移触发指标 |
| 单进程或容器丢失 | 模拟任务中断或数据回到初始状态 | 持久 outbox、显式持久卷、备份恢复和重建演练 |
| 客户端或 dispatcher 重试副作用 | 重复开嘱、扣费或发药 | idempotency、expected version、ambiguous 状态和对账 |
| Encounter 完成与 Scenario Run 完成混淆 | 药房错误修改临床状态 | 医生完成 Encounter，发药只终止 Scenario Run，分别测试 |
| 原型内存状态被复用 | 授权、持久化和事务成为页面假象 | 正式切片按 Command 与真实 API 重写，不导入原型状态机 |
| 场景数据互相污染 | 回放不可信、数据泄漏 | Workspace/Epoch SQL 强制过滤和跨 Workspace 测试 |
| Agent context 或 lease 失效后仍可提交 | stale proposal 产生无责任归属 Effect | scope/TTL 失效关闭审阅，失败 proposal 标记 `stale`，正式 Command 始终重验人类 session |
| DSH Tool schema 与 runtime 子集不一致 | Host lease 失败并形成重试风暴 | Surface adapter 投影受支持 schema，artifact 和真实 lease 验证 |
| 术语版本和许可不清 | 接口不可复现或合规风险 | 版本化 terminology package，只放合法演示子集 |
| OpenHIS 功能名造成过度承诺 | 误判业务完整度 | 以 executable scenario 和验收测试为唯一完成标准 |
| Repository 被误解为零成本可移植 | 迁移时遗漏 SQL 与运维差异 | 每个新数据库单独设计 adapter、迁移和双端 contract tests |

## 17. 首期确认边界

以下边界已经确认，需求变化必须重新经过 design gate 并更新 canonical spec：

1. 产品界面是 Web-only 的普通门诊发热闭环，同时提供 Agent CLI；不开发 Desktop 或 React Native Mobile 产品行为。
2. 人类岗位为挂号员、分诊护士、门诊医生、收费员和药师；LIS 是系统 Actor，只有管理员能 reset Scenario。
3. 一个 Encounter 贯穿挂号、分诊、首诊、检验和复诊；独立结构化病历签署不改变 Encounter，带 Consultation 的病例通过正式临床事实门禁完诊，首期复诊兼容流只在没有结构化签署根文书时组合签署与完诊；发药完成 Scenario Run。
4. 首期使用单 Node.js 进程和 file-backed SQLite；D1、PostgreSQL 与 Supabase 只保留未来 adapter 迁移方向。
5. FHIR R5 版本固定为 `5.0.0`，项目 canonical base 固定为 `https://caizongyuan.github.io/clinmesh/fhir`。
6. Registration 与 Prescription 是持久领域事实；挂号同事务创建 Account 和挂号 Charge Item。
7. Synthetic Case Instance 固定 Case Truth、活动 Brief 和 Investigation snapshots；reset 在新 Epoch replay 同一 revision，Action Trace 与 Audit Event、Provenance 分开。
8. DSH 原生 Agent 只代表当前人类岗位执行页面 action 和 proposal，任务 Agent 只通过单岗位 Grant 的受控 CLI 行动；首期不实现模型 runner、AG-UI Gateway、MCP、自治 Agent Run、Agent OAuth、Evaluation Spec、评分、附件、真实外部系统或真实患者数据。

## 18. 当前架构保证

- 资源能力注册表维护当前 ownership、interaction 和 SearchParameter canonical；未实现的 profile、operation、terminology 与 compartment 不进入注册表。
- `/fhir/R5/metadata` 只声明该注册表中实际支持的 R5 能力。
- FHIR current/history/Search index 在同一 SQLite 事务原子更新，并可重建验证。
- 所有业务 Command 使用 idempotency key；修改既有业务资源的 Command 使用 expected version 或绑定预览版本。
- 领域原生资源的 FHIR 投影不接受 generic write。
- 严格 Search 对未知参数返回 `400 OperationOutcome`；Workspace/Epoch 进入 search、total、history 和 cursor。
- clinical/financial Command 同时生成 AuditEvent 与 Action Trace；文书签署/修订生成 Provenance，任一同事务写入失败时整体回滚。
- 结构化病历草稿按病例 CAS 更新；签署创建唯一根文书但不推进 Encounter，修订只从最新 Composition 创建线性替代版本。
- v3 处方草稿按病例 CAS 更新且不创建 FHIR 资源；正式开具与无需用药互斥，责任 Actor/Practitioner Role 受 workspace 级外键约束，撤回以追加事实取消未调剂 MedicationRequest，并保留处方、支付和 FHIR 历史。v1/v2 的固定目录配置与初始定义 hash 不被升级改写。
- generation 固定 Synthea commit、profile/身份依赖、experimental-preview clinical-display catalog provenance 和 seed；翻译 gap 保留来源 display 并绑定有界 warning，结构或 provenance 错误仍拒绝患者，reset/replay 复用 Case、Brief 与 Investigation snapshots，不重新调用外部模型。
- 真实 file-backed SQLite 测试覆盖 transaction rollback、零行条件写、幂等竞争、outbox lease/recovery、audit head、backup/restore 和 reset/callback 隔离。
- 一个 Encounter 贯穿首期门诊；独立结构化病历签署与 Encounter 完成是不同事实，首期复诊兼容流仍可组合处理，发药只完成 Scenario Run。
- 挂号原子创建 Registration、Encounter、Queue Task、Account 和挂号 Charge Item；Prescription 稳定关联 MedicationRequest、费用、支付和发药。
- Virtual Patient 直接接诊原子复用其合成 Patient；没有活动病例时建立 Registration、Encounter、Account 和医生 Queue Task，可进入首诊的活动病例则复用同一组事实，不伪造分诊或费用事实。
- 五个人类岗位可以通过 Web/API、单岗位任务 Agent 可以通过 CLI 完成由 Synthetic Case 直接开始的 Scenario；生成库、来源历史和全局目录查询满足分页与交互基线。
- standalone Web 与 DSH React Surface 复用同一 Web application；DSH 原生 Session 只能获得当前岗位/view 的窄 Tools，正式业务 Effect 需要人类审阅并可关联 Tool、proposal、review、Command、Audit 与 Trace。
- `clinmesh` CLI 由同一 Operation Catalog 生成命令树，Capability Grant 绑定单一 Practitioner Role、Workspace/Epoch、Scenario Run、policy version 和真实过期时间。
- Node.js 服务重启后从同一 SQLite 文件恢复；备份/恢复验证 schema、integrity 与 canonical state hash。
- 首期没有 Desktop、Mobile、模型 runner、AG-UI Gateway、MCP、自治 Agent、评分或附件入口；Agent 能力只声明当前 DSH Surface Tools、CLI、Capability Grant 和 Skills。
- 所有演示数据都有合成数据标记，不包含真实敏感信息或真实平台凭证。

## 19. 参考资料

项目内：

- [Web Demo 运行与部署架构](./demo-architecture.md)
- [跨端前端架构](./frontend-architecture.md)
- [Agent 工程开发](./agent-development.md)
- [Node.js 与 SQLite Web 基础设施决策](../.agents/notes/implemented/architecture/2026-08-23-node-sqlite-web-foundation.md)
- [多岗位发热门诊首期闭环决策](../.agents/notes/implemented/feature/2026-08-23-outpatient-fever-first-release.md)
- [结构化临床文书独立生命周期决策](../.agents/notes/implemented/feature/2026-08-25-structured-clinical-document-lifecycle.md)
- [DSH 原生 ClinMesh React Surface 决策](../.agents/notes/implemented/architecture/2026-08-30-dsh-native-clinmesh-surface.md)
- OpenHIS 研究输入：`references/openhis-itai-pro/`
- Medplum 研究输入：`references/medplum/`

外部标准与参考实现：

- [FHIR R5](https://hl7.org/fhir/R5/)
- [FHIR R5 RESTful API](https://hl7.org/fhir/R5/http.html)
- [FHIR R5 CapabilityStatement](https://hl7.org/fhir/R5/capabilitystatement.html)
- [FHIR R5 Extensibility](https://hl7.org/fhir/R5/extensibility.html)
- [FHIR R5 OperationOutcome](https://hl7.org/fhir/R5/operationoutcome.html)
- [SMART App Launch](https://hl7.org/fhir/smart-app-launch/)
- [CN Core R4 参考项目](https://github.com/HL7China/CN-CORE-R4)
- [SQLite Transactions](https://www.sqlite.org/lang_transaction.html)
- [SQLite Write-Ahead Logging](https://www.sqlite.org/wal.html)
- [SQLite Online Backup API](https://www.sqlite.org/backup.html)
