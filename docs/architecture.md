# Agent + 中国公立医院仿真 HIS 详细架构设计

- 状态：建议稿
- 日期：2026-08-20
- 适用范围：Agent 环境、产品演示、技术验证、小规模在线试用
- 关联决策：[在线演示 Demo 架构选择](./demo-architecture.md)
- 领域词汇：[ClinMesh 仿真医院领域](../CONTEXT.md)
- 参考实现：`references/openhis-itai-pro/`、`references/medplum/`

## 0. 执行摘要

本系统不是生产医院信息平台，也不是完整 FHIR Server 产品。它的目标是用较低成本模拟中国公立医院中足够真实的岗位、数据和业务状态，为 Agent 提供稳定、标准、可审计、可重置的观察与行动环境。

推荐架构是一个部署到 Cloudflare Workers 的 TypeScript 模块化单体：

```text
React SPA
   |
   +-- /fhir/R5/* -------- FHIR R5 互操作 API
   +-- /api/his/v1/* ----- 非 FHIR 业务命令 API
   +-- /api/tools/v1/* --- Agent 工具 API
   +-- /mcp/* ------------ 可选 MCP 传输适配
   +-- /api/sim/v1/* ----- 场景、时钟、重置、评分 API
   +-- /api/auth/* ------- OAuth/OIDC/SMART 相关端点
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
       +------- D1 / SQLite -------+
                       |
                       +-- R2：文书、附件、报告文件
                       +-- Outbox：异步模拟与集成事件
```

核心决策如下：

1. **FHIR 版本采用 R5 `5.0.0`。** 截至本文日期，R5 是最新已发布稳定版本；R6 仍是 CI build。Medplum 5.1.30 仍以 R4 `4.0.1` 为正式服务版本，因此借鉴其架构，不直接依赖其 R4 类型和服务端实现。
2. **标准接口和业务命令分层。** FHIR 用于标准资源查询、交换和受控写入；复杂状态转换由显式 FHIR Operation 或 `/api/his/v1` 命令完成。禁止让客户端通过多个通用 CRUD 自行编排挂号、医嘱签发、发药、结算、退费或医保撤销。
3. **按资源确定唯一权威数据源。** 标准临床和主数据以 FHIR JSON 为权威记录；库存、医保、收银交账、仿真运行等领域以规范化关系表为权威，并生成只读 FHIR 投影。禁止同一事实被两个模型双向修改。
4. **不追求完整 FHIR Search。** 只实现资源能力注册表列出的 SearchParameter canonical，并由 CapabilityStatement 引用同一清单；本服务器首期固定采用严格处理，不支持的参数返回 `OperationOutcome`。
5. **Agent 不直接获得全能 FHIR 写工具。** Agent 通过窄化、强类型、角色限定的工具执行任务；所有副作用支持幂等、预期版本、预览、审计和风险分级。
6. **仿真能力是一等领域。** 每个运行拥有隔离 workspace、虚拟时钟、确定性随机种子、外部系统脚本、隐藏真值、检查点和评分日志。
7. **SQLite 是设计约束，不只是本地替代品。** 金额和数量使用定点整数，关系使用外键或受控 typed reference，不依赖 PostgreSQL 数组、range、GIN/GiST、Quartz、Redis 或长事务。

## 1. 背景与目标

### 1.1 产品定位

系统服务两个消费者：

- 人类用户通过 Web 工作台扮演挂号员、医生、护士、药师、收费员、医保操作员、病案管理员等角色。
- Agent 通过标准 API 和工具执行同样的受限业务动作，并接受可重复的场景评测。

仿真应有足够真实的中国医院业务约束，但不应复制生产 HIS 的全部工程和监管复杂度。

### 1.2 必须满足

- 支持中国公立医院常见的患者、组织、科室、门诊、住院、医嘱、药房、收费、医保和病历语义。
- 对外提供版本明确、能力可发现、错误可解析的 FHIR R5 JSON API。
- 为 Agent 提供低歧义、低权限、可追踪的业务工具。
- 本地使用 SQLite，线上使用 Cloudflare D1，迁移和核心查询在两者上保持一致。
- 数据规模小、可快速 seed、可创建隔离运行、可重置、可回放。
- 所有数据均为虚构或合成数据，不连接真实医保、支付、短信、邮件、LIS、PACS 或电子票据平台。
- 业务写入具备状态机校验、幂等、乐观并发、历史版本和审计。

### 1.3 应当满足

- 前后端和共享契约使用 TypeScript。
- 单 Worker 部署，核心运行不依赖 Redis、常驻进程或微服务。
- R2 只保存大对象，D1 保存元数据、业务事实和检索索引。
- 外部模拟器支持成功、拒绝、超时、重复、结果未知等情形。
- FHIR profile、术语和自定义 operation 形成可版本化的轻量 Implementation Guide。

### 1.4 明确不做

首期不实现：

- 生产级 HIS、真实诊疗、真实费用结算或真实个人健康信息存储。
- 全国各省医保协议的完整兼容。
- 完整 LIS、RIS/PACS、DICOM 归档、手术麻醉、输血、院感、病理、ICU、消毒供应或财务 ERP。
- 完整 FHIR R5 资源集合、完整 Search、Bulk Data、跨库事务或正式合规认证。
- 高并发号源抢占、大规模报表、实时协作编辑和大文件在线处理。
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

沿用 `docs/demo-architecture.md` 的单 Worker 决策，不拆微服务。模块之间只能通过公开应用服务或领域端口交互，不允许跨模块直接查询私有表。

```text
HTTP Adapters
  - React static assets
  - FHIR R5 Router
  - HIS Command Router
  - Agent Tool Router / MCP
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
  - D1/SQLite
  - R2
  - outbox adapters
```

### 3.2 三种接口、一个业务内核

| 接口 | 消费者 | 用途 | 是否作为业务权威入口 |
| --- | --- | --- | --- |
| FHIR R5 REST | 标准客户端、查询型 Agent、集成测试 | 标准资源读写、查询、历史、Operation | 标准资源是；复杂流程不是 |
| HIS Command API | Web 工作台、内部编排 | FHIR 难以表达的业务聚合和动作 | 是 |
| Agent Tool API / MCP | Agent runtime | 窄化、角色化、低歧义的任务动作 | 否，适配到前两者 |

