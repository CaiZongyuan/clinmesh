# 门诊业务流程

本文定义现场普通门诊从患者物化、挂号分诊、受控自由问诊、12 字段实时病历整理、诊断确认到七项完诊门禁与已完诊病例时间线的状态机和恢复边界。门诊处方与药房交接见[处方、医嘱与药事](orders-and-pharmacy.md)，医技申请、预付费门禁与报告已阅见[检验、检查与报告](examinations-and-reports.md)，收费与医保见[收费、结算与医保](billing-and-insurance.md)，专病算子、诊疗建议与事中质控见[临床决策支持与质控](clinical-decision-support.md)。

## 现场挂号与患者来源物化

### 普通现场挂号与资源边界

```text
管理员生成 Synthetic Case + 选定 Patient Persona
  -> 挂号员选择待挂号病例与科室/号别/诊室 -> Registration + Encounter + Account + 挂号 ChargeItem + Consultation (awaiting-triage)
  -> 分诊录入体征 Observation + Queue Task ready (awaiting-doctor) -> 负责医生接诊绑定责任
  -> 受控问诊 + 12 字段首版病历整理与正式电子签名 -> 确认主次诊断 Condition
  -> 独立医技申请收齐放行与报告已阅 + 本院/外延处方或无需用药结论 + 可选签后病历修订草稿与线性 Composition 修订签名
  -> 七项完诊门禁与事中质控通过 -> Encounter completed -> 药房发药与取消检查退款收敛 -> Scenario Run completed
```

ClinMesh 实现现场普通门诊闭环，同一个 `Encounter` 贯穿挂号、分诊、首诊、医技检查与当日复诊，不为结果回报新建 `Encounter`；预约（`Appointment`）、号源时段（`Slot`）、急诊、退号与取消就诊不属于现场普通挂号状态机，不能从现场挂号状态反推其语义。

`Registration` 是持久领域事实。管理员生成 `Synthetic Case` 并选定 `Patient Persona` 后，挂号员从待挂号列表选择病例与挂号目录项，经 `registration.synthetic-case.start` 共享物化内核在同一事务内原子创建或关联 `Patient`、`Registration`、`Encounter`、`Queue Task`、`Account`、挂号 `ChargeItem`、`Consultation` 与 `Case materialization`，将病例置为 `awaiting-triage` 并移出待挂号列表、进入挂号记录与分诊队列。多挂号员以不同幂等键并发提交同一病例时仅一个 revision 条件更新成功，失败方收到受控冲突并刷新队列；管理员仍可直接启动 ready 病例。临时患者建档仅创建普通 HIS `Patient Identity`（院内患者号归属 `Patient`，门诊号归属 `Encounter.identifier`），不推导 `Synthetic Case`、`Case Truth` 或 `Patient Persona`。取舍见[挂号编号与完整性决策](../decisions/implemented/architecture/2026-10-20-registration-numbering-integrity.md)。

### 院后复诊来源冻结与本院住院摘要白名单

院后门诊复诊通过挂号页患者检索复用同一 `Patient Identity`，创建新的 `Registration`、`Encounter` 与独立 `Consultation`。当该患者在当前 `Workspace/Epoch` 具有唯一有效的 `Synthetic Case materialization` 时，挂号事务将来源冻结写入 `outpatient_case_source`，外部可见既往史、`Patient Persona` 与 `clinical_request_source` 均沿此冻结引用读取；后续新增病例物化不改变已开始复诊的来源，多义来源不自动选择。原病例、`Profile Revision`、`Case Truth` 与 `Persona Revision` 不复制或覆盖，Epoch reset 后按新 Epoch 的物化事实重新绑定。

