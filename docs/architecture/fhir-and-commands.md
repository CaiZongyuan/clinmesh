# FHIR 与 Command 合同

本文拥有 FHIR R5 能力、资源映射、术语、Search、版本与 HIS Command 接口合同。系统总入口见[系统架构](../architecture.md)，业务验证要求见[测试策略](../testing.md)。

## FHIR R5 策略

### 版本决策

FHIR API 基路径固定为部署 origin 下的 `/fhir/R5`。`CapabilityStatement`、当前本地 identifier/extension URL 以及未来可能发布的 IG、Profile、ValueSet、CodeSystem、SearchParameter 和 OperationDefinition 共用固定 canonical base `https://caizongyuan.github.io/clinmesh/fhir`（作为定义身份，不要求该地址承担运行中 API）。`CapabilityStatement.fhirVersion` 固定为 `5.0.0`，同一端点内禁止混用 R4、R4B 和 R5 资源。

选择 R5 的理由：它是当前最新已发布稳定版本，在 workflow、subscription、medication、inventory 和 financial 等领域语义更完整，且仿真系统无既有 R4 客户端包袱。Medplum 等 R4 生态仅借鉴模式，不使用 `@medplum/fhirtypes` 作为本项目 R5 契约；CN Core 公开 R4 语义按本项目 R5 边界重新表达，不宣称兼容 CN Core R4；若未来必须接入 R4，须在独立 `/fhir/R4` adapter 显式转换并标记信息损失，绝不能绕过 R5 业务 Command。

<a id="52-只声明真实能力"></a>

### 只声明真实能力

当前提供：

- `GET /fhir/R5/metadata`
- `GET /fhir/R5/{ResourceType}/{id}`
- `GET /fhir/R5/{ResourceType}/{id}/_history/{vid}`
- `GET /fhir/R5/{ResourceType}/{id}/_history`
- `GET /fhir/R5/{ResourceType}?search-params`

