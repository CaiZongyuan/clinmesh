# 临床业务流程

本文拥有门诊、医嘱、文书、检查、处方、收费与其他临床流程的状态、事实归属和失败边界；后续范围在相应章节明确标注。系统总入口见[系统架构](../architecture.md)，业务验证要求见[测试策略](../testing.md)。

## 8. 核心业务状态机

<a id="81-门诊闭环"></a>

### 8.1 门诊闭环

医生工作台页头主诉从当前病例病历工作稿投影，未保存修改立即显示并标记“未保存”；清空保持未记录，不回退分诊。刷新使用该病例已保存草稿，无医生文书时才沿用分诊初记；签署后使用最高业务修订号的不可变文书。页头不维护独立可写主诉，也不触发保存，分诊原文和生命体征保留。

主诉质控保留一份完整分诊初记，绑定持久记录身份、版本和业务时间，并标明摘要的派生关系；患者问诊、医生补充和报告保持各自原文及业务时间，实际保存时间可用时另行投影，不补造旧数据。文书版本、保存者、保存时间和候选改动字段只说明待检查文本归属，不是独立事实依据。两阶段检查均区分正常概括、同义改写、有来源补充、合理时间变化和有依据更正；同时同语境的未解释互斥仍提示具体事实。来源身份与时间参与指纹，纯文书保存元数据不破坏同文复用。取舍与验证边界见[当前主诉决策](../decisions/implemented/bug-fix/2026-10-20-current-chief-complaint.md)。

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

患者模型的输入只有固定档案、最近 40 个对话轮次、可见既往史、分诊体验、正式 Specimen 的类型与采集时间和已签发报告。Case Truth 仅由档案生成器与独立泄漏出口检查读取，不进入回答模型上下文。出口检查规范化诊断术语修饰尾缀及常见数字写法，并覆盖已知的常见简称；命中本次隐藏诊断术语时重新生成一次，再命中则保存安全患者应答；既往已知诊断允许陈述。每次回答尝试共享自开始起的 30 秒期限，失败或结果未知时保留医生发言，其他诊疗环节继续可用。

未回答的医生发言阻止追加下一条医生发言。检验报告 final 或更正时，系统追加引用固定 DiagnosticReport 版本的报告卡片；卡片不充当文本回答，不阻断正在生成的回答。回答执行按受信 Workspace/Epoch 与待回答医生轮次协调，ask、同键重发及重叠补答共同等待一次生成，各请求独立执行授权、输入冲突检查与自身回执。持久意图关联原回答尝试；相同 key 的成功回放优先返回已保存回答，失败或未知回放原终态，不重新推理。档案绑定缺失的 `CONSULTATION_CASE_NOT_FOUND`（404）与旧版档案的 `CONSULTATION_PERSONA_OUTDATED`（409）同样保存并保留原分类重放；恢复有效档案绑定后，仍须明确使用新补答意图。公开 Command 回执仍按原 operation 和幂等键查询；已接受而尚未完成的回执为 `executing`，包含已保存发言。

