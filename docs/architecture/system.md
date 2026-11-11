# 系统范围与拓扑

本文拥有系统定位、模块与数据职责、单实例部署拓扑、当前实现范围及跨领域架构保证。系统总入口见[系统架构](../architecture.md)，统一业务语言见[领域词汇](../../CONTEXT.md)，业务验证要求见[测试策略](../testing.md)。

<a id="0-执行摘要"></a>

## 执行摘要

ClinMesh 不是生产医院信息平台，也不是完整 FHIR Server 产品。它用可重复、可审计的合成医院场景，让人类岗位通过 standalone Web 或 DSH React Surface、交互式 Agent 通过 DSH 页面 Tools、任务 Agent 通过 CLI 完成同一业务交接。当前发布覆盖多岗位普通门诊闭环、住院全链路（登记入科、床位、医嘱与给药、检查检验、手术与耗材、出区结算清床与召回、病案首页归档、CHS-DRG 分组推演与医保办模拟核定）、DSH Surface adapter、Agent CLI 及支撑基础设施；Agent adapter 只开放已经实现的业务能力。

```text
React SPA (standalone Web / DSH React Surface)
   |
   +-- /fhir/R5/* -------- FHIR R5 只读互操作 API
   +-- /api/his/v1/* ----- 显式业务 Query / Command API
   +-- /api/sim/v1/* ----- 场景、时钟、参考清单与管理员重置 API
   +-- /api/auth/* ------- Web 会话与岗位上下文
   +-- /api/agent/v1/* --- Page Context、proposal 审阅与 Capability Grant CLI API
            |
            v
     Application Services -> Domain Command Handlers -> Repository Interfaces
                                                               |
                     +-----------------------------------------+-------------------+
                     v                                         v                   v
            FHIR Resource Store                        HIS Domain Tables    persistent outbox
                     +-------------- operational SQLite (single writer) -----------+

     只读参考与素材边界：Reference SQLite（ICD-10/药品/检验） · Guideline SQLite（指南全文检索） · 本地影像与病理素材目录
```

核心架构决策如下：

1. **FHIR 版本固定为 R5 `5.0.0`。** 项目 canonical base 固定为 `https://caizongyuan.github.io/clinmesh/fhir`；借鉴 Medplum 等开源实现时保持自有精简 R5 边界，不混入 R4 服务端模型。
2. **标准接口和业务命令分层。** FHIR API 用于标准资源读取、版本历史和白名单搜索；所有业务写入由 `/api/his/v1`、`/api/sim/v1` 或 `/api/agent/v1` 的显式 Command 完成，禁止客户端用通用 CRUD 编排挂号、医嘱、发药或收退款。
3. **按资源确定唯一权威数据源。** 标准临床和主数据以 FHIR JSON 为权威；库存、医保、收退款、住院聚合、仿真运行等领域以规范化关系表为权威并生成只读 FHIR 投影，禁止双向修改。
4. **严格声明真实能力。** 只实现资源能力注册表列出的交互和 SearchParameter canonical，不支持的参数返回 `400 OperationOutcome`。
5. **单 Node.js 进程与本地 SQLite。** standalone Web 与 DSH React Surface 复用同一 Web 应用；Hono 在单进程内服务 API 与静态产物，operational SQLite 承载全部可变业务状态，独立只读 Reference SQLite 与 Guideline SQLite 分别提供全国参考目录与指南检索。Desktop、React Native Mobile、远程数据库和多实例部署均后置。
6. **仿真是一等领域，评分基础设施后置。** 每个 Scenario Run 绑定 Workspace/Epoch、虚拟时钟、不可变 Synthetic Case Instance、私有 Case Truth、Patient Persona、冻结的 Investigation Result Snapshot 和 Action Trace；当前不包含自建 Evaluation Spec 或评分引擎。
7. **一个 Encounter 贯穿单次门诊，住院多维状态分立。** 门诊结构化病历签署独立于 Encounter 完诊，药品支付与发药在完诊后推进 Scenario Run；住院的行政在院、财务结算、清床与病案归档彼此独立。
8. **Agent adapter 不拥有第二套业务内核。** DSH 拥有模型 Session 与宿主壳，ClinMesh 拥有 Page Context、窄 Tools、proposal 人工审阅、共享 Command 和审计关联；`clinmesh` CLI 从同一 Operation Catalog 生成命令树并受短期单岗位 Capability Grant 约束。