Tool handler、Web 页面和 FHIR Operation 必须调用同一个 command handler。禁止复制状态机或在路由层直接写库。

### 3.3 权威数据所有权

每类数据必须在注册表中声明一种所有权：

- `fhir-native`：FHIR JSON 是唯一权威记录。
- `domain-native`：规范化领域表是唯一权威记录，FHIR 是只读投影。
- `external-package`：由 IG、术语包或 seed 提供，只读。
- `simulation-private`：仅场景引擎和评估器可见，不进入普通 FHIR API。

同一个资源不能同时接受 FHIR CRUD 和领域表写入。`owner_kind` 决定 API 写策略。业务 command 可以修改 `fhir-native` 资源，但仍只写 FHIR Resource Store，不另建一份同义领域事实。

初始 ownership 注册表：

| 所有权 | 资源/聚合 | 写入方式 |
| --- | --- | --- |
| `fhir-native` | Patient、Organization、Location、Practitioner、PractitionerRole、Schedule、Slot、Appointment、Task、Encounter、Condition、Observation、各类 Request、Medication、MedicationDispense、Account、ChargeItem、Invoice | 低风险资源可受控 CRUD；有状态机的资源只允许 command/Operation |
| `fhir-native immutable` | 已签署文书 Bundle/Composition/DocumentReference、Provenance | 只创建新的业务资源或修订关系，不覆盖已提交业务实例 |
| `domain-native` | PaymentTransaction、RefundTransaction、CashierShift、医保调用/结算、库存账、EMR 编辑草稿、仿真运行、audit_log | 只通过 `/api/his/v1` 或内部 command 写入 |
| `domain-projection` | AuditEvent、Claim/ClaimResponse/EOB、PaymentNotice/PaymentReconciliation、InventoryItem/SupplyDelivery 等交换视图 | 从领域聚合同事务生成，FHIR API 只读 |
| `external-package` | IG 基础资源、CodeSystem、ValueSet、ConceptMap、演示目录 | 随版本包安装，只读 |
| `simulation-private` | hidden fact、故障规则、评分和 evaluator 状态 | 仅 evaluator binding 可访问 |

账务边界特别约定：Account、ChargeItem、Invoice 是标准交换事实并保存在 FHIR Resource Store；实际收款、退款、医保基金分配和收费员交账由领域账务表负责。两者通过明确引用关联，不把“账单”和“支付流水”混成一个资源。

### 3.4 部署拓扑

首期硬依赖：

- Cloudflare Worker + Static Assets
- D1
- 可选 R2

可选增强：

- Cron Trigger：清理过期 workspace、推进定时事件、重试 outbox。
- Cloudflare Queues：外部模拟器和订阅事件量增加后启用。
- Durable Objects：真实出现号源或单患者并发写热点后再启用。

核心正确性不能依赖内存 timer、进程 singleton、`waitUntil` 一定成功或 WebSocket 粘性会话。

### 3.5 深模块与 seam

模块的 interface 同时是调用者和测试的唯一表面，必须包含输入、状态前置条件、错误、幂等、顺序和性能约束；HTTP/MCP adapter 不暴露内部 repository 或状态机细节。

建议的深模块：

- `CommandExecutor`：用一个受信 context 执行/预览强类型 Command，内部隐藏授权、幂等、dependency set、write plan、审计和 outbox。
- `FhirRepository`：提供资源读、历史、受控搜索和原子 write plan；SQLite 与 D1 是两个真实 adapter，因此该 seam 有实际价值。
- `ScenarioRuntime`：隐藏 building/active epoch、虚拟时钟、事件推进、checkpoint 和 reset 切换协议。
- `PolicyEvaluator`：统一计算 resource、field、context binding 和 Agent 风险策略，查询与写入调用同一 interface。
- `ExternalOperationPort`：统一 correlation、inflight/ambiguous、查询和补偿；每种医保/支付/LIS 模拟器只是 adapter。

删除任一模块时，其复杂度应重新散落到多个调用者，说明模块确实提供 leverage；只做参数透传的浅模块应合并。

## 4. 领域边界

| 领域 | 主要职责 | 权威模型 | 首期 |
| --- | --- | --- | --- |
| Identity & Access | 用户、Agent client、角色、委托、token、策略 | 关系表 + OAuth 资源 | 必须 |
| Workspace & Simulation | 场景运行、隔离、时钟、事件、重置、评分 | 领域表 | 必须 |
| Organization & Workforce | 医院、科室、病区、诊室、床位、人员、岗位 | FHIR native | 必须 |
| Terminology | CodeSystem、ValueSet、ConceptMap、目录版本 | FHIR native / package | 必须 |
| Patient Identity | 患者、标识、联系人、合并 | FHIR native + 唯一性辅助表 | 必须 |
| Scheduling & Queue | 排班、号源、预约、签到、候诊、叫号 | FHIR native + 容量辅助表 | 门诊必须 |
| Encounter | 门诊、住院、位置历史、参与者、转科转床 | FHIR native | 必须 |
| Clinical Ordering | 药品、检查、检验、治疗、耗材医嘱及校对 | FHIR native + Task | 必须 |
| Medication & Pharmacy | 药品目录、调剂、发药、退药、执行 | FHIR native + 库存端口 | 必须 |
| Clinical Results | 生命体征、检验/检查结果、报告、处置 | FHIR native | 必须 |
| EMR & Medical Record | 草稿编辑、签署文书、病案首页、质控、归档 | 草稿 domain native；签署件 FHIR native | 第二期 |
| Charging & Billing | 账户、挂费、支付、退费、账单、电子票据、交账 | Account/ChargeItem/Invoice 为 FHIR native；支付/退款/交账为 domain native | 门诊最小闭环 |
| Insurance Simulation | 人员查询、登记、上传、预结算、结算、撤销 | domain native | 第二/三期 |
| Inventory | 批号、效期、库存移动、锁定、盘点、调拨 | domain native | 第二/三期 |
| Integration & Outbox | 模拟 LIS/PACS/医保/支付/票据及重试 | domain native | 必须 |
| Audit & Provenance | 安全审计、资源来源、Agent 行为、回放 | audit_log 为 domain native 并投影 AuditEvent；Provenance 为 FHIR-native 新事件 | 必须 |

## 5. FHIR R5 策略

### 5.1 版本决策

统一基路径：

```text
/fhir/R5
```

