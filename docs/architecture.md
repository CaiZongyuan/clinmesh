# 中国公立医院仿真 HIS 详细架构设计

- 状态：首期方案已确认，Phase 0 已交付
- 日期：2026-08-23
- 适用范围：Web 产品演示、技术验证、后续 Agent 环境
- 首期运行决策：[Web Demo 运行与部署架构](./demo-architecture.md)
- 领域词汇：[ClinMesh 仿真医院领域](../CONTEXT.md)
- 参考实现：`references/openhis-itai-pro/`、`references/medplum/`

## 0. 执行摘要

本系统不是生产医院信息平台，也不是完整 FHIR Server 产品。它用可重复、可审计的合成医院场景，让人类岗位先通过 Web 完成真实业务交接，并为后续 Agent 接入保留受控接口。首个发布只证明多岗位普通门诊发热闭环和支撑该闭环的基础设施。

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
```

核心决策如下：

1. **FHIR 版本采用 R5 `5.0.0`。** 截至本文日期，R5 是最新已发布稳定版本；R6 仍是 CI build。Medplum 5.1.30 仍以 R4 `4.0.1` 为正式服务版本，因此借鉴其架构，不直接依赖其 R4 类型和服务端实现。
2. **标准接口和业务命令分层。** FHIR 用于标准资源查询、交换和受控写入；复杂状态转换由显式 FHIR Operation 或 `/api/his/v1` 命令完成。禁止让客户端通过多个通用 CRUD 自行编排挂号、医嘱签发、发药、结算、退费或医保撤销。
3. **按资源确定唯一权威数据源。** 标准临床和主数据以 FHIR JSON 为权威记录；库存、医保、收银交账、仿真运行等领域以规范化关系表为权威，并生成只读 FHIR 投影。禁止同一事实被两个模型双向修改。
4. **不追求完整 FHIR Search。** 只实现资源能力注册表列出的 SearchParameter canonical，并由 CapabilityStatement 引用同一清单；本服务器首期固定采用严格处理，不支持的参数返回 `OperationOutcome`。
5. **首期只交付 Web 和 SQLite。** Hono 在单个 Node.js 进程中运行，一个本地 SQLite 文件持久化所有业务状态；Desktop、React Native、Cloudflare/D1、PostgreSQL/Supabase 和多实例部署均后置。
6. **仿真能力是一等领域，但评分不是首期基础设施。** 每个 Scenario Run 绑定 Workspace/Epoch、虚拟时钟、确定性随机种子、Hidden Fact、Reveal Policy、外部系统脚本和 Action Trace；首期没有 Evaluation Spec、评分规则或 evaluator runtime。
7. **SQLite 是首期真实数据库。** 所有关系约束、迁移、备份恢复、幂等竞争、outbox 恢复和 reset 都在 file-backed SQLite 上验证。未来数据库通过新 adapter 和显式迁移接入，不维护未使用的兼容路径。
8. **一个 Encounter 贯穿首期门诊。** 医生复诊时签署不可变临床文书并完成 Encounter，药品支付和发药随后发生；发药完成 Scenario Run，而不是再次推进 Encounter。
9. **后续 Agent 不拥有第二套业务内核。** AG-UI、Agent tools 或 MCP 只能适配受信 Actor context、共享 Command、CAS/expected version 草稿和人类确认签署，不能绕过授权、状态机或审计。

## 1. 背景与目标

### 1.1 产品定位

首期消费者是通过 Web 工作台扮演挂号员、分诊护士、门诊医生、收费员和药师的人类用户，LIS 作为受控系统 Actor 参与同一 Scenario Run。系统应有足够真实的中国医院业务约束，但不复制生产 HIS 的全部工程和监管复杂度。

后续 Agent 会通过标准 API 和窄工具执行同样的受限业务动作。该方向只约束当前 Command 与授权边界，不构成首期交付项或能力声明。

### 1.2 必须满足

- 支持普通门诊发热场景所需的患者、组织、科室、挂号、分诊、就诊、检验、处方、药房、收费和病历语义。
- 对外提供版本明确、能力可发现、错误可解析的 FHIR R5 JSON API。
- 为 Web 岗位提供由服务端解析的受信 Actor context 和共享 Command。
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
- FHIR profile、术语和自定义 operation 形成可版本化的轻量 Implementation Guide。

### 1.4 明确不做

首期不实现：

- 生产级 HIS、真实诊疗、真实费用结算或真实个人健康信息存储。
- Desktop、React Native Mobile、离线写入和多端语义 parity。
- Agent runtime、AG-UI、MCP、OAuth/SMART Agent 凭证、Evaluation Spec 和评分基础设施。
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

### 3.2 两种首期接口、一个业务内核

| 接口 | 消费者 | 用途 | 是否作为业务权威入口 |
| --- | --- | --- | --- |
| FHIR R5 REST | 标准客户端、Web 查询层、集成测试 | 标准资源读写、查询、历史、Operation | 标准资源是；复杂流程不是 |
| HIS Command API | Web 工作台、内部编排 | FHIR 难以表达的业务聚合和动作 | 是 |

Web 页面和 FHIR Operation 必须调用同一个 command handler。禁止复制状态机或在路由层直接写库。后续 Agent Tool API、MCP 或 AG-UI 只能成为第三种 adapter，同样调用已有查询与 Command，不成为新的业务权威入口。

### 3.3 权威数据所有权

每类数据必须在注册表中声明一种所有权：

- `fhir-native`：FHIR JSON 是唯一权威记录。
- `domain-native`：规范化领域表是唯一权威记录，FHIR 是只读投影。
- `external-package`：由 IG、术语包或 seed 提供，只读。
- `simulation-private`：仅 Scenario Runtime 与受控场景维护入口可见，不进入普通 FHIR API；具有 reset 权限不自动获得读取权。

同一个资源不能同时接受 FHIR CRUD 和领域表写入。`owner_kind` 决定 API 写策略。业务 command 可以修改 `fhir-native` 资源，但仍只写 FHIR Resource Store，不另建一份同义领域事实。

初始 ownership 注册表：

| 所有权 | 资源/聚合 | 写入方式 |
| --- | --- | --- |
| `fhir-native` | Patient、Organization、Location、Practitioner、PractitionerRole、Schedule、Slot、Appointment、Task、Encounter、Condition、Observation、各类 Request、Medication、MedicationDispense、Account、ChargeItem、Invoice | 低风险资源可受控 CRUD；有状态机的资源只允许 Command/Operation |
| `fhir-native immutable` | 已签署文书 Bundle/Composition、Provenance | 只创建新的业务资源或修订关系，不覆盖已提交业务实例 |
| `domain-native` | Registration、Prescription、PaymentTransaction、RefundTransaction、CashierShift、医保调用/结算、库存账、EMR 编辑草稿、Scenario Run、Action Trace、audit_log | 只通过 `/api/his/v1` 或内部 Command 写入 |
| `domain-projection` | AuditEvent、Claim/ClaimResponse/EOB、PaymentNotice/PaymentReconciliation、InventoryItem/SupplyDelivery 等交换视图 | 从领域聚合同事务生成，FHIR API 只读 |
| `external-package` | IG 基础资源、CodeSystem、ValueSet、ConceptMap、演示目录 | 随版本包安装，只读 |
| `simulation-private` | Hidden Fact、Reveal Policy 和故障规则 | 仅 Scenario Runtime 与受控场景维护入口可访问 |

账务边界特别约定：Account、ChargeItem、Invoice 是标准交换事实并保存在 FHIR Resource Store；实际收款、退款、医保基金分配和收费员交账由领域账务表负责。两者通过明确引用关联，不把“账单”和“支付流水”混成一个资源。

### 3.4 部署拓扑

首期硬依赖只有浏览器、一个 Node.js 服务端进程和一个本地文件系统上的 SQLite 文件。开发环境可以让 Vite 单独提供静态资源并代理 API；可部署构建由 Node.js 服务同时提供静态资源、SPA fallback、HTTP API 和 FHIR API。

数据库文件必须放在提供 SQLite 锁语义的本地磁盘或单实例容器持久卷中。首期不支持多个服务实例或多个进程同时写入同一文件。outbox dispatcher 与服务同进程，但待处理状态必须持久化；正确性不能依赖内存 timer 或进程持续存活。

D1、PostgreSQL 或 Supabase 只在出现公开托管、多实例、持续写竞争或独立运维需要时重新评估。迁移时新增真实 adapter 与迁移工具，不修改业务 Command contract 来迁就数据库。

### 3.5 深模块与 seam

模块的 interface 同时是调用者和测试的主要表面，必须包含输入、状态前置条件、错误、幂等和顺序约束；HTTP/FHIR adapter 不暴露内部 repository 或状态机细节。

建议的深模块：

- `CommandExecutor`：用一个受信 context 执行/预览强类型 Command，内部隐藏授权、幂等、dependency set、write plan、审计和 outbox。
- `FhirRepository`：提供资源读、历史、受控搜索和原子 write plan；首期只有 SQLite adapter，interface 用于隔离领域、协议与持久化错误，不伪造第二数据库实现。
- `ScenarioRuntime`：隐藏 building/active epoch、虚拟时钟、事件推进、checkpoint 和 reset 切换协议。
- `PolicyEvaluator`：统一计算 resource、field 和 Actor context binding，查询与写入调用同一 interface；未来 Agent 风险策略在该结果上进一步收窄权限。
- `ExternalOperationPort`：统一 correlation、inflight/ambiguous、查询和补偿；每种医保/支付/LIS 模拟器只是 adapter。

删除任一模块时，其复杂度应重新散落到多个调用者，说明模块确实提供 leverage；只做参数透传的浅模块应合并。

## 4. 领域边界

| 领域 | 主要职责 | 权威模型 | 首期 |
| --- | --- | --- | --- |
| Identity & Access | Web 用户、岗位、Workspace Membership、会话和策略 | 关系表 + Better Auth | 必须 |
| Workspace & Simulation | Scenario Run、隔离、时钟、事件、Hidden Fact、Action Trace 和管理员重置 | 领域表 | 必须 |
| Organization & Workforce | 医院、科室、病区、诊室、床位、人员、岗位 | FHIR native | 必须 |
| Terminology | CodeSystem、ValueSet、ConceptMap、目录版本 | FHIR native / package | 必须 |
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
| Agent Integration | AG-UI、窄工具、Agent 凭证与风险策略 | 现有 Command 的 adapter | 后续 |

## 5. FHIR R5 策略

### 5.1 版本决策

统一基路径：

```text
/fhir/R5
```

FHIR API base 是部署 origin 下的 `/fhir/R5`。项目 IG、Profile、Extension、ValueSet、CodeSystem、SearchParameter 和 OperationDefinition 使用固定 canonical base：

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

必须提供：

- `GET /fhir/R5/metadata`
- `GET /fhir/R5/{ResourceType}/{id}`
- `GET /fhir/R5/{ResourceType}/{id}/_history/{vid}`
- `GET /fhir/R5/{ResourceType}/{id}/_history`
- `GET /fhir/R5/{ResourceType}?search-params`
- 对明确允许的资源提供 `POST`、`PUT`；首期若支持 PATCH，只接受声明的 JSON Patch Content-Type，不暗示 XML Patch/FHIRPath Patch
- 对明确动作提供 `POST /fhir/R5/{ResourceType}/{id}/$operation`
- `HEAD`、conditional create/update、`_format` 和 `Prefer: return=` 逐项进入能力注册表；未实现就不宣告

首期不声明：

- system history
- Bulk Data export
- GraphQL
- 全资源 transaction Bundle
- 任意条件 delete
- 任意 `_include:iterate` 或无限 chained search
- XML

`CapabilityStatement` 从资源能力注册表生成，不能手写一份与实现漂移的静态 JSON。注册表逐资源记录：profile/supportedProfile、ownership、interaction、conditional interaction、SearchParameter canonical、reference target profile、terminology binding、状态转换、custom operation 及调用层级、业务修订规则、compartment/security 和 projection source。

### 5.3 资源映射

#### 5.3.1 直接作为 FHIR native

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
| 候诊/叫号任务 | `Task` | `focus` 指向 Encounter，`businessStatus` 表示待叫、已叫、过号等 |
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

#### 5.3.2 FHIR 资源加本地 Profile/Extension

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

签署临床文书的业务实例不可原地覆盖。后续更正或修订创建新的 document Bundle、Composition 和 Provenance，并通过 `Composition.relatesTo` 表达 replaces/transforms。FHIR `_history` 只记录同一 logical id 的服务器版本，不作为临床修订链、Provenance 或 AuditEvent 的追加机制。

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
| Hidden Fact、Reveal Policy 和故障注入 | Simulation private API | 不进入普通 FHIR |

FHIR `Basic` 不是默认逃生口。只有概念确实没有资源、无需复杂行为且短期只需交换时才考虑，并应优先定义正式 profile 或本地 API。

医保投影必须遵守资源原义：Coverage 表达保障资格，不表示一次人员查询；Claim 表达向付款方提出的费用申报；ClaimResponse 表达付款方裁决；ExplanationOfBenefit 是面向受益人的裁决结果表达，不是接口调用日志。签到、查询、上传批次、游标、重试和原始报文不得机械转换为 Claim 系列资源。一次结算、多次申报、撤销和重结算之间使用稳定 identifier 和明确 replacement 关系。

### 5.4 中国术语策略

术语是接口兼容性的核心，不是 UI 字典。

至少维护：

- 院内患者标识、就诊类型、科室类型、床位状态、队列状态。
- 中国身份证件类型、行政区划、民族、职业等基础编码。
- 中国临床版 ICD-10、手术操作编码及本地诊断目录。
- 药品国家编码、批准文号、剂型、用法、频次、单位和医保目录编码。
- 医疗服务、收费项目、医保医疗类别、险种和基金类别。
- 中医疾病、证候、治法和煎服法。

实现原则：

- FHIR 绑定使用 canonical URL + version，不只保存 display；每个 coded 元素明确 `required`、`extensible`、`preferred` 或 `example` binding strength。
- 院内码、国家码、医保码只有在表达同一个语义概念时才可并列于同一个 `CodeableConcept.coding`；属性、分类和价格目录号不得混入同一概念。
- 本地到国家/医保编码映射使用 `ConceptMap`，不在业务代码中写 switch；ConceptMap 不代表映射天然无损、双向或可自动应用。
- 编码导入保留来源、版本、生效期和停用状态；运行时区分未知 code、inactive code、版本不匹配和 display 不一致。
- 若 CapabilityStatement 宣告 `$validate-code`、`$expand`、`$lookup` 或 `$translate`，实现必须满足所声明的范围；首期做不到就不宣告 terminology operation。
- 对有许可限制的术语，只提交合法的最小演示子集或生成的虚构术语，不把未授权全量码表放入仓库。

### 5.5 FHIR Search 最小实现

每个受支持参数必须引用一个 R5 `SearchParameter` canonical 定义。标准参数采用 R5 定义；项目自定义参数在 IG 中发布固定 `url`、`version`、`base`、`code`、`type`、`expression`、target 以及 modifier/chain 范围。CapabilityStatement 的 `rest.resource.searchParam.definition` 引用该 canonical，并只声明真实实现的参数；不得从 profile 字段名自行猜测搜索语义。

实现前维护逐资源矩阵：`ResourceType + SearchParameter.code + canonical URL + modifier + chain + sort support`。`patient`、`subject`、`encounter` 等不是跨所有资源的自动同义词；日期参数也必须使用对应 R5 SearchParameter 的真实 code。

首期通用结果控制参数：

- `_id`
- `_lastUpdated`
- `_count`，默认 20，上限 100
- `_sort`，仅白名单字段
- `_summary`
- `_elements`
- `_total=none|accurate`；默认 `none`，首期不伪造 `estimate`

首期只为明确列入矩阵的参数实现以下类型：

- token：完整定义 `system|code`、重复参数的 AND/OR 规则和允许 modifier。
- string：按参数声明标准前缀和可选 `:contains`。
- reference：校验允许的 target type 和类型限定。
- date：按 R5 规则实现已声明的比较前缀。
- quantity/number：只为明确资源、单位系统和精度策略实现。

约束：

- 使用签名或认证加密的 keyset cursor，不暴露数据库 offset。cursor 绑定 workspace/run epoch、规范化查询 hash、policy version、排序键、resource ID tie-breaker 和过期时间；客户端不得解析或跨上下文重放。
- 明确分页是弱一致 keyset 语义：并发更新可能造成重复或遗漏，客户端按 resource id/version 去重；需要快照语义的评测使用 checkpoint。
- `_include` 和 `_revinclude` 首期最多一跳、最多 50 个附加资源。
- chained search 最多一层，只开放白名单链。
- 不实现 `_has`、递归 include 和任意 FHIRPath filter，除非有明确场景。
- 本服务器首期固定使用严格搜索处理：未知参数、未知 modifier 和不支持的组合返回 `400 OperationOutcome`；不支持 `Prefer: handling=lenient`。这是本服务器策略，不宣称是规范唯一允许行为。
- 授权过滤必须参与 SQL，而不是拿到结果后再过滤。
- Bundle link 返回可直接调用的完整 `self` 和 `next`，Agent 只能跟随服务端给出的同源 URL。
- `_total=accurate` 只在受控查询中计算并返回 `Bundle.total`；默认 `none` 时不返回 total。
- 使用 `_summary` 或 `_elements` 返回不完整资源时，按 R5 要求添加 `SUBSETTED` 标签。

### 5.6 版本与并发

每个 FHIR 资源具有：

- `meta.versionId`：在同一 resource type + logical id 内单调递增的整数，以字符串表示；它不是业务修订号。
- `meta.lastUpdated`：真实提交时间，不使用虚拟业务时间替代。
- 业务发生时间：写入各资源对应时间字段，来自 simulation clock。

HTTP 行为：

- 读取返回 `ETag: W/"{versionId}"` 和 `Last-Modified`。
- 更新要求高风险客户端提供 `If-Match`。
- 版本不一致返回 `412 Precondition Failed` + OperationOutcome。
- 删除产生 tombstone 和新历史版本；临床、账务和审计资源默认禁止通用 DELETE。
- 资源实际内容未变化时不创建新版本。
- 管理员 expunge 不属于首期公开能力。

### 5.7 校验与 Implementation Guide

仓库维护：

```text
fhir/
  ig/
    input/fsh/
      profiles/
      extensions/
      terminology/
      operations/
    sushi-config.yaml
  packages/
  generated/
