# ClinMesh 仿真医院领域

ClinMesh 用可重复、可审计的合成医院场景，为人类岗位和 Agent 提供中国公立医院业务环境。本词汇表只定义领域语言，不描述技术实现。

## 仿真环境

**Workspace**:
一组彼此隔离的医院仿真事实和参与者上下文。一个 Workspace 可以经历多次重置，但同时只有一个活动数据世代。
_Avoid_: Tenant, database, session

**Epoch**:
Workspace 内一次不可复用的数据世代。重置产生新 Epoch，旧 Epoch 的结果不能改变新 Epoch。
_Avoid_: Reset version, generation number

**Scenario**:
版本固定的初始事实、Hidden Fact、时间、外部行为规则和允许动作集合。修订产生新版本，已经开始的 Scenario Run 继续绑定原版本。
_Avoid_: Seed, fixture, demo data

**Scenario Run**:
一个 Scenario 在某个 Workspace/Epoch 中的一次执行，由一个或多个 Actor 产生有序行动和结果。
_Avoid_: Session, chat, test

**Action Trace**:
Scenario Run 中按顺序保存的观察动作、Command 尝试、结果和 Effect 引用。它用于回放和过程分析，不等同于 Audit Event、Provenance 或应用日志。
_Avoid_: Audit Event, Provenance, application log, chain-of-thought

**Virtual Time**:
Scenario 中业务事件发生所依据的医院时间。它与系统接收请求和执行安全控制所用的真实时间不同。
_Avoid_: Server time, created time

**Hidden Fact**:
Scenario 预先定义、普通参与者必须通过合规观察才能发现的事实。
_Avoid_: Secret, hidden field

**Reveal Policy**:
Scenario 中规定哪些合规观察会把 Hidden Fact 转化为参与者可见业务证据的规则。
_Avoid_: Scoring rule, direct hidden access

**Hospital Baseline**:
Scenario 采用的虚构医院类型、所属地区和政策生效日期。它限定组织、目录、价格和地域规则，不能被解释为全国统一医院模型。
_Avoid_: Generic Chinese hospital, live policy

**Reference Data Package**:
构建 Scenario 时使用的版本固定 Reference Data Release 与审核映射集合，并保留来源、地域、有效期和使用条件。它不是运行中的医院事实，也不是完整 Scenario。
_Avoid_: Seed, live catalog, Scenario

**Reference Data Release**:
一次不可变发布的规范化参考术语或目录数据及其来源清单。它是 Scenario authoring 输入，不表示某所医院已经启用其中项目。
_Avoid_: Hospital Baseline, live catalog, patient fact

**Generation Batch**:
一次受控生成请求产生的一组合成患者及其共同来源参数。Generation Batch 只表达 provenance，不是患者生命周期，也不决定患者是否进入业务流程。
_Avoid_: Patient library, review batch, lifecycle

**Synthetic Patient Profile**:
可复用的合成患者身份、来源病史和业务展示信息。它独立于活动 Epoch，尚未发起就诊时不等同于运行中的 Patient Identity 或 Virtual Patient。
_Avoid_: Patient Identity, Virtual Patient, Scenario Dataset

**Synthetic Patient Library**:
一个 Workspace 中全部 Synthetic Patient Profile 的持久集合。患者未被选入就诊不会因此被丢弃，Generation Batch 仅作为其来源维度。
_Avoid_: Generation Batch, Scenario Dataset list, queue

**Profile Revision**:
Synthetic Patient Profile 一次不可覆盖的修订。修订不改写已经创建的 Patient、Registration 或 Encounter 事实，只影响之后的业务物化。
_Avoid_: FHIR resource version, Dataset version, overwrite

**Index Encounter**:
Synthea 来源时间线中最后一次具有诊断、检验、用药、操作或明确就医原因的临床 Encounter。它定义待诊断的本次就医，不等同于 ClinMesh 后续创建的本院 Encounter。
_Avoid_: Latest event, local Encounter, visible history

**Visible Source History**:
Index Encounter 之前允许临床参与者查看的本地化 Synthea 来源资源及其时间线投影。它是外部合成病史，不表示本院实施过这些诊疗活动。
_Avoid_: Local FHIR record, Case Truth, imported Encounter

**Case Truth**:
由 Index Encounter 及其关联来源资源组成的本次病例客观依据。它只供仿真器使用，不是参与者可直接读取的 Clinical Record，也不能通过普通 HIS、FHIR、历史详情或 Agent 接口返回。
_Avoid_: Clinical Record, answer key endpoint, Visible Source History