`CapabilityStatement.fhirVersion` 固定为 `5.0.0`。一个端点内禁止混用 R4、R4B 和 R5 资源。

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
| 临床文书 | `Bundle`、`Composition`、`DocumentReference` | 签署件发布为 `Bundle.type=document`，首 entry 为 Composition；后续修订创建新业务资源 |
| 文件 | `Binary` | R2 object key 仅为内部实现；标准访问通过 Binary endpoint 或 Attachment URL |
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

签署临床文书的业务实例不可原地覆盖。后续更正或修订创建新的 document Bundle、Composition、DocumentReference 和 Provenance，并通过 `Composition.relatesTo`、`DocumentReference.relatesTo` 等适用关系表达 replaces/transforms。FHIR `_history` 只记录同一 logical id 的服务器版本，不作为临床修订链、Provenance 或 AuditEvent 的追加机制。

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
| 场景真值、评分和故障注入 | Simulation private API | 不进入普通 FHIR |

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
5. Worker 运行时执行结构、基数、切片、关键 invariant、Reference target profile 和关键术语校验；复杂规则继续由官方 Validator 合约测试覆盖，避免将完整验证器与全部定义打入边缘包。
6. CapabilityStatement 的 `rest.resource.profile` 表示服务器遵循的基础 profile，`supportedProfile` 表示额外支持/接受的 profile；两者与实际验证策略、部署版本一起发布。

## 6. 接口设计

### 6.1 路径规划

`docs/demo-architecture.md` 中“业务 API 使用 `/api`”继续适用，但 FHIR 标准端点作为明确例外使用独立根路径。

| 路径 | 说明 |
| --- | --- |
| `/fhir/R5/*` | FHIR R5 |
| `/api/his/v1/*` | 非 FHIR 领域命令和查询 |
| `/api/tools/v1/*` | Agent 工具 HTTP 适配 |
| `/mcp/*` | 可选 MCP Streamable HTTP 传输 |
| `/api/sim/v1/*` | 场景运行管理，仅 evaluator/admin |
| `/api/auth/*` | OAuth/OIDC token、authorize、JWKS 等 |
| `/fhir/R5/.well-known/smart-configuration` | SMART 能力发现；可选保留根路径 alias，但 FHIR base 下端点为规范入口 |
| `/api/admin/*` | seed、迁移状态和管理能力 |

### 6.2 FHIR 写入策略

FHIR API 不等于所有资源都允许通用写入。

| 写策略 | 资源示例 | 行为 |
| --- | --- | --- |
| 标准 CRUD | Patient、RelatedPerson、部分主数据 | 授权和 profile 校验后允许 create/update |
| 受控 create | Observation、DiagnosticReport、DocumentReference | 只允许可信角色或集成 client，引用必须存在 |
| 受控 create/update，状态迁移 Operation only | Encounter、MedicationRequest、ServiceRequest、Appointment | 允许受控创建和合法草稿编辑；签到、签发、停止、出院等迁移只走 `$operation`/command |
| Read-only projection | AuditEvent、ClaimResponse、InventoryItem、PaymentReconciliation 等领域视图 | 未声明写 interaction，generic write 返回 `405` + OperationOutcome |
| 业务不可变 | 已签署文书 Bundle/Composition/DocumentReference、Provenance | 后续事件或修订创建新的 logical resource；`_history` 不作为业务追加链 |
| Hidden | 场景真值、评分、内部 command receipt | 普通 FHIR API 不暴露 |

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
POST /api/his/v1/payments/preview
POST /api/his/v1/payments/{id}/actions/confirm
POST /api/his/v1/payments/{id}/actions/refund
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
X-Agent-Run-Id: run-...       # 可选一致性断言，不用于选择 run
X-Request-Reason: ...          # 高风险读取或写入时必填
```

workspace、epoch 和 Agent run 只从服务端 token/session/task context binding 解析。两个 header 若存在必须完全一致，否则立即拒绝；幂等、approval、commit token、audit、cursor 和 outbox 只能使用服务端解析值。

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

错误使用稳定错误码。FHIR 端点返回 OperationOutcome；HIS 端点使用统一错误 envelope；Tool Gateway 将两者归一为 Agent error，不把堆栈和内部 SQL 返回给客户端。

### 6.5 Idempotency

Agent、队列和外部模拟器都可能重试，所有业务命令必须幂等。

服务端以 `(workspace_id, epoch, actor_id, operation, idempotency_key)` 唯一识别请求，并保存：

- 规范化请求 hash
- 执行状态
- 完整或可重建响应
- 创建/更新的资源引用
- 外部 correlation ID

数据库唯一索引解决两个并发首请求同时看到“不存在”的竞争。纯数据库 command 在同一 batch 写入最终 `completed` receipt。含外部副作用的 operation attempt 与 outbox 使用同一状态机，并在每次推进时同 batch 更新 receipt：

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

## 7. Agent 环境与工具设计

### 7.1 FHIR 是系统契约，工具是 Agent 契约

Agent 不应被迫自己组合大量 FHIR Search 和多资源写入。工具层负责：

- 固定 resource type 和 interaction。
- 将自然任务转成窄化查询或单个 command。
- 从服务端 context binding 注入 workspace/epoch/run、patient、encounter、actor 和用途上下文，不能信任模型自报上下文。
- 限制结果数量、字段和时间窗口。
- 把 FHIR OperationOutcome 转成稳定的可重试/不可重试错误。
- 返回证据引用和资源版本，便于 Agent 说明依据。

MCP 只是工具传输协议，不是业务领域模型。

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

服务端持久化 `approval_grant(jti, ..., status, consuming_command_id)`，状态为 `unused/consumed/revoked`。消费 approval 与业务写在同一个 batch 中做条件状态转换，并以唯一约束保证一个 grant 只绑定一个 command；不同 idempotency key 也不能重复使用。测试必须覆盖并发双提交、跨 workspace/run/operation 重放和过期 token。

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

- 病历、附件/OCR、患者备注、术语 display、历史工具结果、外部错误和模拟器消息均为不可信数据。
- 不可信内容只进入独立数据字段，禁止拼接进 system/developer prompt；调用侧必须用固定指令明确其不可支配工具选择和权限。
- Tool schema、权限和状态机不受资源自由文本控制；参数只接受结构化枚举和服务端解析的资源引用。
- approval UI 只展示服务端 write plan 生成的主体、金额、版本、effects 和风险，不把病历自由文本当可信审批说明。
- 工具不能接受绝对 URL；所有资源 URL 解析后必须校验 origin 和路径白名单。
- 出站网络默认禁止，只允许模拟 adapter 的固定 endpoint。
- Binary 下载使用短期签名 URL，并限制大小、类型和 workspace。
- 单次工具调用限制搜索结果数、Bundle entry 数、正文长度和总响应字节数。
- 高风险工具拒绝由自由文本拼装 resource type、operation 名或 SQL 字段。

## 8. 核心业务状态机

### 8.1 门诊闭环

```text
预约门诊：Appointment booked -> check-in -----+
现场挂号/加号：registered Encounter -----------+-> Queue Task ready
急诊/绿色通道：emergency Encounter -----------+-> called
                                                     -> Encounter in-progress
                                                     -> diagnosis / orders
                                                     -> charging / payment / execution
                                                     -> Encounter completed
