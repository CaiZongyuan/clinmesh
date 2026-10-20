# FHIR 与 Command 合同

本文拥有 FHIR R5 能力、资源映射、术语、Search、版本与 HIS Command 接口合同。系统总入口见[系统架构](../architecture.md)，业务验证要求见[测试策略](../testing.md)。

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

<a id="52-只声明真实能力"></a>

### 5.2 只声明真实能力

当前提供：

- `GET /fhir/R5/metadata`
- `GET /fhir/R5/{ResourceType}/{id}`
- `GET /fhir/R5/{ResourceType}/{id}/_history/{vid}`
- `GET /fhir/R5/{ResourceType}/{id}/_history`
- `GET /fhir/R5/{ResourceType}?search-params`

资源能力注册表中的每种资源只声明 `read`、`vread`、`history-instance` 和 `search-type`。当前注册 Patient、AllergyIntolerance、Organization、Location、Practitioner、PractitionerRole、Encounter、Task、Account、ChargeItem、Observation、ServiceRequest、Specimen、DiagnosticReport、Condition、Medication、MedicationRequest、MedicationDispense、MedicationAdministration、Composition、Bundle、Provenance、InventoryItem、AuditEvent 和 ImagingStudy。

逐资源 SearchParameter 白名单见 [5.5 节](fhir-and-commands.md#55-fhir-search-最小实现)。所有资源共享 `_count`、`_cursor` 和 `_total=none|accurate` 三个结果控制参数。

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

<a id="53-资源映射"></a>

### 5.3 资源映射

#### 5.3.1 直接作为 FHIR native

下表是领域到 FHIR R5 的架构映射，不是当前 CapabilityStatement 清单。只有 [5.2 节](fhir-and-commands.md#52-只声明真实能力)列出的资源和 interaction 可由当前 FHIR API 访问；其他映射在对应业务实现并加入同一能力注册表后才构成公开能力。

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
| 影像检查 | `ImagingStudy` | 本院检查运行事实的只读 domain projection；DiagnosticReport 通过 `study` 引用它，正文不含文件路径、素材标识或来源 UID。病理会诊的检查模态为 `SM`，每张切片一个序列并引用其 Specimen |
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

独立 Reference SQLite 通过 `reference-data.lock.json` 和 `pnpm reference:sync` 获取、验证并导入版本固定的疾病、药品与检验来源。项目内锁固定 `cn-health` 版本、Registry URL、Ed25519 信任根、Dataset Release、Manifest hash 和复合 Release 身份；`cn-health dataset materialize` 只在显式同步时访问 Registry，并把签名已验证的 Manifest、SQLite 和 receipt 原子交给 ClinMesh。ClinMesh 再校验 receipt、hash、SQLite、Schema 和 canonical 表不变量。check-only 使用临时 Reference SQLite，正式同步失败不留下部分 Release，也不切换 Server 当前 Release。运行中的 Server 只读 ClinMesh Reference SQLite，不调用 `cn-health`、GitHub 或 Registry。

每个成功发布的 Reference Release 固定来源版本、许可、artifact checksum、materialization provenance、记录数、导入诊断和 content hash。`loinc-zh-cn` Dataset Schema v2 把完整 LOINC 主表、单位、SYSTEM 标本关系和 panel 成员边保存在同一不可变 Release，Class Type 1 进入 laboratory domain，其他 Class Type 进入 `other`。`laboratory-cn` Schema v2 在同一 Release 中保存 WS/T 886 原子项目、全部成人参考规则、项目整理 panel 和有序成员边；首个锁定 Release 的四张表分别有 84、96、15 和 88 条记录。Server 使用索引和 FTS 提供有界分页查询，不把全国目录复制进 Workspace、Epoch 或 operational SQLite。

目录搜索返回稳定的 `system + version + code + display`。诊断、医嘱等本院 R5 业务事实在创建时保存所选 coding/display 快照，因此切换全局当前 Release 不会改写既有病历。Synthea R4 来源 coding 仅用于呈现 Visible Source History 和解析同 LOINC 的隐藏 Observation；不以显示文本匹配，不建设 Synthea 到本院疾病或药品目录的通用映射。

Reference Concept 拥有检验术语、分类、值类型、UCUM 单位、标本、成人规则和 panel 关系。默认 Reference Release 包含疾病、药品和 `laboratory-cn`，不下载或导入独立 LOINC Dataset。Server 启动时通过内部 Command，自动把当前 Release 的所有 active `laboratory-cn` 单项和组合启用为 doctor-orderable Hospital Service；正常临床使用不需要管理员选择或发布。确定性 policy 冻结单位、precision、成人规则、健康生成策略、TAT 180 分钟和未计价状态，不调用 Catalog Enrichment。单项拥有独立可开服务，组合同时拥有不可单独开立的成员服务；同一来源编码跨 Release 保持服务 ID，重复启动不修改已经匹配的版本。普通组合取全部成员共同支持的标本，明确声明混合标本的组合保留各成员标本。默认 Release 不含 LOINC 时，已有 LOINC 服务停用，但已签发申请的冻结快照保留。管理员 CLI 保留显式配置路径：候选查询默认 laboratory-cn，显式 LOINC 来源需要包含该 Dataset 的 Reference Release；人工批次上限 50 根，LOINC 运营字段仍需 Catalog Enrichment。

医生病例级检验目录只返回当前 Workspace/Epoch 中 active、doctor-orderable 的 Hospital Laboratory Service；dependency-only 叶子不会单独出现。所有可见项目都可保存草稿和正式开立，响应不含 Case Truth、模型或 Investigation Generation Capability。开立时冻结服务版本、source coding 和完整 report definition；成人规则按 Virtual Time 计算年龄，男/女规则优先于 `all`，其他或未知性别只使用 `all`。不足 18 岁或任一叶子没有适用规则时，保存和开立都以稳定领域错误失败。

Simulator 对每个冻结报告叶子先复用编码、值类型和单位兼容的精确 Case Truth Observation；单位兼容包括[受控真值换算](../decisions/implemented/bug-fix/2026-10-16-laboratory-truth-unit-conversion.md)。存在精确但不兼容的事实时失败，不生成正常值。缺少精确事实且存在适用的 `laboratory-cn` 规则时，generation policy v1 从 input hash、服务版本和 concept ID 的 SHA-256 固定位生成均匀值，使用独立 simulation bounds、precision 舍入和夹紧；fixed-normal 直接使用冻结字符串。其余 LOINC 叶子才进入 Investigation Agent。一个 panel 可以混合精确结果和 Adult Reference Baseline，每个结果记录来源；单侧临床范围只进入报告语义，不作为随机边界。outbox 对可恢复错误最多自动尝试三次，确定性真值兼容错误首次即进入 `generation-failed`；失败不创建部分 Specimen、Observation、DiagnosticReport 或 Provenance。Snapshot 按 Case revision、冻结服务/报告版本和申请前证据形成 input hash；相同请求、重试和 Reset 初始证据复用，新正式证据产生新 Snapshot。

`laboratory-cn` 的 Observation 以 ClinMesh-owned WS/T 886 system 为主并附可用 LOINC crosswalk，Quantity 使用 UCUM，fixed-normal 使用 `valueString`。Specimen 使用本地 specimen system；ServiceRequest 和 DiagnosticReport 同时保留本院服务与 source panel coding。Provenance 关联 Investigation Result Snapshot、ClinMesh Reference Release、Dataset Release、generation policy 和 input hash。WS/T 886—2026 在 2026-11-01 实施；更早的 Hospital Baseline 只能以明确 future-standard preview 方式启用，不能描述为已生效标准。

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

<a id="55-fhir-search-最小实现"></a>

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
- `patient` 精确引用匹配：AllergyIntolerance、Condition、Encounter、Task、Account、ChargeItem、Observation、ServiceRequest、Specimen、DiagnosticReport、MedicationRequest、MedicationDispense、MedicationAdministration、Composition 和 ImagingStudy。
- `encounter` 精确引用匹配：Condition、ChargeItem、Observation、ServiceRequest、DiagnosticReport、MedicationRequest、MedicationDispense、MedicationAdministration、Composition 和 ImagingStudy。
- Task `focus`：接受 Encounter、ServiceRequest 或 MedicationRequest 引用。
- MedicationDispense `prescription`：只接受 MedicationRequest 引用。
- MedicationAdministration `request`：只接受 MedicationRequest 引用；`patient` 与 `encounter` 分别索引 subject、encounter。R5 5.0.0 正式字段为 `occurenceDateTime`，medication 与 performer.actor 使用 CodeableReference；partOf 引用本次实际 MedicationDispense。
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
| `/api/agent/v1/doctor-queries` | 在实际查询时复验医生任务、当前 Context 与 pending receipt，只读当前病例及授权历史 |
| `/api/agent/v1/doctor-tasks/permit` | 为原生侧栏提交的医生原文签发短期输入凭证 |
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
POST /api/his/v1/encounters/{id}/actions/ask-consultation-question
POST /api/his/v1/encounters/{id}/actions/retry-consultation-reply
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
GET  /api/his/v1/doctor/cases/{id}/document-quality-control
POST /api/his/v1/doctor/cases/{id}/document-quality-control/actions/check
POST /api/his/v1/doctor/cases/{id}/document-quality-control/actions/retain
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
POST /api/sim/v1/synthetic-cases/{id}/patient-persona-jobs
GET  /api/sim/v1/patient-persona-jobs/{id}
GET  /api/sim/v1/synthetic-cases/{id}/patient-persona-revisions
POST /api/sim/v1/synthetic-cases/{id}/patient-persona-revisions
PUT  /api/sim/v1/synthetic-cases/{id}/patient-persona-revisions/active
GET  /api/his/v1/registration/synthetic-cases
POST /api/his/v1/synthetic-cases/{id}/actions/start-outpatient-visit
```

`GET /api/his/v1/registration/synthetic-cases` 只允许挂号员读取同一 Workspace 中 `brief-ready`、具有活动 Patient Persona 且尚未开始的病例，支持按姓名或病历号分页检索。响应从 Case 固定的 Profile Revision 投影病例 ID、Case/Profile/Persona revision、病例类型、姓名、病历号、性别和出生日期；不读取当前 Profile，也不返回 Case Truth、来源 Bundle、生成配置或来源历史详情。


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

`encounter.consultation.ask` 接收自由文本 `message`、当前 Encounter/Task expected versions 和 `expectedConsultationVersion`。医生发言先由共享 Command 以短事务追加；患者模型在事务外生成回答，再由第二个 Command 追加。完整响应保留 `requestId`、`auditId`、`effects` 与双方轮次；病例详情只返回有序 `turns` 和聚合版本。`encounter.consultation.reply.retry` 只为尚未得到文本回答的医生发言生成回答，输入为 Encounter ID 和当前 Consultation version。

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

<a id="65-idempotency"></a>

### 6.5 Idempotency

Web mutation、outbox dispatcher 和模拟器处理都可能重试。CommandExecutor 以 `(workspace_id, epoch, actor_id, operation, idempotency_key)` 唯一识别业务请求，并保存规范化请求 hash、Acting Practitioner Role、完整响应与 Effect 引用。请求 hash 同时绑定 expected versions、业务输入以及服务端解析的 Practitioner、Practitioner Role、role code、Organization 和 Location；相同 Actor 切换 Acting Practitioner Context 后重用 key 会得到稳定冲突，公开 receipt 查询也要求当前 Practitioner Role 与原 Command 一致，不能读取上一岗位的回执。升级前 receipt 从对应成功 Audit Event 回填岗位，无法可靠解析的旧记录保持不可由有岗位 context 查询。

Command receipt 的 `executing` 插入与业务写处于同一个 `BEGIN IMMEDIATE` 事务，成功时在提交前变为 `completed`。相同 key 和相同 hash 读取并返回第一次完整响应；相同 key 和不同 hash 返回稳定冲突。事务失败时业务事实、FHIR、receipt、审计、Action Trace 和 outbox 一起回滚，失败尝试另写不包含请求正文的审计记录。

住院登记额外要求原意图的 `expectedEpoch`：它是 Command 事务中对受信 Epoch 的乐观前置断言，不参与 Workspace/Epoch 选择或授权。Scenario 重放可能复用 Patient logical id 与版本，单独的 Patient expected version 不能阻止旧人类 Cookie 请求在新 Epoch 登记收款；不匹配返回 `INPATIENT_EPOCH_CONFLICT` 且不创建住院和资金事实。登记 Catalog version 2 与运行时 Skill 同步声明该字段。

外部模拟工作不复用 Command receipt 状态机。持久 outbox 独立使用 `queued`、`claimed`、`completed`、`failed`、`ambiguous` 和 `abandoned`；claim 带 owner、lease version、过期时间、attempt 和 correlation ID。可重试失败在达到最大尝试前按 `next_attempt_at` 重新领取，结果未知保持 `ambiguous`，Epoch 关闭变为 `abandoned`。结果未知不得当作普通失败盲目重做。

### 6.6 预览与提交

当前临床文书签署和支付使用预览/提交协议。结构化病历预览绑定 Actor context、独立草稿版本和 Encounter 版本；首期复诊兼容预览同时绑定旧文书、诊断、Prescription 和 Encounter；支付预览绑定 Charge Item。预览从服务端事实计算文书摘要或金额分配并返回按服务端真实时间计时、五分钟有效的签名 `commitToken`，不修改权威临床、费用或支付状态。

提交验证 token、Actor context、Workspace/Epoch、过期时间和 expected versions，然后重新读取并校验依赖。客户端不能回传或修改预览 effects。发药使用 Prescription expected version 与库存批次条件写直接提交；退药、退款、医保、库存调拨、出院和病案归档不属于当前能力，也不宣称已有预览协议。