当前门诊责任医生的 `local-completed` 历史按临床日期混排本人经治的门诊完诊记录与同患者已出院住院摘要；纳入混排的住院记录必须同时满足当前 `Workspace/Epoch`、同一 `Patient`、行政状态 `departed | cleared` 且 `Encounter` 为 `discharged | completed`。住院摘要严格实行白名单投影：仅含入出院时间、最新正式住院诊断、已完成手术及可用冠脉造影结论、正式药物医嘱（保留停嘱状态供历史用药判断，不作为当前处方）以及已签发检验检查结论与结果；未出院记录、其他患者、其他 Epoch、影像／切片素材标识与 `Case Truth` 不进入摘要。原 `/doctor/completed-cases` 病例库保持独立；医生从病例页「本院既往诊疗」展开列表与详情，诊疗建议将该摘要列为必读证据并按单包 12 KiB 的 UTF-8 字节预算无损打包。取舍见[门诊工作流拆分与院后复诊决策](../decisions/implemented/architecture/2026-11-12-outpatient-workflow-domain-split.md)。

## 受控自由问诊与回答恢复

### 对话聚合与隐藏诊断泄漏出口检查

`Consultation` 是病例级领域聚合，`Consultation Record` 按 append-only 保存对话轮次。`Synthetic Case` 启动时绑定 `Persona Revision` 并追加患者开场白；首次医生发言可同时开始首诊并绑定负责 `Practitioner Role`。每轮保存说话方、内容类型、来源（预留 `asr-import` 与 `external-sync`，当前无外部导入接口）、虚拟业务时间、参与 Actor 与患者档案修订。

患者对话模型的输入仅限固定档案、最近 40 个对话轮次、可见既往史、分诊体验、正式 `Specimen` 的类型与采集时间以及已签发检验报告（放射仅提供检查名称与时间而不含所见或印象，病理仅提供“会诊已受理”）。`Case Truth` 仅由档案生成器与独立泄漏出口检查读取，绝不进入回答模型上下文。出口检查规范化诊断术语修饰尾缀、数字写法与常见简称：命中本次隐藏诊断术语时重新生成一次，再命中则替换为安全患者应答落库；档案中既往已知诊断允许正常陈述。边界见[患者档案对话决策](../decisions/implemented/architecture/2026-09-16-patient-persona-dialogue.md)与[已知既往诊断边界决策](../decisions/implemented/bug-fix/2026-10-06-persona-known-diagnosis-boundary.md)。

### 待答互斥、请求复用与未知结果恢复

未回答的医生发言阻止追加下一条医生发言，但病历、医技、诊断与处方模块保持可用。检验报告签发或更正时追加引用固定 `DiagnosticReport` 版本的报告卡片，卡片不充当文本回答，也不阻断在途生成。每次回答尝试共享自开始起的 30 秒期限，失败或结果未知时保留已落库医生发言。

回答执行按受信 `Workspace/Epoch` 与待答医生轮次协调：`ask`、同键重发及重叠补答共同复用单次生成，各自独立校验授权、输入冲突并保存自身回执。在途回执状态为 `executing` 并含已存发言；相同幂等键回放已终止意图时直接返回原回答或原失败／未知终态（含档案缺失 `404` 与档案过期 `409`），绝不重新推理。