```

Appointment 表达预约承诺，Slot 表达可预约时段，不承担完整挂号凭证、排队序号、挂号费和退号语义。现场挂号、加号、急诊可直接创建已登记 Encounter，并关联 Slot、Account、ChargeItem 或本地挂号事实。取消预约、退号和取消就诊是三个不同动作。

关键约束：

- “未签到不能接诊”只适用于要求签到的预约 profile；急诊、现场入口和绿色通道由 admission source、profile 和显式策略控制。
- 一个普通门诊 Encounter 同时只能有一个主接诊者。
- 诊断、过敏和重要观察必须在签发相关医嘱时参与校验。
- 签发后的请求不得通过无约束 update 改写已生效临床意图。停止、撤销、纠错、替代和补充分别使用适用的标准 status/statusReason、关系字段、受控 Operation 和 Provenance；只有形成新临床请求时才创建新 logical resource。
- 退费必须关联原 ChargeItem、PaymentTransaction 和发药/执行状态。
- 已发药项目退费前先完成退药或明确豁免。
- 医嘱签发、费用生成、支付和执行不是统一线性顺序。不同目录项目在签发、确认执行、发药、耗材领用或人工补记时生成 ChargeItem。
- ChargeItem 取消不自动删除临床请求，临床撤销也不自动等价退款；每类目录项目声明计费触发点、数量来源、可退条件和原始业务引用。

### 8.2 住院闭环

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

检验检查区分：申请、预约/执行 Task、标本采集、标本接收、结果项、报告签发、危急值通知和报告更正。ServiceRequest、Specimen、Observation 和 DiagnosticReport 分别保留自身状态；更正报告创建新的业务修订关系，不能覆盖原事实而丢失签发链。首期不实现影像归档时，只模拟检查报告和受控附件，不把报告等同 DICOM Study。

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

所有索引只为资源能力注册表列出的 SearchParameter canonical 生成，CapabilityStatement 引用同一清单。提取器由对应 SearchParameter 定义在构建时生成；运行时不对任意表达式执行无限制 FHIRPath。每次资源变更在同一 batch 删除该资源旧索引并插入完整新索引；提供按 resource type + SearchParameter version 重建和一致性检查命令。

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

签署时创建新的 `Bundle.type=document`（首 entry 为 Composition）、DocumentReference、受控 Binary/Attachment 和 Provenance。签署业务实例不可原地覆盖；修订创建新 logical resources 和 replaces 关系。编辑器 JSON 不是直接可互操作的临床文档。

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
evaluation_event
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

### 9.5 SQLite/D1 类型规则

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
- 维护 SQLite/D1 SQL feature matrix，覆盖 SQLite/D1 版本、JSON 函数、FK、ALTER/表重建、时间排序和 pragma 差异；每项能力以真实 D1 preview 测试为准。

### 9.6 事务与 D1

本地 SQLite 可使用短 `BEGIN IMMEDIATE` 事务。D1 使用 `batch()` 提交预先计算的 write plan；批次中任一 statement 失败则整体回滚。但 batch 之前的读取不属于该事务快照，因此 write plan 的正确性有明确前提：所有并发敏感依赖必须在 batch 内通过数据库约束、条件写或 guard 重新验证，不能读取旧余额后无条件写回绝对值。

每个 command 流程：

1. 认证、workspace 和权限检查。
2. schema 与 profile 校验。
3. 查询 idempotency receipt。
4. 加载所需资源和当前版本。
5. 纯领域逻辑生成 deterministic write plan 和完整 dependency set。
6. 为 dependency set 构造版本、策略、时钟、余额、床位、号源、approval、idempotency 和 audit head 的批内约束/guard。
7. 使用相对增减和带 version/余额条件的写语句；禁止对并发敏感余额做无条件绝对值覆盖。
8. 一个 batch 写入当前资源、历史、Search 索引、领域表、outbox、审计和 receipt。
9. 提交后再执行外部模拟或通知。

D1 缺少传统长连接交互事务时，使用事务 guard 表让前置条件失败触发整个 batch 回滚：

```sql
CREATE TABLE tx_guard (
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  command_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ok INTEGER NOT NULL CHECK (ok = 1),
  PRIMARY KEY (workspace_id, epoch, command_id, seq)
);
```

示意 guard：

```sql
INSERT INTO tx_guard(workspace_id, epoch, command_id, seq, ok)
SELECT ?, ?, ?, ?, CASE WHEN EXISTS (
  SELECT 1 FROM fhir_resource
  WHERE workspace_id = ?
    AND epoch = ?
    AND resource_type = ?
    AND resource_id = ?
    AND version_id = ?
    AND deleted = 0
) THEN 1 ELSE 0 END;
```

guard 只是补充断言，不能替代数据库约束。核心不变量使用以下模式：

- 当前床位占用：`bed_occupancy(workspace_id, epoch, bed_id)` 唯一约束。
- 号源：batch 内 guard 检查 version/capacity，随后条件递增 booked count；不先读计数再无条件写。
- 库存：`available = available - delta` 的相对更新同时检查 version 和 `available >= delta`。
- approval：`unused -> consumed` 条件更新并绑定唯一 consuming command。
- idempotency：唯一 receipt key；唯一冲突的请求读取既有状态，不重复执行。
- 审计：条件推进 `audit_head`，sequence 唯一；冲突使整个业务 batch 失败并由服务端有界重建 write plan。
- workspace 关系：复合 foreign key 和 reference index，不能只依赖每条 SQL 手写过滤。

每个 guard 在 batch 末尾删除。SQLite 单 writer 保证同一 batch 的 guard 与写入之间没有另一个 writer 插入，但任何条件 update 的零行结果都必须转化为会使 batch 失败的约束断言，不能在提交后才发现。Phase -1 必须在真实 D1 preview 验证 statement 失败整体回滚、零行更新识别和错误分类。

如果某个聚合的完整 dependency set 和不变量无法表示为有限 batch，优先拆短命令；仍无法证明时交给 Durable Object 串行化，或从首期范围删除，不能继续宣称 command 内强一致。

### 9.7 Outbox

`outbox_event` 状态：

```text
pending -> leased -> delivered
                 -> retryable-failed -> pending
                 -> permanently-failed
                 -> ambiguous