病例 `consultation.replyAttempt` 返回医生轮次、开始与截止时间、`executing`、`blocked`、`succeeded`、`failed` 或 `unknown` 及安全错误码。控制或账本阻塞返回 `MODEL_CONTROL_BLOCKED`（409）并保留已保存问题；恢复后仅在原期限内、授权和病例仍有效时接续。客户端刷新病例和原回执后，在原尝试仍执行或等待控制时继续等待；新 retry key 也加入原尝试，不切模型或延长期限。原尝试终止且问题仍待答时，只有医生明确的新补答意图与新 key 才开始采用当前模型的新尝试，不重新提交医生问题。页面或 HTTP 断开不取消已接受的回答；runtime 关闭主动取消并等待执行收束，重启把已派发而结果不明的遗留执行标为未知且不自动补答，明确未派发的有效待办保留原期限恢复。`AI_TIMEOUT` 和 `CONSULTATION_REPLY_UNKNOWN` 表示无法确认完整结果；原成功回答及回执继续可重放。持久归属见[模型执行恢复](storage.md#模型执行恢复)，理由见[请求复用与持久恢复决策](../decisions/implemented/architecture/2026-10-19-model-request-reuse-recovery.md)。

复诊延续同一条对话；完诊只读。Reset 重放保留病例与档案事实，重新生成的措辞可以不同。Canonical hash 的覆盖范围与限制见[确定性与故障注入](simulation.md#104-确定性与故障注入)。

DSH 模型桥接已配置时，新病例默认启用整理；历史未启用病例仍须显式补录，缺少原任务身份时通过受信激活恢复。患者回答、原生证明绑定的医生补充和固定版本已发布报告保存为统一来源，同事务创建持久任务和 outbox。病历整理覆盖主诉、现病史、既往史、家族史、过敏史、体格检查、辅助检查、评估、处置和随访十字段。体格检查与后三项医生决定仅接受明确医生来源，新家族和过敏事实分别归类；确定性校验检查完整引用与病例归属，来源语义、事实保留和关系统一归病历质控。来源及审计保存在后台，页面展示正文、变动提醒、整理控制和质控提示。详见[全病历整理规格](../spec/2026-10-14-doctor-full-document-recording.md)与[整合决策](../decisions/implemented/architecture/2026-10-15-unified-direct-document-recording.md)。

通过确定性来源校验的新增、补充、更正和矛盾直接经共享 Command 写入草稿，原子保存来源、锚点、批次关联、草稿版本和任务完成事实，不创建逐片段模型核对任务。新增追加；补充或明确更正只替换仍归 automatic 且锚点有效的片段。人工改写转为 manual，原文保留，相应患者更正另行追加；矛盾保留原陈述并追加待核实总结。写入前重新比较所有相关字段的人工上下文，变化时保留失败供显式恢复；长度超限隔离到独立候选并显示失败，不形成待应用建议。前端三方合并保护未保存输入，hasSavedDraft 保留首次草稿预填和保存后空值。页面无逐条应用、忽略、确认或撤销操作；语义疑点沿用现有质控的待核实、影响和处理建议，不自动改写正文。病历字段实际变化时累积客户端查看提醒，按方案 B 显示局部流光和“已更新”，病历标签显示“有更新”；字段进入可见区域后才计时，人工输入和同值响应不产生提示。提醒不成为核对事实，刷新建立新基线；查看时序见[病历字段规格](../spec/2026-10-14-clinical-document-fields.md)。旧 pending 标为被替代历史，受影响及后续轮次重新排队；启动经共享 Command 调度，通过当前校验后记录，迁移和 Query 不写正文。取舍见[直接记录决策](../decisions/implemented/architecture/2026-10-14-consultation-direct-recording.md)。

实时整理固定新增来源小批与快照，失败不阻塞后续来源；实时、历史补录、建议和其他业务分开限流。实时模型可独立配置，等待沿用常规模型预算；来源进度与增量同事务提交，页面通知只加速 Query 重读。问诊栏不常驻失败文字或逐来源重复错误，展开后显示尚未写入的合并说明和恢复入口；后台失败、来源与签署快照保持真实。模型预算、上下文上限、状态和性能验收由[低延迟记录规格](../spec/2026-10-15-low-latency-document-recording.md)拥有，取舍见[增量记录决策](../decisions/implemented/architecture/2026-10-15-low-latency-document-recording.md)。

新整理快照固定句子引用协议，模型只返回事实文字与句子编号，服务端恢复原始来源身份和逐字完整引文后复用既有程序校验与质控来源上下文；旧快照继续按原协议恢复，未变化事实沿用保留索引。编号映射和格式修复均计入完整输入预算，超限保留来源和失败。协议、句界、快照隔离及体积比较见[句子编号决策](../decisions/implemented/architecture/2026-10-19-recording-sentence-references.md)。

病例 Query 的 `consultationRecording` 返回持久控制版本、暂停／待补录／处理中／失败状态、已整理和剩余来源数量、来源及草稿保存事实。常规失败保留来源和失败状态，不自动重跑；服务关闭后仅安全接续可确认没有未决派发的任务或复用已持久成功步骤，在途结果未知须由医生明确重试。`failures` 返回安全错误码、来源与重试状态，预算和恢复规则见[低延迟记录规格](../spec/2026-10-15-low-latency-document-recording.md)。任务、来源和应用状态在 SQLite 持久化，重启复用模型绑定，旧 Epoch 结果不得写入当前病例。暂停只停止整理，回答继续保存；恢复与失败重试按序补录未完成来源，既有病例首次补录须医生明确点击。兼容 verification 计数固定为零、issues 为空，不代表语义通过；旧核对任务只退役，不驱动重试。控制 Command 推进任务代次，迟到结果不得越过暂停或新代次，完成回答不重置；顺序与模型绑定见[记录恢复决策](../decisions/implemented/architecture/2026-10-08-consultation-recording-recovery.md)。

自动记录没有医生确认状态，签署不要求逐条核对或问诊遗漏勾选。预览仍固定完整正文、草稿版本、负责身份、Encounter 版本与 Consultation/来源快照；准备推进提取代次，迟到结果失效，已签文书不可变。取消恢复未完成任务并保留暂停和失败；冻结与恢复见[签署准备决策](../decisions/implemented/architecture/2026-10-10-consultation-signing-preparation.md)。正式签署与 Agent 高风险提案批准沿用原授权。

病历质控独立检查适用模板缺项、已知事实遗漏、事实不一致及 Agent 新增事实的来源，不以自动整理完成代表整份病历已核对。实时检查只使用本次问诊、医生补充、已发布报告、当前正文及当前临床摘要；自动记录的不可变批次和保存片段提供变更前后事实、关系、拒绝事实及新依据范围，沿连续替换链纳入同一指纹、输入预算和两阶段完整覆盖，缺失、超限或检查失败明确标为不完整。保存或候选中的正常人工改写退出自动片段归属检查，整份正文及其他自动片段继续质控。取舍见[统一质控决策](../decisions/implemented/architecture/2026-10-19-recording-quality-consolidation.md)。检查不自动枚举既往病历全文或既往诊断清单。ClinMesh 通过共享 Command 与 outbox 保存检查输入和代次，DSH 提供辅助模型；结果绑定实际正文、草稿版本、合法来源和授权上下文。未保存候选带独立客户端身份与编辑版本，仅用于检查，不隐式保存病历；同一完整临床输入的已保存和候选入口共享持久规范任务，导航、记录进度及纯草稿版本变化不重复调用模型，失败只由明确重试推进代次。“依据与说明”的病历质控及签署汇总详情按字段展示待补充、待核实问题和只读历史记录；页面顶部的紧凑提示仅展示待核实问题，不提供逐条依据按钮或来源展开；医生直接修改正文，不提供逐条确认、核实保留或原因填写，已有处理记录仅作只读历史兼容。签署预览汇总问题与待完成、过期或失败状态，质控完成不单独使预览失效，不新增签署门禁，也不恢复自动整理的逐条核对或来源界面。详细规则与范围由[四项质控规格](../spec/2026-10-15-doctor-document-quality-control.md)拥有。

结构化 Clinical Document 草稿包含主诉、现病史、既往史、家族史、过敏史、体格检查、辅助检查、评估、处置和随访十个共享字段；草稿允许字段为空，正式签署仍校验原六项核心完整性。家族史、过敏史允许缺失或留空，表示未记录，不自动补阴性或创建 AllergyIntolerance；新签署件使用稳定章节编码并统一体格检查标题，存量缺失章节及原件保持不变，详见[病历字段决策](../decisions/implemented/architecture/2026-10-14-clinical-document-fields.md)。人工编辑先保留在当前工作台按病例隔离的工作稿中，切换病例可恢复，刷新或重建工作台不能代替保存；正文存在本地改动时在保存操作旁提示保存草稿，并隐藏先前的保存成功提示，保存成功或恢复原文后清除，后台已持久化的自动记录不单独触发该提示。草稿按病例保存在 `clinical_document_draft`，以 `expectedDraftVersion` 和 Encounter expected version 做 CAS 更新。签署预览固定 Actor context、Encounter 版本、草稿正文和草稿版本；提交重新校验这些依赖与 token 后创建不可变 FHIR R5 Composition、带稳定 identifier 且首 entry 为该 Composition 的自包含 document Bundle，以及同时引用二者的 Provenance，但不改变 Encounter 或病例状态。`signed_clinical_document` 只保存 FHIR 资源关联、签署者、时间和修订父链；每个病例只允许一个根文书，修订只接受最新 Composition 并创建线性替代版本。首期复诊 `sign-and-complete` 是兼容入口，只能用于无 Consultation 且尚无结构化签署根文书的病例；存在问诊或已有根文书时，预览和提交（包括旧 token）都返回稳定业务冲突。签署准备不依赖自动记录是否启用；关闭自动记录时的取消投影见[签署准备决策](../decisions/implemented/architecture/2026-10-10-consultation-signing-preparation.md)。

病历质控独立检查适用模板空项、已知事实遗漏、同时同语境矛盾和 Agent 片段来源。新问题包含字段、具体摘要、影响与处理建议，原文及时间按需展开；旧持久问题可读取，缺少的新说明不被伪造。模型缺项范围限于实际模板空项和附正文位置的主诉内容辅助建议，未安排的检查结果与可选病史不成为通用缺项。一般书写原则作为背景，具体模型判断标为项目辅助提示；系统不能核验来源只表明支持尚未确认。说明参与问题关联指纹，策略版本参与输入指纹，旧缓存和不同含义的旧核实保留失效。质控不写入病历，不增加签署门禁；输入归属由[质控决策](../decisions/implemented/architecture/2026-10-15-doctor-document-quality-control.md)拥有，说明取舍见[临床说明决策](../decisions/implemented/architecture/2026-10-16-clinical-explanations.md)。

诊断是病例级独立聚合。版本化 `diagnosis_catalog` 为当前 Workspace/Epoch 提供受控 ICD-10 条目；`diagnosis_state` 保存一至八条目录引用、主次角色和可选备注，草稿以 Encounter expected version 与单调 `expectedDraftVersion` 做 CAS。保存草稿不创建 Condition 或其他 FHIR 资源；已确认状态可以重新进入草稿，但不会改写既有确认。重复目录项、停用目录项、过期版本和已有首期复诊组合草稿分别返回稳定目录或业务冲突。

确认诊断要求草稿恰有一个主诊断。Command 为每条主诊断或次诊断创建关联当前 Patient 与 Encounter 的 FHIR R5 Condition，以标准 `encounter-diagnosis` category 标识本次就诊诊断，把主次角色写入 `Encounter.diagnosis.use`，并创建同时覆盖全部 Condition 与更新后 Encounter 的 Provenance。`diagnosis_confirmation.revision_number` 与 `supersedes_confirmation_id` 形成不可覆盖的线性确认历史；再次确认把上一 revision 的 Condition 标记为 `verificationStatus=entered-in-error`，Encounter 当前诊断引用只保留新 Condition。领域事实、Condition、Encounter、Provenance、草稿清除、Command receipt、审计和 Action Trace 在同一事务提交。病例详情返回最新确认和可选的新草稿，并与既往 Condition 分区；病例库筛选、处方适应规则和完诊门禁只读取最新 confirmation revision。

处方草稿是病例级 domain-native 聚合，保存一至八条受控药品、剂量、频次、疗程和数量，并以 Encounter expected version 与单调 `expectedDraftVersion` 做 CAS。保存或删除草稿不创建 MedicationRequest；正式开具时重新读取目录和已确认诊断，校验药品组合、诊断适应规则、患者过敏、剂量、频次、疗程和数量，然后在同一 Command 创建稳定处方号、Prescription、每种药一个的 active FHIR R5 MedicationRequest、Medication ChargeItem 和 Charge Record。`prescription_authorship` 通过 `workspace_actor` 与 Practitioner Role 复合外键保存负责身份，草稿正文同时清除且版本递增。收费预览只有在 Encounter 已完诊、处方仍 signed 且未撤回时可用；支付成功把病例移交药房。独立处方入口与首期复诊组合草稿互斥，已存在正式用药结论时不能继续普通编辑。

临床目录响应以 `prescriptionConclusionSupported` 显式声明当前 Epoch 是否具有独立用药结论能力。v3 药品目录同时提供疗程、数量和诊断适应规则并返回 `true`；保留的 v1/v2 目录只提供组合、剂量和频次规则并返回 `false`，其组合复诊流程保持可用，独立处方与无需用药 Command 返回稳定目录冲突，Web 不显示独立用药结论面板。

诊疗建议是绑定 Workspace、Epoch、负责医生、病例和建议类型的独立辅助结果。医生页面通过 `GET /api/his/v1/doctor/cases/:caseId/recommendations/:kind` 读取，通过同路径的 `POST actions/generate` 提交当前 Encounter 版本与资料指纹，类型为检验、放射、病理、诊断和处方。生成 Command 只更新建议状态并入持久 outbox，不创建正式临床资源。输入包括当前授权公开病例、完整问诊和病历字段、报告与可见历史、当前院内目录以及已核验的官方短条款和本地免费指南检索原文，不读取 Case Truth、私有 Persona、影像像素或 DSH Session transcript。

免费指南使用独立 SQLite，维护来源元数据、原文定位和 FTS5 trigram 索引，不改变 HIS 或 Reference 数据库迁移。显式同步校验官方 HTTPS、逐跳重定向、文件大小与 SHA-256，以 PDF.js 提取物理页或保留 WHO 官方文本层；完整原文与缓存只存本地数据目录。建议服务在授权后按当前可见病例检索中英主题和正文，最多提供 8 段、受 48 KiB 检索预算约束；段落完整保留，不用摘要替代。仅启用 active 且用途已核实并符合部署用途的全文，非商业全文默认禁用，只有显式声明适用非商业用途后启用；未核实资料保留入库状态，撤回或替代同时排除同源固定引文。全库内容与部署用途共同构成 revision 并纳入建议指纹，运行中的只读连接可见独立 writer 更新。取舍见[免费全文检索决策](../decisions/implemented/architecture/2026-10-16-free-guideline-corpus.md)，同步入口和状态查询见[部署指南](../deployment.md#免费指南全文同步)。

建议按完整临床内容、来源、目录与证据版本的指纹去重。结构化正文逐字段精确比较，草稿保存版本和保存时间不参与临床输入；同文保存仍推进真实草稿版本和审计，不取消在途任务或重开建议。保存、签署和采纳的预期版本检查继续生效。来源、临床内容、目录、授权或代次有效变化时尽力取消旧执行，并在每次派发和结果提交重新检查；设置切换不自动刷新成功结果。可验证的旧成功快照只有与当前输入分别规范化后确实相同才复用。持久输入与草稿边界见[来源决策](../decisions/implemented/architecture/2026-10-13-doctor-guideline-recommendations.md)。

建议按资料筛选、目录筛选、生成和核验的稳定计划保存私有成功步骤；后段技术失败或重启恢复只处理未完成单元。同一阶段批次含首次最多三次真实模型请求，同一 generation 的所有批次合计最多四次额外请求；限流重发、格式修复、自动恢复和人工继续共享派发前原子预占的持久计数。任一上限耗尽即停止所有新派发，outbox 重新领取不增加额度。明确可恢复技术失败在剩余额度内恢复；已发出但未获得完整结果的超时、断流、关停及无法证明未派发的崩溃窗口为未知，保留次数且不自动重发。

普通 `refresh:false` 请求遇到同输入失败、未知或耗尽时返回原任务；`continueGeneration` 与 `refresh:false` 表示医生明确继续原任务，保留原模型、generation、成功步骤与剩余额度，同一继续意图重放不再次授权。关闭自动重试后，医生仍可明确继续一个未完成步骤；待办因禁止重试而暂停时也可提供继续入口，停用、额度、权限和原次数上限继续生效。`refresh:true` 是人工重新生成，采用当前资料、当前模型和新 generation 额度，与继续互斥。公开 `recovery` 返回阶段状态、累计次数、上限与 `canContinue`，未知和耗尽分别以 `MODEL_OUTCOME_UNKNOWN`、`MODEL_REQUEST_LIMIT` 说明。次数仅限制 ClinMesh 可观察请求，不是 Token、金额或供应商费用账本；DSH 原生会话和宿主内部不可见重试不在此范围。持久化见[模型执行恢复](storage.md#模型执行恢复)，取舍见[请求复用与持久恢复决策](../decisions/implemented/architecture/2026-10-19-model-request-reuse-recovery.md)。

可采纳候选先按真实目录固定名称、编码和所选检查来源，再由独立请求核对最终条目的条款支持、病例支持、适用性与限定语，核验后不替换临床身份；全部必要核验完成前候选只保存在私有步骤，合法否定结论正常结束，不触发格式修复或重做候选直至通过。处方进一步核对所选本院药品的实际规格与每个字段依据，无法证实的字段保持 `null`；目录默认值与允许值只用于执行映射。

建议状态分别保存可采纳 `items`、只读 `considerations` 与分类 `notices`。没有适用指南或可执行目录时，诊断及检查仍可基于本次病例和医学知识提出待核实思路，明确理由、支持、反对及会影响具体判断的核实事项；思路必须引用本轮病例，独立复核病例事实、适用性和限定语，不包含执行身份或采纳入口。仅指南支持未通过的非处方候选，其余核验成立时降为思路；病例支持、适用性或限定语不成立则拒绝发布。只读生成协议要求显式返回思路数组、可采纳条目为空，病例引用的模型 schema 枚举限定为本轮实际来源；运行时仍核对引用归属与全局唯一身份。候选与思路合计最多 8 项，同批复核与输入预算继续有效。系统根据实际结果区分指南覆盖、院内目录、核验未通过和处理能力限制，核验说明包含相关条目、未通过环节和可用的具体原因；模型顶层的无关联缺项清单不再作为患者缺陷展示。策略版本纳入输入指纹，旧结果失效；处方不走无指南思路。取舍见[临床说明决策](../decisions/implemented/architecture/2026-10-16-clinical-explanations.md)。

历史从授权索引批量读取并无损打包，完整本次与安全资料始终保留；其余历史只在单次输入溢出时按完整记录分批读取，使用本批短句柄选择原文，再重新无损打包。完整筛选请求哈希、Workspace/Epoch、Actor/context、病例、模型与策略均相同时，已成功筛选可跨建议类型和人工新 generation 持久复用；生成及核验不跨任务共享，输入指纹仍覆盖全部来源与完整目录。模型目录只投影临床身份、标本、组合及适用条件，核验继续读取所选真实定义。核验超限时按完整候选拆分，全部完成后才发布；必要资料仍超限或未完成读取时明确 `missing-evidence`，不截断来源。来源、目录与输入预算由[分批读取决策](../decisions/implemented/architecture/2026-10-15-recommendation-context-budget.md)拥有，记录句柄、审计和限流协议由[记录级筛选决策](../decisions/implemented/bug-fix/2026-10-16-recommendation-record-selection.md)拥有。

医生接诊期间，页面级准备器在问诊、病历、报告、诊断及开具记录变化后自动核对五种建议，切换栏目不停止；连续资料更新合并，无关整理进度不触发新准备。服务端状态由 TanStack Query 保存，医生手改、取消选择、移除与暂停偏好按授权范围和病例保存。默认显示可编辑清单，来源、思路与详细状态统一收在“依据与说明”；问诊页没有待办汇总。更新或失败时保留草稿并禁用旧自动项，来源撤回明确清除旧自动结果。

继续原任务保留 generation，因此页面读取到同代任务从失败恢复为 `pending` 时接受该状态并继续轮询，包括继续回执丢失或由另一入口继续的情况。读取确认同代、同输入任务已恢复或完成后，原继续请求的传输错误不再阻止使用结果；仍失败或读取失败时保留错误。迟到的 Command `pending` 回执不能覆盖已经观察到的终态，较旧 generation 与明确来源撤回仍按各自保护规则处理。

医生手动添加与 Agent 项目共用同一份可编辑待办清单，每个栏目只有一个正式确认或开具入口。开具前左侧融合目录检索与字段填写、右侧展示紧凑待办；开具后左侧保留按需展开的目录及待办、正式记录列表，右侧集中展示选中记录详情。布局与两阶段归属由[开具工作区决策](../decisions/implemented/architecture/2026-10-19-clinical-order-workspace.md)拥有。纯人工提交使用当前 Encounter、草稿版本和明确选择，独立于模型任务、指南与建议读取状态；包含自动项目时另要求准备代次和完整资料指纹。原子确认 Command 事务内重新授权并复用既有正式领域校验；一批检查任一项失败整体回滚。已有草稿先完整显示，只有明确处理标志及正确版本才能替换，检查草稿删除与开具同事务执行。已确认或开具记录不自动改写，新资料时间晚于记录时仅提示医生核对，并进入既有记录处理入口；检查开具时间投影自 ServiceRequest.authoredOn，缺少可信时间的旧记录不推断先后。协议与取舍见[准备确认决策](../decisions/implemented/architecture/2026-10-18-prepared-clinical-confirmation.md)。

无需用药结论是独立的 domain-native 正式事实，记录负责 Actor、Practitioner Role 和虚拟业务时间，不用空 Prescription 或空 MedicationRequest 代替。有效处方与无需用药结论互斥；处方撤回后可确认无需用药。确认动作也清除处方草稿并递增草稿版本。

处方撤回使用不可变 `prescription_withdrawal` 事实表达，不删除或覆盖原 Prescription。只有未发生任何调剂、无未知或部分收款且无有效医保分配的 signed 或 paid 处方可按 Prescription expected version 和全部 MedicationRequest expected versions 撤回；基金和个人账户支付为零的医保分配也可能累计年度起付金额，须先由收费员撤销原医保待遇并追加补偿。成功后各 MedicationRequest 进入 `cancelled` 并保留 FHIR history，Prescription 版本递增且读模型投影为 `withdrawn`。未收费的已撤回药品费用不再进入收费员待收费队列，已全额收费历史仍可查询且不会隐式退款；药房队列、审核、支付和发药入口都拒绝已撤回处方。

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

<a id="82-住院闭环后续"></a>
<a id="82-住院闭环"></a>

### 8.2 住院闭环

当前已实现建档与入科：负责门诊医生开住院证，登记员通过直接入院、门诊转收或转院途径办理登记并收取预交金，病区护士接诊分床、同病区转床和互换床位。诊断确认、长期和临时医嘱、校对、实际发药与给药、健康教育执行和逐项费用及关联冲正已实现；检查检验送检、报告、三方转科、手术最小闭环和出院、结算、清床、召回已实现；主管医生提交病案首页核心字段、病案人员编码审核与归档已实现，范围见[住院规格](../spec/2026-10-20-inpatient-closed-loop.md)。

住院由独立 `InpatientService` 通过共享 CommandExecutor 执行，不借用 `outpatient_case`、门诊 Registration 或门诊支付外键。登记输入固定当次受信 context 的 `expectedEpoch`，仅作为事务前置断言，不能选择活动 Epoch。每次登记创建独立住院号、`Encounter.class=IMP` 和 Account；`registered` 对应标准 `planned`，接诊后为 `admitted` / `in-progress`。行政、财务及病案状态分别保存，不把它们合并为 Encounter.status。住院证以 ServiceRequest 记录，转收后完成，不能重复使用；零预交金不创建资金交易，正数以安全整数分形成独立交易。重试由 Command receipt 去重。

Scenario 默认提供一个“住院科”、一个“住院病区”、一间病房与三张床位，沿用 `organization-inpatient-medicine`、`ward-general` 等稳定标识；住院医生与病区护士各有一个默认 Practitioner Role。目录以 `acceptingAdmissions` 区分新入院目标，新的直接入院、转院登记及新签发住院证仅接受默认病区，其他病区返回 `INPATIENT_WARD_UNAVAILABLE`；已签发住院证继续按原患者及目标病区转收，原幂等键优先重放，不重复收费。服务端仍按受信 Organization 和病区 Location 限定读写，管理员岗位只控制场景。

旧库的资源、岗位、患者归属、床位占用、费用、审核归档及原回执完整保留；启动不合并历史病区、不自动转科或停嘱。已识别的原默认住院科、病区、病房和床位显示名在原稳定 ID 上升级为中性名称，FHIR 旧名称仍可从历史版本读取，病区目录名称同步更新；自定义名称及其他旧病区名称保持原样，不改变临床版本、首页来源指纹或原回执。目录保留旧病区并标记其不接收新登记，原岗位仍负责既有住院与转科任务。身份响应的可选 `locationName` 取自当前 Workspace/Epoch 的权威 FHIR Location，位置缺失不移除原岗位或改变 Actor Context。收敛默认配置的取舍见[单住院科与旧上下文保留](../decisions/implemented/simplification/2026-10-21-single-inpatient-default.md)。

床位占用保存起止时间，活动床位与活动住院各有唯一约束。接诊、转床与互换床位同时更新占用事实及 Encounter.location 历史；任一侧版本、投影或审计失败则整体回滚。跨科转移属于独立转科流程；多病区责任边界通过显式双病区测试环境验证。

登记时仅在能确定唯一合成病例来源时固定内部 `source_case_id`，它引用同 Workspace/Epoch 的 synthetic_case_materialization。门诊转收必须与住院证的患者及来源 Encounter 一致；直接登记遇到多个来源时要求显式指定来源 Encounter，手工建档且无来源时保持空值。该私有关联不进入临床 DTO；后续检查不能从无来源患者制造合成事实。

Web 登记工作台提供住院登记页签，住院医生、病区护士和病案人员进入住院工作台；门诊病例页提供住院证入口。CLI 的 `inpatient` 命令和 [clinmesh-inpatient](../../skills/clinmesh-inpatient/SKILL.md)复用相同岗位、schema、预期版本与幂等合同。

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

住院检查检验由 InpatientInvestigations 适配原 ClinicalRequestKernel、Workflow 检验和 ImagingRequestService，不建立第二套报告状态机。开立以本次 admission 固定的 source_case_id 定位同 Epoch 的真实 Synthetic Case；结果解析读取其 Case Truth，正式 ServiceRequest、Specimen、Observation、ImagingStudy 和 DiagnosticReport 归当前 IMP Encounter。无来源患者明确不支持，不使用 Scenario 正常结果兜底。旧门诊检验与影像的公开草稿、开立 Command 仅允许 outpatient-doctor；住院专用 Command 在同一事务组合共享 apply、冻结价目和送检关联，不能从旧公开入口绕过这些住院事实。医生开立仅产生待送检申请，护士校对送检后才排入原 accept outbox；晚到受理重验取消状态，并按真实 clinical_request_context 要求存在同一住院的已送检关联，缺失关联也拒绝。旧已完成回执仍先无写重放。读、取消、重试、已阅和阅片元数据均校当前科室与病区，转科后新科接管报告；住院报告发布不触发门诊对话、自动记录或完诊。

住院检查目录区分可开展、尚未开展和未计价。正数且已声明住院适用范围的医院价沿用原定义；基础 WBC（WS/T 886-2026 `0100101A`）、HGB（`0100501A`）与院内 CBC（`CN-LAB-CBC`）另声明800、800、2500分的合成本院住院价，匹配完整编码身份，不为其他单项或组合推测价格。胸片和胸部 CT 平扫分别声明8000与30000分的合成本院价。申请冻结定义、目录版本、价格和 `execution-completed` 触发；首次执行完成及报告发布在同一事务只计一次费，报告修订不重收。未计价不等于免费，未声明价格的项目不可开立。报告收费事务重读当前科室、住院及财务状态，已出区或结算后拒绝追加；出院门禁复用在途申请检查。

转科以独立 Task 保存 requested、handed-over、completed、cancelled，依次由当前医生申请、原护士交接、目标护士接收；目标 incoming 清单仅授权目标病区并提供接收必要字段，普通详情仍由当前责任科室拥有。原科医嘱须停嘱并核停，未执行计划须明确取消，未送检申请须送检或取消，未实施手术须完成或取消；已送检的在途检查继续完成，由新科接管。接收在同一 Command 事务再次核验 Task 与 Encounter 版本、全部阻塞和目标空床，结束原占用、创建新占用并切换 Admission 与 FHIR 科室/位置历史。既往发药、库存与费用保留，新执行及床日费使用当前科室。设计取舍见[Agent Note](../decisions/implemented/architecture/2026-10-21-inpatient-investigations-and-transfer.md)。

#### 住院手术最小闭环

InpatientService.surgery 拥有申请、准备、取消及实际实施事实。申请生成 ServiceRequest，保存计划术式及虚拟时间；requested/ready 可以取消，completed 保留实际事实，不以计划到时自动执行。护士记录术前检查核对，医生确认知情同意书已签署，两项分别保存责任人、时间、说明与审计；均完成后为 ready，执行前在同一 Command 事务重新检查岗位、当前住院责任、在院状态与申请版本。这是对已签署同意的确认，不是电子签名系统。

Scenario 拥有固定八条临床分类摘录和合成本院手术、耗材价目，启动只补缺失项。临床编码保留完整代码、类别、3.0来源版本、项目摘录Release、来源URL/哈希/单元格；来源与限制见[编码依据](../research/2026-10-20-inpatient-record-coding-and-recall.md#手术操作固定子集的来源)。分类编码、院内手术ID与ChargeDefinition分开，价格标为合成演示价；耗材只记录实际使用与收费，不包含库存、采购或批号供应链。

耗材目录包含原两项合成材料与固定心血管参考表的231条记录。归一化来源快照保留原字段、企业、原编码/注册证、规格及单位缺项、价格类型、地区、起止日、适用性和7组附件来源及哈希；原工作簿不进入仓库。中选价按元规范为整数分，独立的基准品拟供应价不覆盖中选价。52条明确单位的记录按中选价作为合成本院演示收费，另179条保存 `reference.unit=null`、`unavailableReason=unit-unconfirmed`，保留参考价但没有收费定义，实际实施拒绝选择；规格不推测。来源含历史采购价及地区限制，不代表真实医院现行价格，也不自动扩展起搏术式。目录 query operation v2 返回完整来源，Web只为选中的可收费耗材展开用量；每次最多20类。当前及新Epoch沿用幂等补缺安装，既有项和实施、receipt不被覆盖，取舍见[Agent Note](../decisions/implemented/architecture/2026-10-22-cardiovascular-material-catalog.md)。

实际实施可选择与计划不同的术式，server 按实际目录及版本冻结术式、实施岗位、虚拟时间、说明、耗材数量和安全整数分价格。同一事务保存唯一 Procedure、耗材、手术与耗材逐项费用、申请完成和审计；投影或费用失败则全部回滚。账目归属实施时当前科室，申请原作者保留。首页只从 executedForAdmission 读取实际事实；出院与转科 Command 在自身事务调用 assertNoPending，未实施且未取消申请阻断出院、交接及接收。该内部门禁由调用方先校验当前业务权限；目标病区接收前尚未拥有原科普通详情权限。

术后医嘱沿普通签发流程附本次 surgeryExecutionId，在原医嘱 Command 内验证它属于当前 Workspace/Epoch/Admission 且已完成；保存引用并分别投影 MedicationRequest.supportingInformation 或 ServiceRequest.supportingInfo。申请、已取消计划、其他住院和既往来源 Procedure 均不能代替本次实施。关联后仍需护士校对，药品仍需实际发药后才能给药。Web 与 CLI 共用原预期版本、完整输入、幂等键及 receipt 恢复合同。

#### 住院出院与结算

InpatientDischarge在共享Command事务中执行五个分立动作：医生issue进入discharge-pending，护士depart记录实际出区及明确离院方式，收费员settle结清，护士clear释放床位，符合窗口时医生recall召回。离院方式是本院仿真枚举home/transfer/against-advice/death/other，不宣称国家上报代码；病案读取原出区事件，不重新填报覆盖。医生和护士均按当前科室、病区授权，administrator不办理业务。

出院申请、出区及结算在各自事务重验在途手术、检查检验及转科门禁。检查的issued/accepted/in-progress/generation-failed须完成或取消，reported/acknowledged/cancelled可放行，未阅报告不等于未完成检查；转科requested/handed-over须接收或取消。出区和结算还须医嘱全部stopped/completed、执行单全部completed/cancelled。discharge-pending仍允许申请停嘱、护士核停，禁止新医嘱、校对、发药或执行。已发未给核停后取消任务，保留历史发药、库存与费用，不自动退库存。床日费在admitted及discharge-pending的实际在院午夜计费，departed虽保留原床也不再计床费。

depart结束Encounter的实际床位period并设置discharged，保留领域床位占用。未出区不能结算，未结算不能清床；clear将Encounter完成并结束占用，床位才能重用。召回仅departed+open、未清床且原床保留时可用，与结算在同一Admission状态CAS竞争，仅一个成功。召回保留原出区及离院方式，追加关联原事件的逆向事件与新床位period，恢复行政在院状态而不恢复任何旧医嘱。结算后再次收治创建独立新住院。

收费员以独立窄DTO读取逐项费用、原预交金、资金和补退金额，不能读取临床出区说明。预览一致读计算稳定逐项fingerprint，涵盖费用ID、版本、金额、来源、科室、业务日、虚拟时间、冲正关系、原入金及资源版本。结算在Command写事务重读，并核对原fingerprint、expectedChargesFen和expectedBalanceFen；Encounter版本或净额未变仍可能因明细变化而拒绝。Web显式预览后冻结已展示金额与指纹，不随账目后台刷新更新；失效必须明确重新预览，丢回执恢复沿用原key、原版本、原指纹和原金额。

InpatientPayments拥有首次封账前的追加预交金、出区补缴和退款Command，复用共享渠道计划及RefundLedger。登记时的正数预交金继续作为同一资金原款；现代预交金成功时按payment ID唯一投影入原inpatient_deposit，未知或拒绝不增加入金。补缴以独立成功尝试参与资金聚合，封账时按原ID投影入首次结算账。余额由同一正式费用账、去重原款和成功退款推导，不新增可编辑余额。组合现金、银行卡及移动支付冻结在原尝试；退款只能引用本次住院已成功预交金或补缴，不超过应退差额与共享可退余额，并沿原方式分配。未知退款保留原款占用，拒绝释放占用；查询原尝试追加唯一结果，原入金不改写。

收退款预览绑定完整逐项费用及资金状态、岗位、金额、方式和过期时间；确认只提交previewId与token，状态、明细或资金变更须显式重审。未知资金不阻断医生出院医嘱和护士实际出区，但阻断新的收退款、首次封账和清床。首次settle在资金无未知且剩余差额为零时冻结原结算快照与唯一资金投影；为保留旧调用合同，从未有独立收退款尝试时，原人工审阅settle可在同一事务执行默认现金结清。出现独立拒绝或未知后不能回退默认路径，须明确补收退并重新预览。旧settlement-preview.balanceFen继续使用原费用减原预交金口径，资金入口remainingFen表示尚应收退，两者不重复入账。

历史退款以稳定原ID适配进共享退款账，迁移不触发渠道、不改变原预交金、结算交易或存储JSON。补缴原款退回使用窄投影保留原结算表的预交金外键。结算封账后InpatientBilling与普通冲正入口继续拒绝新增费用或冲正，归档锁不因资金恢复放宽；投影、资金、状态、receipt和审计同一Command事务提交或回滚。取舍见[首次资金与冻结账决策](../decisions/implemented/architecture/2026-10-22-inpatient-funding-and-first-settlement.md)及[出院动作决策](../decisions/implemented/architecture/2026-10-21-inpatient-discharge-and-settlement.md)。

单笔退款上限保持1,000,000,000分（1000万元），住院退款输入、预览输出、确认和共享退款创建使用同一限额。超限请求在预览阶段拒绝，大额原款须逐次预览、审阅并分笔退回；未知结果先查询原尝试，不能通过分笔绕过资金门禁。历史现金原款总额及同一方式累计已退金额仅用于核对余额，可以超过单笔额度；每一笔退款及其方式金额仍受单笔限额、原款余额和应退差额约束。默认现金结清的总差额超过单笔限额时以INPATIENT_FUNDS_REQUIRED拒绝，调用方先分次办理收退款，结清后再重新预览封账。

#### 住院医保与首次冻结账

普通住院医保读取同一本正式住院费用账，以原费用及其冲正的净额生成逐项来源版本；床日、服务、检验、手术为目录内，药品和影像采用 10% 合成先行自付，材料为目录外。这些覆盖参数仅供仿真，与医院价格及 DRG 支付参数分开。收费员仅在已出区、首次财务尚未完成且未归档时确认或撤销本次待遇；未知收退款须先查询原尝试，不能在金额尚未确定时改变分摊。

首次结算预览保存原医保结算及逐项分摊，患者负担为总费用减基金及个人账户，预交金与补收退款只抵扣患者负担。原待遇的费用来源失效时，原资金记录仍可读取并查询未知结果；未封账的资金余额暂按已确认的原待遇计算，不能用于新增收退款或封账。收费员须先查明未知资金，再撤销原待遇并重新预览，才能按新分摊继续收退及结算；年度余额变化只影响尚未确认的预览，不改写已经确认的待遇。结算指纹包含本次待遇与资金事实，撤销、重结算或资金恢复后旧预览不可继续确认。

首次结算后，病案读取冻结的原医保快照，归档以原患者现金加原基金及个人账户核对原费用，并核对逐项账及原入金；后续医保补偿不替换首次分摊。待遇、资金、临床完成和病案归档分别保留，见[冻结医保的决策](../decisions/implemented/architecture/2026-10-22-inpatient-insurance-freeze.md)。

#### 结算后的财务更正

首次结算完成后，收费员可在已结算、清床或归档的本次住院追加关联原正数费用的冲减或补计，并明确记录原因。原费用、首次结算和归档快照保持可查；当前账只叠加这些有业务引用的更正。病案页面单独显示原冻结金额与当前差异，病案人员只读此差异。后续财务状态不写入行政、首次财务或病案状态，不恢复床位、撤销出区、解档或更改诊断操作。

费用与资金分别确认。冲减退款须同时满足本更正剩余额度、全账待退净额及本次成功原交易可退余额；补计补收须同时满足本更正剩余额度与全账待收净额，组合方式金额合计须一致。相反方向的未处理更正先抵消差额，未知资金继续预占。原交易的成功及未知退款统一扣减余额和原方式额度，不能换依据、原交易或幂等键重复退；后续成功补收也可成为新的原退款来源。拒绝保留尝试并释放预占，未知只开放原尝试结果查询；补收或退款有任一未知结果时，新预览和确认均以 `INPATIENT_FUNDS_PENDING` 拒绝，包括仍有剩余差额或改选其他原交易的情况。恢复追加确定结果，不重新收退；之后重新读取差额并审阅新预览。

后续预览绑定当前账目指纹、原交易余额版本、金额、渠道规则及岗位上下文，真实时间五分钟过期，确认在共享 Command 写事务内重验。响应丢失先查原 receipt，沿用原输入和 key。当前 Workspace/Epoch 内的人类收费会话可在 active/completed Run 执行这些窄财务 Command，closed Run 与失效 Agent Grant 不开放新写，原临床 Command 仍要求 active。后续未知只使本调整待处理，首次完成、清床和归档不倒退。理由见[首次冻结与后续更正分离](../decisions/implemented/architecture/2026-10-22-inpatient-financial-adjustments.md)。

##### 后续医保补偿与重结算

已投保住院的后续财务更正由 `InpatientInsuranceAdjustments` 在共享 Command 内串联费用调整、原待遇补偿和新待遇。收费员在 `financial-adjustments/:adjustmentId/insurance/cancel|preview|confirm` 依次办理，路径绑定当前住院最新调整。补偿精确逆转当前待遇的原年度影响；替代预览沿用首次方案、覆盖规则与原年度，按原费用及全部追加调整重建来源，并读取患者该年度实时累计，其他就诊的影响继续保留。确认校验原预览、Actor、有效期、费用来源及原年度余额版本；任何变化均须重新审阅。原待遇、补偿、新待遇以独立引用保留，详情由财务读模型的 `insurance.cycles` 返回。

投保住院每次只允许一个未完成更正；新待遇尚未有效时不开放资金差额收退。确认后患者应负担减当前净现金决定补收或退款，不以费用调整方向或金额限制医保现金差额。未知收退占用原交易或待收额度，查原尝试恢复，当前调整保持 `unknown`；确定拒绝保留尝试并允许重新审阅。当前 Epoch 的人类收费会话可在 completed Run 办理此窄更正，closed Run、失效 Agent 与其他岗位不开放新写。首次结算、出区、床位及病案归档保持冻结；设计理由见[后续医保更正决策](../decisions/implemented/architecture/2026-10-22-inpatient-insurance-adjustments.md)。

#### 病案首页与归档

首页核心字段分为患者基本信息、住院过程、正式诊断与本次实际操作、费用四组。独立病案号在本Epoch的患者首次住院时持久生成，之后住院沿用；住院号每次独立，住院次数截止本次登记。首页固定采用的 Patient 版本与字段、首次真实床位占用对应科室病区、完成转科、未被召回逆向的最终出区及离院方式，不能用当前科室覆盖首次入科。

诊断复用正式确认及 Condition；主管医生可在已入科、待出院、出区与清床后未归档窗口纠正诊断，保留当前科室病区授权、原Encounter版本与诊断revision。该窄更正不会恢复医嘱、库存或费用动作。编码审核按已确认的固定Release核对完整临床版2022诊断身份、来源定位与版本，保留来源研究声明的权威性和再取得限制；院内备用编码可保存待审稿，须经正式诊断入口更正才可批准。实际操作只从本次 Surgery execution 与 Procedure 取得，保留实施时冻结的临床版3.0有界摘录编码、术者与材料；有操作必须由医生显式选本次实际主操作，无操作明确空集合，申请、计划、取消和既往史不进入已实施列表。编码来源与限制见[来源研究](../research/2026-10-20-inpatient-record-coding-and-recall.md)。

提交、审核和归档分别追加独立事实。每次提交保存四组快照与来源指纹；编码人员只能对当前首页修订及相同来源批准或附原因退回。指纹包含实际采用Patient、诊断和Condition/Encounter版本、操作材料与Procedure版本、床位及有效转出区经过、全部费用正反行与ChargeItem版本、结算资金，以及临床申请/Task/报告/Observation/ImagingStudy版本和完整报告修订确认链。排序稳定，首页状态、审核归档自身、查询时虚拟时间与当前启用Reference Release不属于来源；首页工作流不更新Encounter。来源变化即使净额或Encounter版本相同，也须医生重新提交后审核。当前审核可用性以首页查询的 `reviewCurrent` 及原修订/hash为准，Admission的 `record_status` 不代替来源校验。

归档在同一Command事务重读来源，核原修订/hash、当前审核通过、已清床且结算、核心完整、唯一主诊断、有效实际操作、费用与结算资金一致及无在途任务。归档保存不可变完整快照，读取不拼接当前共享Patient；不全局冻结跨就诊Patient。病案已归档时，ADL、诊断医嘱、手术、检查转科、出院财务和系统报告更正等真实写点共同拒绝写入，既有原receipt仍可无写重放。报告确认先校当前临床责任再守归档锁，无责任的旧门诊入口保持权限拒绝，不因归档暴露不同状态。当前Epoch内的人类会话在Scenario完成后仍可读取住院清单、详情、目录和归档；护士工作台常驻的待接收转科及其目标床位目录、登记员住院证清单、收费员逐项费用与资金预览、药师独立药房清单及窄详情，同样使用保留原岗位与责任筛选的current只读授权；后三岗不因此取得首页或完整诊疗读取权限，各自Command仍要求active Run；Agent Grant继续遵守原有效期与active Run边界。Web归档详情只展示存储首页，不发起已结束诊疗的active查询。决策理由见[病案快照与审核](../decisions/implemented/architecture/2026-10-21-inpatient-record-snapshot.md)。

### 8.3 医嘱生命周期

当前住院医嘱由 InpatientService 下的 InpatientOrders 拥有。长期/临时、护士校对和停嘱状态保存在独立住院聚合，药品和健康教育分别创建 MedicationRequest、ServiceRequest；执行计划以 Task 表达，实际给药使用 MedicationAdministration。登记员不拥有临床详情读取权限，住院医生和病区护士还需匹配当前科室及病区；药师通过独立药房清单和详情读取药嘱、任务、相关批次、实际发药及有效药物过敏风险；旧住院通用清单、详情、目录与临床详情不授权药师。收费员通过独立费用详情读取真实项目标签、账项、净额和财务状态，不读取诊断、POA、备注、医嘱与给药事实；发药及冲正回执分别使用相同岗位的窄响应。Web 和 CLI 共用窄 schema、预期版本、幂等 receipt 和完整审计，不引入门诊 paid 门禁或 Scenario 完成副作用。门诊最后一次发药只有在全部门诊完成、没有未归档住院且没有 issued 住院证时才能完成 Scenario Run；仍有住院或转收责任时保持 active，出院结算或清床不等同全场景结束。

住院医生正式确认主次诊断和逐项入院病情（1有、2临床未确定、3情况不明、4无），形成引用本次住院的 Condition 和 Encounter.diagnosis。病情必须显式选择，Web 保留全部已确认诊断的顺序、逐项入院病情和备注，支持多个次诊断增删与排序；检索及分页保留已选标签，首次编辑固定确认与 Encounter 版本，避免后台刷新覆盖未提交内容。输入次序以 ordinal 随确认修订持久保存，不根据备注或日期推断，也不以生成的 Condition ID 排序。server 优先解析活动 Reference Data Release 的实际诊断条目并冻结 `system/version/code/display/sourceLocator` 与当次 `releaseId`；合成院内 fallback 以 `operational:diagnosis_catalog` 明确标识。住院药品目录沿用真实产品、价格和剂量/频次规则，每次片数由声明的剂量映射约束；不复用门诊处方总数量/疗程语义。三个合成本院产品的真实临床版适应症采用已核定完整 coding 与 Dataset Release/来源定位等值映射，来源见[编码依据](../research/2026-10-20-inpatient-record-coding-and-recall.md)，不以显示名或编码前缀推断。

本院虚拟班次是 Shanghai QD08:00、BID08:00/20:00；首日只产生校对时尚未过去的执行时点，临时医嘱一次，PRN只由护士以理由显式申请。场景推进按业务日展开后续长期任务，以医嘱和时点去重；不会自动形成给药事实。申请停嘱立即冻结新任务、发药和给药，护士核停将 pending/dispensed 任务明确取消，保留已有发药、给药和费用，不自动退库存。该班次只描述本院仿真策略，事实分离的设计理由见[Agent Note](../decisions/implemented/architecture/2026-10-21-inpatient-orders-and-administration.md)。

实际发药按声明的 dispense 触发点逐项入账，健康教育在实际 execution 时入账；床日费继续由午夜推进触发。费用由 InpatientBilling 在拥有该业务动作的同一事务记录，并保留发生时科室。收费员可在未结算时全额冲正：新增关联原费用的反向条目，原账不删，净额包含正反两侧；禁止重复冲正或冲正的再次冲正。出院结算消费这一本费用账。


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

当前门诊账单按一次门诊的 Account 汇总既有 Charge Record，显示挂号、兼容检验与药品应收、累计成功收款、医保覆盖、未收余额及各次支付历史。账单是只读聚合，不新增可编辑 Invoice 或独立余额。未收且已撤回的药品项与收费队列一样退出有效应收汇总，原费用和支付尝试仍保留；已全额收款后撤回的项目继续计入原总额与实收。挂号费用保留为未收应收，本期只有兼容检验和药品收款入口；独立检查申请仍不计费。门诊支持基于费用更正依据的部分退款；普通门诊待遇见[医保模拟](#86-医保模拟)，正式票据尚未实现。

收费员可对当前应收分次收款，每次可组合现金、银行卡和移动支付，同一种方式只出现一次。金额使用整数分；显式输入必须为正，各方式合计不得超过该应收剩余余额。未指定方式时默认现金收取全部剩余金额，保留历史零价项目的零元现金兼容行为。预览冻结本次金额、方式、费用版本及岗位上下文，人工审阅后用 token 确认；金额或临床依赖变化后须重新预览。

成功尝试计入累计实收，拒付与未知尝试不计入，原始尝试及关联号始终保留。部分成功保持应收可继续收取，累计成功实收与有效基金、个人账户分配覆盖原费用后，由原 Workflow Command 推进兼容检验 LIS 或已完诊处方药房放行；单次成功不等于全额完成，组合方式也不独立触发临床状态。待遇撤销后产生的补收只改变财务余额，不回退临床进度或重复放行。部分收款后仍属于原队列时，页面保留队列页码及选中费用；支付历史独立翻页，切换就诊时从历史第一页开始，翻页不改变整单金额。

未知尝试未查明前禁止对同一应收再次预览或确认。收费员从支付历史审阅“查询原支付结果”，提交原 payment ID、支付版本和当前 ChargeItem 版本；恢复仅给原尝试追加确定结果，不创建新收款。确定性模拟器的未知规则分别查询为成功、拒付或继续未知，查询计划在原收款时冻结；旧库未知尝试保持未知，不推定成功。恢复为拒付后可按最新余额重新预览；继续未知时仍禁止收款。页面刷新和服务重启后从同一持久账单恢复历史与可用动作。

门诊收费员可记录带具体原因及原 ChargeItem 版本的费用冲减，再预览并审阅关联成功原款的部分退款。费用冲减追加 `ChargeAdjustment`，不发送资金、不改写原费用金额；退款追加独立资金反向记录，不撤销处方、检查、发药、库存、临床放行或执行事实。原项目、原交易、冲减原因、当前净应收及净实收可分别核对。后续收款依据冲减后的应收与成功退款后的净实收计算剩余金额。

退款同时受原交易未退余额与该费用累计冲减依据约束，跨原支付共享依据额度。退款按原款冻结方式顺序反向分配，每种方式只使用其未退余额，不由操作者另选退款方式。未知结果预占原款、方式和依据额度，拒付释放预占；预览绑定原款余额版本、费用版本、金额、渠道规则、岗位上下文与真实时间五分钟期限。确认在共享 Command 写事务内重验，竞争预览或不同幂等键不能重复占用同一额度。查询恢复仅以原退款 ID、退款版本及当前费用版本追加原尝试已冻结的渠道结果，不接受金额或 outcome。新冲减、新退款继续要求 active Scenario Run；仅原退款恢复允许当前 Workspace/Epoch 的人类收费员在 completed Run 查询并收敛已有尝试，closed Run 与 completed Agent Grant 不开放写入。取舍见[退款与费用更正决策](../decisions/implemented/architecture/2026-10-22-original-payment-refunds.md)。同一费用有任一未知收款或退款时，拒绝新收退款的预览与确认；收款恢复只有在全部未决资金已收敛、成功资金与有效医保分配覆盖净应收时才放行临床执行。

门诊费用冲减、退款预览、退款确认和原退款查询发送前，页面把原幂等键、完整输入、病例目标及账号与岗位绑定保存到 `sessionStorage`，读取时严格验证结构，恢复前重新核对服务端会话。响应丢失或刷新后先查原 Command receipt，只有明确不存在时才按原 key 和原 payload 重放；刷新、重启不会重发资金。待确认期间阻断新资金写入；切换病例仍可通过全局入口恢复原操作，病例目标、原输入和幂等键保持不变。退款预览恢复保留原 `previewId`、`commitToken` 和 ChargeItem 版本，按完整受信会话与病例保存客户端审阅状态；其他病例不展示该预览，返回原病例可直接审阅确认。审阅对话框在框内显示失败、待确认状态及恢复按钮，刷新后保留同一恢复入口。

重要建模：

- `ChargeItem` 表达可计费活动及其状态，不等同最终确认费用或支付。
- `Invoice` 表达向付款方汇总的账单，不等同财政电子票据、税务发票或收款流水。
- 财政电子票据的开具、红冲、换开、票号和平台状态由领域模型管理；DocumentReference 可引用其版式文件。
- 院内收款使用本地 PaymentTransaction，不滥用 FHIR PaymentNotice 或 PaymentReconciliation；前者仅用于付款方通知，后者仅用于确有付款方对账语义的投影。
- 金额分配使用关联表，不保存 `charge_item_ids` 字符串。调价、减免、四舍五入、医保拒付和自费转医保使用独立调整/分配记录。
- 收款退款、账单红冲和医保结算撤销是不同交易链，均通过反向记录或 replacement 关系处理，不覆盖原账。

### 8.6 医保模拟

当前普通门诊与住院共用 `InsuranceService` 待遇内核。收费员从真实费用和目录映射预览，经人工审阅后确认；HTTP、Operation Catalog、CLI 与收费页面调用同一 Command。医保只分配基金、个人账户与患者负担，不创建现金交易，不改写原 Charge Record 金额，也不表示院方 DRG/DIP 支付。

普通门诊固定合成 v1 参数如下，不代表地区政策。所有金额以整数分计算，比例乘法使用整数截断，不以浮点元累计。

| 方案 | 年起付线 | 基金比例 | 年基金封顶 | 个人账户期初 |
| --- | --- | --- | --- | --- |
| 合成职工 v1 | 1000 分 | 70% | 100000 分 | 2000 分 |
| 合成居民 v1 | 2000 分 | 50% | 50000 分 | 0 分 |

普通门诊合成目录把挂号标为目录外，兼容检验先行自付 10%，药品先行自付 20%。原费用的类别和来源必须有明确映射；缺映射拒绝预览，不以零待遇代替。先扣目录外和先行自付，再抵年度剩余起付线，对剩余目录内费用按比例及封顶分配基金，个人账户抵扣目录内个人负担，余额由患者承担。逐项结果保存原费用引用、版本、目录版本及各金额，供页面解释和审计。

门诊待遇、患者收款与临床放行采用原费用减去已记录冲减的净额。药品待遇预览与确认要求 Encounter 已完诊，否则以 `INSURANCE_FUNDS_CONFLICT` 拒绝；个人账户全额覆盖也遵守该门禁，原待遇撤销补偿继续开放。有效医保分配关联的费用须先撤销待遇，再办理冲减，保留原费用、待遇和现金历史。未知收款或退款未查明前，阻断待遇变化、再次收款及费用冲减；原尝试恢复入口继续开放。

待遇账户绑定 Workspace/Epoch、Patient 与上海时区虚拟日历年。年度首次结算固定方案，撤销也不允许切换方案；普通门诊与住院的目录内累计、起付线和基金封顶分别计算，个人账户共用。一次门诊可先结算检验、收取患者余额，再对新处方单独结算；已有效分配的费用不会进入下一笔预览。已收取患者资金的费用拒绝新待遇确认，须先完成适用的财务更正。

预览绑定岗位上下文、目标、原费用与目录指纹、年度及账户版本，五分钟过期。确认重新读取全部依赖，任何变化要求重新预览；并发确认只允许一份分配成功。撤销指定有效结算和原年度的预期账户版本，追加关联原结算的负向累计及账户恢复，保留后续结算；读取结果的 `annualBalances` 提供各原结算年度余额，不能用当前年度版本办理旧年撤销。每份原结算最多一份补偿，旧结算和原现金事实保留。已临床放行的费用撤销后产生补收，保持原临床状态。

收费页面按完整会话与就诊绑定预览和弹窗，展示参数、年度累计、基金、账户、患者现金及补偿历史。确认与撤销先把原意图和幂等键存入绑定会话的 sessionStorage；响应未知或刷新后先查询原 Command receipt，完成时刷新账单，明确拒绝后才允许新意图。恢复入口仅在原目标可用，旧患者的迟到响应不能覆盖当前预览。决策理由见[患者待遇内核](../decisions/implemented/architecture/2026-10-22-patient-insurance-benefits.md)。

后续地区平台协议流程如下，当前合成待遇不宣称已有这些平台接口：

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
