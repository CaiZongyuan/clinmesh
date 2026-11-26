# ClinMesh 全球医疗智能体探索领域

ClinMesh 是面向全球医疗环境的医疗智能体探索平台，内置可模块化扩展的 **Mini HIS Core** 仿真临床环境，支持人类临床人员与多智能体在固定病例、可切换医院数据包与严格安全门禁下开展诊疗协作与评测。本词汇表仅定义领域语言，不记录技术实现。

## 平台与仿真环境

**Workspace**:
一组相互隔离的医疗机构运行事实、已装载的 **Hospital Data Pack** 与参与者上下文。一个 **Workspace** 可经历多次重置，但同一时刻仅有一个活动 **Epoch**。
_Avoid_: Tenant, database, session, sandbox

**Epoch**:
**Workspace** 内一次不可复用的数据世代。重置创建新 **Epoch**，旧世代的运行结果不能改写新世代。
_Avoid_: Reset version, generation number

**Virtual Time**:
仿真环境中临床事件与计费周期所依据的医院业务时间，与请求接收及安全审计使用的真实时间相分离。
_Avoid_: Server time, wall clock

**Mini HIS Core**:
面向全球医疗机构最小必要临床闭环的核心能力集合，包含患者身份、机构与角色上下文、就诊责任、通用结构化病历、多编码体系诊断、通用临床请求及完诊门禁，不内置特定国家制度或可选专科逻辑。
_Avoid_: Full HIS, China HIS, monolith core

**Clinical Module**:
按统一契约按需启用或停用的可插拔临床或扩展业务单元（如检验、药房、住院、基础账务、临床决策支持、轻量影像、病理会诊、地区支付规则、语音交互或标准互操作投影）。停用模块不破坏已有历史记录与核心主线。
_Avoid_: Microservice, arbitrary plugin, feature flag

## 数据包与病例

**Hospital Data Pack**:
描述一家医疗机构运行环境的版本化声明式数据包，涵盖机构元信息（语言、时区、币种精度、启用模块）、组织与岗位、带编码体系标识的临床目录、可选知识与规则，以及固定 **Clinical Case** 集合。切换 **Hospital Data Pack** 即可迁移到其他医院或地区，无需修改核心业务规则。
_Avoid_: Seed script, China catalog, hardcoded baseline

**Clinical Case**:
**Hospital Data Pack** 中预先编写、版本固定的合成患者场景（中文简称“病例”），包含基础资料、**Prior History**、**Patient Persona** 与预先备齐的 **Case Truth**。装载病例不产生本院就诊、医嘱或费用事实。
_Avoid_: Clinical Record, Synthea batch, fixture, live generated case

**Prior History**:
本次就诊开始前允许临床人员与 **Clinician Assistant** 查阅的既往病史、过敏史与基线临床信息。它是既有背景，不等同于本次就诊新形成的临床结论。
_Avoid_: Case Truth, Clinical Record

**Patient Persona**:
驱动 **Patient Agent** 表达的版本固定档案，包含性格、表达方式、主诉体验与自知病史。它只描述患者本人知晓的内容，不直接暴露尚未确诊的疾病名称或客观检查真值。
_Avoid_: System prompt, Case Truth, chat script

**Case Truth**:
与一个 **Clinical Case** 绑定的隐藏客观事实，包含真实病情、体征及分阶段确定性检查检验结果依据。在 **Encounter** 未完结前对临床人员与 **Clinician Assistant** 不可见，仅通过合规问诊或正式检查逐步揭示。
_Avoid_: Answer key, Clinical Record, Prior History

## 身份与智能体

**Visitor Gate**:
进入公开托管 **Workspace** 之前用于保护系统与智能体资源的轻量访问门禁。通过门禁后，参与者在 **Workspace** 内切换 **Hospital Data Pack** 定义的临床角色无需重复认证。
_Avoid_: Multi-tenant RBAC login wall, role password

**Practitioner Role**:
由当前 **Hospital Data Pack** 定义的一项医院岗位职责（如挂号、分诊、门诊医生、药师、住院医生、护士、收费或管理员）。同一参与者在探索模式下可按需切换当前行动角色，审计始终记录实际操作角色。
_Avoid_: User account, hardcoded China role

**Patient Agent**:
绑定单次 **Encounter**、严格依据 **Patient Persona** 与已告知可见事实扮演虚拟患者的持久化智能体，在文本或语音问诊中以患者视角应答，永不读取未揭示的 **Case Truth** 或 **Clinician Assistant** 推理过程。
_Avoid_: Chatbot, real patient, Patient Persona

**Clinician Assistant**:
伴随临床人员开展诊疗工作的持久化临床助手智能体，可通过受控查询与界面动作协助检索资料并起草 **Draft**，但没有正式医疗签发权。常态下与 **Patient Agent** 严格隔离，不能绕过临床人员私自多轮问诊。
_Avoid_: Autonomous prescriber, DSH bot, doctor

**Ambient Mode**:
**Clinician Assistant** 的显式可选工作模式（默认关闭）。开启后，终态医患对话或新签发报告自动触发助手在后台更新界面 **Draft**，同时保护临床人员正在编辑或已手改的内容，正式签发仍须人工确认。
_Avoid_: Background EMR extractor, silent auto-commit

**Evaluation Run**:
显式开启的自动化端到端诊疗评测运行，按固定 **Clinical Case** 与 **Epoch** 将受测医生智能体对接 **Patient Agent** 执行完整临床闭环，并产出可复现轨迹与对照结果。
_Avoid_: Normal workbench session, ad-hoc chat