```

每个事件具有 event ID、workspace epoch、aggregate version、dedup key、attempt、next attempt、`lease_owner/lease_version/leased_until` 和 payload hash。lease 以真实时间做条件抢占，支持过期回收、指数退避、最大尝试和 dead-letter 管理；需要顺序的聚合拒绝旧 aggregate version 回调覆盖新状态。

- 首期由请求后 `waitUntil` 尝试处理，并由 Cron 兜底扫描；两者竞争使用 lease CAS。
- `waitUntil` 失败不丢事件，D1 outbox 才是事实来源。
- 启用 Cloudflare Queues 后，outbox publisher 只负责发布，consumer 仍按 event ID/correlation ID 幂等。
- consumer 在外部调用前和提交结果前都验证 workspace epoch 仍 active。
- 外部调用不得位于核心数据库事务中。
- 不承诺 exactly-once；使用 at-least-once + 幂等 + ambiguous outcome 对账。

### 9.8 R2 与 Binary

- 小型结构化 FHIR JSON 留在 D1；文书编辑器 JSON、PDF、图片、报告附件和模拟影像放 R2。
- 服务端生成不可猜、不可复用 object key。D1 保存 immutable object version/hash、实际大小、magic MIME、声明 MIME、workspace/epoch、securityContext、创建者和 `uploading/scanning/available/quarantined` 状态。
- R2 key 只属于内部实现。FHIR JSON 的 Binary 按规范提供 `contentType` 和适用的 `data`；大对象通过 `DocumentReference.content.attachment.url` 指向受控 Binary endpoint，并明确原始字节内容协商、Range、大小上限和授权策略。
- 上传后校验实际大小、hash 和 magic MIME。HTML/SVG 等主动内容强制 attachment、`nosniff`、私有不缓存；Agent 不自动解析未扫描附件。
- 短期签名 URL 绑定 object version/hash、workspace/epoch、subject、disposition 和真实时间 TTL。
- 资源历史引用的对象不可静默覆盖；新业务修订使用新 key 或内容寻址 key。
- 删除 FHIR Binary 默认只建 tombstone，不立即物理删除 R2；清理由保留策略处理。

### 9.9 从本地 SQLite 到 D1

“上传到 Cloudflare”应理解为部署 Worker、应用迁移并导入 SQL 数据，不假定直接复制本地 `.sqlite` 文件。

要求：

- Drizzle schema 和 raw migration 只使用双方支持的 SQL。
- 每个 migration 在空本地 SQLite 和 D1 preview 上测试。
- seed 从声明式 fixture 生成，不能依赖本地自增 ID。
- 导出/导入使用版本化 SQL 或场景包。
- repository contract tests 同时运行 SQLite adapter 和 D1 adapter。
- 生产 demo 数据库不接受本地命令直接覆盖，只能通过受控 reset/import job。

## 10. 仿真架构

### 10.1 Workspace 隔离

每个用户演示或 Agent 评测运行创建独立 workspace，并使用不可复用的 `epoch` 标识一次具体数据世代。所有资源、索引、领域表、token、approval、command、outbox、callback 和 R2 metadata 都绑定 `workspace_id + epoch`；审计保留域独立，不随 reset 删除。

不为每次运行创建一个 D1 数据库，原因是绑定和数据库生命周期成本过高。小数据量下按 workspace 行隔离更简单。

安全要求：

- workspace/epoch 由认证上下文注入 repository，业务调用者不能选择；`X-Workspace-Id` 最多作为必须与 token 一致的断言，不能用于切换上下文。
- 每次请求重验 active epoch、membership、delegation grant 和 policy version，不能只信 token 中可能陈旧的角色/location claims。
- 所有表、唯一键、外键、索引和 SQL 都包含 workspace/epoch；schema/query lint 拒绝缺少隔离键的租户关系和查询。
- Search total、include/revinclude、cursor、history、Binary、outbox lease 和 FHIR 投影同样执行隔离。
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
  scoring.yaml
```

manifest 包含：

- scenario ID/version
- FHIR IG version
- seed
- 初始虚拟时间
- 可用角色和工具
- 资源规模
- 允许的故障
- 终止条件
- 数据版权/来源说明

fixture 在导入前必须通过项目 profile 校验。`hidden-facts.json` 只表示作者侧源文件：构建必须将其排除在 SPA、普通 Worker bundle、Agent 可读仓库/附件和公开场景包之外；高可信评测将隐藏真值加密后放入独立 evaluator binding/storage，由不同凭据访问。若 Agent 本身拥有源码工作区访问权，仓库内明文 hidden facts 不构成隐藏边界。

### 10.4 确定性与故障注入

- 所有随机行为由 workspace seed 驱动。
- 可重复运行固定 app build、DB schema、FHIR IG、scenario、policy 和 tool schema 版本，并记录规范化 command、解析后的 actor context、随机选择、外部结果和并发线性化顺序。
- canonical state hash 排除 `meta.lastUpdated`、审计 duration、lease、request ID 等真实运行字段，只覆盖定义明确的领域事实；跨版本 replay 是兼容性验证，不承诺 hash 必然相同。
- 同一固定版本集 + seed + 线性化 action sequence 应得到相同领域结果和 canonical hash。
- 外部模拟器规则按 correlation ID 和 attempt 决定响应。
- 可模拟：拒绝、超时、延迟、重复响应、部分成功、结果未知和后续回调。
- 故障规则对 Agent 不可见，只能通过正常业务观察发现。

### 10.5 隐藏真值与评分

`hidden_fact` 和 `scoring_rule` 只允许 evaluator service account 访问，普通 FHIR、HIS 和 MCP 端点完全不可见。