```

流程：

1. 用 FSH 定义本项目 R5 profiles、extensions、CodeSystem、ValueSet、ConceptMap 和 OperationDefinition。
2. CI 使用 SUSHI 生成 IG 包。
3. CI 使用官方 FHIR Validator 校验示例和测试 fixture。
4. 构建时可从固定支持集生成基础 TypeScript 类型、profile-aware 校验元数据和 SearchParameter 提取器，但 TypeScript 类型不能证明 profile conformant。
5. Node.js 运行时执行结构、基数、切片、关键 invariant、Reference target profile 和关键术语校验；复杂规则继续由官方 Validator 合约测试覆盖，避免让每次请求运行完整验证器和全部定义。
6. CapabilityStatement 的 `rest.resource.profile` 表示服务器遵循的基础 profile，`supportedProfile` 表示额外支持/接受的 profile；两者与实际验证策略、部署版本一起发布。

## 6. 接口设计

### 6.1 路径规划

`docs/demo-architecture.md` 中“业务 API 使用 `/api`”继续适用，但 FHIR 标准端点作为明确例外使用独立根路径。

| 路径 | 说明 |
| --- | --- |
| `/fhir/R5/*` | FHIR R5 |
| `/api/his/v1/*` | 非 FHIR 领域命令和查询 |
| `/api/sim/v1/*` | Scenario Run 查询、虚拟时间和管理员 reset |
| `/api/auth/*` | Web 登录、注销、会话和岗位上下文 |
| `/api/admin/*` | seed、迁移状态和管理能力 |

首期路由表不包含 `/api/tools/v1`、`/mcp`、SMART discovery 或 Agent OAuth 端点。后续接入 Agent 时按实际实现的协议版本和能力另行扩展，不能提前发布空路由或虚假元数据。

### 6.2 FHIR 写入策略

FHIR API 不等于所有资源都允许通用写入。

| 写策略 | 资源示例 | 行为 |
| --- | --- | --- |
| 标准 CRUD | Patient、RelatedPerson、部分主数据 | 授权和 profile 校验后允许 create/update |
| 受控 create | Observation、DiagnosticReport | 只允许可信角色或集成 client，引用必须存在 |
| 受控 create/update，状态迁移 Operation only | Encounter、MedicationRequest、ServiceRequest、Appointment | 允许受控创建和合法草稿编辑；签到、签发、停止、出院等迁移只走 `$operation`/command |
| Read-only projection | AuditEvent、ClaimResponse、InventoryItem、PaymentReconciliation 等领域视图 | 未声明写 interaction，generic write 返回 `405` + OperationOutcome |
| 业务不可变 | 已签署文书 Bundle/Composition、Provenance | 后续事件或修订创建新的 logical resource；`_history` 不作为业务追加链 |
| Hidden | Hidden Fact、Reveal Policy、故障规则、内部 command receipt 和 Action Trace | 普通 FHIR API 不暴露 |

### 6.3 自定义 FHIR Operation

业务主体明确对应某个 FHIR 资源时，优先定义 OperationDefinition：

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

FHIR 没有稳定等价物的聚合使用显式 API：

```text
POST /api/his/v1/registrations/actions/register
POST /api/his/v1/encounters/{id}/actions/record-triage
POST /api/his/v1/encounters/{id}/actions/start-first-visit
POST /api/his/v1/encounters/{id}/actions/start-revisit
POST /api/his/v1/encounters/{id}/actions/sign-document-and-complete
POST /api/his/v1/payments/preview
POST /api/his/v1/payments/{id}/actions/confirm
POST /api/his/v1/payments/{id}/actions/refund
POST /api/his/v1/prescriptions/{id}/actions/sign
POST /api/his/v1/dispenses/preview
POST /api/his/v1/dispenses/{id}/actions/complete
POST /api/sim/v1/scenario-runs/{id}/actions/reset

# 后续范围
POST /api/his/v1/cashier-shifts/actions/submit
POST /api/his/v1/cashier-shifts/{id}/actions/approve
POST /api/his/v1/insurance/outpatient/actions/register
POST /api/his/v1/insurance/outpatient/actions/pre-settle
POST /api/his/v1/insurance/outpatient/actions/settle
POST /api/his/v1/insurance/settlements/{id}/actions/reverse
POST /api/his/v1/inventory/movements/actions/transfer
POST /api/his/v1/inventory/stocktakes/actions/commit
```

每个写请求支持：

```http
Idempotency-Key: 018f...
If-Match: W/"7"
X-Workspace-Id: ws-...        # 可选一致性断言，不用于选择 workspace
X-Scenario-Run-Id: run-...    # 可选一致性断言，不用于选择 run
X-Request-Reason: ...          # 高风险读取或写入时必填
```

Workspace、Epoch、Scenario Run 和 Actor 只从服务端 session/context binding 解析。两个上下文 header 若存在必须完全一致，否则立即拒绝；幂等、approval、commit token、audit、cursor 和 outbox 只能使用服务端解析值。未来 Agent token 也必须解析到同一上下文，不增加客户端自报入口。

命令请求包含：

```json
{
  "expectedVersions": {
    "Encounter/018f...": "7",
    "MedicationRequest/018e...": "3"
  },
  "reason": {
    "code": "clinical-care",
    "text": "门诊处方签发"
  },
  "input": {}
}
```

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

Web mutation、outbox dispatcher 和外部模拟器都可能重试，所有业务命令必须幂等。

服务端以 `(workspace_id, epoch, actor_id, operation, idempotency_key)` 唯一识别请求，并保存：

- 规范化请求 hash
- 执行状态
- 完整或可重建响应
- 创建/更新的资源引用
- 外部 correlation ID

数据库唯一索引解决两个并发首请求同时看到“不存在”的竞争。纯数据库 Command 在同一 SQLite 事务写入最终 `completed` receipt。含外部副作用的 operation attempt 与 outbox 使用同一状态机，并在每次推进时由短事务原子更新 receipt：

```text
pending-dispatch -> inflight -> completed
                             -> ambiguous
                             -> failed-final
pending-dispatch/inflight    -> abandoned  # epoch 关闭
```

只有持久化证据证明请求尚未发送的 `pending-dispatch` 才能重新派发。dispatcher 在发送前持久化 `inflight`、correlation ID 和 lease；发送后 lease 丢失或结果未知进入 reconcile/ambiguous，不能直接退回 pending。outbox 永久失败时，未发送的 attempt 进入 failed-final，可能已发送的 attempt 进入 ambiguous；epoch 关闭进入 abandoned。唯一冲突的后到请求读取首请求状态：已完成则返回原响应，pending/inflight 返回 `202` 和查询位置，ambiguous 返回对账指引，不得另起执行。

相同 key、相同 hash 返回原响应；相同 key、不同 hash 返回 `409 IDEMPOTENCY_KEY_REUSED`。receipt 设保留期，响应正文按字段策略脱敏或只保存可重建引用。结果未知的外部操作不得自动当作失败重做，应通过查询或补偿解决。

### 6.6 预览与提交

以下动作必须支持预览：

- 签发成组医嘱
- 发药/退药
- 结算/退费
- 医保预结算/正式结算/撤销
- 库存调拨/盘点损益
- 出院和病案归档

预览返回：

- 将改变的资源和版本
- 金额/库存影响
- 校验警告和阻断项
- `planHash`
- 有效期很短、绑定 actor/workspace/run epoch/dependency set 的 `commitToken`

`dependency set` 至少覆盖相关资源、目录/术语版本、policy version、库存批次、simulation clock revision、schema/tool 版本和外部报价版本。`planHash` 使用服务端 canonical serialization 计算；提交时服务端重建 write plan 并重新检查全部依赖，绝不信任客户端回传的 effects。预览不是锁，过期或状态变化必须重新预览。

## 7. 后续 Agent 环境与工具边界

本节约束未来集成，不属于首期实施或验收。当前不提供 Agent runtime、AG-UI、Tool API、MCP、Agent OAuth/SMART 凭证、Evaluation Spec 或评分入口，也不为这些能力发布 CapabilityStatement 或 discovery 元数据。

AG-UI 只能传输面向用户的消息、状态和确认交互。它必须从服务端受信 Actor context 获取权限，使用与 Web 相同的 Query 与 Command，以 CAS/expected version 更新草稿，并在签署临床文书前取得人类确认；AG-UI 层不得直接访问 Repository 或拥有独立状态机。

### 7.1 FHIR 是系统契约，工具是 Agent 契约

Agent 不应被迫自己组合大量 FHIR Search 和多资源写入。工具层负责：

- 固定 resource type 和 interaction。
- 将自然任务转成窄化查询或单个 command。
- 从服务端 context binding 注入 workspace/epoch/run、patient、encounter、actor 和用途上下文，不能信任模型自报上下文。
- 限制结果数量、字段和时间窗口。
- 把 FHIR OperationOutcome 转成稳定的可重试/不可重试错误。
- 返回证据引用和资源版本，便于 Agent 说明依据。

MCP 只是未来可选的工具传输协议，不是业务领域模型。

### 7.2 不提供全能写工具

不提供：

```text
fhir_request(method, arbitrary_path, arbitrary_body)
sql_query(...)
http_fetch(arbitrary_url)
run_as(user_id)
execute_bundle(arbitrary_bundle)
```

可提供受限只读工具：

```text
fhir.read(resource_type_allowlist, id)
fhir.search(resource_type_allowlist, approved_filters, limit)
```

写工具按业务动作和角色拆分。

### 7.3 建议工具目录

#### 通用临床读取

```text
patient.search
patient.get_summary
encounter.list
encounter.get_context
clinical.get_allergies
clinical.get_conditions
clinical.get_recent_results
clinical.get_medications
catalog.search_medication
catalog.search_service
```

#### 门诊医生

```text
outpatient.start_reception
outpatient.add_diagnosis
order.preview
order.create_draft
order.update_draft
order.sign
order.stop
outpatient.complete_encounter
emr.create_note_draft
emr.sign_note
```

#### 护士

```text
inpatient.verify_order
inpatient.verify_stop_order
nursing.record_vital_signs
nursing.execute_order
nursing.assign_bed
nursing.transfer_bed
```

#### 药师

```text
pharmacy.get_dispense_queue
pharmacy.prepare
pharmacy.preview_dispense
pharmacy.dispense
pharmacy.preview_return
pharmacy.return_medication
```

#### 收费与医保

```text
billing.get_unbilled_items
billing.preview_payment
billing.confirm_payment
billing.preview_refund
billing.refund
insurance.query_person
insurance.preview_settlement
insurance.settle
insurance.reverse_settlement
```

普通医生 Agent 不应看到药师、收费员或医保操作员的写工具。

### 7.4 工具结果

统一结果包含：

```json
{
  "ok": true,
  "data": {},
  "evidence": [
    {
      "reference": "Observation/018f...",
      "versionId": "2",
      "lastUpdated": "2026-08-20T00:40:00Z"
    }
  ],
  "effects": [],
  "warnings": [],
  "requestId": "req-...",
  "auditId": "audit-..."
}
```

输出要求：

- 默认最小字段，不返回整份患者档案。
- 列表必须分页并返回 `nextCursor`。
- 不把 secret、access token、内部 prompt、隐藏真值或未授权字段返回模型。
- 不返回服务端思维过程，只返回事实、规则命中和可操作错误。
- 文书、OCR、外部错误和自由文本放在独立 `untrustedContent` 字段，并携带 source/provenance；该标记只是数据边界，不能单独“防止”模型服从其中指令。

### 7.5 风险分级

| 等级 | 示例 | 策略 |
| --- | --- | --- |
| R0 只读 | 搜索患者、读结果 | 角色和上下文授权，完整审计 |
| R1 草稿 | 创建未签发医嘱、文书草稿 | 幂等 + 版本检查，可由 Agent 直接执行 |
| R2 可逆写 | 签到、更新队列、修正未签署草稿 | 预期版本 + 明确 effects |
| R3 临床/财务提交 | 签发医嘱、发药、结算、退费、出院 | preview + commit；按场景要求模拟人工批准 |
| R4 禁止 | 删除已签文书、改审计、读取隐藏真值、任意提权 | 工具层不暴露，服务端强制拒绝 |

模拟人工批准不是 UI 确认框字符串，而是一个一次性 approval token，绑定：

- 随机 `jti`
- actor 和 delegator
- workspace、run 和不可复用 epoch
- context binding ID/version
- operation 与 `planHash`
- 完整 dependency set
- 真实时间过期

服务端持久化 `approval_grant(jti, ..., status, consuming_command_id)`，状态为 `unused/consumed/revoked`。消费 approval 与业务写在同一个事务中做条件状态转换，并以唯一约束保证一个 grant 只绑定一个 Command；不同 idempotency key 也不能重复使用。测试必须覆盖并发双提交、跨 Workspace/Run/operation 重放和过期 token。

### 7.6 Agent 身份与委托

Token 至少包含：

- `sub`：ClientApplication/Agent 身份
- `workspace_id`
- `practitioner_id` 或服务主体
- `role_codes`
- `organization_id`
- `location_id`
- `purpose_of_use`
- `agent_run_id`
- `delegated_by`，若代表人类执行
- `aud`
- `exp`

Agent 不能在请求体中自行指定 `runAs`。代表用户执行必须由服务端签发受限 token，并在 Provenance、AuditEvent 和 command log 中同时记录 Agent 与委托人。

高风险工具使用服务端 `task_context_binding`，绑定 workspace/epoch/run、actor/delegator、role、purpose、允许的 Patient/Encounter 集合、policy version 和有效期。模型参数只能引用 binding 已授权的对象，不能扩大集合；command handler 每次重新验证目标属于 binding。切换患者或就诊必须走独立 `context.select` 动作，验证当前岗位与目标患者的业务关系并审计。approval/commit token 同时绑定 context binding ID/version，防止恶意病历诱导 Agent 对另一名虽可搜索但不属于当前任务的患者执行动作。

### 7.7 Prompt injection 与工具安全

- 病历、患者备注、术语 display、历史工具结果、外部错误和模拟器消息均为不可信数据；后续支持附件/OCR 时同样按不可信内容处理。
- 不可信内容只进入独立数据字段，禁止拼接进 system/developer prompt；调用侧必须用固定指令明确其不可支配工具选择和权限。
- Tool schema、权限和状态机不受资源自由文本控制；参数只接受结构化枚举和服务端解析的资源引用。
- approval UI 只展示服务端 write plan 生成的主体、金额、版本、effects 和风险，不把病历自由文本当可信审批说明。
- 工具不能接受绝对 URL；所有资源 URL 解析后必须校验 origin 和路径白名单。
- 出站网络默认禁止，只允许模拟 adapter 的固定 endpoint。
- 单次工具调用限制搜索结果数、Bundle entry 数、正文长度和总响应字节数。
- 高风险工具拒绝由自由文本拼装 resource type、operation 名或 SQL 字段。

## 8. 核心业务状态机

### 8.1 门诊闭环

```text
Registration + Encounter + Account + 挂号 Charge Item
  -> 分诊 Observation + Queue Task ready
  -> 医生首诊 + 检验 ServiceRequest + 检验 Charge Item
  -> 检验支付
  -> LIS Specimen / Observation / DiagnosticReport
  -> 医生复诊 + Condition + Prescription + MedicationRequest
  -> 签署 document Bundle / Composition
  -> Encounter completed
  -> 药品支付
  -> MedicationDispense + Inventory Movement
  -> Scenario Run completed
```

首期只实现现场普通门诊。Registration 是持久领域事实；挂号 Command 在同一事务中创建或关联 Registration、Encounter、Queue Task、Account 和挂号 Charge Item。Appointment 表达未来预约承诺，Slot 表达可预约时段，不承担挂号事实、排队序号或挂号费语义，二者不属于首期闭环。

关键约束：

- 一个 Encounter 贯穿挂号、分诊、首诊、检验和复诊，不为复诊新建 Encounter。
- 一个普通门诊 Encounter 同时只能有一个主接诊者。
- LIS 是受控系统 Actor，只接收已支付的检验请求；结果通过持久 outbox 推进并可在服务重启后恢复。
- 诊断、过敏、生命体征和检验结果必须在签发相关处方时参与校验。
- Prescription 是带处方号的持久领域聚合，归组 MedicationRequest 并拥有审核、收费和调剂边界；它不等同 RequestOrchestration。
- 医生签署结构化 FHIR 文书并完成 Encounter 后，收费员才处理药品支付，药师再调剂发药。Encounter 完成与 Scenario Run 完成是两个事实。
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

建议统一表，而不是每个资源三张表。

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

写时 Search 索引：

```text
fhir_sp_token(workspace_id, epoch, resource_type, resource_id, param, system, code)
fhir_sp_string(workspace_id, epoch, resource_type, resource_id, param, normalized, exact)
fhir_sp_reference(workspace_id, epoch, resource_type, resource_id, param, target_type, target_id, target_url)
fhir_sp_date(workspace_id, epoch, resource_type, resource_id, param, start_value, end_value)
fhir_sp_number(workspace_id, epoch, resource_type, resource_id, param, low_value, high_value)
fhir_sp_quantity(workspace_id, epoch, resource_type, resource_id, param, value_scaled, scale, system, code)
fhir_sp_uri(workspace_id, epoch, resource_type, resource_id, param, value)
fhir_compartment(workspace_id, epoch, compartment_type, compartment_id, resource_type, resource_id)
```

所有索引只为资源能力注册表列出的 SearchParameter canonical 生成，CapabilityStatement 引用同一清单。提取器由对应 SearchParameter 定义在构建时生成；运行时不对任意表达式执行无限制 FHIRPath。每次资源变更在同一事务删除该资源旧索引并插入完整新索引；提供按 resource type + SearchParameter version 重建和一致性检查命令。

FHIR compartment membership 根据版本固定的 `CompartmentDefinition` 路径计算并写入 `fhir_compartment`。Encounter 上下文、科室和本地 care-team 授权是额外策略，不能伪装成标准 Patient compartment。

### 9.2 领域表

#### FHIR native 的约束投影

部分 FHIR-native 事实需要可重建的关系索引来执行数据库约束：

```text
identity_claim
slot_capacity_state
bed_occupancy
active_encounter_claim
resource_reference_claim
```

这些表不是第二权威：字段来源、唯一写命令、源 resource version、重建算法和一致性校验必须写入事实级 ownership matrix。例如 Slot 的标准时间和状态由 Slot JSON 权威，`slot_capacity_state` 只维护容量/已占计数；床位互斥由 `bed_occupancy` 权威管理占床事实，并投影到 Encounter.location。若辅助表承载无法从 FHIR 重建的业务事实，就必须升级为独立 domain aggregate，不能继续称为索引。

#### 账务

```text
payment_transaction
payment_allocation
refund_transaction
cashier_shift
cashier_shift_payment
insurance_settlement
insurance_fund_allocation
```

#### 库存

```text
inventory_lot
inventory_balance
inventory_movement
inventory_reservation
trace_code
trace_code_event
stocktake
stocktake_line
```

`inventory_movement` append-only，`inventory_balance` 是事务内维护的余额投影。金额使用整数分；允许小数的数量使用 `(value_scaled, scale)` 定点表示。

#### EMR 草稿

```text
clinical_document_draft
clinical_document_revision
clinical_document_lock        # 首期可只做乐观锁
clinical_document_template
```

签署时创建新的 `Bundle.type=document`（首 entry 为 Composition）和 Provenance。签署业务实例不可原地覆盖；修订创建新 logical resources 和 replaces 关系。首期签署件以受验证的结构化 FHIR JSON 保存在 SQLite 中，不创建 Binary、图片、PDF 或其他附件。编辑器 JSON 不是直接可互操作的临床文档。

#### 平台与仿真

```text
workspace
workspace_epoch
workspace_actor_context
simulation_clock
simulation_event
scenario_run
scenario_checkpoint
external_simulation_rule
hidden_fact
reveal_policy
action_trace
approval_grant
command_receipt
command_effect
outbox_event
audit_head
audit_log
```

### 9.3 FHIR 投影

`domain-native` 聚合通过映射器生成 FHIR 投影，并记录：

```text
domain_resource_link
  workspace_id
  epoch
  domain_type
  domain_id
  fhir_resource_type
  fhir_resource_id
  projection_version
```

规则：

- 领域写入与 FHIR 投影、Search 索引、历史版本在同一数据库原子提交。
- 投影失败时整个 command 失败，不能接受“稍后最终一致”作为默认。
- 投影资源 `owner_kind=domain-projection`，FHIR generic PUT/PATCH/DELETE 被拒绝。
- 外部异步事件只处理通知和模拟系统调用，不负责修复核心投影一致性。

实现前维护事实级 ownership matrix，逐项列出：权威事实、存储位置、唯一允许的写 command、投影方向、事务边界、aggregate/projection 版本对应、重建方式和一致性检查。至少覆盖 Slot/容量、Patient/唯一 identifier、Encounter/床位占用、MedicationDispense/库存移动、ChargeItem/支付分配、Invoice/电子票据和 Account/账务余额。

### 9.4 标识符

- 在线新建的 FHIR logical id 使用 UUIDv7 文本；scenario fixture 的稳定 ID 使用预分配 ID 或由 scenario version + logical key 派生的 UUIDv5。二者都满足 FHIR id 长度和字符要求。
- 业务号放对应主体的 `Identifier`，不把患者号、就诊号或处方号当数据库主键。
- 每个 identifier 有稳定 `system` URI、用途、分配机构和有效期。
- 患者合并保留源 Patient，并通过 link/状态表达；禁止改写所有历史 ID。
- 需要唯一的院内 identifier 通过 `identity_claim` 辅助表和唯一索引保证。
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
- 所有 workspace-scoped 表的主键/唯一键以 `(workspace_id, epoch, ...)` 开头；所有租户内关系使用 `(workspace_id, epoch, target_id)` 复合外键，禁止只引用裸 ID，删除默认 `RESTRICT`。
- FHIR Reference 写入时解析目标、验证 workspace/epoch，并写入受三列隔离键约束的 reference index。
- migrations 固定并记录最低 SQLite 版本；依赖 JSON 函数、`RETURNING` 或其他版本相关能力前，以真实 file-backed 数据库测试证明目标运行时支持。

### 9.6 SQLite 事务

SQLite 连接启用 foreign keys、WAL 和有界 `busy_timeout`。首期只允许一个服务端进程写入数据库；Command 使用短 `BEGIN IMMEDIATE` 事务，在获得 write lock 后读取依赖并提交完整 write plan。请求不得在事务中等待浏览器、调用外部模拟器或执行不受界限的计算。

每个 Command 流程：

1. 认证、workspace 和权限检查。
2. schema 与 profile 校验。
3. 查询 idempotency receipt。
4. 开启 `BEGIN IMMEDIATE` 并重新读取 active Epoch、receipt、资源版本和所有并发敏感依赖。
5. 纯领域逻辑生成 deterministic write plan 和完整 dependency set。
6. 通过复合 foreign key、unique/check constraint、expected-version 条件更新和余额下限约束保护不变量。
7. 在一个事务写入当前资源、历史、Search 索引、领域事实、outbox、Audit Event、Action Trace 和 receipt。
8. 提交后唤醒 dispatcher；外部模拟或通知始终在事务之外执行。

数据库约束是并发正确性的最终保护：幂等 receipt key 唯一，approval 从 `unused` 条件更新为 `consumed`，库存以带 version 和 `available >= delta` 的相对更新扣减，Workspace 内引用使用含 Epoch 的复合 foreign key。任何条件更新零行、约束错误或审计写入失败都使事务回滚，并被转换为稳定的 conflict、invariant 或 transient 错误。

数据库忙只允许在 CommandExecutor 边界做有界重试。已经发出外部副作用或得到 ambiguous outcome 的操作不能通过重跑整个 Command 解决。事务持续时间、busy 次数和重试耗时必须观测；持续竞争无法满足交互延迟时触发数据库和部署方案重选。

### 9.7 Outbox

`outbox_event` 状态：

```text
pending -> leased -> delivered
                 -> retryable-failed -> pending
                 -> permanently-failed
                 -> ambiguous
```

每个事件具有 event ID、Workspace/Epoch、aggregate version、dedup key、correlation ID、attempt、next attempt、`lease_owner/lease_version/leased_until` 和 payload hash。lease 以真实时间通过短事务条件抢占，支持过期回收、指数退避、最大尝试和 dead-letter 管理；需要顺序的聚合拒绝旧 aggregate version 回调覆盖新状态。

- 服务启动时扫描可恢复事件；Command 提交后只负责唤醒同进程 dispatcher，内存通知丢失不会丢事件。
- dispatcher 在外部调用前持久化 claim、lease 和 correlation ID，在提交结果前重新验证 Workspace/Epoch 仍 active。
- LIS 与支付模拟器按 event ID/correlation ID 幂等；结果未知进入 `ambiguous` 和对账路径，不直接退回 pending。
- dispatcher 崩溃后由过期 lease 恢复；人工重放必须受权、审计并保留原 attempt 链。
- 不承诺 exactly-once；使用 at-least-once delivery、幂等 consumer 和 ambiguous outcome 对账。

### 9.8 文书与附件边界

首期只保存通过 profile 与业务规则验证的结构化 FHIR JSON。已签署 document Bundle、Composition、Provenance 和 Clinical Document Revision 与其他 FHIR 资源一起进入 current/history store，不写本地散落文件。

首期不提供 Binary、图片、PDF、扫描件、OCR、报告附件、模拟影像或对象存储。未来加入附件时必须另行设计内容校验、授权、版本不可变性、备份恢复和对象生命周期，不能把 SQLite 文件路径直接写入 FHIR 资源。

### 9.9 数据库迁移边界

首期只有 SQLite Repository adapter。Drizzle schema 和迁移以 SQLite 为真实目标，不维护 D1 或 PostgreSQL 方言的虚假兼容层。Scenario package 使用稳定逻辑 key 和版本化 schema，不依赖本地自增 ID。

未来选择 D1、PostgreSQL 或 Supabase 时必须：

- 新增目标数据库的真实 Repository adapter 与双端 contract tests。
- 设计并演练 schema、FHIR history、领域事实、审计和 outbox 的显式迁移。
- 验证 canonical state hash、引用完整性、金额和数量守恒、history/version 与 active Epoch。
- 单独定义目标运行时的事务、并发、备份、恢复和部署约束。

Repository 边界降低业务代码耦合，但不承诺直接复制 `.sqlite` 文件或零成本切换。

## 10. 仿真架构

### 10.1 Workspace 隔离

每次人类演示或未来 Agent 运行创建 Scenario Run，并在 Workspace 内使用不可复用的 Epoch 标识一次具体数据世代。所有资源、索引、领域表、session context、approval、Command、outbox、callback 和 Action Trace 都绑定 `workspace_id + epoch`；审计保留域独立，不随 reset 删除。

首期所有 Workspace 共用一个 SQLite 文件并按行隔离。数据库文件不是 Workspace 边界；任何查询和约束都必须显式携带 Workspace/Epoch。

安全要求：

- workspace/epoch 由认证上下文注入 repository，业务调用者不能选择；`X-Workspace-Id` 最多作为必须与 token 一致的断言，不能用于切换上下文。
- 每次请求重验 active epoch、membership、delegation grant 和 policy version，不能只信 token 中可能陈旧的角色/location claims。
- 所有表、唯一键、外键、索引和 SQL 都包含 workspace/epoch；schema/query lint 拒绝缺少隔离键的租户关系和查询。
- Search total、include/revinclude、cursor、history、outbox lease、Action Trace 和 FHIR 投影同样执行隔离。
- FHIR Reference 写入解析目标并拒绝跨 workspace/epoch 引用。

### 10.2 虚拟时钟

每个 workspace 有：

```text
simulation_clock
  current_time
  timezone = Asia/Shanghai
  mode = frozen | manual | scaled
  scale
  revision
```

业务发生时间通过 `Clock` 领域端口读取，禁止直接在 domain code 中调用 `Date.now()`。

真实提交时间仍用于：

- `meta.lastUpdated`
- token 过期
- lease
- 审计接收时间
- 系统性能指标

Agent 可用的时间推进工具必须由场景授权：

```text
simulation.get_time
simulation.advance_time
simulation.run_due_events
```

普通临床角色不能任意回拨时间。

### 10.3 场景定义

场景包建议使用版本化 JSON/YAML：

```text
scenarios/outpatient-fever-001/
  manifest.yaml
  fixtures/
    patients.json
    encounters.json
    observations.json
    catalogs.json
  external-rules.yaml
  events.yaml
  hidden-facts.json
  reveal-rules.yaml
```

manifest 包含：

- scenario ID/version
- FHIR IG version
- seed
- 初始虚拟时间
- 可用角色和 Command
- 资源规模
- 允许的故障
- 终止条件
- 数据版权/来源说明

fixture 在导入前必须通过项目 profile 校验。`hidden-facts.json` 和 `reveal-rules.yaml` 只表示作者侧源文件：构建必须将其排除在 SPA bundle 和普通岗位可下载的场景内容之外，运行时写入只有 Scenario Runtime 可读的表。能读取源码工作区或数据库文件的主体不受产品授权边界保护，因此这些材料不能当作对基础设施管理员保密。

首期提供两个数据档：小型 `golden` 场景与使用相同 schema、不变量的 `density` 数据。病例只有在临床专业人员审核后才能标记为 `golden`；未审核内容使用 `draft` 或 `demo` 标记。首期不使用 Synthea 或 LLM 在线生成数据。

### 10.4 确定性与故障注入

- 所有随机行为由 workspace seed 驱动。
- 可重复运行固定 app build、DB schema、FHIR IG、scenario、policy 和 tool schema 版本，并记录规范化 command、解析后的 actor context、随机选择、外部结果和并发线性化顺序。
- canonical state hash 排除 `meta.lastUpdated`、审计 duration、lease、request ID 等真实运行字段，只覆盖定义明确的领域事实；跨版本 replay 是兼容性验证，不承诺 hash 必然相同。
- 同一固定版本集 + seed + 线性化 action sequence 应得到相同领域结果和 canonical hash。
- 外部模拟器规则按 correlation ID 和 attempt 决定响应。
- 可模拟：拒绝、超时、延迟、重复响应、部分成功、结果未知和后续回调。
- 故障规则对 Agent 不可见，只能通过正常业务观察发现。

### 10.5 Hidden Fact、Reveal Policy 与 Action Trace

Hidden Fact 表示普通岗位不能直接读取、只能通过合规业务观察发现的场景事实。Reveal Policy 决定哪些业务动作会生成可见 Observation、DiagnosticReport、队列状态或模拟器结果；二者都不进入普通 FHIR Search 或 HIS 查询。

Action Trace 按 Scenario Run 记录观察动作、Command 尝试、结果码、Effect 引用和资源版本，用于重放与过程分析。它不保存模型 chain-of-thought，也不代替 Audit Event 或 Provenance。首期不定义评分规则、Evaluation Spec、分数变化或 evaluator service account。

### 10.6 重置、检查点和回放

`workspace_epoch` 状态机为 `building -> active -> closing/closed -> purged`。reset 协议：

1. 以新 epoch 的 `building` 状态分批导入 fixture，并校验资源、引用和 canonical hash；普通请求不可见 building 数据。
2. 只有管理员可提交 reset Command；它在一个短 SQLite 事务中条件切换 `workspace.active_epoch`，关闭旧 Epoch、激活新 Epoch，并使旧 session context、approval 和 commit token 失效。
3. 旧 outbox 可以在后续短事务中标记 `abandoned`；consumer 的 claim 和结果提交都检查 active Epoch，因此晚到结果不得写入新 Epoch。
4. 首期模拟器不调用真实外部平台。已经开始的本地模拟 attempt 可能在 reset 后返回，但只保留原 Epoch 的 attempt/审计状态，不产生新 Epoch 业务 Effect。

- checkpoint 在 SQLite 保存 Workspace/Epoch 资源版本清单、canonical domain state hash、时钟和事件游标。
- replay 从初始场景按线性化 command log 重放，并验证每步 canonical state hash。
- 外部 side effect 只重放记录的模拟结果，不重复调用真实网络。
- 旧 Epoch 只由显式管理员维护命令按保留策略清理；审计保留域和必要的 Action Trace 引用不随 reset 删除。

## 11. 认证、授权与审计

### 11.1 认证

首期使用 Better Auth 管理合成 User Account、登录凭证、浏览器 cookie session 和会话撤销，禁用公开注册。Scenario 安装过程创建挂号员、分诊护士、门诊医生、收费员和药师的预置合成账户；管理员账户由受控运维步骤创建。Better Auth 不拥有 Workspace Membership、Practitioner Role、地点或 Scenario 权限。

每个受保护请求先验证浏览器会话，再由 ClinMesh Identity & Access 模块重新解析 active Workspace Membership、选择的 Practitioner Role、active Epoch、组织、地点和 policy version，形成受信 Actor context。岗位切换是显式、受审计的服务端动作；cookie 或请求体中的角色、Workspace 和 Epoch 不能替代数据库事实。

首期不发布 OAuth/OIDC Provider、JWKS、SMART configuration、backend services 或 Agent token 能力。未来浏览器会话与 Agent 凭证可以使用不同协议表面，但必须解析到同一种 Actor context；届时按固定规范版本和互操作测试单独设计。

### 11.2 授权模型

最终权限是以下条件的交集：

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
- scenario-admin
- lis-system

首期只有 `scenario-admin` 能 reset Scenario。`lis-system` 只从受控 outbox context 调用允许的检验结果 Command，不具有交互式登录或任意患者搜索能力。住院、医保、完整库存、病案、审计员和未来 Agent 角色在相应能力实施前不进入 seed、导航或授权矩阵。

查询授权必须下推 SQL。不能先查 100 个患者，再在 JavaScript 中删掉 90 个；否则 total、排序、include 和时间差都可能泄漏信息。

### 11.3 字段级策略

- 患者身份证、联系方式、医保凭证默认 masked。
- 每个岗位查询只返回完成当前工作所需字段；未来 Agent adapter 还要进一步窄化。
- 普通岗位不能读取 session secret、外部原始凭证、Hidden Fact、Reveal Policy 或其他 Scenario 私有状态。
- readonly/hidden 字段由服务端 repository 强制，不能只靠前端隐藏。
- break-glass 如需模拟，必须独立 command、理由、短有效期和高等级审计。

### 11.4 Provenance、AuditEvent 和日志

Audit Event、Provenance、Action Trace 和应用日志职责分开：

- Provenance：某个资源版本由谁、代表谁、通过什么活动生成。
- AuditEvent：谁在何时访问或操作了什么，结果如何。
- Action Trace：某个 Scenario Run 的观察、Command 尝试、结果和 Effect 顺序，用于重放与过程分析。
- 应用日志：排障和性能，不承载完整医疗审计。

`audit_log` 是权威 append-only 事件表，FHIR AuditEvent 是只读投影。日志包含：

- workspace/epoch、sequence、previous hash、current hash
- real timestamp、virtual timestamp
- actor、client、delegator、role、organization、location
- request ID、Scenario Run ID；未来适用时增加 Agent run/tool call ID
- interaction/command、target references
- outcome、错误码、duration
- request/response 摘要 hash

`audit_head(workspace_id, epoch, audit_domain, sequence, hash, version)` 通过条件更新推进，sequence 唯一。并发冲突使整个关键业务事务回滚，服务端重新读取 head 并有界重试；禁止两个事件共享父 hash。若该成本不可接受，则取消线性链承诺，只保留独立不可变事件 hash，不能接受静默分叉。

审计事件矩阵至少覆盖：敏感读取、成功写入、授权/校验失败、approval 签发/拒绝/消费、委托与 break-glass、reset/import、跨 workspace 尝试、隐藏数据访问尝试、outbox 人工重放和管理员配置变更。审计保留域不随 workspace reset 删除。

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

每次请求贯穿：

- `requestId`
- `traceId`
- `workspaceId`
- `scenarioRunId`
- `idempotencyKey`
- `commandId`
- `outboxEventId`

指标至少包括：

- API latency 和错误码
- SQLite transaction duration、busy/retry、statement 数和数据库文件大小
- Search resource type/parameter/结果数量
- command conflict 与 idempotency hit
- outbox backlog、retry、ambiguous
- workspace 数量和数据规模

指标标签不得包含患者姓名、身份证、完整资源 ID 或自由文本。

## 13. 代码结构

```text
.
├── apps/
│   ├── web/                 # Vite React SPA
│   ├── server/              # Hono on Node.js；HTTP/FHIR/静态资源与 SQLite adapter
│   ├── desktop/             # 现有工程壳；首期不开发
│   ├── mobile/              # 现有 Expo 工程壳；首期不开发
│   └── docs/                # VitePress 投影与公开页面 manifest
├── packages/
│   ├── contracts/           # Zod schema、DTO、FHIR 辅助类型
│   ├── core/                # 无平台领域函数和客户端规则
│   ├── ui/                  # DOM primitives 与 token
│   └── views/               # 首期 Web 业务视图；保留未来 Desktop 复用边界
├── docs/                    # canonical Markdown
├── fhir/                    # IG、FSH 与生成包
├── scenarios/               # 版本化仿真场景
├── drizzle/                 # SQLite 迁移
├── scripts/                 # 文档投影、验证和 seed 工具
└── .agents/                 # skills 与 Agent Notes
```

跨端包职责和未来 Mobile 共享限制见[跨端前端架构](frontend-architecture.md)。Server 内部按 identity、patient、registration、encounter、ordering、pharmacy、billing、emr 和 simulation 模块组织；HTTP、FHIR、SQLite 和外部模拟器均是 adapter。Insurance、住院和完整库存模块在进入实际阶段时再增加。

依赖规则：

- Command/领域模块不依赖 Hono Request、SQLite driver、React 或未来 Agent/MCP SDK。
- FHIR mapper 依赖领域公开模型，不反向控制领域状态机。
- Web adapter 调用应用层 Query/Command；未来 Tool/AG-UI adapter 同样只能调用应用层，不能直接访问 Repository。
- 模块私有 repository 不被其他模块 import。
- `contracts/core` 只放真正跨端的 schema、类型和纯函数，不形成无归属工具箱。

## 14. 测试策略

### 14.1 单元测试

- Encounter、Registration、Prescription、检验、支付、发药和 Scenario Run 状态机。
- 金额和定点数量计算。
- 岗位、Workspace/Epoch、compartment 和字段策略。
- 虚拟时钟、确定性随机和故障规则。

### 14.2 FHIR 合约测试

- 所有示例通过官方 R5 profile validator，覆盖切片、invariant、binding、Reference target profile、choice type 和 modifierExtension。
- FHIR JSON round-trip 不丢失支持字段。
- CapabilityStatement 与实际 router/ownership/operation registry 一致。
- 逐资源 SearchParameter canonical 的提取、modifier/chain、SQL 编译、严格错误和 Bundle link。
- OperationDefinition 的 system/type/instance 层级、参数基数、affectsState 和 profile 校验。
- ETag、If-Match、history、tombstone、`Prefer: return=`、Content-Type 和 OperationOutcome。
- HTTP 黑盒互操作测试覆盖 read/vread/history/search/create/update 及实际宣告的条件交互；不支持的能力必须稳定失败。

### 14.3 Repository 合同测试

首期 Repository contract suite 运行于真实临时 SQLite 文件。未来增加数据库 adapter 时，同一套外部行为测试必须同时运行于新旧 adapter，不能用 mock 声称可迁移。

覆盖：

- 当前资源 + 历史 + Search 索引原子更新与索引重建。
- transaction/约束失败整体回滚、条件 update 零行识别和错误分类。
- idempotency key 并发首请求、执行中、完成、ambiguous 和不同 payload 冲突。
- Workspace/Epoch 复合 foreign key、唯一 identifier、Registration、Prescription 和库存条件写。
- approval 并发双消费只能成功一次。
- outbox lease 竞争、owner 崩溃、过期回收、乱序回调和 dead-letter。
- audit head 并发推进不分叉，审计与关键业务同事务提交。
- reset 与晚到 callback 并发时旧 epoch 不得影响新数据。

### 14.4 场景测试

每个业务能力必须以可执行场景验收，而不是以类、页面或表存在验收。

首期只有一个经临床审核的 golden scenario：普通门诊发热从挂号、分诊、首诊、检验支付、LIS、复诊、处方与文书签署、Encounter 完诊、药品支付到发药和 Scenario Run 完成。同一场景必须覆盖过敏拦截、旧版本冲突、支付拒绝、LIS 重试、未支付处方禁止发药、已签文书禁止覆盖和 reset 后晚到结果隔离。

`density` 数据使用相同 schema 和状态机，扩大患者、队列、目录与历史数量，用于分页、筛选、长中文文本和 SQLite 读写竞争验证。未完成临床审核的数据不得标记为 `golden`。

### 14.5 后续 Agent 安全测试

本测试层在 Agent/AG-UI 进入独立 spec 后启用，不属于首期退出条件：

- 越权 resource type 和跨 workspace 查询。
- 当前、持久化和间接 prompt injection，包括恶意病历、术语 display、错误消息、OCR/附件和历史工具结果。
- 注入诱导更换 patient/workspace、调用高风险工具或污染 approval 说明。
- 任意 URL/SSRF、绝对路径和同源绕过。
- 超宽搜索、递归 include、大 Bundle 和超长文本。
- 重放 approval token、idempotency key 和过期 commit token。
- Agent 自行伪造 delegator、role、patient 或 encounter context。

## 15. 分期实施

各阶段按可观察能力排序，不包含日期、工期或人员估算。Phase 0 和 Phase 1 先证明基础设施；Phase 2 到 Phase 7 每次增加一个可以由真实 Web 岗位验收的纵向交接；Phase 8 只加固已存在的完整闭环。

### Phase 0：架构基线

状态：已交付。

交付：

- 将 `apps/server` 的目标运行时从 Cloudflare Worker 改为 Node.js Hono，建立开发代理与可部署静态资源 fallback。
- 固定 Web-only 首期构建图；Desktop 与 Mobile 保留工程壳但不进入业务实现、发布和验收。
- 建立 `contracts -> core -> ui/views`、Server application/domain/infrastructure 的依赖边界，以及 Query/Command/Repository interfaces。
- 建立配置 schema、统一错误 envelope、request/trace ID、日志脱敏、健康检查和 `/fhir/R5/metadata` 的 capability registry 骨架。
- 建立 SQLite migration、Scenario install/reset、备份/恢复和容器持久卷的命令入口，但不宣称尚未验证的能力。

退出条件：Web 与 Node.js Server 可在本地同时启动；生产构建由 Node.js 服务提供 SPA fallback、健康检查和只声明已实现能力的 FHIR metadata；依赖边界检查拒绝 Domain/Command 导入 Hono、React、SQLite driver 或环境变量。

### Phase 1：SQLite 正确性 Spike

只验证基础设施最高风险假设，不做业务页面：

- 使用真实临时数据库文件验证 foreign keys、WAL、`busy_timeout`、短 `BEGIN IMMEDIATE` 和进程内单 writer 约束。
- 验证有序 migrations、空库安装、迁移前备份、恢复到新路径和完整性检查。
- 验证 FHIR current/history/search 与领域事实、receipt、Audit Event、Action Trace 和 outbox 的事务回滚。
- 验证幂等并发首请求、expected-version 条件更新、约束错误分类、busy 有界重试和审计链竞争。
- 验证 dispatcher claim/lease、进程重启恢复、重复消费、ambiguous outcome 与旧 Epoch 晚到结果隔离。

退出条件：所有测试都在真实 file-backed SQLite 上通过；失败注入后不存在部分提交；备份恢复保持 schema version 与 canonical state hash；记录可接受的事务持续时间、busy 行为和触发数据库重选的观测指标。

### Phase 2：挂号基础纵向切片

交付：

- Better Auth Web 登录、禁用公开注册、五个岗位合成账户、Workspace Membership、Practitioner Role 选择和受信 Actor context。
- 虚构医院、科室、地点、人员、患者、最小目录、虚拟时间，以及 `golden`/`density` Scenario 安装。
- 挂号员工作台的患者检索、现场挂号和待分诊队列。
- 一个挂号 Command 原子创建 Registration、Encounter、Queue Task、Account、挂号 Charge Item、FHIR history/search、receipt、Audit Event 和 Action Trace。
- Patient、Organization、Location、Practitioner、PractitionerRole、Encounter、Task、Account 和 ChargeItem 的首批 R5 read/history/白名单 Search。

退出条件：挂号员能从真实 Web 入口创建一次持久门诊挂号，刷新与 Server 重启后状态不丢失；重复幂等请求不重复挂号或挂费；越权岗位、旧 Epoch 和跨 Workspace 查询被拒绝且不泄漏 total/history/cursor。

### Phase 3：分诊与队列

交付分诊护士工作台、待分诊/已分诊/候诊 Queue Task 状态、主诉、生命体征 Observation、分诊级别和医生队列查询。分诊 Command 只推进 Phase 2 创建的 Encounter，并以 expected version 防止不同岗位静默覆盖。

退出条件：分诊护士能把同一 Encounter 从待分诊推进到医生候诊；挂号员和医生刷新后看到一致交接；重复提交、旧版本、缺少生命体征和越权动作得到稳定错误且不留下部分 Observation 或 Queue Task。

### Phase 4：医生首诊

交付门诊医生候诊队列、患者上下文、首诊草稿、过敏与既往事实读取、检验 ServiceRequest 签发和检验 Charge Item 生成。医生工作台只使用 TanStack Query 保存服务端状态，Zustand 不镜像患者或 Encounter 响应。

退出条件：医生能从候诊队列接诊并签发检验请求；请求与费用引用同一 Encounter/Account；过敏或不满足目录规则的请求被阻断；并发接诊与重复签发不会生成第二份请求或费用。

### Phase 5：首次收费与 LIS

交付收费员检验待缴队列、Payment Transaction 预览/确认、金额分配、支付成功/拒绝/ambiguous 状态，以及 LIS 系统 Actor、Specimen、Observation、DiagnosticReport 和持久 outbox。只有支付成功的检验请求可以被 LIS 接收。

退出条件：收费员可为检验费用完成一次幂等支付，医生随后看到结构化报告；未支付请求不进入 LIS；Server 在 dispatch 前后崩溃都能恢复或进入明确 ambiguous 状态；重复结果不产生第二份最终报告，reset 后晚到结果不污染新 Epoch。

### Phase 6：复诊、处方、文书与 Encounter 完诊

交付医生复诊队列、检验结果审阅、Condition、Prescription、MedicationRequest、药品 Charge Item、临床文书草稿、签署与 Clinical Document Revision。签署 Command 原子创建不可变 document Bundle/Composition 与 Provenance，并将同一 Encounter 设为 `completed`。

退出条件：医生可以在同一 Encounter 内完成复诊、诊断、处方和文书签署；Prescription 稳定归组药品请求并关联费用；已签文书不能普通覆盖；药品尚未支付或发药时 Encounter 已完成，而 Scenario Run 仍未完成。

### Phase 7：药品收费、药房与 Scenario Run 完成

交付收费员药品待缴队列、药品 Payment Transaction、药师待发队列、处方审核、最小 Inventory Lot/Movement、MedicationDispense 和 Scenario Run 终止判定。药房只接收已签 Prescription 且药品支付成功的项目。

退出条件：收费员和药师从真实 Web 入口完成药品支付与发药；库存不为负且移动可追踪；未支付、重复发药、旧版本和越权动作被阻断；发药后 Scenario Run 转为 `completed`，Encounter 保持医生已完成的状态。

### Phase 8：完整闭环加固

交付：

- 端到端 golden scenario 与 density 数据回归，覆盖五个岗位、LIS 系统 Actor 和管理员 reset。
- 支付拒绝/ambiguous、LIS 重试、过敏拦截、并发冲突、进程重启、备份恢复和旧 Epoch 晚到结果故障矩阵。
- FHIR CapabilityStatement/Operation/Search/profile 合约、Workspace/Epoch 授权查询和 Action Trace/Audit/Provenance 交叉引用检查。
- Web 的加载、空、错误、冲突和权限状态，可访问性、窄视口、长中文文本、键盘操作和 density 性能验证。
- 单实例容器持久卷重建、migration/backup/restore/reset 运维演练，以及完整文档和真实 Web 入口验收证据。

退出条件：从空库安装到完整门诊闭环、重启恢复、备份恢复和 reset 均可重复；所有声明的 FHIR 与 Web 能力有自动化和真实入口证据；未实现的 Desktop、Mobile、Agent、AG-UI、评分、附件和远程数据库没有伪入口或 capability 声明。

## 16. 关键风险与缓解

| 风险 | 后果 | 缓解 |
| --- | --- | --- |
| 把“支持 FHIR”理解成实现全服务器 | 范围失控、边缘性能不可控 | CapabilityStatement 白名单，按场景增量实现 |
| FHIR 与领域表双向写 | 数据漂移 | 每类数据唯一 owner，domain projection 只读 |
| 强行 FHIR 化医保/库存/交账 | 语义错误、事务被客户端拆散 | 本地 command API + 标准只读投影 |
| R5 生态不如 R4 成熟 | 类型、validator、CN profile 复用困难 | 自有精简 R5 IG；保留独立 R4 adapter 边界 |
| SQLite 单 writer 出现持续竞争 | 岗位轮询或写入超时 | 短 `BEGIN IMMEDIATE`、组合索引、有界重试和迁移触发指标 |
| 单进程或容器丢失 | 模拟任务中断或数据回到初始状态 | 持久 outbox、显式持久卷、备份恢复和重建演练 |
| 客户端或 dispatcher 重试副作用 | 重复开嘱、扣费或发药 | idempotency、expected version、ambiguous 状态和对账 |
| Encounter 完成与 Scenario Run 完成混淆 | 药房错误修改临床状态 | 医生完成 Encounter，发药只终止 Scenario Run，分别测试 |
| 原型内存状态被复用 | 授权、持久化和事务成为页面假象 | 正式切片按 Command 与真实 API 重写，不导入原型状态机 |
| 场景数据互相污染 | 回放不可信、数据泄漏 | Workspace/Epoch SQL 强制过滤和跨 Workspace 测试 |
| 术语版本和许可不清 | 接口不可复现或合规风险 | 版本化 terminology package，只放合法演示子集 |
| OpenHIS 功能名造成过度承诺 | 误判业务完整度 | 以 executable scenario 和验收测试为唯一完成标准 |
| Repository 被误解为零成本可移植 | 迁移时遗漏 SQL 与运维差异 | 每个新数据库单独设计 adapter、迁移和双端 contract tests |

## 17. 首期确认边界

以下边界已经确认，需求变化必须重新经过 design gate 并更新 canonical spec：

1. 首个发布是 Web-only 的普通门诊发热闭环，不开发 Desktop 或 React Native Mobile。
2. 人类岗位为挂号员、分诊护士、门诊医生、收费员和药师；LIS 是系统 Actor，只有管理员能 reset Scenario。
3. 一个 Encounter 贯穿挂号、分诊、首诊、检验和复诊；医生在药品支付与发药前签署文书并完诊，发药完成 Scenario Run。
4. 首期使用单 Node.js 进程和 file-backed SQLite；D1、PostgreSQL 与 Supabase 只保留未来 adapter 迁移方向。
5. FHIR R5 版本固定为 `5.0.0`，项目 canonical base 固定为 `https://caizongyuan.github.io/clinmesh/fhir`。
6. Registration 与 Prescription 是持久领域事实；挂号同事务创建 Account 和挂号 Charge Item。
7. Scenario 包含初始事实、Hidden Fact、Reveal Policy 和模拟器行为；Action Trace 与 Audit Event、Provenance 分开。
8. 首期不实现 Agent、AG-UI、Evaluation Spec、评分、附件、真实外部系统或真实患者数据。
9. 计划只定义开发阶段，不附日期、工期或人力估算。

## 18. 架构验收标准

架构实现被认为成立，至少满足：

- 维护逐资源 conformance registry：ownership、profile、interaction、SearchParameter canonical、reference target、terminology binding、状态转换、operation 层级、修订规则、compartment 和 projection source。
- `/fhir/R5/metadata` 只声明该注册表中实际支持的 R5 能力。
- 支持资源通过项目 R5 profile 校验。
- FHIR current/history/Search index 在同一 SQLite 事务原子更新，并可重建验证。
- 所有高风险命令支持 idempotency 和 expected version。
- 领域原生资源的 FHIR 投影不接受 generic write。
- 首期严格搜索策略下，未知 SearchParameter 返回 `400 OperationOutcome`；若未来增加 lenient，必须显式返回被忽略参数的 warning。
- Workspace/Epoch 授权进入 SQL，total/include/history/cursor 无跨上下文泄漏。
- clinical/financial write 同时生成 Audit Event 与 Action Trace；适用的 FHIR 事实生成 Provenance，任一写入失败时整体回滚。
- 虚拟时钟、seed 和外部模拟响应可重复。
- reset 后同一场景得到一致初始 state hash。
- 真实 file-backed SQLite contract tests 覆盖 transaction rollback、零行条件写、幂等竞争、outbox lease/restart、audit head、backup/restore 和 reset/callback 竞争。
- 一个 Encounter 贯穿首期门诊；Encounter 在药品支付与发药前完成，发药只完成 Scenario Run。
- 挂号原子创建 Registration、Encounter、Queue Task、Account 和挂号 Charge Item；Prescription 稳定关联 MedicationRequest、费用、支付和发药。
- 五个人类岗位可以从真实 Web 入口完成经临床审核的 golden scenario；density 数据使用同一 schema 并满足分页与交互基线。
- Node.js 服务重启和单实例容器重建后可从同一 SQLite 文件或已验证备份恢复。
- 首期没有 Desktop、Mobile、Agent、AG-UI、评分或附件入口，也不声明对应能力。
- 所有演示数据都有合成数据标记，不包含真实敏感信息或真实平台凭证。

## 19. 参考资料

项目内：

- [Web Demo 运行与部署架构](./demo-architecture.md)
- [跨端前端架构](./frontend-architecture.md)
- [Agent 工程开发](./agent-development.md)
- [Node.js 与 SQLite Web 基础设施决策](../.agents/notes/proposed/architecture/2026-08-23-node-sqlite-web-foundation.md)
- [多岗位发热门诊首期闭环决策](../.agents/notes/proposed/feature/2026-08-23-outpatient-fever-first-release.md)
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