<a id="1-背景与目标"></a>

## 背景与目标

### 产品定位

当前消费者包括通过 standalone Web 或 DSH Surface 操作十个合成医院岗位（挂号员、分诊护士、门诊医生、收费员、药师、住院医生、病区护士、病案人员、医保办、管理员）的人类用户，以及通过 `clinmesh` CLI 持单岗位短期授权执行的任务 Agent；LIS、放射与病理系统执行者作为受控系统 Actor 参与同一 Scenario Run。DSH 原生 Agent 可读取当前页面状态、导航、填写草稿并准备正式动作，最终医院 Command 由登录人类审阅提交；任务 Agent 仅执行 Grant allowlist 允许的显式操作与只读 FHIR 查询。

### 必须满足

- 覆盖普通门诊与住院核心诊疗、检查检验、处方医嘱、药房调剂、收退款、合成医保待遇、病案归档及 CHS-DRG 分组核定语义。
- 对外提供版本明确、能力可发现、错误可解析的只读 FHIR R5 JSON API，以及带受信 Actor context、状态机校验、幂等、expected version、历史版本和审计的共享业务 Command。
- 为 Agent 提供可发现、schema 驱动、可恢复且按单岗位授权的 HIS CLI 与动态页面窄 Tools。
- 在单个 Node.js 进程中使用 file-backed SQLite，支持有序迁移、受控备份恢复、持久 outbox、隔离运行、Epoch 重置与确定性重放。
- 所有业务数据均为虚构或合成数据，不连接真实医保、支付、短信、邮件、LIS、PACS 或电子票据平台；公开授权、已去标识的放射与病理素材是唯一像素例外，且不进入 Git、SQLite、日志或模型输入。

<a id="14-明确不做"></a>

### 明确不做