评分来源：

- 最终资源状态和版本。
- command/effect 序列。
- 是否查询了必要证据。
- 是否违反权限或安全策略。
- 是否进行了不必要的高风险动作。
- 用时使用虚拟时间和行动步数，不使用模型内部推理。

评估日志记录 tool call、输入摘要、结果码、effects、资源版本和分数变化，但不要求或保存模型 chain-of-thought。

### 10.6 重置、检查点和回放

`workspace_epoch` 状态机为 `building -> active -> closing/closed -> purged`。reset 协议：

1. 以新 epoch 的 `building` 状态分批导入 fixture，并校验资源、引用和 canonical hash；普通请求不可见 building 数据。
2. 最终用一个短 batch 条件切换 `workspace.active_epoch`，关闭旧 epoch、激活新 epoch，并记录 token/approval 撤销边界。
3. 旧 outbox 不要求在切换 batch 中全量更新，可后台标记 `abandoned`；consumer 的结果提交必须以 active epoch 为条件，因此旧结果不得写入新 epoch。
4. 外部 HTTP 存在“检查 active 后、发送前 epoch 被关闭”的 TOCTOU，系统只能保证旧结果不污染新 epoch，不能声称已发出的外部副作用会被撤销。请求携带不可复用 epoch/correlation/idempotency key，并进入对账或补偿；要求 reset 后绝不继续外发的 adapter 使用 Durable Object 线性化关闭与发送，或让 reset 等待 inflight 收敛。

- checkpoint 保存 workspace/epoch 资源版本清单、canonical domain state hash、时钟和事件游标。
- 小场景可将压缩快照存 R2；D1 保存索引和 hash。
- replay 从初始场景按线性化 command log 重放，并验证每步 canonical state hash。
- 外部 side effect 只重放记录的模拟结果，不重复调用真实网络。
- 过期 workspace epoch 由 Cron 清理；审计保留域与运行数据分开配置。

## 11. 认证、授权与审计

### 11.1 认证

目标协议：OAuth 2.0 Security BCP/OIDC + 固定版本的 SMART App Launch（实施时记录 package/version，不能只写“SMART 语义”）。首期明确只支持 standalone launch 和 backend services；EHR launch、patient launch context 与 refresh/offline scope 未实现前不得宣告。

- SPA：Authorization Code + PKCE。
- Agent：SMART Backend Services/client credentials；优先 `private_key_jwt`，demo 可使用受控 client secret。
- Token 短有效期、固定 audience、可撤销。
- 提供 JWKS 和 SMART configuration。
- 不支持把 Basic Auth 作为 FHIR 用户认证。
- demo 账户均为虚构角色，不使用真实医院账户。

首期可实现最小一方 OAuth server，但 endpoint、scope 和 claim 必须保持可替换，不能把前端 session cookie 直接当 Agent 长期凭证。

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
- inpatient-doctor
- nurse
- pharmacist
- cashier
- insurance-operator
- inventory-manager
- medical-record-admin
- auditor
- evaluator

查询授权必须下推 SQL。不能先查 100 个患者，再在 JavaScript 中删掉 90 个；否则 total、排序、include 和时间差都可能泄漏信息。

### 11.3 字段级策略

- 患者身份证、联系方式、医保凭证默认 masked。
- Agent 工具只返回完成任务所需字段。
- 普通临床角色不能读取 OAuth client、secret、外部原始凭证和隐藏评分。
- readonly/hidden 字段由服务端 repository 强制，不能只靠前端隐藏。
- break-glass 如需模拟，必须独立 command、理由、短有效期和高等级审计。

### 11.4 Provenance、AuditEvent 和日志

三者职责分开：

- Provenance：某个资源版本由谁、代表谁、通过什么活动生成。
- AuditEvent：谁在何时访问或操作了什么，结果如何。
- 应用日志：排障和性能，不承载完整医疗审计。

`audit_log` 是权威 append-only 事件表，FHIR AuditEvent 是只读投影。日志包含：

- workspace/epoch、sequence、previous hash、current hash
- real timestamp、virtual timestamp
- actor、client、delegator、role、organization、location
- request ID、Agent run ID、tool call ID
- interaction/command、target references
- outcome、错误码、duration
- request/response 摘要 hash

`audit_head(workspace_id, epoch, audit_domain, sequence, hash, version)` 通过条件更新推进，sequence 唯一。并发冲突使整个关键业务 batch 回滚，服务端重新读取 head 并有界重建 write plan；禁止两个事件共享父 hash。若该成本不可接受，则取消线性链承诺，只保留独立不可变事件 hash，不能接受静默分叉。

审计事件矩阵至少覆盖：敏感读取、成功写入、授权/校验失败、approval 签发/拒绝/消费、委托与 break-glass、reset/import、跨 workspace 尝试、隐藏数据访问尝试、outbox 人工重放和管理员配置变更。审计保留域不随 workspace reset 删除。

hash chain 只能提供防篡改线索，不能在单一管理员控制的 demo 环境中宣称正式防抵赖。关键写操作的审计必须与业务状态同批次提交；审计写失败则业务写失败。普通应用日志不得记录 token、密码、完整身份证、完整病历正文或原始医保凭证。

## 12. 可靠性与性能边界

### 12.1 请求约束

- 所有列表分页。
- `_count` 和工具 limit 有硬上限。
- Bundle、transaction、operation 输入限制 entry 数和总字节数。
- Binary 不经 Worker 内存做大规模转换。
- 报表使用预定义 SQL 和小结果集，不允许 Agent 提交任意聚合表达式。
- Worker 请求内数据库 statement 数设置预算，超出时拆命令或异步化。

### 12.2 一致性

- 单 command 只有在完整 dependency set 被 batch 内约束/条件写覆盖时才保证强一致；无法证明的聚合交给 Durable Object 或移出首期。
- 外部模拟器通过 outbox 最终一致。
- 核心 FHIR 投影与领域状态同事务强一致。
- Search 索引与当前资源同事务强一致。
- read-after-write 使用 primary/session 一致性能力，不假定任意副本立刻可见。

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
- `agentRunId`
- `toolCallId`
- `idempotencyKey`
- `commandId`
- `outboxEventId`

指标至少包括：