**Synthetic Case Instance**:
绑定一个不可变 Profile Revision、Case Truth、病例类型和可见历史清单的合成病例实例。普通业务只能开始一次；管理员可在新 Epoch 中重放同一不可变 revision。
_Avoid_: Synthetic Patient Profile, local Encounter, Scenario Dataset

**Patient Brief**:
根据合成患者背景和本次病例证据生成的患者初始表现，包括主诉、开场陈述、已知史摘要和问诊主题。它不得直接泄露参与者尚不可见的本次诊断。
_Avoid_: Case Truth, diagnosis note, chat transcript

**Brief Revision**:
一次通过结构校验和诊断泄漏检查的不可覆盖 Patient Brief 结果。Case 只能选择已有成功 revision，重新生成不会改写旧结果。
_Avoid_: Editable prompt output, Case revision, overwrite

**Investigation Result Snapshot**:
针对一个 Synthetic Case Instance 和一个固定检查编码首次成功解析或生成的不可变结构化结果。后续重试和新 Epoch 重放复用该结果，不再次调用外部模型。
_Avoid_: Live laboratory result, mutable simulator response, normal fallback

## 身份与参与

**User Account**:
可登录 ClinMesh 的人类认证身份。一个 User Account 可以加入多个 Workspace，但不等于医院工作人员、岗位或权限。
_Avoid_: User, Practitioner, role

**Actor**:
在 Workspace 中发起受审计行为的认证主体，可以是 User Account、系统客户端或 Agent client。Actor 与其代表的 Practitioner 分别记录。
_Avoid_: User, Practitioner, role

**Workspace Membership**:
Actor 参与特定 Workspace 的资格及其可承担岗位范围。Membership 不表示 Actor 当前正以哪个岗位行动。
_Avoid_: Tenant user, account role

**Practitioner**:
Scenario 中的一名医院工作人员。Practitioner 可以没有对应的 User Account，也不能自行表达其岗位、地点或系统权限。
_Avoid_: User Account, login identity, role

**Practitioner Role**:
Practitioner 在特定组织、地点和职责下的一项岗位分配。同一 Practitioner 可以拥有多项 Practitioner Role。
_Avoid_: Account role, permission

## 行动与结果

**Command**:
参与者表达的单一业务意图，其执行受角色、状态和领域不变量约束。
_Avoid_: CRUD, endpoint, method call

**Effect**:
Command 成功后产生的可观察事实变化。
_Avoid_: Response, side effect

**Approval Grant**:
授权特定参与者在特定上下文中提交一个已预览高风险 Command 的一次性许可。
_Avoid_: Confirmation, yes/no flag

**Ambiguous Outcome**:
外部动作可能已经发生，但系统尚不能可靠确认成功或失败的状态。
_Avoid_: Timeout, retryable failure

## 患者与就诊

**Patient Identity**:
表示同一个自然人的稳定身份及其患者级标识。
_Avoid_: Visit number, inpatient number, medical record number

**Appointment**:
患者与医疗服务在未来时间上的预约承诺。
_Avoid_: Registration, queue ticket, Encounter

**Registration**:
医院接受患者进入某次门诊或住院流程的业务事实，可来自预约、现场、加号或急诊入口。
_Avoid_: Appointment, check-in

**Encounter**:
患者与医院发生的一次实际或计划中的诊疗互动。
_Avoid_: Patient, Appointment, Episode

**Queue Task**:
某次就诊在候诊、叫号或岗位工作队列中的待处理工作。
_Avoid_: Appointment status, Encounter status

**Virtual Patient**:
由版本固定的合成病例事实和确定性回答规则驱动、可供参与者完成诊疗流程的患者表现。Virtual Patient 不是真实患者，也不等同于 Scenario 或 Patient Identity。
_Avoid_: Real patient, chatbot, Scenario

**Consultation Record**:
一次 Encounter 中医患问答的有序业务记录。它保存问诊过程，但不等同于医生整理和签署的 Clinical Document。
_Avoid_: Clinical Document, chat transcript, medical record

**Report Acknowledgement**:
负责医生确认已查看一份已签发诊断报告的业务事实。它不改变报告内容或签发状态。
_Avoid_: Report status, report approval, read receipt

**Encounter Completion**:
负责医生确认一次 Encounter 已满足临床收尾条件并结束本次诊疗责任的业务事实。它不等同于收费、发药、Scenario Run 完成或病案归档。
_Avoid_: Discharge, Scenario completion, archive

**Acting Practitioner Context**:
超级管理员在不改变登录身份的前提下选择的当前 Practitioner Role 和 Practitioner 行动上下文。审计同时保留超级管理员 Actor 与被选择的工作人员。
_Avoid_: Login identity, account switch, unrestricted impersonation

