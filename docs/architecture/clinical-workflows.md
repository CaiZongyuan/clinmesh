# 临床业务流程

本文拥有门诊、医嘱、文书、检查、处方、收费与其他临床流程的状态、事实归属和失败边界；后续范围在相应章节明确标注。系统总入口见[系统架构](../architecture.md)，业务验证要求见[测试策略](../testing.md)。

## 8. 核心业务状态机

<a id="81-门诊闭环"></a>

### 8.1 门诊闭环

```text
管理员生成 Synthetic Case + 选定 Patient Persona
  -> 挂号员读取待挂号病例 + 选择科室/号别/地点
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

管理员生成 Synthetic Case 并选定 Patient Persona 后，挂号员从待挂号列表选择 Case 与挂号目录项，复用 `registration.synthetic-case.start` 对应的共享物化内核原子创建 Patient、Registration、Encounter、Queue Task、Consultation 与 Case materialization。成功结果是 `awaiting-triage`，同时从待挂号列表移除并进入挂号记录与分诊待处理队列；两个挂号员以不同幂等键并发提交同一 Case 时只有一个 revision 条件更新成功，失败方收到受控冲突并刷新队列。管理员仍可直接开始 ready Case。临时患者建档只创建普通 HIS Patient Identity，不推导 Synthetic Case、Case Truth 或 Patient Persona。



Consultation 是病例级领域聚合，Consultation Record 保存 append-only 对话轮次。Synthetic Case 开始时绑定 Persona Revision 并追加患者开场白；首次医生发言可以同时开始首诊并绑定负责 Practitioner Role。每个轮次保存说话方、内容类型、来源、虚拟业务时间、参与 Actor 和患者档案修订。来源预留 `asr-import` 与 `external-sync`，当前没有导入接口。旧选择题问答迁移为保留原文的只读轮次；旧版档案不能用于自由对话，三个手写 Virtual Patient 的直达接诊路由已移除。

患者模型的输入只有固定档案、最近 40 个对话轮次、可见既往史、分诊体验、正式 Specimen 的类型与采集时间和已签发报告。Case Truth 仅由档案生成器与独立泄漏出口检查读取，不进入回答模型上下文。出口检查规范化诊断术语修饰尾缀及常见数字写法，并覆盖已知的常见简称；命中本次隐藏诊断术语时重新生成一次，再命中则保存安全患者应答；既往已知诊断允许陈述。整轮共享 30 秒期限，失败时保留医生发言并允许重试，其他诊疗环节继续可用。

未回答的医生发言阻止追加下一条医生发言。检验报告 final 或更正时，系统追加引用固定 DiagnosticReport 版本的报告卡片；卡片不充当文本回答，不阻断正在生成的回答。同一医生发言的回答使用稳定追加键，并发生成只能冻结一个结果。公开 Command 回执按原 operation 和幂等键查询；已接受但尚未返回完整回答时为 `executing`，包含已保存的发言。客户端先刷新病例确认末条未回答发言，再调用显式重试；成功后相同请求返回第一次完整回执。

复诊延续同一条对话；完诊只读。Reset 重放保留病例与档案事实，重新生成的措辞可以不同。Canonical hash 的覆盖范围与限制见[确定性与故障注入](simulation.md#104-确定性与故障注入)。

DSH 模型桥接已配置时，新病例默认启用整理；历史未启用病例仍须显式补录，缺少原任务身份时通过受信激活恢复。患者回答、原生证明绑定的医生补充和固定版本已发布报告保存为统一来源，同事务创建持久任务和 outbox。病历整理覆盖主诉、现病史、既往史、家族史、过敏史、体格检查、辅助检查、评估、处置和随访十字段。体格检查与后三项医生决定仅接受明确医生来源，新家族和过敏事实分别归类；确定性校验检查完整引用与病例归属，来源语义、事实保留和关系统一归病历质控。来源及审计保存在后台，页面展示正文、变动提醒、整理控制和质控提示。详见[全病历整理规格](../spec/2026-10-14-doctor-full-document-recording.md)与[整合决策](../decisions/implemented/architecture/2026-10-15-unified-direct-document-recording.md)。

通过确定性来源校验的新增、补充、更正和矛盾直接经共享 Command 写入草稿，原子保存来源、锚点、批次关联、草稿版本和任务完成事实，不创建逐片段模型核对任务。新增追加；补充或明确更正只替换仍归 automatic 且锚点有效的片段。人工改写转为 manual，原文保留，相应患者更正另行追加；矛盾保留原陈述并追加待核实总结。写入前重新比较所有相关字段的人工上下文，变化时保留失败供显式恢复；长度超限隔离到独立候选并显示失败，不形成待应用建议。前端三方合并保护未保存输入，hasSavedDraft 保留首次草稿预填和保存后空值。页面无逐条应用、忽略、确认或撤销操作；语义疑点沿用现有质控的待核实、影响和处理建议，不自动改写正文。病历字段实际变化时累积客户端查看提醒，按方案 B 显示局部流光和“已更新”，病历标签显示“有更新”；字段进入可见区域后才计时，人工输入和同值响应不产生提示。提醒不成为核对事实，刷新建立新基线；查看时序见[病历字段规格](../spec/2026-10-14-clinical-document-fields.md)。旧 pending 标为被替代历史，受影响及后续轮次重新排队；启动经共享 Command 调度，通过当前校验后记录，迁移和 Query 不写正文。取舍见[直接记录决策](../decisions/implemented/architecture/2026-10-14-consultation-direct-recording.md)。

实时整理固定新增来源小批与快照，失败不阻塞后续来源；实时、历史补录、建议和其他业务分开限流。实时模型可独立配置，等待沿用常规模型预算；来源进度与增量同事务提交，页面通知只加速 Query 重读。问诊栏不常驻失败文字或逐来源重复错误，展开后显示尚未写入的合并说明和恢复入口；后台失败、来源与签署快照保持真实。模型预算、上下文上限、状态和性能验收由[低延迟记录规格](../spec/2026-10-15-low-latency-document-recording.md)拥有，取舍见[增量记录决策](../decisions/implemented/architecture/2026-10-15-low-latency-document-recording.md)。

新整理快照固定句子引用协议，模型只返回事实文字与句子编号，服务端恢复原始来源身份和逐字完整引文后复用既有程序校验与质控来源上下文；旧快照继续按原协议恢复，未变化事实沿用保留索引。编号映射和格式修复均计入完整输入预算，超限保留来源和失败。协议、句界、快照隔离及体积比较见[句子编号决策](../decisions/implemented/architecture/2026-10-19-recording-sentence-references.md)。

病例 Query 的 `consultationRecording` 返回持久控制版本、暂停／待补录／处理中／失败状态、已整理和剩余来源数量、来源及草稿保存事实。常规失败保留来源和失败状态，不自动重跑；只有服务关闭中断在剩余 outbox 尝试预算内恢复。`failures` 返回安全错误码、来源与重试状态，预算和恢复规则见[低延迟记录规格](../spec/2026-10-15-low-latency-document-recording.md)。任务、来源和应用状态在 SQLite 持久化，重启复用模型绑定，旧 Epoch 结果不得写入当前病例。暂停只停止整理，回答继续保存；恢复与失败重试按序补录未完成来源，既有病例首次补录须医生明确点击。兼容 verification 计数固定为零、issues 为空，不代表语义通过；旧核对任务只退役，不驱动重试。控制 Command 推进任务代次，迟到结果不得越过暂停或新代次，完成回答不重置；顺序与模型绑定见[记录恢复决策](../decisions/implemented/architecture/2026-10-08-consultation-recording-recovery.md)。

自动记录没有医生确认状态，签署不要求逐条核对或问诊遗漏勾选。预览仍固定完整正文、草稿版本、负责身份、Encounter 版本与 Consultation/来源快照；准备推进提取代次，迟到结果失效，已签文书不可变。取消恢复未完成任务并保留暂停和失败；冻结与恢复见[签署准备决策](../decisions/implemented/architecture/2026-10-10-consultation-signing-preparation.md)。正式签署与 Agent 高风险提案批准沿用原授权。

病历质控独立检查适用模板缺项、已知事实遗漏、事实不一致及 Agent 新增事实的来源，不以自动整理完成代表整份病历已核对。实时检查只使用本次问诊、医生补充、已发布报告、当前正文及当前临床摘要；自动记录的不可变批次和保存片段提供变更前后事实、关系、拒绝事实及新依据范围，纳入同一指纹、输入预算和两阶段完整覆盖，缺失、超限或检查失败明确标为不完整。取舍见[统一质控决策](../decisions/implemented/architecture/2026-10-19-recording-quality-consolidation.md)。检查不自动枚举既往病历全文或既往诊断清单。ClinMesh 通过共享 Command 与 outbox 保存检查输入和代次，DSH 提供辅助模型；结果绑定实际正文、草稿版本、合法来源和授权上下文。未保存候选带独立客户端身份与编辑版本，仅用于检查，不隐式保存病历；同一完整临床输入的已保存和候选入口共享持久规范任务，导航、记录进度及纯草稿版本变化不重复调用模型，失败只由明确重试推进代次。字段、旧处理记录和签署汇总均隐藏所有待补充问题，只显示待核实问题，不提供依据按钮或展开内容；医生直接修改正文，不提供逐条确认、核实保留或原因填写，已有处理记录仅作只读历史兼容。签署预览汇总问题与待完成、过期或失败状态，质控完成不单独使预览失效，不新增签署门禁，也不恢复自动整理的逐条核对或来源界面。详细规则与范围由[四项质控规格](../spec/2026-10-15-doctor-document-quality-control.md)拥有。

结构化 Clinical Document 草稿包含主诉、现病史、既往史、家族史、过敏史、体格检查、辅助检查、评估、处置和随访十个共享字段；草稿允许字段为空，正式签署仍校验原六项核心完整性。家族史、过敏史允许缺失或留空，表示未记录，不自动补阴性或创建 AllergyIntolerance；新签署件使用稳定章节编码并统一体格检查标题，存量缺失章节及原件保持不变，详见[病历字段决策](../decisions/implemented/architecture/2026-10-14-clinical-document-fields.md)。人工编辑先保留在当前工作台按病例隔离的工作稿中，切换病例可恢复，刷新或重建工作台不能代替保存；正文存在本地改动时在保存操作旁提示保存草稿，并隐藏先前的保存成功提示，保存成功或恢复原文后清除，后台已持久化的自动记录不单独触发该提示。草稿按病例保存在 `clinical_document_draft`，以 `expectedDraftVersion` 和 Encounter expected version 做 CAS 更新。签署预览固定 Actor context、Encounter 版本、草稿正文和草稿版本；提交重新校验这些依赖与 token 后创建不可变 FHIR R5 Composition、带稳定 identifier 且首 entry 为该 Composition 的自包含 document Bundle，以及同时引用二者的 Provenance，但不改变 Encounter 或病例状态。`signed_clinical_document` 只保存 FHIR 资源关联、签署者、时间和修订父链；每个病例只允许一个根文书，修订只接受最新 Composition 并创建线性替代版本。首期复诊 `sign-and-complete` 是兼容入口，只能用于无 Consultation 且尚无结构化签署根文书的病例；存在问诊或已有根文书时，预览和提交（包括旧 token）都返回稳定业务冲突。签署准备不依赖自动记录是否启用；关闭自动记录时的取消投影见[签署准备决策](../decisions/implemented/architecture/2026-10-10-consultation-signing-preparation.md)。

病历质控独立检查适用模板空项、已知事实遗漏、同时同语境矛盾和 Agent 片段来源。新问题包含字段、具体摘要、影响与处理建议，原文及时间按需展开；旧持久问题可读取，缺少的新说明不被伪造。模型缺项范围限于实际模板空项和附正文位置的主诉内容辅助建议，未安排的检查结果与可选病史不成为通用缺项。一般书写原则作为背景，具体模型判断标为项目辅助提示；系统不能核验来源只表明支持尚未确认。说明参与问题关联指纹，策略版本参与输入指纹，旧缓存和不同含义的旧核实保留失效。质控不写入病历，不增加签署门禁；输入归属由[质控决策](../decisions/implemented/architecture/2026-10-15-doctor-document-quality-control.md)拥有，说明取舍见[临床说明决策](../decisions/implemented/architecture/2026-10-16-clinical-explanations.md)。

诊断是病例级独立聚合。版本化 `diagnosis_catalog` 为当前 Workspace/Epoch 提供受控 ICD-10 条目；`diagnosis_state` 保存一至八条目录引用、主次角色和可选备注，草稿以 Encounter expected version 与单调 `expectedDraftVersion` 做 CAS。保存草稿不创建 Condition 或其他 FHIR 资源；已确认状态可以重新进入草稿，但不会改写既有确认。重复目录项、停用目录项、过期版本和已有首期复诊组合草稿分别返回稳定目录或业务冲突。

确认诊断要求草稿恰有一个主诊断。Command 为每条主诊断或次诊断创建关联当前 Patient 与 Encounter 的 FHIR R5 Condition，以标准 `encounter-diagnosis` category 标识本次就诊诊断，把主次角色写入 `Encounter.diagnosis.use`，并创建同时覆盖全部 Condition 与更新后 Encounter 的 Provenance。`diagnosis_confirmation.revision_number` 与 `supersedes_confirmation_id` 形成不可覆盖的线性确认历史；再次确认把上一 revision 的 Condition 标记为 `verificationStatus=entered-in-error`，Encounter 当前诊断引用只保留新 Condition。领域事实、Condition、Encounter、Provenance、草稿清除、Command receipt、审计和 Action Trace 在同一事务提交。病例详情返回最新确认和可选的新草稿，并与既往 Condition 分区；病例库筛选、处方适应规则和完诊门禁只读取最新 confirmation revision。

处方草稿是病例级 domain-native 聚合，保存一至八条受控药品、剂量、频次、疗程和数量，并以 Encounter expected version 与单调 `expectedDraftVersion` 做 CAS。保存或删除草稿不创建 MedicationRequest；正式开具时重新读取目录和已确认诊断，校验药品组合、诊断适应规则、患者过敏、剂量、频次、疗程和数量，然后在同一 Command 创建稳定处方号、Prescription、每种药一个的 active FHIR R5 MedicationRequest、Medication ChargeItem 和 Charge Record。`prescription_authorship` 通过 `workspace_actor` 与 Practitioner Role 复合外键保存负责身份，草稿正文同时清除且版本递增。收费预览只有在 Encounter 已完诊、处方仍 signed 且未撤回时可用；支付成功把病例移交药房。独立处方入口与首期复诊组合草稿互斥，已存在正式用药结论时不能继续普通编辑。

临床目录响应以 `prescriptionConclusionSupported` 显式声明当前 Epoch 是否具有独立用药结论能力。v3 药品目录同时提供疗程、数量和诊断适应规则并返回 `true`；保留的 v1/v2 目录只提供组合、剂量和频次规则并返回 `false`，其组合复诊流程保持可用，独立处方与无需用药 Command 返回稳定目录冲突，Web 不显示独立用药结论面板。

诊疗建议是绑定 Workspace、Epoch、负责医生、病例和建议类型的独立辅助结果。医生页面通过 `GET /api/his/v1/doctor/cases/:caseId/recommendations/:kind` 读取，通过同路径的 `POST actions/generate` 提交当前 Encounter 版本与资料指纹，类型为检验、放射、病理、诊断和处方。生成 Command 只更新建议状态并入持久 outbox，不创建正式临床资源。输入包括当前授权公开病例、完整问诊和病历字段、报告与可见历史、当前院内目录以及已核验的官方短条款和本地免费指南检索原文，不读取 Case Truth、私有 Persona、影像像素或 DSH Session transcript。

免费指南使用独立 SQLite，维护来源元数据、原文定位和 FTS5 trigram 索引，不改变 HIS 或 Reference 数据库迁移。显式同步校验官方 HTTPS、逐跳重定向、文件大小与 SHA-256，以 PDF.js 提取物理页或保留 WHO 官方文本层；完整原文与缓存只存本地数据目录。建议服务在授权后按当前可见病例检索中英主题和正文，最多提供 8 段、受 48 KiB 检索预算约束；段落完整保留，不用摘要替代。仅启用 active 且用途已核实并符合部署用途的全文，非商业全文默认禁用，只有显式声明适用非商业用途后启用；未核实资料保留入库状态，撤回或替代同时排除同源固定引文。全库内容与部署用途共同构成 revision 并纳入建议指纹，运行中的只读连接可见独立 writer 更新。取舍见[免费全文检索决策](../decisions/implemented/architecture/2026-10-16-free-guideline-corpus.md)，同步入口和状态查询见[部署指南](../deployment.md#免费指南全文同步)。

建议按资料、目录与证据版本的指纹去重，显式刷新创建新代次；同一任务的生成、结构化修复、自动重试与重启恢复沿用固定模型，新的代次采用当前模型选择。可采纳候选先按真实目录固定名称、编码和所选检查来源，再由独立请求核对最终条目的条款支持、病例支持、适用性与限定语，核验后不替换临床身份；合法否定结论不触发格式修复。处方进一步核对所选本院药品的实际规格与每个字段依据，无法证实的字段保持 `null`；目录默认值与允许值只用于执行映射。来源、目录、授权或代次变化会阻止旧结果生效。持久输入与草稿边界见[来源决策](../decisions/implemented/architecture/2026-10-13-doctor-guideline-recommendations.md)。

建议状态分别保存可采纳 `items`、只读 `considerations` 与分类 `notices`。没有适用指南或可执行目录时，诊断及检查仍可基于本次病例和医学知识提出待核实思路，明确理由、支持、反对及会影响具体判断的核实事项；思路必须引用本轮病例，独立复核病例事实、适用性和限定语，不包含执行身份或采纳入口。仅指南支持未通过的非处方候选，其余核验成立时降为思路；病例支持、适用性或限定语不成立则拒绝发布。只读生成协议要求显式返回思路数组、可采纳条目为空，病例引用的模型 schema 枚举限定为本轮实际来源；运行时仍核对引用归属与全局唯一身份。候选与思路合计最多 8 项，同批复核与输入预算继续有效。系统根据实际结果区分指南覆盖、院内目录、核验未通过和处理能力限制，核验说明包含相关条目、未通过环节和可用的具体原因；模型顶层的无关联缺项清单不再作为患者缺陷展示。策略版本纳入输入指纹，旧结果失效；处方不走无指南思路。取舍见[临床说明决策](../decisions/implemented/architecture/2026-10-16-clinical-explanations.md)。

历史从授权索引批量读取并无损打包，完整本次与安全资料始终保留；其余历史只在单次输入溢出时按完整记录分批读取，使用本批短句柄选择原文，再重新无损打包。同一授权、模型与来源可复用已完成筛选，输入指纹仍覆盖全部来源与完整目录。模型目录只投影临床身份、标本、组合及适用条件，核验继续读取所选真实定义。核验超限时按完整候选拆分，全部完成后才发布；必要资料仍超限或未完成读取时明确 `missing-evidence`，不截断来源。来源、目录与预算由[分批读取决策](../decisions/implemented/architecture/2026-10-15-recommendation-context-budget.md)拥有，记录句柄、审计和限流恢复由[记录级筛选决策](../decisions/implemented/bug-fix/2026-10-16-recommendation-record-selection.md)拥有。

医生接诊期间，页面级准备器在问诊、病历、报告、诊断及开具记录变化后自动核对五种建议，切换栏目不停止；连续资料更新合并，无关整理进度不触发新准备。服务端状态由 TanStack Query 保存，医生手改、取消选择、移除与暂停偏好按授权范围和病例保存。默认显示可编辑清单，来源、思路与详细状态统一收在“依据与说明”；问诊页没有待办汇总。更新或失败时保留草稿并禁用旧自动项，来源撤回明确清除旧自动结果。

医生手动添加与 Agent 项目共用同一份可编辑待办清单，每个栏目只有一个正式确认或开具入口。开具前左侧融合目录检索与字段填写、右侧展示紧凑待办；开具后左侧保留按需展开的目录及待办、正式记录列表，右侧集中展示选中记录详情。布局与两阶段归属由[开具工作区决策](../decisions/implemented/architecture/2026-10-19-clinical-order-workspace.md)拥有。纯人工提交使用当前 Encounter、草稿版本和明确选择，独立于模型任务、指南与建议读取状态；包含自动项目时另要求准备代次和完整资料指纹。原子确认 Command 事务内重新授权并复用既有正式领域校验；一批检查任一项失败整体回滚。已有草稿先完整显示，只有明确处理标志及正确版本才能替换，检查草稿删除与开具同事务执行。已确认或开具记录不自动改写，新资料时间晚于记录时仅提示医生核对，并进入既有记录处理入口；检查开具时间投影自 ServiceRequest.authoredOn，缺少可信时间的旧记录不推断先后。协议与取舍见[准备确认决策](../decisions/implemented/architecture/2026-10-18-prepared-clinical-confirmation.md)。

无需用药结论是独立的 domain-native 正式事实，记录负责 Actor、Practitioner Role 和虚拟业务时间，不用空 Prescription 或空 MedicationRequest 代替。有效处方与无需用药结论互斥；处方撤回后可确认无需用药。确认动作也清除处方草稿并递增草稿版本。

处方撤回使用不可变 `prescription_withdrawal` 事实表达，不删除或覆盖原 Prescription。只有未发生任何调剂的 signed 或 paid 处方可按 Prescription expected version 和全部 MedicationRequest expected versions 撤回；成功后各 MedicationRequest 进入 `cancelled` 并保留 FHIR history，Prescription 版本递增且读模型投影为 `withdrawn`。未收费的已撤回药品费用不再进入收费员待收费队列，已收费历史仍可查询且不会隐式退款；药房队列、审核、支付和发药入口都拒绝已撤回处方。

带 Consultation 的病例使用独立检验申请 owner。`laboratory_request_state` 保存一个病例级草稿及单调递增版本；保存和删除都以当前 Encounter 与草稿版本做 CAS，删除或开具只清空草稿而不复用旧版本。保存草稿重新读取 active、doctor-orderable Hospital Service 并冻结 service/report snapshot；开立再次校验相同 service ID 和版本，直接提交 Reference Concept ID 返回目录冲突。单一内部适应证 `clinical-evaluation` 不要求医生选择。没有病例责任人的 `awaiting-doctor` 病例必须先由接诊 Command 分配责任并推进状态，Web 才开放检验、诊断、处方和病历写入。开具时保存本院服务 coding、根 LOINC 和报告定义，创建 `ServiceRequest.status=active` 与 `Task.status=requested`，Task `focus` 指向该 ServiceRequest。服务配置保留合成价格，但该流程不创建 ChargeItem，也不推进 Encounter 或医生 Queue Task。

独立申请开具后由持久 outbox 绑定 `lis-system`，依次把领域状态和执行 Task 从 `issued/requested` 推进到 `accepted/accepted` 与 `in-progress/in-progress`。报告 consumer 对暂时失败和可恢复非法输出执行最多三次有界尝试；前两次保持申请 `in-progress`，第三次失败写入 `generation-failed`。精确真值不兼容或缺少结果底账属于确定性错误，首次即写入失败。成功后创建一个 Specimen、每个报告叶子一个 Observation、一个 DiagnosticReport 和 Provenance，并完成 ServiceRequest、执行 Task 与申请；同一 request 的重复投递返回已关联 snapshot，不重复调用模型或创建资源。

Report Acknowledgement 是按报告版本独立保存的领域事实，只能由原检查申请的开具医生对当前 `DiagnosticReport.status=final` 且申请为 `reported` 的报告创建。成功确认把申请推进到 `acknowledged` 并递增申请版本，但不更新 DiagnosticReport 或其 FHIR `meta.versionId`；确认 Command 以 `ReportAcknowledgement/<id>` effect 进入审计和 Action Trace。每个报告版本至多有一条确认事实，不同幂等键的重复确认返回第一次确认的 ID、时间和当时的申请版本。

报告更正只接受当前 `reported` 或 `acknowledged` 报告、申请 expected version、原 DiagnosticReport expected version、原因、结论，以及覆盖既有结果代码全集且不重复的数值。每次更正为 DiagnosticReport 和全部 Observation 创建新的 logical ID，旧资源和旧 Report Acknowledgement 保持可读；新的 Provenance 以 `entity.role=revision` 引用被替代报告和结果，领域修订表以 latest-only 唯一约束维持线性链。更正后申请指向新报告并回到 `reported`，当前确认投影清空，医生必须对新版本重新确认；并发更正只有一次能通过申请 CAS。FHIR R5 DiagnosticReport 没有 Composition 式 `relatesTo`，因此替代关系由标准 Provenance 与领域修订链共同表达，不添加伪标准字段。公开 HTTP adapter 只接受登录账户具有 administrator 能力的受信 session，再把调用绑定为受信 `lis-system` Command context，同时保留该 session 当前选择的 Practitioner、Practitioner Role 和 Location 供 receipt 与 Audit 关联；其他账户和请求正文不能声明或伪造该系统角色。

`issued` 或 `generation-failed` 申请可由原开具医生取消；取消把 ServiceRequest 改为 `revoked`、执行 Task 改为 `cancelled`，并递增正式申请版本。取消与受理竞争时由版本和条件更新决定唯一结果，已取消申请收到晚到受理事件时以无副作用完成。`generation-failed` 表达系统执行异常；可恢复错误的人工重试基于冻结 Laboratory Service 和报告定义开启新的三次尝试窗口，确定性错误拒绝重试。错误分类、存量恢复与多入口规则由[检验真值换算决策](../decisions/implemented/bug-fix/2026-10-16-laboratory-truth-unit-conversion.md)拥有，不按病例级生成 capability 过滤医生目录。医生病例详情读取草稿版本、可选草稿和全部正式申请；报告 DTO 从已签发的 DiagnosticReport 和 Observation 还原，不从当前目录或结果模板重建。Web 对失败申请显示对应原因、取消及符合错误分类的重试入口，对当前 `reported` 报告显示确认已阅；内部 Agent 错误文案不直接暴露给医生。

没有 Consultation 的既有挂号病例继续由 Web 使用 `issue-laboratory-order` 兼容入口和 `lab-fever-panel`，该命令绑定首诊草稿、Encounter 与医生 Queue Task，创建 ServiceRequest、ChargeItem 和待缴状态。独立草稿入口的请求 schema 不接受 `lab-fever-panel`；两条路径不共享草稿版本、正式申请领域状态或执行 Task 状态机。

带 Consultation 的病例通过 `GET /api/his/v1/encounters/{id}/completion` 读取完诊门禁。预览固定返回主诊断已确认、结构化病历已签署、必要报告已阅、用药结论已记录、无未处理草稿、处置完整和随访完整七个稳定 code，并为每项返回 `complete/incomplete`、中文状态和 `diagnosis`、`clinical-document`、`laboratory` 或 `medication-conclusion` 目标。没有未取消检查申请时“必要报告已阅”成立；存在申请时必须全部为 `acknowledged`。有效正式处方或无需用药事实满足用药结论，已撤回处方不满足。已存在签署结构化文书时保留的文书草稿不再视为未处理；诊断、检查或处方草稿仍会阻塞。

`encounter.complete` Command 在同一个 `BEGIN IMMEDIATE` 事务中重新计算门禁并校验唯一的 Encounter expected version，不能信任此前预览。任一条件缺失时返回 `ENCOUNTER_COMPLETION_BLOCKED` 并回滚；成功只把 FHIR Encounter 更新为 `status=completed` 并写入虚拟业务时间 `actualPeriod.end`，同时生成 Command receipt、FHIR AuditEvent 和 Action Trace。它不修改医生 Queue Task、`outpatient_case.status`、Registration、收费、处方、发药或 Scenario Run。医生队列按当前 Encounter JSON 状态排除已完成病例；当前诊疗中保留的已选病例详情默认关闭问诊、草稿、确认、撤回、修订和完诊控件，签署文书、报告、诊断和用药结论继续只读展示。只有从病例库详情的 capability 显式导航回当前诊疗时，页面才恢复对应 owner 的纠错控件，Command 仍重新校验责任、状态和版本。

病例主接诊责任由 `outpatient_case_responsibility` 按 Workspace、Epoch 和病例唯一保存，引用实际 Practitioner Role，并记录首次分配的虚拟业务时间。医生直接建立病例或从既有队列开始接诊时都通过同一责任分配逻辑写入；已存在同一责任时保持不变，另一医生尝试接管时返回岗位错误。旧库升级时，Virtual Patient 直达接诊病例优先从成功 Command receipt 与匹配审计记录恢复实际 Acting Practitioner Role，其他既有病例从医生 Task `owner` 回填；完成后的授权不再从可变化的 Task 状态或页面选择重建。

医生通过 `GET /api/his/v1/doctor/completed-cases` 查询当前 Practitioner Role 负责且 `Encounter.status=completed`、具有 `actualPeriod.end` 的病例。查询支持 Patient logical ID、完诊业务日期闭区间和诊断目录项筛选，按 `actualPeriod.end` 降序、病例 ID 升序稳定分页。`GET /api/his/v1/doctor/completed-cases/{caseId}` 对未完诊、未分配或属于其他医生的病例统一返回业务冲突，只读取各 owner 的正式事实：Consultation Record、不可变 Clinical Document 修订链、检查申请与报告修订及确认、诊断确认、处方或无需用药结论、Patient 和已完成 Encounter；活动草稿、编辑版本和页面状态不进入病例库合同。

病例库详情的业务时间线由服务端从各 owner 的正式事实和成功草稿删除 Action Trace 组装，按虚拟业务时间升序排列，相同时间依次按主资源引用和事件 kind 排序。活动草稿正文和编辑版本不进入病例库；只有 Effect 引用当前病例 `LaboratoryRequestDraft` 或 `PrescriptionDraft` 的成功删除 trace 进入时间线，以 ActionTrace 为主引用并关联对应 Draft。检查取消以 LaboratoryRequest 为主引用并关联 ServiceRequest 和执行 Task；处方撤回以 PrescriptionWithdrawal 为主引用并关联原 Prescription，因此原始开具与逆向事实分别形成事件。每个事件返回稳定 kind、主资源引用和关联资源引用；Web 只按响应顺序展示，不重新推断事件、当前版本或临床状态。医生工作台以“当前诊疗”和“已完诊病例”页签分隔写入与查询入口；病例库页只提供受控筛选、分页、只读事实展示和受控 owner 导航。详情为每个 Clinical Document 和检查申请返回 `correctionSupported`，为处方返回 `withdrawalSupported`，缺失字段按 `false` 处理；只有能在活动病例读模型中恢复并由现有 Command 执行的结构化病历和独立检查申请标记为可更正，只有当前 Epoch 支持独立用药结论且处方为 signed 或 paid、未发生任何调剂时才标记为可撤回，首期两字段病历与兼容检验事实继续可读但不显示更正导航。病历更正从病例库显式跳转后才显示最新版本修订表单，修订 Command 重新校验当前 Practitioner Role 是该病例的持久责任岗位；报告更正要求登录 session 具有 administrator 能力，可从当前 acting-doctor 页面使用结构化字段和提交前确认发起；处方撤回从病例库跳转到活动病例的用药结论区，复用对象预览和显式确认。三个动作都调用各自 owner 的受控 Command，成功后同时失效活动病例与病例库详情查询，使新版本和时间线从服务端正式事实重新读取；完诊成功还会失效病例库列表。任何动作都不能在病例库 DTO 上普通覆盖。

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

<a id="87-检验检查与报告修订"></a>

### 8.7 检验检查与报告修订

检验检查区分：申请、预约/执行 Task、标本采集、标本接收、结果项、报告签发、危急值通知和报告更正。ServiceRequest、Specimen、Observation 和 DiagnosticReport 分别保留自身状态；更正报告创建新的业务修订关系，不能覆盖原事实而丢失签发链。

检验、放射与病理会诊是同一个申请生命周期内核上的三种申请类型。正式申请共用一张申请表，以类型列区分 `laboratory`、`imaging` 与 `pathology`；类型列不在表上枚举取值，追加新的申请类型只新增适配器和自己的明细表，不重建申请表及其引用表。受理、执行、报告、取消、重试、已阅和修订的状态机、幂等、预期版本、审计与 Action Trace 由内核统一拥有，类型策略只提供各自的 outbox 事件、执行者和报告构造。“同一服务只能有一条进行中申请”的约束覆盖全部申请类型。已发布的检验 operation、HTTP 与 CLI 路径、返回结构和错误语义不变；一类申请的操作作用于另一类申请时返回稳定冲突。

放射申请的范围是胸片与胸部 CT 平扫：

- 放射服务是本院 Hospital Service，启用状态随服务版本保存；医生目录中的“已开展”在查询时由启用状态与对应检查的素材就绪共同计算，与具体病例无关。
- 放射草稿使用独立的病例级草稿，与检验草稿互不覆盖。开立时冻结服务定义、检查指征和负责医生；本院当前未开展的检查可以保存草稿，但开立返回目录冲突。
- 放射系统执行者经 outbox 受理、开始并报告。报告在一个短事务内发布 ImagingStudy、DiagnosticReport、Provenance 和申请完成效果；检查时间与签发时间取开单时的 Virtual Time。病例没有可用的影像结果时，申请以统一的 `generation-failed` 结束，不生成报告，医生可以重试或取消，失败信息不透露匹配原因；其他执行故障最多自动尝试三次，之后同样以 `generation-failed` 结束，申请不会停在执行中。
- 确认已阅要求影像当前可读；像素缺失或损坏时报告仍可阅读，但不开放确认。最新未取消的报告未确认时不满足完诊门禁。
- 更正由管理员发起，只能从同一素材另一份已核对发布的报告内容修订中选择，不接受自由改写，也不更换像素；原报告与原确认保留。
- 医生可以把报告摘要显式插入未签病历的“辅助检查”，摘要写明报告版本与签发时间；报告后到或更正不自动改写病历。
- 患者模型只得到“做过哪项检查、何时做的”，不含所见、印象或报告正文；放射报告不作为对话卡片注入。

不实现 PACS、DICOMweb、放射科岗位状态流、增强扫描或其他部位与模态。

病理申请的范围是乳腺切片病理会诊：患者携带既往乳腺手术的 H&E 切片来院，由本院病理科以受控系统执行者身份出具会诊报告。

- 会诊服务是本院 Hospital Service，“已开展”同样由启用状态与切片素材就绪共同计算，与具体病例无关。服务目录同时给出该病例可送检的既往手术：只取医生本已可见的来源病史中、编码与服务相容且早于本次就诊的手术，不依赖隐藏病情、匹配结论或素材占用。
- 草稿是独立的病例级草稿，包含服务、所选来源手术和会诊目的。保存和开立时都校验所选手术仍在可送检清单内；开立时把手术作为来源引用快照保存在申请明细中，来源病史不转换为本院资源。
- 病理系统执行者经 outbox 受理（收片登记）、开始（阅片中）并报告。报告在一个短事务内创建 Specimen（采集时间取所选来源手术的时间，接收时间为收片时间，记录 HE 染色；不引用本院 Procedure）、模态为 SM 的 ImagingStudy、通过 `specimen` 与 `study` 引用二者的 DiagnosticReport、Provenance 和申请完成效果；收片与签发时间取开单时的 Virtual Time。病例没有与来源事实相符的切片时，申请以 `generation-failed` 结束，不生成报告。
- 报告结构是标本信息（所选既往手术、切片数量、染色）、镜下所见、病理诊断、既有免疫组化结果和备注。确认已阅、更正、摘要插入病历和完诊门禁的规则与放射相同；更正只能选择同一切片另一份已核对发布的报告内容修订。
- 患者模型只得到“会诊已受理”，不含报告正文、镜下所见或诊断。

不实现本院活检、冰冻切片、细胞学、免疫组化或分子检测的切片、乳腺以外的器官、病理科工作台、取材制片流程和病理计费。会诊入口的取舍见 [Agent Note](../decisions/implemented/architecture/2026-10-03-breast-slide-consultation-loop.md)。

### 8.8 患者主索引与合并

MPI 合并是受控高风险 command。被合并 Patient 保留原 logical id，更新 active/link 状态；既有临床资源不批量重写 subject。读取、搜索、授权和审计定义 canonical Patient 与历史 Patient 的解析规则，并支持受控取消合并。院内患者号属于 Patient；门诊号、住院号通常属于 Encounter.identifier；病案号属于病案/照护周期聚合；医保人员编号按其真实主体建模，不能全部笼统塞入 Patient.identifier。
