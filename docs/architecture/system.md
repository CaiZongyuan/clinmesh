# 系统范围与拓扑

本文拥有系统定位、模块与数据职责、运行拓扑、当前实现范围及跨领域架构保证。系统总入口见[系统架构](../architecture.md)，业务验证要求见[测试策略](../testing.md)。

- 状态：standalone Web、DSH React Surface 与 Agent CLI 已实现
- 日期：2026-09-01
- 适用范围：Web 产品演示、DSH 原生 Agent 协作、Agent CLI 与技术验证
- 首期运行决策：[Web Demo 运行与部署架构](../demo-architecture.md)
- 领域词汇：[ClinMesh 仿真医院领域](../../CONTEXT.md)
- 参考实现：`references/openhis-itai-pro/`、`references/medplum/`

## 0. 执行摘要

本系统不是生产医院信息平台，也不是完整 FHIR Server 产品。它用可重复、可审计的合成医院场景，让人类岗位通过 standalone Web 或 DSH React Surface、交互式 Agent 通过 DSH 页面 Tools、任务 Agent 通过 CLI 完成同一业务交接。当前发布证明多岗位普通门诊发热闭环、住院建档、医嘱执行与手术最小闭环、DSH Surface adapter、Agent CLI 和支撑这些能力的基础设施；Agent adapter 只开放已经实现的业务能力。

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
6. **仿真能力是一等领域，但评分不是首期基础设施。** 每个 Scenario Run 绑定 Workspace/Epoch、虚拟时钟、不可变 Synthetic Case Instance、私有 Case Truth、Patient Persona、冻结的 Investigation Result Snapshot 和 Action Trace；首期没有 Evaluation Spec、评分规则或 evaluator runtime。
7. **SQLite 是首期真实数据库。** 所有关系约束、迁移、备份恢复、幂等竞争、outbox 恢复和 reset 都在 file-backed SQLite 上验证。未来数据库通过新 adapter 和显式迁移接入，不维护未使用的兼容路径。
8. **一个 Encounter 贯穿首期门诊。** 结构化病历签署拥有独立生命周期，不推进 Encounter；带 Consultation 的病例由独立完诊门禁汇总正式临床事实，无 Consultation 的首期复诊兼容流仍可在尚无结构化签署根文书时组合签署与完诊。药品支付和发药随后发生，发药完成 Scenario Run，而不是再次推进 Encounter。
9. **Agent adapter 不拥有第二套业务内核。** DSH 拥有模型 Session、transcript、Tool 调度和 Surface 宿主，ClinMesh 拥有 Page Context、前端 action、proposal、人工审阅、共享 Command 和审计关联；`clinmesh` CLI 从业务 Operation Catalog 生成命令树，通过受信 Actor context 调用同一 Query 与 Command。两条入口都不能绕过授权、CAS/expected version、状态机、审计或各自声明的人工确认边界。