- 生产级 HIS、真实诊疗、真实费用结算或真实个人健康信息存储。
- Desktop、React Native Mobile、离线写入和多端产品行为对齐（当前仅保留工程壳与跨端包边界）。
- 自建自治 Agent runtime、模型 runner、独立 AG-UI Gateway、MCP、OAuth/SMART Agent 凭证、Evaluation Spec 和评分基础设施；DSH 原生 Session/browser Tool 桥接与私有 Capability Grant CLI 是已实现边界。
- Cloudflare Worker、D1、R2、Queues、PostgreSQL、Supabase、多数据库 adapter、跨库事务或多实例并发写入。
- 全国各省真实医保平台接口协议；完整 LIS、RIS/PACS、DICOM 归档、DICOMweb、手术麻醉、输血、院感、ICU、消毒供应或财务 ERP（胸片、胸部 CT 平扫阅片闭环与乳腺切片病理会诊为已实现窄范围，见[检验检查与报告修订](clinical-workflows.md#检验检查与报告修订)与[影像素材与病例影像准备](simulation.md#影像素材与病例影像准备)）。
- 完整 FHIR R5 资源全集、完整 Search、通用 FHIR 写入、自定义 FHIR Operation、Bulk Data 或正式合规认证。
- 临床图片、PDF、扫描件或其他 Binary 附件存储；签署文书仅保存受验证的结构化 FHIR JSON（影像与病理像素不属于附件，见[文书与附件边界](storage.md#文书与附件边界)）。

## 总体架构决策

<a id="31-模块化单体"></a>

### 模块化单体

系统采用单进程模块化单体，不拆微服务；模块之间只能通过公开应用服务或领域端口交互，禁止跨模块直接查询私有表。

```text
HTTP Adapters (Web static / FHIR R5 Router / HIS & Sim Routers / Agent Router)
          |
Application Layer (use-case orchestration / auth & policy checks / transaction boundary)
          |
Domain Layer (aggregates & state machines / invariant checks / deterministic effects)
          |
Infrastructure (FHIR & domain repositories / file-backed SQLite / in-process outbox dispatcher)
```

<a id="32-多种-adapter一个业务内核"></a>

### 多种 adapter、一个业务内核

| 接口 | 消费者 | 用途 | 是否作为业务权威入口 |
| --- | --- | --- | --- |
| FHIR R5 REST | 标准客户端、集成测试 | 标准资源读取、查询和历史 | 只读互操作面，不是业务写入口 |
| HIS / Sim Command API | Web 工作台、内部编排 | 医院业务聚合查询与受控状态变迁 | 是 |
| DSH React Surface + Agent API | DSH Web 原生 Session | 完整 Web 工作台、Page Context、受控前端 action 和 proposal 审阅 | adapter；正式写入仍调用 HIS Command |
| `clinmesh` CLI | 人类运维、任务 Agent、合约测试 | Catalog 发现、HIS Query/Command、只读 FHIR 和 receipt 恢复 | adapter；复用现有 HTTP 与 Command owner |

standalone Web、DSH Surface 和 CLI 最终调用相同的 Query 与 Command handler。未来若扩展自定义 FHIR Operation、MCP 或其他宿主桥接，同样只能调用既有应用层 handler，不在路由层复制状态机或直接写库。

<a id="33-权威数据所有权"></a>

### 权威数据所有权

系统按四个互不混写的边界管理数据：本地化 FHIR R4 Bundle 与 Synthetic Patient Profile Revision 为不可变来源档案；Index Encounter 及其关联资源构成私有 Case Truth；本院诊疗运行事实保存在 operational SQLite 的 FHIR R5 与领域表；全国疾病、药品、检验目录与指南全文分别保存在只读 Reference SQLite 与 Guideline SQLite。来源 R4 不转换为本院 R5，参考目录行也不复制进 operational SQLite。

每类对外 FHIR R5 资源在能力注册表中声明唯一所有权：

| 所有权 | 资源/聚合 | 写入方式 |
| --- | --- | --- |
| `fhir-native` | Patient、AllergyIntolerance、Organization、Location、Practitioner、PractitionerRole、Encounter、Task、Account、ChargeItem、Observation、ServiceRequest、Specimen、DiagnosticReport、Condition、Medication、MedicationRequest、MedicationDispense、MedicationAdministration | 只由 Case 物化或业务 Command 创建和更新；FHIR API 只读 |
| `fhir-native-immutable` | 已签署的 Composition、document Bundle、Provenance | 业务 Command 只创建新资源；更正创建显式修订关系，不覆盖已签实例 |
| `domain-native` | Workspace Actor、Agent Client/Grant、Synthetic Patient Profile/Case/Persona、Investigation Result Snapshot、Consultation、Registration、[住院事实](clinical-workflows.md#住院闭环)、Diagnosis Draft/Confirmation、Prescription、收退款与医保待遇账、库存账、临床草稿、模型执行与用量账本、Scenario Run、Action Trace、audit_log | 只通过 `/api/agent/v1`、`/api/his/v1`、`/api/sim/v1` 或内部 Command 写入 |
| `domain-projection` | AuditEvent、InventoryItem、ImagingStudy、Procedure | 从领域事实同事务生成；FHIR API 只读 |
| `simulation-private` | Index Encounter、Case Truth、隐藏来源资源和生成模型输入 | 仿真解析器内部可读；管理员仅在受控核对边界只读 Case Truth，生成模型输入不公开；普通 HIS、FHIR、来源历史和岗位 Agent 不可读取 |

Account、ChargeItem、Invoice 表达标准账务交换事实并保存在 FHIR Resource Store；实际收款、退款、患者医保待遇分配和医院侧 DRG 核定保存在领域表，通过显式引用关联。

<a id="4-单实例约束"></a>

### 部署拓扑与单实例约束

运行期硬依赖为一个 Node.js Hono 进程与本地文件系统上的 SQLite 文件。开发环境可由 Vite 独立提供前端热更新并反代 API，DSH 模式通过宿主同源 `/clinmesh-api` 与 `/clinmesh-agent-handoff` 转发到回环 Hono；生产与容器构建由同一 Node.js 进程同时托管 Web 静态资源、SPA fallback、业务 API 和 FHIR API。

operational SQLite 启用 `foreign_keys = ON`、`journal_mode = WAL` 和 `busy_timeout = 5000`，必须位于具备完整本地文件锁语义的磁盘或单实例容器命名卷（`compose.yaml` 的 `clinmesh-data`）。不支持多副本共享同一 SQLite 卷、多进程同时作为业务库 writer，或挂载在缺少锁保证的网络文件系统上。同进程 outbox dispatcher 的待处理状态全部持久化在 SQLite 中，进程重启通过租约过期与状态扫描恢复，不依赖内存定时器存活。数据库迁移、备份与带发行权威高水位合并的恢复合同见[数据库运维](storage.md#database-operations)。

### 深模块与代码结构

```text
.
├── apps/
│   ├── web/                 # Vite React 岗位工作台（standalone 与 DSH Surface 共用应用本体）
│   ├── dsh-web/             # DSH Host 代理、execution proof 与 React Surface adapter
│   ├── server/              # Hono 后端：application 服务、Command、FHIR 注册表、SQLite 迁移与仓储
│   ├── cli/                 # Catalog 驱动的 HIS/FHIR CLI 与凭据 adapter
│   ├── desktop/             # Electron 工程壳
│   ├── mobile/              # Expo 工程壳
│   └── docs/                # VitePress 投影与公开页面 manifest
├── packages/
│   ├── contracts/           # Zod schema、DTO、Operation Catalog、Agent Tool 目录与 FHIR 辅助类型
│   ├── core/                # 无平台依赖的领域纯函数和客户端规则
│   ├── ui/                  # DOM 视觉 primitives 与语义 token
│   └── views/               # 当前 Desktop 工程壳占位视图；预留未来跨端共享视图边界
├── skills/                  # 九个 model-invoked clinmesh-* 运行时 Skills
├── docs/                    # 架构合同、规格、Agent Notes（docs/decisions/）、记忆与研究
├── scripts/                 # 文档投影、校验、同步与运维脚本
├── vendor/dsh-react-surface/ # 固定 commit 的 React Surface 子模块
└── .agents/                 # 本机开发 skills（不纳入 Git）
```

后端以少量深模块隐藏内部复杂性：`IdentityService` 解析 Better Auth 会话、Membership、Agent Capability Grant 与活动 Workspace/Epoch；`CommandExecutor` 统一 `BEGIN IMMEDIATE` 事务、expected version、幂等回执、审计与 Action Trace；`FhirRepository` 封装资源读写、历史与白名单搜索；`ScenarioDataService`、`SyntheticCaseVisitService` 与 `ScenarioService` 负责合成患者生成、待挂号投影与 Epoch 重置重放；`WorkflowService`、`InpatientService` 与 `InsuranceService` 分别拥有门诊闭环、住院全链路和合成医保待遇规则；`AgentIntegrationService` 拥有 Page Context、execution proof 与 proposal 审阅生命周期；`OutboxRepository` 与 `OutboxDispatcher` 负责持久异步调度。

模块依赖方向遵循：应用层不依赖 Hono Request、React、DSH、CLI 或外部 runner；Hono 路由与 Agent HTTP adapter 只做输入校验、上下文绑定和结果关联，不复制状态机或直写业务表；`packages/contracts` 不导出 SQLite 表定义或服务端私有实现；跨端前端包约束见[跨端前端架构](../frontend-architecture.md)。

## 领域边界

| 领域 | 主要职责 | 权威模型 | 当前状态 |
| --- | --- | --- | --- |
| Identity & Access | Web 用户、十岗位上下文、Workspace Membership、Agent Client/Grant、会话与策略 | 关系表 + Better Auth | 已实现 |
| Workspace & Simulation | Profile/Case 生成、Scenario Run、隔离、虚拟时钟、Case Truth、Persona、Investigation Snapshot、Action Trace 与 Epoch 重放 | 领域表 + 私有 Case Store | 已实现 |
| Organization & Workforce | 医院、科室、病区、诊室、床位、人员、岗位 | FHIR native + 床位占用互斥表 | 已实现 |
| Terminology & Guidelines | 全局 Reference Release、DRG 离线资料与规则包、指南全文检索库及医院目录快照 | Reference SQLite + Guideline SQLite + domain snapshot | 已实现 |
| Patient & Visit | 患者标识、门诊持久挂号、住院登记入科、转床转科、候诊与岗位工作队列 | Patient/Encounter/Task 为 FHIR native；挂号与住院聚合为 domain native | 已实现 |
| Clinical Ordering & Execution | 门诊诊断/检查/处方、住院诊断/长期与临时医嘱/护士校对与给药、手术计划与耗材核实 | FHIR native + Task + domain native 聚合 | 已实现 |
| Clinical Results & EMR | 生命体征、标本、检验/放射/病理报告、已阅与更正；病历草稿、签署修订与住院病案归档 | 正式临床资源与签署件为 FHIR native；草稿与病案归档快照为 domain native | 已实现 |
| Charging, Payment & Insurance | Account/ChargeItem、合并与分次收款、原款退款、财务更正、患者合成医保待遇、CHS-DRG 预分组与医保办模拟核定 | Account/ChargeItem 为 FHIR native；收退款、医保待遇与 DRG 为 domain native | 已实现（合成模拟） |
| Inventory | 门诊与住院发药批次扣减及不可变库存移动（不含调拨、盘点与追溯码） | domain native + InventoryItem 投影 | 最小子集已实现 |
| Integration, Audit & Agent | LIS/放射/病理/支付模拟与持久 outbox；`audit_log`/AuditEvent/Provenance；DSH Surface Tools、CLI 与运行时 Skills | domain native + FHIR 投影 + 应用层 adapter | 已实现 |

<a id="15-首期实现状态"></a>

## 首期实现状态

### 运行、端口与协议

- Node.js Hono 进程统一监听 `51868`（容器内外一致），Web 开发热更新使用 `51888`，DSH Web 默认使用 `3080`，Synthea Provider 与内部 `cn-health` localizer 分别使用 `51878` 与 `51879`（localizer 不暴露宿主端口），文档站开发与预览使用 `51898/51899`。默认 ClinMesh 镜像与 `compose.yaml` 固定单实例及 `clinmesh-data` 持久卷，不包含 Java 或 Synthea；`compose.synthea.yaml` 按固定 digest 叠加预构建生成容器，Provider 可用性不作为 HIS 启动门禁。
- Better Auth 禁止公开注册，启动时幂等 seed 十个合成演示账户（挂号员、分诊护士、门诊医生、收费员、药师、住院医生、病区护士、病案人员、医保办、管理员）；人类请求实时重验 Membership、Practitioner Role 与活动 Workspace/Epoch，Agent CLI 请求实时重验短期单岗位 Capability Grant（原始 token 不落库）。
- `/fhir/R5/metadata` 仅声明已实现的 R5 `5.0.0` `read`、`vread`、`history-instance` 和白名单 `search-type`；当前资源、SearchParameter 与负面保证见 [FHIR 与 Command 合同](fhir-and-commands.md#只声明真实能力)。
- `clinmesh` CLI 从 `hisOperationCatalog` 生成全部业务命令和五个只读 FHIR 操作，支持离线目录发现、schema 检视、human profile、Agent Grant 和 Command receipt 恢复；根 `skills/` 下的九个 `clinmesh-*` 运行时 Skills 与真实 Catalog 保持漂移受测。

### 业务与前端覆盖

- **门诊闭环**：管理员生成或准备合成病例与 Patient Persona 后，经挂号、分诊、自由问诊与实时病历整理、独立检验/胸片与胸部 CT/乳腺切片病理会诊开立与预付费放行、报告已阅与更正、主次诊断线性确认、本院药房或外延处方（及无需用药结论/未调剂撤回）、结构化病历签署修订、七项门禁完诊、合并或分次收退款与合成医保待遇，最终在药房发药及取消检查退款责任结清后完成 Scenario Run。
- **住院闭环**：支持门诊住院证转收与直接入院（含固定 PCI 黄金病例准备）、护士接诊分床与转床互换、住院主次诊断与入院病情、长期/临时/PRN 医嘱与集中校对停嘱、住院药房集中发药与护士实测给药/宣教、住院检查检验送检与连续阅片、三方转科、冠脉造影与 PCI 耗材预计/逐笔登记/补录更正/完成核实、出院医嘱与出区召回、首次冻结结算与医保待遇、清床、病案首页提交审核归档、CHS-DRG 3.0 条件分组推演、医保办模拟核定及结算/归档后关联财务与医保更正。
- **Web 与 DSH Surface**：十岗位工作台共用响应式卡片架构、中英文文案目录与 `TanStack Query`（服务端状态）/ `Zustand`（纯视图状态）分工；独立 Web 支持 `system/light/dark` 主题与三档语义字号，DSH Surface 挂载于 ShadowRoot + Memory Router，跟随宿主主题并按当前岗位与页面分区动态发布窄 Tools，正式业务写入统一走 ClinMesh 原生人工审阅框。

## 跨领域架构保证与风险缓解

| 关键风险 | 架构保证与缓解机制 |
| --- | --- |
| 把“支持 FHIR”泛化为全量通用服务器或双向写 | 注册表唯一声明 `owner_kind`、交互与 SearchParameter 白名单；`domain-projection` 只读，未知搜索参数返回 `400 OperationOutcome` |
| SQLite 单 writer 锁竞争或跨世代串扰 | 同步 Command 采用小于 1 秒的短 `BEGIN IMMEDIATE` 事务（外部网络与人工审阅全部留在事务外）；所有运行表主键、外键、Search 索引与分页游标均绑定 `workspace_id + epoch` |
| 客户端超时、重试或崩溃造成重复扣费/开单/发药 | 全部写 Command 强制幂等键与 expected version（或冻结预览 token）；未知结果先查原 Command receipt 或原支付/退款尝试，禁止盲目换键重发 |
| 单容器重建、进程重启或错用备份导致状态回退与重号 | 持久 outbox 租约恢复异步事件；数据库 CLI 校验 schema、外键、完整性与 canonical state hash，受控恢复强制合并最新发行权威的按日门诊号高水位（恢复库 hash 可能因高水位推进而不同于旧备份，见[存储与事务](storage.md#database-operations)） |
| 页面 Agent 越权或过期提案在上下文变化后误提交 | Page Context 与 lease 随岗位、病例、资源版本变化立即失效并关闭未决审阅；正式提交始终在服务端重验人类登录会话与业务前置条件 |
| 模型不可用、限流或失联影响医院核心读写 | 普通 HIS 读写与确定性规则不依赖外部模型；模型调用经统一双层配额账本与持久步骤恢复，未知派发保守保留占用且不自动重发 |