- API latency 和错误码
- D1 statement 数、rows read/written
- Search resource type/parameter/结果数量
- command conflict 与 idempotency hit
- outbox backlog、retry、ambiguous
- workspace 数量和数据规模
- Agent 工具风险等级与拒绝次数

指标标签不得包含患者姓名、身份证、完整资源 ID 或自由文本。

## 13. 代码结构

```text
.
├── apps/
│   ├── web/                 # Vite React SPA
│   ├── server/              # Hono 后端，当前运行于 Cloudflare Workers
│   ├── desktop/             # Electron main/preload/renderer
│   ├── mobile/              # Expo / React Native
│   └── docs/                # VitePress 投影与公开页面 manifest
├── packages/
│   ├── contracts/           # Zod schema、DTO、FHIR 辅助类型
│   ├── core/                # 无平台领域函数和客户端规则
│   ├── ui/                  # Web/Desktop primitives 与 token
│   └── views/               # Web/Desktop 共享业务视图
├── docs/                    # canonical Markdown
├── fhir/                    # IG、FSH 与生成包
├── scenarios/               # 版本化仿真场景
├── drizzle/                 # D1/SQLite 迁移
├── scripts/                 # 文档投影、验证和 seed 工具
└── .agents/                 # skills 与 Agent Notes
```

跨端包职责和 Mobile 共享限制见[跨端前端架构](frontend-architecture.md)。Server 内部按 identity、patient、scheduling、encounter、ordering、pharmacy、billing、insurance、inventory、emr 和 simulation 模块组织；HTTP、FHIR、MCP、D1、R2 和外部模拟器均是 adapter。

依赖规则：

- Command/领域模块不依赖 Hono Request、D1 binding、React 或 MCP SDK。
- FHIR mapper 依赖领域公开模型，不反向控制领域状态机。
- Tool adapter 只能调用应用层 CommandExecutor，不能直接访问 repository。
- 模块私有 repository 不被其他模块 import。
- `contracts/core` 只放真正跨端的 schema、类型和纯函数，不形成无归属工具箱。

## 14. 测试策略

### 14.1 单元测试

- Encounter、医嘱、发药、结算、退费、库存等状态机。
- 金额和定点数量计算。
- 角色、scope、compartment 和字段策略。
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

同一套测试分别运行：

- 本地 SQLite repository
- D1 local/preview repository

覆盖：

- 当前资源 + 历史 + Search 索引原子更新与索引重建。
- guard/约束失败整体回滚、条件 update 零行识别和错误分类。
- idempotency key 并发首请求、执行中、完成、ambiguous 和不同 payload 冲突。
- workspace/epoch 复合 foreign key、唯一 identifier、床位、号源和库存条件写。
- approval 并发双消费只能成功一次。
- outbox lease 竞争、owner 崩溃、过期回收、乱序回调和 dead-letter。
- audit head 并发推进不分叉，审计与关键业务同事务提交。
- reset 与晚到 callback 并发时旧 epoch 不得影响新数据。

### 14.4 场景测试

每个业务能力必须以可执行场景验收，而不是以类、页面或表存在验收。

首批 golden scenarios：

1. 普通门诊发热：挂号、接诊、诊断、检查、处方、收费、发药、完诊。
2. 过敏拦截：Agent 尝试签发冲突药物，系统阻断并给出结构化原因。
3. 门诊退费：已收费未发药与已发药两条分支。
4. 住院入科分床：床位冲突与互换床。
5. 长期医嘱：签发、校对、执行、停嘱、停嘱校对。
6. 医保结算超时：结果未知后查询对账，不能重复扣款。
7. 库存批号：近效期先出、追溯码和退药回库。
8. 病案签署：草稿修订、签署、归档后禁止覆盖。

### 14.5 Agent 安全测试

- 越权 resource type 和跨 workspace 查询。
- 当前、持久化和间接 prompt injection，包括恶意病历、术语 display、错误消息、OCR/附件和历史工具结果。
- 注入诱导更换 patient/workspace、调用高风险工具或污染 approval 说明。
- 任意 URL/SSRF、绝对路径和同源绕过。
- 超宽搜索、递归 include、大 Bundle 和超长文本。
- 重放 approval token、idempotency key 和过期 commit token。
- Agent 自行伪造 delegator、role、patient 或 encounter context。

## 15. 分期实施

### Phase -1：D1 正确性 Spike

只验证风险最高的基础假设，不做业务 UI：

- batch statement 失败整体回滚和零行条件写识别。
- 复合 FK、partial/unique/check 约束和 Search 索引替换。
- 幂等并发首请求、approval 双消费、audit head 竞争。
- outbox lease、重复 Cron、consumer 崩溃和晚到 callback。
- workspace reset/epoch 与在途请求并发。
- 记录 SQL feature matrix、单 command statement/rows read-written 预算和迁移限制。

退出条件：上述测试全部在真实 D1 preview 通过；无法用有限 batch 证明的聚合明确使用 Durable Object 或删除首期承诺。

### Phase 0：最小纵向骨架

交付：

- Server/React/D1 基础工程。
- workspace/epoch、虚拟时钟、最小 seed/reset。
- 只支持 Patient、Organization、Practitioner、Location、Encounter 的 R5 current/history 和最小 Search。
- 一条 Patient -> Encounter command 写路径，含 CapabilityStatement、OperationOutcome、ETag/If-Match。
- OAuth demo identity、两个角色、SQL 授权过滤、audit、idempotency receipt 和最小 outbox。
- FSH/IG/validator CI 与 SQLite/D1 repository contract test。

退出条件：

- 上述资源可按声明的能力创建、读取、搜索和看历史。
- 两个 workspace/epoch 不能互相发现资源，包括 total、history、cursor 和 Binary metadata。
- 同一合同测试在 SQLite 和 D1 preview 通过。
- 在约定 fixture 规模下给出 P95 延迟、最大 statement 数和 rows read/written 基线。

### Phase 1A：门诊医生闭环

交付 Schedule、Slot、Appointment、Task、Encounter 门诊入口，Condition、AllergyIntolerance、Observation，以及 MedicationRequest、ServiceRequest、最小 RequestOrchestration。支付和发药先使用无副作用 stub，只验证医生接诊、诊断、草稿、签发、过敏拦截和完诊工具。

退出条件：医生 Agent 可完成接诊到签发；重复签发、过敏和号源冲突被阻断；canonical replay hash 稳定。

### Phase 1B：门诊收费