<a id="1-背景与目标"></a>

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
- 完整 LIS、RIS/PACS、DICOM 归档、DICOMweb、手术麻醉、输血、院感、病理、ICU、消毒供应或财务 ERP。胸片与胸部 CT 平扫的阅片闭环、乳腺切片病理会诊是已实现的例外，范围见 [8.7 节](clinical-workflows.md#87-检验检查与报告修订)与 [10.7 节](simulation.md#107-影像素材与病例影像准备)。
- 完整 FHIR R5 资源集合、完整 Search、Bulk Data、跨库事务或正式合规认证。
- 高并发号源抢占、大规模报表、实时协作编辑和大文件在线处理。
- 图片、PDF、扫描件或其他临床附件；签署文书仅保存受验证的结构化 FHIR JSON。影像检查的像素不属于附件，见 [9.8 节](storage.md#98-文书与附件边界)。
- 将 OpenHIS 的 124 张核心表和全部扩展模块机械迁移到 SQLite。

## 3. 总体架构决策

<a id="31-模块化单体"></a>

### 3.1 模块化单体

沿用[Web Demo 运行与部署架构](../demo-architecture.md)的单进程决策，不拆微服务。模块之间只能通过公开应用服务或领域端口交互，不允许跨模块直接查询私有表。

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
| `fhir-native` | Patient、AllergyIntolerance、Organization、Location、Practitioner、PractitionerRole、Encounter、Task、Account、ChargeItem、Observation、ServiceRequest、Specimen、DiagnosticReport、Condition、Medication、MedicationRequest、MedicationDispense、MedicationAdministration | 只由 Case 开始或业务 Command 创建和更新；FHIR API 只读 |
| `fhir-native-immutable` | 已签署的 Composition、document Bundle、Provenance | 业务 Command 只创建新资源；更正创建显式修订关系，不覆盖已签实例 |
| `domain-native` | Workspace Actor、Agent Client/Grant、Synthetic Patient Profile 与 Profile Revision、Synthetic Case Instance、Patient Persona Revision、Investigation Result Snapshot、Consultation 与 Consultation Record、Registration、[住院事实](clinical-workflows.md#82-住院闭环)、Diagnosis Draft 与 Diagnosis Confirmation、Prescription、PaymentTransaction、库存账、临床草稿、Scenario Run、Action Trace、audit_log | 只通过 `/api/agent/v1`、`/api/his/v1`、`/api/sim/v1` 或内部 Command 写入 |
| `domain-projection` | AuditEvent、InventoryItem、ImagingStudy、Procedure | 从领域事实同事务生成；FHIR API 只读 |
| `simulation-private` | Index Encounter、Case Truth、隐藏来源资源和生成模型输入 | Simulator 内部解析器可访问；管理员病例核对仅可读 Case Truth，生成模型输入仍不公开；普通 HIS、FHIR、来源历史详情和角色 Agent 均不可读取 |

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
- `SyntheticCaseVisitService`：向挂号员投影固定 Profile/Persona revision 的待挂号病例，并把管理员或挂号员确认的 Case 开始请求交给共享 Workflow 内核。
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

跨端包职责和未来 Mobile 共享限制见[跨端前端架构](../frontend-architecture.md)。当前 Server 以少量深模块组织：`IdentityService` 解析受信 Actor context，`ScenarioService` 拥有 Epoch 转换，`WorkflowService` 拥有首期门诊状态流，`InpatientService` 拥有已交付的住院事实，`CommandExecutor` 统一事务/幂等/审计，`AgentIntegrationService` 拥有 Page Context 与 Tool/proposal/review 关联，FHIR/Workspace/Outbox Repository 封装 SQLite 读写。Insurance、完整库存、IG 和外部 Scenario package 在进入实际范围时再增加。

依赖规则：

- Application 模块不依赖 Hono Request、React、DSH、CLI、Agent runner 或未来 MCP SDK；当前直接组合 SQLite Repository 与数据库事务，不宣称已有第二数据库的抽象实现。
- Hono route 只解析/验证 HTTP 输入并调用应用服务，不能复制 Workflow 状态机。
- standalone Web、DSH Surface 与 CLI adapter 调用应用层 Query/Command；Agent HTTP adapter 只签发/校验 context、Grant 和结果关联，不能直接访问业务 Repository 或复制状态机。未来 MCP 或其他 AG-UI adapter 同样只能调用应用层。
- `packages/contracts` 不导出 SQLite driver、表定义或应用私有类型。
- `contracts/core` 只放真正跨端的 schema、类型和纯函数，不形成无归属工具箱。

<a id="15-首期实现状态"></a>

## 15. 首期实现状态

首期 Web 发布已经形成一个可执行纵向闭环：

```text
登录与受信岗位上下文
  -> 合成病例患者档案与挂号
  -> 分诊生命体征与医生候诊
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
- file-backed SQLite 启用 foreign keys、WAL 和五秒 busy timeout；有序 migration 建立身份、FHIR、Scenario、Command、审计、outbox、门诊事实、结构化病历、诊断与处方、持久生成任务、Synthetic Patient Profile/Revision、Synthetic Case Instance、Persona Revision、Investigation Result Snapshot、来源 R4 artifact、Visible Source History、Epoch materialization、Agent Client/Grant/Workspace Actor/receipt role、模型任务绑定，以及 DSH Page Context/Tool/proposal/review 关联。
- 数据库 CLI 提供 migrate、verify、reindex、backup 和 restore；已有旧版数据库执行 migrate 时先在同目录创建并验证升级前备份，Server 进程只验证 migration。
- CommandExecutor 统一 `BEGIN IMMEDIATE`、expected versions、幂等 receipt、FHIR current/history/search、领域事实、AuditEvent、Action Trace 和 outbox 原子提交。
- 同进程 dispatcher 持久化 claim/lease/attempt/correlation，支持失败重试、ambiguous、重复消费和旧 Epoch abandon。
- Docs 开发与预览入口使用 `51898/51899`，Web 开发入口使用 `51888`，Synthea Provider 默认在宿主与容器内使用 `51878`，内部 cn-health localizer 使用 `51879`，Server 本地、宿主与容器内统一使用 `51868`。standalone Provider 仅绑定宿主回环地址，宿主端口可覆盖；localizer 不发布宿主端口。默认 ClinMesh Dockerfile 与 Compose 固定单实例和命名持久卷，不包含 Java 或 Synthea；`compose.synthea-provider.yaml` 以固定 digest 启动两个非 root、只读的预构建服务，不使用宿主数据挂载，`compose.synthea.yaml` 复用它们并为一键部署注入容器内 URL。Server 通过可选 URL adapter 调用固定协议，不把 Provider 健康状态作为启动门禁。

### 15.2 协议与业务

- Better Auth 禁止公开注册，并幂等 seed 九个合成账户；Human 请求重新解析 Membership、Practitioner Role 和 active Workspace/Epoch。Agent 请求从短期 Capability Grant 重新解析同一 Actor context，原 token 不持久化。
- FHIR 固定 R5 `5.0.0`，当前资源只声明 read、vread、instance history 和 search-type；Search 白名单与负面保证见 [5.2 节](fhir-and-commands.md#52-只声明真实能力)。
- `clinmesh` CLI 从 Catalog 生成全部 canonical HIS 命令和五个只读 FHIR 操作，提供离线 list/schema、JSON/table 输出、human profile、Agent Grant、结构化错误和 Command receipt 恢复；七个领域 Skills 与真实命令路径共同受测。
- 门诊五个岗位通过真实 API 推进同一个 Encounter。医生完成 Encounter 与药师完成 Scenario Run 是独立状态变化。
- 支付支持 success、declined 和 ambiguous；LIS 通过持久 outbox 推进独立检查申请的受理、执行和结构化报告签发，兼容收费检验仍只在支付成功后生成报告；药房只处理已签且成功支付的处方。
- 结构化病历草稿使用 CAS 版本并可在 Web 恢复；独立签署不完成 Encounter。签署件不可普通覆盖，修订只能从最新版本创建新的 Composition、document Bundle、Provenance 和 Clinical Document Revision。
- 诊断草稿使用受控目录和独立 CAS 版本；确认时恰有一个主诊断，并原子创建 Condition、更新 Encounter.diagnosis 和记录 Provenance。确认后仍可重新进入草稿，再次确认创建线性 revision 并保留旧 Condition 历史；既往 Condition 不进入本次诊断编辑状态。
- v3 处方草稿使用受控目录和独立 CAS 版本，草稿不发布 FHIR；开具时重新校验诊断、过敏、药品组合和五项用药字段，再创建 Prescription、带 Actor/Practitioner Role 外键的 authorship 与 MedicationRequest。无需用药是带责任人的互斥正式结论；未调剂处方可追加撤回事实，取消 MedicationRequest，但不抹除已收费历史或触发退款。v1/v2 保留原药品目录与组合复诊入口。
- Synthea Profile、Case Truth 和本院 R5 事实保持独立 owner；来源 R4 coding 不通过疾病或药品 mapping gate 转为本院编码。
- 胸片与胸部 CT 平扫可以开立、取得报告、阅片、确认已阅和更正；放射申请与检验共用申请生命周期内核，像素来自本地素材目录，见 [8.7 节](clinical-workflows.md#87-检验检查与报告修订)与 [10.7 节](simulation.md#107-影像素材与病例影像准备)。
- 乳腺切片病理会诊可以为既往乳腺手术开立、取得会诊报告、阅片、确认已阅和更正；病理申请是同一内核上的第三种申请类型，切片来自独立的病理素材包，见 [8.7 节](clinical-workflows.md#87-检验检查与报告修订)与 [10.7 节](simulation.md#107-影像素材与病例影像准备)。

### 15.3 Web 与明确边界

- Web 提供挂号员、分诊护士、门诊医生、住院医生、病区护士、病案人员、收费员、药师和管理员入口；管理员以模拟数据为唯一岗位首页，可生成 Synthetic Profile/Case、浏览 Visible Source History、生成并选择 Brief、查看本次病例真值、直接开始病例，并在确认影响范围后重置。检验目录默认自动启用 laboratory-cn，Web 不提供手动选择发布或标准/密集数据载入入口；未计价服务不显示为免费。医生工作台从全局 Reference Release 分页搜索诊断和药品，从病例级目录搜索本院已发布检验服务；诊断、检验和处方有效修改自动保存，已创建事实固定对应 snapshot。Investigation 的系统执行异常支持受控重试，不向医生展示生成 capability。病例库继续提供责任范围内的已完诊 Encounter 与受控更正入口。服务端状态只由 TanStack Query 缓存，退出或跨账户登录会清除非 session 查询。
- 可见字符串具有中文和英文 catalog；独立 Web 主题支持 system、light 与 dark，DSH Surface 始终跟随宿主主题。岗位页面具有分页、加载、空、错误、冲突、无权限和成功状态，并覆盖长中文文本与窄视口。
- DSH Web 可从统一 launcher 打开同一完整工作台，使用 Memory Router、ShadowRoot 和动态岗位 Tools；Agent 可执行读取、导航、选择、草稿和 preview，正式动作只进入 detached 人工审阅。
- `clinmesh` CLI 通过 Operation Catalog、单岗位 Capability Grant 和领域 Skills 开放当前 Query、Command 与只读 FHIR 能力。
- 首期不包含 Desktop/Mobile 产品行为、模型 runner、AG-UI Gateway/MCP、自治 Agent、评分、附件、真实外部系统、完整医保/住院/库存、远程数据库、多实例或高可用。
- 住院提供登记入科、床位、医嘱校对与执行、药房发药与给药、检查检验送检报告、转科、手术实际事实、逐项费用、出区结算清床与召回、病案首页核心字段编码审核归档；范围及固定编码来源限制见[住院闭环](clinical-workflows.md#82-住院闭环)。
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

1. 产品界面交付 Web 普通门诊发热闭环及住院建档、医嘱执行与手术最小闭环，同时提供 Agent CLI；不开发 Desktop 或 React Native Mobile 产品行为。
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
- 医生接诊统一使用具有固定患者档案的 Synthetic Case；挂号与分诊提供接诊上下文。
- 门诊五岗及住院医生、病区护士、病案人员可以通过 Web/API、单岗位任务 Agent 可以通过 CLI 完成由 Synthetic Case 直接开始的 Scenario；生成库、来源历史和全局目录查询满足分页与交互基线。
- standalone Web 与 DSH React Surface 复用同一 Web application；DSH 原生 Session 只能获得当前岗位/view 的窄 Tools，正式业务 Effect 需要人类审阅并可关联 Tool、proposal、review、Command、Audit 与 Trace。
- `clinmesh` CLI 由同一 Operation Catalog 生成命令树，Capability Grant 绑定单一 Practitioner Role、Workspace/Epoch、Scenario Run、policy version 和真实过期时间。
- Node.js 服务重启后从同一 SQLite 文件恢复；备份/恢复验证 schema、integrity 与 canonical state hash。
- 首期没有 Desktop、Mobile、模型 runner、AG-UI Gateway、MCP、自治 Agent、评分或附件入口；Agent 能力只声明当前 DSH Surface Tools、CLI、Capability Grant 和 Skills。
- 所有演示数据都有合成数据标记，不包含真实敏感信息或真实平台凭证。
