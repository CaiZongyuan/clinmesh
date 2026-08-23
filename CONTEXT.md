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
构建 Scenario 时使用的版本固定术语、目录和映射集合，并保留来源、地域、有效期和使用条件。它不是运行中的医院事实，也不是完整 Scenario。
_Avoid_: Seed, live catalog, Scenario

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

**Bed Occupancy**:
一个床位在一段时间内被某次住院就诊预占或实际占用的互斥事实。
_Avoid_: Encounter location, bed status text

## 临床请求与执行

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