交付 Account、ChargeItem、Invoice、PaymentTransaction、分配、预览、确认和退款；加入收费员工具和支付成功/拒绝/ambiguous 场景。

退出条件：重复请求不重复收款；收款退款、账单红冲、医保撤销边界可区分；金额始终按定点规则守恒。

### Phase 1C：门诊药房

交付 MedicationDispense、库存 reservation/movement 最小子集、批号、部分发药和退药；加入药师工具。

退出条件：已发药退费需要退药或豁免；多批次发药可追溯；库存不为负；医生、收费、药师组合场景闭环。

### Phase 2A：住院

交付住院登记、入科、分床、转科转床、出院、清床、长期/临时医嘱、护士校对/执行/停嘱、MedicationAdministration、护理 Observation 和 Task 工作队列。

退出条件：床位预占/占用/转床/清床互斥成立；长期医嘱执行实例可追踪；住院状态机和护士工具场景通过。

### Phase 2B：EMR 与病案基础

交付 EMR 草稿、document Bundle/Composition/DocumentReference 签署发布、修订链和最小病案归档 Task。

退出条件：已签业务实例不能被普通 update 覆盖；修订创建新 logical resources；附件和 Provenance 可追溯。

### Phase 2C：医保模拟

交付人员查询、就诊登记、费用上传、预结算、结算、撤销和对账模拟器。

退出条件：成功、拒绝、超时和 ambiguous 四类结果可重复；晚到回调不影响新 epoch；Claim 系列只在语义成立时生成。

### Phase 3：完整库存、病案与兼容层

交付：

- Inventory ledger、批号、效期、追溯码、调拨和盘点。
- 病案首页 profile、质控 Task、归档和借阅模拟。
- 电子票据/支付/LIS/PACS adapter 模拟。
- 有明确集成需求时评估 `/fhir/R4` 只读兼容层。

退出条件：

- 库存移动可追溯、余额不为负、反向业务不改原账。
- R4 转换有字段损失清单和双版本合约测试。

## 16. 关键风险与缓解

| 风险 | 后果 | 缓解 |
| --- | --- | --- |
| 把“支持 FHIR”理解成实现全服务器 | 范围失控、边缘性能不可控 | CapabilityStatement 白名单，按场景增量实现 |
| FHIR 与领域表双向写 | 数据漂移 | 每类数据唯一 owner，domain projection 只读 |
| 强行 FHIR 化医保/库存/交账 | 语义错误、事务被客户端拆散 | 本地 command API + 标准只读投影 |
| R5 生态不如 R4 成熟 | 类型、validator、CN profile 复用困难 | 自有精简 R5 IG；保留独立 R4 adapter 边界 |
| D1 缺少交互事务 | 多步状态可能部分提交 | deterministic write plan + transactional batch + guard |
| Agent 重试副作用 | 重复开嘱、扣费、发药 | idempotency、expected version、ambiguous 状态和对账 |
| Agent 通用工具权限过大 | 越权和 prompt injection | 角色化窄工具、风险分级、preview/commit、无任意 URL |
| 场景数据互相污染 | 评测不可信、数据泄漏 | workspace SQL 强制过滤和跨 workspace 测试 |
| 术语版本和许可不清 | 接口不可复现或合规风险 | 版本化 terminology package，只放合法演示子集 |
| OpenHIS 功能名造成过度承诺 | 误判业务完整度 | 以 executable scenario 和验收测试为唯一完成标准 |

## 17. 实施前需要确认的产品决策

以下问题不阻塞架构，但会改变 Phase 1 的具体范围：

1. 第一类目标 Agent 是门诊医生、住院医生、护士、药师、收费员，还是通用运营 Agent？默认从门诊医生开始。
2. Agent 评测更关注临床决策、业务流程正确性，还是 HIS 操作熟练度？默认三者都记录，但评分以流程和安全为主。
3. 是否必须与现成 Medplum/Epic/HAPI 客户端互通？默认不要求，因此首期坚持 R5。
4. 是否需要真实格式的中国身份证和医保数据？默认只用明确标记的合成数据，禁止任何真实外部调用。
5. 首期 UI 是否覆盖所有岗位？默认只做场景所需工作台，不复刻 OpenHIS 全菜单。
6. 是否需要多医院租户？默认一个 deployment 多 workspace，每个 workspace 可包含一个医院组织树；暂不实现集团化跨医院结算。

## 18. 架构验收标准

架构实现被认为成立，至少满足：

- 维护逐资源 conformance registry：ownership、profile、interaction、SearchParameter canonical、reference target、terminology binding、状态转换、operation 层级、修订规则、compartment 和 projection source。
- `/fhir/R5/metadata` 只声明该注册表中实际支持的 R5 能力。
- 支持资源通过项目 R5 profile 校验。
- FHIR current/history/Search index 在同一 batch 原子更新，并可重建验证。
- 所有高风险命令支持 idempotency 和 expected version。
- 领域原生资源的 FHIR 投影不接受 generic write。
- 首期严格搜索策略下，未知 SearchParameter 返回 `400 OperationOutcome`；若未来增加 lenient，必须显式返回被忽略参数的 warning。
- workspace 授权进入 SQL，total/include/history 无跨 workspace 泄漏。
- Agent 无任意 URL、任意 Bundle 或任意 operation 写工具。
- clinical/financial write 同时生成审计；失败时整体回滚。
- 虚拟时钟、seed 和外部模拟响应可重复。
- reset 后同一场景得到一致初始 state hash。
- SQLite 与真实 D1 preview repository contract tests 同时通过，覆盖 batch rollback、零行条件写、approval 双提交、outbox lease、audit head 和 reset/callback 竞争。
- 每阶段给出 fixture 数据规模、单 command statement/rows read-written 上限、P95 延迟、outbox 最大恢复时间和故障矩阵，超过预算不能只用“低并发”豁免。
- 门诊 golden scenario 可由人类 UI 和 Agent 工具分别完成，最终 canonical domain state 一致。
- 所有演示数据都有合成数据标记，不包含真实敏感信息或真实平台凭证。

## 19. 参考资料

项目内：

- [在线演示 Demo 架构选择](./demo-architecture.md)
- [跨端前端架构](./frontend-architecture.md)
- [Agent 工程开发](./agent-development.md)
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
- [Cloudflare D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Cloudflare D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare D1 Import/Export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