资源能力注册表中的每种资源只声明 `read`、`vread`、`history-instance` 和 `search-type`。当前注册 Patient、AllergyIntolerance、Organization、Location、Practitioner、PractitionerRole、Encounter、Task、Account、ChargeItem、Observation、ServiceRequest、Specimen、DiagnosticReport、Condition、Medication、MedicationRequest、MedicationDispense、MedicationAdministration、Procedure、Composition、Bundle、Provenance、InventoryItem、AuditEvent 和 ImagingStudy。逐资源 SearchParameter 白名单见[FHIR Search 最小实现](fhir-and-commands.md#55-fhir-search-最小实现)；所有资源共享 `_count`、`_cursor` 和 `_total=none|accurate`。

首期不声明也不实现 FHIR `POST`、通用 `PUT`、`PATCH`、`DELETE`、自定义 FHIR Operation、conditional create/update、`HEAD`、`_format`、`Prefer: return=`、system history、Bulk Data export、GraphQL、transaction Bundle、任意条件 delete、`_include:iterate`、无限 chained search 或 XML。`CapabilityStatement` 从资源能力注册表动态生成，尚未实现的 profile、terminology、custom operation 或 reference target 约束不进入 metadata。

<a id="53-资源映射"></a>

### 资源映射

#### 已注册 FHIR 资源映射

| 中国 HIS 概念 | FHIR R5 资源 | 当前所有权与建模边界 |
| --- | --- | --- |
| 患者主索引 | `Patient` | 院内患者号等身份标识使用 `Patient.identifier`；门诊号、住院号、病案号归各自就诊或病案主体 |
| 医院、科室、病区组织 | `Organization` | 医院与临床／医技科室结构 |
| 诊室、病区、床位、药房 | `Location` | 用 `partOf` 形成病区与床位等层级 |
| 医务人员与岗位分配 | `Practitioner`、`PractitionerRole` | 工号与岗位科室分配；可选职责以当前 Workspace/Epoch 未删除 `PractitionerRole` 为准 |
| 候诊／受控执行任务 | `Task` | 候诊 Task 的 `focus` 指向 `Encounter`；独立检验或给药执行 Task 的 `focus` 指向 `ServiceRequest` 或 `MedicationRequest` |
| 门诊／住院就诊 | `Encounter` | 门诊和住院由 `class`、`type`、`serviceType` 与业务上下文区分 |
| 诊断与过敏 | `Condition`、`AllergyIntolerance` | `Encounter.diagnosis` 引用 `Condition`；过敏独立建模，不作为普通 `Observation` |
| 体征、检验检查结果与报告 | `Observation`、`Specimen`、`DiagnosticReport` | 数值、UCUM 单位和参考范围结构化；`DiagnosticReport.result` 引用 `Observation` |
| 操作／治疗执行 | `Procedure` | 本次住院实际实施事实的只读 domain projection，`basedOn` 引用 `ServiceRequest`，仅声明 patient/encounter Search，不混入来源 R4 既往操作 |
| 检查检验、治疗与药品医嘱 | `ServiceRequest`、`Medication`、`MedicationRequest` | 一种药一个 `MedicationRequest`；护士校对与停嘱由受控 Command 与领域状态表达 |
| 发药与给药执行 | `MedicationDispense`、`MedicationAdministration` | 实际批次在调剂时确定，部分／多批次发药形成多个 `MedicationDispense`；`MedicationAdministration` 记录单次实际给药并经 `partOf` 引用本次 `MedicationDispense` |
| 影像与病理检查 | `ImagingStudy` | 本院检查运行事实的只读 domain projection，`DiagnosticReport.study` 引用它，不含文件路径、素材标识或来源 UID；病理模态为 `SM`，每张切片一个序列并引用其 `Specimen` |
| 费用归集与计费项 | `Account`、`ChargeItem` | 挂费与冲正由业务 Command 产生；`Account` 仅关联费用归集范围，不作为自费／医保资金账本 |
| 临床文书与溯源 | `Bundle`、`Composition`、`Provenance` | 签署件发布为不可原地覆盖的 `Bundle.type=document`（首 entry 为 `Composition`），后续修订创建新实例并通过 `Composition.relatesTo` 表达 `replaces` |
| 库存与安全审计 | `InventoryItem`、`AuditEvent` | 均为只读 domain projection，与领域库存账本及 `audit_log` 同事务提交 |

#### Extension、Profile 与非 FHIR CRUD 边界

本地 extension 遵循七条边界：（1）使用稳定 `{canonicalBase}/StructureDefinition/...` URL，不用部署域名动态生成；（2）发布后 canonical 根不可随环境变化；（3）明确 `value[x]` 类型、基数、上下文与绑定；（4）仅改变资源解释的字段才允许 `modifierExtension`，未知时不得依赖受影响内容做临床或业务决策；（5）禁止用单个巨大 JSON extension 装载完整业务对象；（6）禁止新增非标准 FHIR status code（本地子状态放 `businessStatus`、extension 或领域表）；（7）当前未发布项目 Profile/IG 或官方 Validator 流程，不在 `CapabilityStatement` 宣告 profile conformance（`Patient` 的 `synthetic-data` 仅为稳定本地标记）。已签署临床文书不可原地覆盖，每个病例最多一个签署根，FHIR `_history` 只记录同一 logical id 的服务器版本而不充当临床修订链。

| 非 FHIR CRUD 业务聚合 | 权威处理方式 | FHIR 投影边界 |
| --- | --- | --- |
| 收银支付、合并分配、原款退款与结果未知恢复 | `PaymentCollection` 与 `RefundLedger` 领域聚合 | `Account`、`ChargeItem`；不把内部收款尝试伪装为 `PaymentNotice` |
| 患者医保待遇预览、结算分摊、撤销与住院财务补偿 | `/api/his/v1/insurance/*` 命令与 `insurance_event` 事件账 | 当前不机械投影 `Coverage`、`Claim`、`ClaimResponse` 或 `ExplanationOfBenefit` |
| 药房批次库存余额、效期与发药扣减流水 | `InventoryLot` 与 `InventoryMovement` 领域表 | `InventoryItem` 只读投影 |
| 临床草稿、签署预览与批量未提交私稿 | 领域草稿表与受检 `sessionStorage` | 正式签署后才发布 `Bundle`/`Composition`/`Provenance` |
| `Case Truth`、隐藏来源资源、回执与 Action Trace | 仿真私有与平台领域表 | 普通 FHIR 与 HIS 查询一律不暴露；不使用 `Basic` 充当逃生口 |

<a id="54-中国术语与参考数据策略"></a>

### 中国术语与参考数据策略

独立 Reference SQLite 通过 `reference-data.lock.json` 和 `pnpm reference:sync` 获取、验证并导入版本固定的疾病（ICD-10）、药品与 `laboratory-cn` 来源：项目锁固定 `cn-health` 版本、Registry URL、Ed25519 信任根、Dataset Release 与 Manifest hash；`cn-health dataset materialize` 仅在显式同步时访问 Registry，运行中的 Server 只读 Reference SQLite（使用索引与 FTS 分页查询，不复制进 operational SQLite）。离线 DRG 资料（`drg-offline.lock.json` 与 `drg-distribution.lock.json`）独立保存在 `reference_offline_inventory`，固定 `offline-review`、`validationScope=integrity-only`、`runtimeEnabled=false`，仅向管理员分页只读开放并写入共享审计链；精简储存与启用流程见[DRG 离线资料储存合同](../drg-reference-storage.md)、[部署指南](../deployment.md#离线-drg-资料核对)及[DRG 条件程序决策](../decisions/implemented/architecture/2026-10-25-drg-condition-program.md)。

`laboratory-cn` Schema v2 在同一不可变 Release 中保存 WS/T 886—2026 原子项目（84）、成人参考规则（96）、组合 panel（15）与有序成员边（88）；可选 `loinc-zh-cn` Schema v2 保存 LOINC 主表、单位、标本与 panel 边（Class Type 1 入 laboratory，其余入 `other`）。Server 启动时通过内部 Command 将当前 Release 全部 active `laboratory-cn` 单项和组合自动启用为 doctor-orderable Hospital Service，确定性冻结 UCUM 单位、precision、成人规则、TAT 180 分钟与生成策略（无需 Catalog Enrichment，普通组合取共同标本、混合组合保留各成员标本，跨 Release 保持稳定服务 ID；默认不含 LOINC 时停用旧 LOINC 服务但保留已签发申请快照，管理员 CLI 仍可按上限 50 根显式发布 LOINC 服务）。

医生病例级检验目录只返回当前 Workspace/Epoch 中 active、doctor-orderable 的根服务（隐藏 dependency-only 叶子与生成策略）；开立时按 Virtual Time 计算年龄（男／女规则优先于 `all`，不足 18 岁或缺规则时稳定失败）并冻结服务版本、source coding 与完整 report definition。Simulator 解析每个报告叶子时优先复用编码、值类型和单位兼容（含[受控真值换算](../decisions/implemented/bug-fix/2026-10-16-laboratory-truth-unit-conversion.md)）的精确 `Case Truth` Observation；存在精确但不兼容事实时首次即进入 `generation-failed`（不伪造正常值，可恢复错误最多自动尝试三次且失败不留部分资源）。缺少精确事实时，有适用 `laboratory-cn` 规则的叶子按 `generation policy v1` 从 `inputHash`、服务版本与 concept ID 的 SHA-256 固定位确定性生成值（`fixed-normal` 取 `valueString`，单侧临床范围仅入报告语义不作随机边界），其余 LOINC 叶子才调用 Investigation Agent；结果以 WS/T 886 system 为主并附 LOINC crosswalk 与 `Provenance` 溯源。

术语与编码绑定遵循以下原则：

- 目录查询与 FHIR 绑定使用稳定的 `system + version + code + display`，外部编码映射键必须包含 `system + version + code` 三元组，禁止以显示文本 fallback 或跨 system 碰撞相同 code。
- 诊断、处方、医嘱和申请在创建时保存所选 coding/display 快照，切换全局 Reference Release 不改写既有病历；Synthea R4 来源 coding 仅用于展示 Visible Source History 和解析同编码隐藏 Observation，不建设到本院疾病或药品目录的通用映射。
- 数值单位转换由审核映射显式保存源 UCUM code、目标 UCUM code 与换算因子，禁止只替换单位标签而不转换数值；院内码、国家码、医保码仅在表达同一语义概念时才并列于同一 `CodeableConcept.coding`。
- 当前不发布 `CodeSystem`、`ValueSet`、`ConceptMap` 或 `$validate-code`／`$expand`／`$lookup`／`$translate` terminology operation；仓库只提交合法的最小演示子集或合成术语。

<a id="55-fhir-search-最小实现"></a>

### FHIR Search 最小实现

`CapabilityStatement.rest.resource.searchParam.definition` 只声明真实实现的 R5 标准或项目固定 `SearchParameter` canonical，禁止从字段名猜测搜索语义（`patient`、`subject`、`encounter` 不跨资源自动同义）。通用结果控制参数固定为 `_count`（默认 20，上限 100）、`_cursor`（服务端 HMAC 签名 keyset cursor）和 `_total=none|accurate`（默认 `none`，不伪造 `estimate`）。

当前业务 SearchParameter 白名单：

- `Patient` `name`（NFKC 归一化、小写化前缀匹配）与 `identifier`（归一化精确匹配）。
- `patient` 精确引用匹配：AllergyIntolerance、Condition、Encounter、Task、Account、ChargeItem、Observation、ServiceRequest、Specimen、DiagnosticReport、MedicationRequest、MedicationDispense、MedicationAdministration、Procedure、Composition 和 ImagingStudy。
- `encounter` 精确引用匹配：Condition、ChargeItem、Observation、ServiceRequest、DiagnosticReport、MedicationRequest、MedicationDispense、MedicationAdministration、Procedure、Composition 和 ImagingStudy。
- `Task` `focus`：接受 Encounter、ServiceRequest 或 MedicationRequest 引用。
- `MedicationDispense` `prescription`：只接受 MedicationRequest 引用。
- `MedicationAdministration` `request`：只接受 MedicationRequest 引用（`patient` 与 `encounter` 分别索引 `subject`、`encounter`；R5 `5.0.0` 字段名为 `occurenceDateTime`，`medication` 与 `performer.actor` 使用 `CodeableReference`，`partOf` 引用本次 `MedicationDispense`）。
- `Provenance` `target`：接受 Bundle、Composition、Condition、DiagnosticReport、Encounter、Observation、ServiceRequest、Specimen 或 Task 引用。

reference 参数只索引本地相对引用，写入时按注册表校验引用格式、目标资源类型及当前 Workspace/Epoch 存在性，任一失败整笔 Command 回滚。keyset cursor 绑定 Workspace、Epoch、resource type、规范化查询 hash、`lastUpdated`、resource ID tie-breaker 与五分钟有效期（弱一致分页语义，客户端按 `id + versionId` 去重，禁止跨上下文重放）。服务器固定采用严格搜索处理：未知参数、未知 modifier、不支持组合及未实现的 chain、`_include`、`_revinclude`、`_has`、`_sort`、`_summary`、`_elements`、FHIRPath filter 或 `Prefer: handling=lenient` 均返回 `400 OperationOutcome`；授权过滤下推 SQL，`Bundle.link` 返回完整同源 `self` 与 `next`。

### 版本与并发

每个 FHIR 资源维护单调递增整数字符串 `meta.versionId`（非业务修订号）、真实提交时间 `meta.lastUpdated` 以及来自虚拟时钟的业务时间字段；内容未变化时不创建新版本。`read` 与 `vread` 返回 `ETag: W/"{versionId}"`（不返回 `Last-Modified`）；对任意资源的 generic `PUT` 返回 `405 OperationOutcome` 并提示使用业务 Command，不提供 FHIR `POST`、`PATCH`、`DELETE`、`If-Match` 写语义、tombstone 或 expunge。

## 接口设计

### 路径规划与 FHIR 写入策略

| 路径 | 职责与边界 |
| --- | --- |
| `/fhir/R5/*` | 只读 FHIR R5 互操作面（`Command-owned FHIR native`、`Read-only projection` 与不可变已签文书均拒绝 HTTP FHIR 直接写入，`Hidden` 仿真资产与内部回执不暴露） |
| `/api/his/v1/*` | 非 FHIR 领域查询与显式业务 Command |
| `/api/sim/v1/*` | 合成患者生成、专病病例包与 PCI 准备、Persona 管理、虚拟时钟推进与管理员 reset/replay |
| `/api/auth/*` | Web 登录、注销、会话和岗位上下文切换 |
| `/api/agent/v1/page-contexts` | 从白名单 claim、DSH Session 和 client revision 签发短期受信 Page Context |
| `/api/agent/v1/tool-calls`、`/review`、`/result` | 用 DSH execution proof 授权一次 Tool call，线性化人类 proposal 审阅决定，并串联 Command、Audit 与 Trace |
| `/api/agent/v1/doctor-queries`、`/doctor-tasks/permit` | 复验医生任务与当前 Context 执行授权只读查询，并为右侧原生会话提交的医生原文签发短期输入许可 |
| `/api/agent/v1/clients*`、`/api/agent/v1/grants*` | 管理员管理 Agent Client/Grant，以及任务 Agent 读取受信 context |

当前路由表不发布通用 `/api/tools/v1`、`/mcp`、SMART discovery、Agent OAuth 或自定义 FHIR `$operation`；未来若为单一 FHIR 资源定义 `OperationDefinition`，必须仅限 `POST`、明确 `system/type/instance` 层级与 `Parameters` 输入输出并立即转换为强类型 Command，跨多账户、多费用、医保与收款的结算继续保留在 HIS Command API。

### HIS Command API

全部可执行 HIS 与仿真操作的 canonical operation ID、HTTP 方法与路径、`cliPath`、输入／输出 Zod schema、岗位 allowlist、风险分级及幂等／expectedVersion 合同，均由 [`packages/contracts/src/his-operations.ts`](../../packages/contracts/src/his-operations.ts) 的 `hisOperationCatalog` 与 `excludedHisRoutes` 唯一权威拥有，并由路由覆盖测试校验。

普通挂号、合成病例开始（`GET /api/his/v1/registration/synthetic-cases` 仅允许挂号员分页读取同 Workspace `brief-ready` 且未开始病例的安全人口学与版本投影，不含 `Case Truth` 或来源历史）及 Epoch 重放共用门诊发号边界，发行状态、Registration、`Encounter.identifier` 与回执原子提交；异常返回 `REGISTRATION_NUMBER_*` 并保留原意图，持久性见[存储与事务](storage.md#94-标识符)。

Command 写请求经同源 session 与 CSRF（或短期 Capability Grant）校验，通过 `Idempotency-Key` 请求头与统一 JSON envelope 提交（服务端解析 Actor、岗位、Workspace 和 Epoch，忽略客户端自报身份）：

```json
{
  "expectedVersions": {
    "Encounter/018f...": "7",
    "MedicationRequest/018e...": "3"
  },
  "input": {}
}
```

`virtual-patient.start-consultation` 的公开 `expectedVersions` 为空对象，由服务端从 `input.expectedVersion` 还原底层依赖集；`encounter.consultation.ask` 先以短事务追加医生发言，在事务外生成患者回复后再以第二个 Command 追加，`encounter.consultation.reply.retry` 仅补答尚未取得文本回复的医生发言。成功响应统一返回：

```json
{
  "data": {},
  "effects": [
    { "kind": "updated", "reference": "MedicationRequest/018e...", "versionId": "4" }
  ],
  "warnings": [],
  "requestId": "req-...",
  "auditId": "audit-..."
}
```

FHIR 端点错误返回 `OperationOutcome`，HIS 端点返回带稳定错误码与 `X-Correlation-Id` 的统一错误 envelope，不泄漏堆栈或内部 SQL。

<a id="65-idempotency"></a>

### Idempotency

CommandExecutor 以 `(workspace_id, epoch, actor_id, operation, idempotency_key)` 唯一识别业务请求，在同一个 `BEGIN IMMEDIATE` 事务内插入 `executing` 回执、执行业务写并在提交前转为 `completed`。规范化请求 hash 同时绑定 `expectedVersions`、业务输入以及服务端解析的 Practitioner、Practitioner Role、role code、Organization 和 Location；相同 Actor 切换岗位后重用同一 key 返回稳定冲突，公开 receipt 查询也要求当前岗位与原 Command 一致。相同 key 且相同 hash 无写返回首次完整响应；相同 key 但 hash 不同返回冲突；事务失败时业务事实、FHIR、receipt、审计、Action Trace 和 outbox 一起回滚，另写不含请求正文的失败审计。

住院登记额外校验原意图的 `expectedEpoch` 乐观前置断言：防止跨 Epoch 重放复用同一 `Patient` 版本时让旧人类会话请求误在新 Epoch 登记收款，不匹配返回 `INPATIENT_EPOCH_CONFLICT`。外部模拟任务不复用 Command receipt，而是通过独立持久 outbox（`queued`、`claimed`、`completed`、`failed`、`ambiguous`、`abandoned`）按租约与 `next_attempt_at` 调度；结果未知保持 `ambiguous`，严禁当作普通失败盲目重做。

<a id="66-预览与提交"></a>

### 预览与提交

- **文书签署与门诊单项／合并支付**：结构化病历预览（绑定 Actor context、草稿版本与 Encounter 版本）和门诊支付预览（绑定岗位、ChargeItem 版本、金额与组合方式）按服务端事实计算摘要并返回真实时间五分钟有效的签名 `commitToken`，不改写权威状态；提交时重验 token、Actor context、Workspace/Epoch、有效期及 `expectedVersions`，客户端不得回传或篡改预览 effects。药房发药直接凭 Prescription `expectedVersion` 与库存批次条件写提交。
- **患者医保待遇**：`insurance.get/preview/confirm/cancel` 仅向收费员开放，通过受信路径 `kind/id` 绑定门诊或住院目标；预览冻结原费用、目录指纹及患者年度与账户版本，确认凭 `previewId/commitToken` 重读依赖，撤销凭原 `settlementId` 和领域 `expectedBalanceVersion` 追加逆向事件，详细规则见[收费、结算与医保](billing-and-insurance.md)。
- **门诊账单分页与未知收款恢复**：`billing.case.get`（及仅绑定当前就诊的 Surface `billing.case.read`）向收费员返回单次门诊净应收与按时间及 payment ID 倒序分页的原支付历史（`page`/`pageSize` 默认 `1`/`20`、上限 `100`，合并原款以 `kind: "multi-charge"` 携带完整 `allocations` 仍占单条记录）。`payment.recover` 与 `payment.multi-charge.recover` 要求原应收或全部原分配的 ChargeItem `expectedVersions`、幂等键与 `input.expectedPaymentVersion`（未决支付版本为 `1`，追加确定结果后为 `2`，不接受任意金额或 outcome 输入），见[收费、结算与医保](billing-and-insurance.md)。
- **住院结算与病案首页**：住院结算采用逐项账目指纹预览而非五分钟 `commitToken`，提交校验原预览指纹、Encounter 版本与预期金额；病案首页 `inpatient.record.read/submit/review/archive` 显式携带实际主操作选择并绑定 `expectedRevision` 与 `expectedSourcesHash`（`INPATIENT_RECORD_STALE` 须重审来源重提，归档后新写返回 `INPATIENT_RECORD_ARCHIVED` 且优先无写重放旧回执），门禁见[住院与手术流程](inpatient-workflows.md)。