**Bed Occupancy**:
一个床位在一段时间内被某次住院就诊预占或实际占用的互斥事实。
_Avoid_: Encounter location, bed status text

## 临床请求与执行

**Drug Concept**:
不绑定生产企业、批准文号、产品包装或医院可用性的药物语义概念，可表达成分以及临床必要的强度和剂型。
_Avoid_: Medication Product, hospital medication catalog item, Inventory Lot

**Medication Product**:
由注册或产品目录识别的具体药品呈现，包含剂型、规格、包装、企业和监管标识等产品属性。
_Avoid_: Drug Concept, Hospital Medication, Inventory Lot

**Hospital Medication**:
某所医院已启用的 Medication Product，拥有本院代码、可用范围、价格和处方规则，但不表示某个具体库存批次。
_Avoid_: Drug Concept, Medication Product, Inventory Lot

**National Medical Service**:
国家层面对检查、检验或治疗项目边界及计价单位的规范定义，不表示某所医院已经开展，也不拥有本院价格。
_Avoid_: Hospital Service, Charge Definition, Clinical Request

**Hospital Service**:
某所医院从 National Medical Service 选择并启用的服务项目，拥有本院代码、执行科室、可用范围、TAT、组合成员和报告模板。
_Avoid_: National Medical Service, Charge Definition, Clinical Request

**Charge Definition**:
医院对一个可收费项目固定的计价单位、币种、价格和生效日期定义；它不是患者已经发生的费用事实。
_Avoid_: National Medical Service, Hospital Service, Charge Item

**Clinical Request**:
临床人员对药品、检查、检验、治疗或耗材提出的单项意图。
_Avoid_: Prescription, template, execution record

**Request Orchestration**:
一组请求或建议之间的组合、选择、条件和顺序。
_Avoid_: Order set template, prescription, execution plan

**Order Set Template**:
可复用但尚未下达的临床请求模板。
_Avoid_: Clinical Request, Request Orchestration

**Prescription**:
按处方号和业务规则归组、用于审核、收费与调剂的一组药品请求。
_Avoid_: MedicationRequest, Request Orchestration

**Execution Plan**:
根据长期或重复 Clinical Request 展开的待执行时点和工作安排。
_Avoid_: Clinical Request, administration record

**Dispense**:
药房依据药品请求准备并交付具体数量和批次药品的事实。
_Avoid_: Medication order, Administration

**Administration**:
患者实际接受或明确未接受一次药物给药的事实。
_Avoid_: Dispense, Execution Plan

**Clinical Document Revision**:
对已签署临床文书的更正、替代或补充所形成的新业务文书。
_Avoid_: Database version, overwrite

## 费用与医保

**Charge Item**:
由诊疗、药品、耗材或服务产生的可计费活动及金额事实。
_Avoid_: Payment, Invoice line ID list

**Account**:
用于归集某个患者或就诊相关费用的上下文。
_Avoid_: Cash balance, insurance fund account

**Invoice**:
向付款方汇总应付项目和金额的账单。
_Avoid_: Payment, fiscal electronic receipt, tax invoice

**Payment Transaction**:
一次收款或外部支付尝试及其结果。
_Avoid_: Invoice, PaymentReconciliation

**Refund Transaction**:
引用原 Payment Transaction 的反向资金交易。
_Avoid_: Delete payment, invoice reversal

**Insurance Settlement**:
医保对一组申报费用作出的结算业务事实及基金分配结果。
_Avoid_: Insurance API call, person query, Payment Transaction

**Fiscal Electronic Receipt**:
财政电子票据平台开具、红冲或换开的法定票据及其号码和状态。
_Avoid_: Invoice, Payment Transaction

## 库存

**Inventory Lot**:
在特定位置、具有相同品项、生产批号和效期的一批库存。
_Avoid_: Medication, catalog item

**Inventory Reservation**:
为尚未完成的业务预留库存数量的事实。
_Avoid_: Dispense, Inventory Movement

**Inventory Movement**:
库存数量从来源到去向或因盘点损益发生的不可覆盖变化记录。
_Avoid_: Balance overwrite, stock status

**Trace Code**:
跟踪特定药品或耗材包装流转的唯一业务编码。
_Avoid_: Lot number, product code

## 互操作与审计

**FHIR Projection**:
从非 FHIR 权威事实生成、用于标准交换的只读资源表达。
_Avoid_: Second source of truth, bidirectional sync

**Provenance**:
说明某个临床或业务事实由谁、代表谁、通过什么活动产生或修订的来源记录。
_Avoid_: Access log, Audit Event

**Audit Event**:
说明谁在什么上下文中访问或操作了什么以及结果如何的安全事件。
_Avoid_: Provenance, application log