## 临床主线

**Patient Identity**:
代表同一自然人的稳定院内患者身份及多签发方业务标识，不等同于某次就诊号或病案号。
_Avoid_: Visit number, encounter id

**Encounter**:
患者与医疗机构发生的一次完整门诊或住院诊疗周期，拥有明确的责任人与生命周期状态，直至满足 **Completion Gate** 后正式完结。
_Avoid_: Consultation, chat session, appointment

**Consultation**:
一次 **Encounter** 中按时间顺序保存的医患对话记录（支持文字与语音转写，区分发言人角色），保留原始沟通证据，不等同于医生签署的 **Clinical Record**。
_Avoid_: Encounter, Clinical Record, chat log

**Clinical Record**:
临床人员针对本次 **Encounter** 整理并签署的结构化病历文书（中文简称“病历”），结构模板由 **Hospital Data Pack** 定义。草稿可反复更新，签署后形成不可覆盖的版本链，更正必须追加新修订。
_Avoid_: Clinical Case, Consultation, transcript

**Diagnosis**:
负责医生针对本次 **Encounter** 正式确认的主次诊断集合（绑定明确编码体系与唯一主诊断）。重新确认形成新修订，不覆盖历史版本；未确认草稿不具正式效力。
_Avoid_: Diagnosis Draft, Case Truth, AI suggestion

**Clinical Order**:
临床人员针对检验、检查、药品、治疗或手术提出的正式单项医疗意图，与执行结果、发药事实或收费事实相分离。
_Avoid_: Draft, Report, Dispense, Charge Item

**Report**:
针对一项检查检验 **Clinical Order** 正式签发的版本化结果报告。结果更正生成新版本，旧版本的 **Report Acknowledgement** 不自动覆盖新版本。
_Avoid_: Order, raw finding, pixel archive

**Report Acknowledgement**:
负责医生明确确认已审阅某份 **Report** 指定版本的临床事实。打开或滚动查看本身不构成已阅确认。
_Avoid_: Viewed flag, read receipt

**Completion Gate**:
完结一次 **Encounter** 前由服务端实时重验的一组强制临床前提（具体清单可随 **Hospital Data Pack** 策略扩展，核心涵盖有效主诊断、必审报告已阅、明确用药或无需用药结论、已签 **Clinical Record** 及无遗留待审高风险草稿）。
_Avoid_: Frontend button disable, soft warning

## 扩展临床域

**Prescription**:
归组用于审核、调剂或外配的正式用药 **Clinical Order** 集合；若评估无需用药，须记录独立的 **No Medication** 结论而非空处方。
_Avoid_: Medication draft, empty prescription

**Dispense**:
药房依据正式 **Prescription** 准备并交付具体批次与数量药品的事实，不等同于患者实际给药（**Administration**）。
_Avoid_: Prescription, Administration

**Inpatient Admission**:
患者经登记入科占床接受连续住院照护的业务聚合，其行政在院、床位占用、医嘱执行、财务结算与病案归档维度各自独立演进。
_Avoid_: Outpatient Encounter, bed status text

**Charge Item**:
由诊疗、药品、耗材或检查活动产生的可计费事实，金额精度遵循当前 **Hospital Data Pack** 币种定义；退款或调整以关联冲正记录表达，不删除或覆写原始账项。
_Avoid_: Payment, invoice total, insurance claim

**Clinical Quality Gate**:
在关键临床写操作节点运行的确定性规则门禁，严格区分不可绕过的安全红线（如明确药物过敏冲突或严重肾功能禁忌）与允许填写受审计医学理由放行的路径偏离警示（**Clinical Override**）。
_Avoid_: Model guess, silent bypass

**FHIR Projection**:
从规范化业务权威事实按需生成的只读 FHIR R5 标准资源视图，仅用于标准互操作交换，绝不构成第二数据源或双向同步。
_Avoid_: Second source of truth, generic FHIR write

**Voice Session**:
通过语音通道开展实时转写与可打断语音播报的交互会话，在界面中严格隔离“诊室医患主麦”与“医生助手指令麦”，防止助手对话混入 **Consultation**。
_Avoid_: Audio attachment, background recording

## 执行与确认边界

**Operation Catalog**:
声明平台全部受控查询与写操作的唯一契约清单，统一定义输入输出校验、允许角色、幂等键与版本前提，供内部智能体工具、外部无头 CLI 与可选虚拟终端环境同源投影。
_Avoid_: Ad-hoc HTTP route list, raw SQL escape hatch

**Command**:
参与者表达的单一业务意图，执行受角色上下文、业务状态机、幂等键与预期版本约束，成功产生可审计事实变化。
_Avoid_: Generic CRUD, raw endpoint

**Draft**:
由人类编辑或由 **Clinician Assistant** 预填的待核对临床草稿（包括候选诊断、待开检查、待开处方与病历草稿）。**Draft** 不是正式临床事实，不触发执行、计费或完诊满足条件。
_Avoid_: Formal record, confirmed order

**Clinical Confirmation**:
临床人员对高风险正式医疗意图（确认诊断、签发检查或处方、确认报告已阅、签署病历、完结就诊、确认资金结算等）作出的显式人工放行。**Clinician Assistant** 不得绕过此边界静默提交。
_Avoid_: Auto-apply, silent commit, implicit confirmation

**Audit Event**:
记录谁在何时以何种 **Practitioner Role** 对何项临床或系统对象执行了什么 **Command** 及其结果的不可变安全留痕。
_Avoid_: Application log, chat transcript