`consultation.replyAttempt` 返回医生轮次、起止时间、`executing`/`blocked`/`succeeded`/`failed`/`unknown` 状态与安全错误码。控制或用量账本阻断返回 `409 MODEL_CONTROL_BLOCKED` 并保留问题，恢复后仅在原期限内且授权与病例有效时接续。刷新或新 retry key 在原尝试仍活动时加入等待，不切模型或延长期限；原尝试终止且问题仍待答时，须由医生以新幂等键发起明确补答意图才使用当前模型开启新尝试，不重复提交问题。HTTP 断连不取消已接受生成；runtime 关闭主动取消并等待收束，重启将已派发未确认的执行标为 `unknown`（`AI_TIMEOUT` / `CONSULTATION_REPLY_UNKNOWN`）且不自动补答，仅明确未派发的有效待办在原期限内恢复。复诊延续同一对话，完诊只读；Epoch reset 重放允许措辞变化（见[确定性与故障注入](simulation.md#104-确定性与故障注入)、[模型执行恢复](storage.md#模型执行恢复)与[模型请求控制与恢复决策](../decisions/implemented/architecture/2026-10-21-model-request-control-recovery.md)）。

## 实时病历整理与十二字段结构化文书

### 统一事实来源、分批预算与直接草稿写入

DSH 模型桥接已配置时，新病例默认启用实时病历整理；历史未启用病例须显式补录，缺少可恢复上下文的已启用病例返回 `requiresContextBinding` 经受信入口恢复医生绑定。患者回答、经原生证明绑定的右侧助手医生补充、以及固定版本已签发报告在同一事务保存为统一来源并写入持久任务与 outbox：

- **医生补充原生绑定**：右侧助手中的真实医生补充无需主会话调用 Tool 即可持久保存，独立于患者对话、待答状态与 Tool／代问许可；仅凭浏览器 permit 拒绝入库，Host 须配对原生输入、Session、RPC、原文哈希与病例锚点并在写入与回放前重验认证与锚点。
- **客观与自述隔离**：报告来源读取固定已发布版本的真实内容而非卡片标题；患者自述居家测量或外院结论注明自述来源，不升格为本院客观检查；病历草稿与 Agent 建议不得作为新事实来源。
- **十二字段来源边界**：覆盖主诉、现病史、既往史、月经史、孕产史、家族史、过敏史、体格检查、辅助检查、评估、处置与随访十二字段。体格检查与评估、处置、随访四项仅接受明确医生来源；月经、孕产、家族与过敏事实分别归类，严禁依年龄、性别或婚姻推定阴性病史。

通过确定性引用与病例归属校验的新增、补充、更正和矛盾直接经共享 Command 原子写入草稿（保存来源、锚点、批次关联、草稿版本与完成事实），不设逐条人工确认队列：新增追加；补充或更正仅替换仍归 `automatic` 且锚点有效的片段；人工改写转为 `manual` 保留原文，后续患者更正另行追加；矛盾保留原陈述并追加待核实归纳。写入前重比人工上下文，变化或超限时保留失败供显式恢复；前端三方合并保护未保存输入，并对可见区域发生后台更新的字段显示按病例与代次隔离的查看提醒（页面切后台或滚出视口暂停，人工编辑仅消退该字段提醒，提醒不构成核对事实）。

实时整理按病例合并未处理来源：单批最多认领 8 条新增来源、4,000 字符，完整持久快照上限 256 KiB，压缩后模型输入上限 128 KiB（超限保留来源与失败状态而不静默截断）。快照采用句子编号引用协议，模型仅返回事实文字与句子编号，服务端还原逐字引文后校验。每份来源落库最终状态（`recorded`、`no-new-facts`、兼容 `needs-verification` 或 `failed`），单条候选冲突不影响同批其他合法候选。Outbox 按实时整理 10、历史补录 1、诊疗建议 1、其他业务 2 隔离槽位；生成与最多一次格式修复共享 `CLINMESH_AI_TIMEOUT_MS` 常规等待预算（无专用短截止），关闭、撤权、暂停与签署准备取消信号直传 Provider。控制 Command 单调推进任务代次，迟到结果不越过暂停或新代次，重启仅接续无未决派发任务。取舍见[统一直接病历整理决策](../decisions/implemented/architecture/2026-10-15-unified-direct-document-recording.md)。

### 页头主诉投影与病历完备性质控

医生工作台页头主诉投影当前病例工作稿：未保存修改立即标记“未保存”，清空保持未记录而不回退分诊；刷新优先读已存草稿，无医生文书时才沿用分诊初记，签署后固定展示最高修订号的不可变文书；分诊原文与体征独立保留。

门诊病历质控独立检查模板缺项、已知事实遗漏、前后不一致及新增事实来源（覆盖自动整理片段与 `outpatient.record.draft.set` 新增内容；纯人工自写不因无引用误报，人工改写退出自动归属检查而整份正文继续一致性核对）。实时质控只读本次问诊、医生补充、已发报告、当前正文与临床摘要，区分正常概括、同义改写、有来源补充、合理病程变化与有据更正，仅对未解释同语境互斥提示具体事实；分诊初记身份与时间参与指纹，纯保存元数据不破坏复用，未保存候选共享规范任务且不隐式保存。界面无问题时隐藏质控块，有问题时单条摘要展开、点击定位字段并选中唯一精确匹配原句，由医生直接改文，不设勾选确认或签署门禁（与四关口事中临床质控边界见[临床决策支持与质控](clinical-decision-support.md#与门诊病历完备性质控的职责边界)，取舍见[病历记录质控整合决策](../decisions/implemented/architecture/2026-10-19-recording-quality-consolidation.md)）。

### 专科动态病史策略与不可变文书签署修订

`clinical_document_draft` 以 `expectedDraftVersion` 与 `Encounter` expected version 做 CAS 更新；十二字段每项上限 4,000 字，留空表示未记录（不自动补阴性／未孕或创建 `AllergyIntolerance`），正式签署校验核心六项完整性与动态专科病史策略 `outpatient-history-v2`（通过 `clinicalHistory` 返回）：男性及未满 10 周岁女童默认收起（不隐藏已有内容），10 至不足 12 周岁可填；满 12 周岁（按挂号就诊日计）女性在 `GYN`、`OB`、`OBGYN`、`REPRO`、`BREAST` 专科且明确为临床初诊时，`menstrualHistory` 与 `obstetricHistory` 在签署预览、提交与修订中必填（缺失返回 `WORKFLOW_CONFLICT` / `CLINICAL_HISTORY_REQUIRED`）；普通门诊、专科随访及分类未知时可填并提示核实而不阻断。负责医生仅可在首次签署前通过 `PUT /api/his/v1/encounters/:encounterId/clinical-document/visit-kind`（不入 Agent Catalog）选定初诊／随访并附依据，写入专用 `Encounter.type` coding 并使旧预览失效；挂号费别与流程步骤不得推定临床初复诊，两项病史也不跨次自动复制。取舍见[动态病史要求决策](../decisions/implemented/feature/2026-11-09-contextual-clinical-history.md)。

签署预览固定 Actor 上下文、`Encounter` 版本、草稿正文与版本及问诊／来源快照，推进提取代次冻结迟到整理（取消则恢复未完成提取）；正式提交重验依赖与 token，原子创建带稳定章节编码的不可变 FHIR R5 `Composition`、首 `entry` 为该 `Composition` 的自包含 `document Bundle` 与 `Provenance`，不直接完成 `Encounter`。每个病例仅允许一个根文书，`signed_clinical_document` 维护仅接受最新 `Composition` 的线性替代修订链，历史原件永久可读。

现代 `Consultation` 门诊病例将“已签署首版根文书”与“已确认有效主诊断”作为正式开单与确认用药结论的统一前置门禁（门诊工作台页签按 `问诊记录 -> 病历记录 -> 诊断 -> 检验检查 -> 处方` 排列）：未签署首版病历时先返回 `409 CLINICAL_DOCUMENT_UNSIGNED`，已签署首版病历但尚无有效已确认主诊断时返回 `409 DIAGNOSIS_UNCONFIRMED`，统一约束四类医技申请签发、处方签发、无需用药结论确认及工作台待办集中确认（草稿保存删除、专病医嘱组套预填、病历完备性质控与 AI 诊疗建议在门禁前保持开放；无 `Consultation` 聚合的首期兼容门诊路径与住院医技不受影响）。首版根文书签署后，只要 `Encounter` 仍处于 `in-progress`，主接诊责任医生仍可经 `encounter.clinical-document.draft.set` 保存签后病历修订草稿（含插入放射／病理报告摘要），并在补充辅助检查、评估、处置或随访后经 `clinical-document.revise` 签署线性替代修订并同步草稿基线。取舍见[门诊首版病历签署与诊断前置开单门禁决策](../decisions/implemented/architecture/2026-11-23-outpatient-initial-document-signing-order-gate.md)。

## 门诊诊断草稿与线性确认修订

门诊诊断基于版本化 `diagnosis_catalog` 受控 ICD-10 条目在 `diagnosis_state` 保存 1–8 条诊断、主次角色与可选备注，以 `Encounter` expected version 与单调 `expectedDraftVersion` 做 CAS；保存草稿不创建 `Condition`，提交空 `entries` 显式丢弃草稿并递增版本而不改动已确认诊断。目录弹窗支持连续加入最多 8 项并维护唯一主诊断，与 Agent 建议共用待办清单（含 Agent 项时额外核验准备代次与资料指纹，见[准备临床确认决策](../decisions/implemented/architecture/2026-10-18-prepared-clinical-confirmation.md)）；确认发送前冻结载荷与幂等键，未知结果先查医生 Session 原回执，确定冲突时释放冻结并保留整组草稿（见[连续办理私稿与逐项原回执恢复](clinical-workflows.md#连续办理私稿与逐项原回执恢复)与[浏览器未提交私稿](storage.md#浏览器未提交私稿)）。

正式确认要求恰有一个主诊断，在同一事务创建 `encounter-diagnosis` 类别的 FHIR R5 `Condition`、更新 `Encounter.diagnosis.use`、写入 `Provenance`、清空草稿并追加线性 `diagnosis_confirmation`（再次确认将上一版 `Condition` 标为 `verificationStatus=entered-in-error`）；处方审方、病例库筛选与完诊门禁仅读取最新确认版本。

## 主接诊责任、完诊门禁与已完诊病例时间线

### 主接诊责任与七项完诊门禁

一个普通门诊 `Encounter` 同时只能有一名主接诊医生，由 `outpatient_case_responsibility` 按 `Workspace`、`Epoch` 与病例唯一记录首次分配的 `Practitioner Role` 与虚拟时间。无责任人的 `awaiting-doctor` 病例须先由接诊 Command 分配责任才开放临床写入，他人抢占接管返回权限冲突，完诊后纠错同样校验该持久责任。

`GET /api/his/v1/encounters/{id}/completion` 返回主诊断已确认、结构化病历已签署、必要报告已阅（全部未取消医技申请须处于最新报告 `acknowledged`，无申请直接成立）、用药结论已记录（未撤回本院／外延处方或正式无需用药结论）、无未处理草稿（诊断、医技或处方草稿均已清空或确认，且已签根文书后的 `clinical_document_draft` 与最新已签 `Composition` 正文无未提交修订差异，否则以 `target = 'clinical-document'` 阻塞）、处置完整与随访完整七项稳定编码。`encounter.complete` 在 `BEGIN IMMEDIATE` 事务内忽略历史预览，重算七项门禁与急性胸痛完诊事中质控（见[临床决策支持与质控](clinical-decision-support.md#四大责任关口与红线警示双层规则)）并核对 `Encounter` expected version；任一缺失返回 `ENCOUNTER_COMPLETION_BLOCKED`，通过后仅更新 `Encounter.status=completed` 与 `actualPeriod.end`，不改动队列任务、挂号、收费、发药或 `Scenario Run`。取舍见[门诊完诊策略与病例库决策](../decisions/implemented/feature/2026-08-25-encounter-completion-policy.md)。

### 已完诊病例库、业务时间线与受控纠错回跳

`GET /api/his/v1/doctor/completed-cases` 分页检索当前 `Practitioner Role` 负责的已完诊病例（支持按患者、完诊日期闭区间与主次诊断筛选，按 `actualPeriod.end` 降序、病例 ID 升序排列）。详情接口仅组装各 owner 正式事实（问诊、不可变签署文书链、医技申请与报告修订及已阅、诊断确认链、处方／撤回或无需用药结论），并按虚拟时间升序生成确定性业务时间线（纳入成功删除医技／处方草稿的 `ActionTrace`，将检查取消与处方撤回作为独立逆向事件输出，前端只读按序渲染）。详情标注 `correctionSupported` 与 `withdrawalSupported`：病历修订与未调剂处方撤回须显式回跳至活动病例对应区域，经对象预览、显式确认、最新 expected version 与新幂等键调用原 owner Command（报告更正由具 `administrator` 能力的会话发起），成功后同步失效活动病例与病例库查询。
