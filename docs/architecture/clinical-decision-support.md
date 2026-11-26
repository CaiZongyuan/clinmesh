# 临床决策支持与质控

本文定义跨门诊与住院共享的受审计专病结构化风险评估与确定性临床算子内核、版本化心血管专病医嘱组套与禁忌预筛、离线免费指南全文库与共享指南专题注册表、门诊可追溯诊疗建议与分批预算收敛、住院只读指南参考意见、以及四节点双层事中临床质控与受审计 `Clinical Override` 合同。门诊病历整理与完诊门禁见[门诊业务流程](outpatient-workflows.md)，住院手术与 PCI 选型见[住院与手术流程](inpatient-workflows.md)，声明式药事安全规则见[处方、医嘱与药事](orders-and-pharmacy.md#门诊与住院共享声明式药事安全规则)。

## 专病风险结构化评估与确定性临床算子

门诊与住院共用受审计的结构化临床体征与专病风险评估底座：门诊分诊生命体征（`triage.record`，支持身高体重并生成 `Provenance`）与住院护理生命体征（`inpatient.vital-signs.record`）提供客观体征输入；门诊（`encounter.risk-assessment.record`）与住院（`inpatient.risk-assessment.record`）共用 `clinical_risk_assessment` 单调修订表、FHIR `Observation` 与 `Provenance` 记录心血管缺血及出血危险分层所需结构化临床观察（区分自发性需医疗干预出血与外伤／围术期非自发性出血等临床属性）。所有尚未明确录入的观察项一律保持 `null`（未记录），严禁在持久层或计算层隐式假定为正常或阴性；其中有效 ST 段偏移结论严格锁定本次就诊／住院首份已签发 12 导联心电图报告，仅在首份报告无明确 ST 段结论时回退床旁结构化评估，绝不以晚发复查心电图覆盖首诊缺血表现。

只读风险评分接口（门诊限当前主接诊责任医生的 `doctor.case.clinical-scores.read`，住院限有权读取岗位的 `inpatient.clinical-scores.read`）拒绝调用方传入任何未落库的临时覆盖数值，严格按当前活动时点或就诊结束／出区截止时点（已完诊门诊或已出区住院自动截断晚于本次就诊的跨次记录，保证历史可复现）抽取已确认客观记录，调用纯函数内核 `@clinmesh/core/clinical-scores` 确定性计算肾功能、急性冠脉综合征缺血风险、双抗出血风险与血脂靶标六项算子（`ckd-epi-2021-egfr`、`cockcroft-gault-crcl`、`grace-acs`、`timi-ua-nstemi`、`precise-dapt`、`ascvd-ldl-target`），内置肌酐、血红蛋白与血脂常规双轨单位精确换算；任一必需客观输入缺失时统一返回 `status: 'incomplete'` 与具体缺项清单 `missingInputs`，不调用模型估算或兜底填补。算子边界与可复现取舍见[确定性临床风险算子决策](../decisions/implemented/architecture/2026-11-17-deterministic-clinical-risk-scores.md)。

## 心血管专病与术后医嘱组套及禁忌预筛

门诊与住院共享版本固定且携带内容 SHA-256 指纹的 `Order Set Template` 注册表（`catalog.order-set-templates.list` v3），覆盖胸痛首诊急查（`chest-pain-stat-workup`）、冠心病入院基线评估（`cad-admission-baseline`）、对比剂肾损高危围术期水化（`cin-perioperative-hydration`）、冠心病／PCI 二级预防标准用药（`cad-pci-secondary-prevention`），以及两套按已完成术式编码匹配的住院术后成套医嘱模板——PCI 术后标准成套医嘱（`pci-postop-standard`，含水化、心电监护与穿刺部位压迫制动护理、术后心肌标志物／心电图与次日肾功及血常规复查）与普外术后标准成套医嘱（`general-surgery-postop-standard`，含补液、切口与生命体征护理及术后血常规、肾功与电解质复查）；病房术后护理成员以 `kind = 'service'` 表达且仅限住院适用、不含 `routeCode`。

零正式副作用草稿预装配接口（门诊 `doctor.case.order-set-drafts.read` 限责任医生，住院 `inpatient.order-set-drafts.read` v3 限主管医生并支持可选 `surgeryExecutionId` 按已完成手术编码自动匹配术后组套；跨适用范围调用返回 `ORDER_SET_SCOPE_NOT_APPLICABLE`）读取当前患者有效确认药物过敏、`ckd-epi-2021-egfr`、最新结构化生命体征与体重，以及住院当前在执医嘱与在途医技申请，经纯函数 `@clinmesh/core/order-set-screening` 将每个组套成员按 `unavailable > excluded > skipped > needs-review > ready` 优先级分类：

- **硬禁忌直接剔除（`excluded`）**：命中有效已确认药物过敏（携带过敏原编码与显示名）、严重心动过缓／低血压生理禁用阈值或严重肾功能不全禁用阈值时，直接从可勾选项剔除并返回 `matchedCatalogId`、客观观测值与来源引用，绝不跨药品自动改选替代药，且优先级严格高于术前已在用跳过。
- **术前已在用与在途去重跳过（`skipped`）**：当患者已存在同品规在执医嘱（`already-active-order`）、同药理互斥类在执药嘱（`mutually-exclusive-active-order`，如已在用替格瑞洛或瑞舒伐他汀时自动跳过氯吡格雷或阿托伐他汀）或同项目在途未完成医技申请（`in-flight-investigation`）时，标为 `skipped` 并计入 `counts.skipped`，在界面以「术前已在用 · 默认跳过」分区与硬禁忌明确区分，避免误导为临床禁忌。
- **缺依据显式待核实（`needs-review`）**：缺少生命体征、体重或近期肾功能检验输入时统一标为 `pending-verification`，默认取消勾选供医生核实，绝不静默假定指标正常；住院医技目录同步区分项目未开展（`catalog-unavailable`）与未声明住院价目（`catalog-unpriced`）。
- **零正式写入与客户端灌入**：预装配读取不产生任何正式医技申请、处方、住院医嘱或账项；门诊开单器、住院普通开嘱器与住院术后医嘱重整统一编排器按需拉取预筛结果灌入客户端待开清单（病情更新后重新套用时自动移除新剔除项并取消勾选新待核实项），最终由医生核对后走既有正式 Command 签发。设计取舍见[专病医嘱组套与禁忌预筛决策](../decisions/implemented/architecture/2026-11-18-cardiology-order-set-templates.md)与[手术通知单停续术前医嘱策略与术后成套医嘱重整决策](../decisions/implemented/architecture/2026-11-25-preop-order-policy-and-postop-order-sets.md)。

## 免费指南全文库与共享指南专题注册表

### 离线指南全文库、叠加校验、人群隔离与共享正文

免费临床指南使用独立 SQLite 维护来源元数据、物理页原文定位与 FTS5 trigram 全文索引，与业务及 Reference 数据库迁移解耦；所有全文与缓存仅驻留本地数据目录，临床业务请求期间绝不发起外部网络下载（部署准备见[免费指南全文同步](../deployment.md#免费指南全文同步)）。常规安装入口加载独立固定 Release：核验原件哈希、派生正文、定位核验记录与规模后，施加静态叠加层的来源人群／专科标注与已校验单页勘误并整包事务入库；可信本地验证在显式开启 `CLINMESH_GUIDELINE_LOCAL_EVALUATION=true` 时仅放行清单登记的 `local-evaluation-` 来源（保留原始许可、哈希与可读页范围，不代表商业授权，操作见[冠心病资料的本地流程验证](../deployment.md#冠心病资料的本地流程验证)）。相同文献版本的完整正文在底层共享单份存储与检索索引，撤回、被替代或正文损坏状态沿 `derivedFromSourceId` 稳定来源链向下游全部派生记录单向传播（派生停用不反向污染原来源），任何完整性损坏均同时阻断同源内置短引文回退（表边界见[存储合同](storage.md#99-数据库迁移边界)）。

指南检索对患者实行确定性人群隔离：按患者出生日期与挂号业务就诊日（缺失时回退当前 Epoch 虚拟时间，缺失／非法／晚于参考日则降级为 `all-only`，绝不读取宿主机挂钟时间）在上海时区日历下计算整周岁——满 18 周岁为 `adult`（仅匹配 `adult` 与 `all` 来源），未满 18 周岁为 `pediatric`（仅匹配 `pediatric` 与 `all` 来源），`all-only` 仅匹配全人群来源；派生来源沿整条祖先链继承人群边界。人群条件纳入 LRU 检索缓存键、全库 `revision` 与建议指纹，因人群不匹配排除的来源不记入表征撤回／损坏的 `inactiveSources`（`internal-testing` 部署策略下，成人上下文可检索已核验成人与全人群来源，儿科血液肿瘤规范保持零召回）。检索先按用途许可、人群、完整性与祖先有效性过滤，合并共享正文后再按主题相关性层分轮选取各独立正文最佳与后续段落，最多输出 8 段完整原文（总上限 48 KiB，不以摘要替代原文）。全文库与叠加隔离见[免费指南全文库决策](../decisions/implemented/architecture/2026-10-16-free-guideline-corpus.md)。

### 共享指南专题注册表

门诊与住院共用经逐字核对且版本固定的 `Guideline Topic` 注册表，首批覆盖急性胸痛与 ACS 危险分层（`acute-chest-pain-acs`）、冠脉血运重建指征与功能学评估（`coronary-revascularization-indication`）、冠脉介入支架选型与腔内影像（`pci-stent`）、对比剂肾损伤预防与围术期水化（`contrast-kidney-hydration`）、双联抗血小板与冠心病二级预防（`cad-dapt-and-secondary-prevention`）以及 2 型糖尿病合并慢性肾脏病用药（`t2dm-renal-medication`）六个专题。

每个注册专题绑定来源身份、版本、SHA-256、物理页码、必须完整保留的原文条款与限定语片段（兼容 PDF 软连字符与断行连字符规范化校验）及适用限制说明，同样受最多 8 段、48 KiB 预算约束。门诊（`doctor.case.guideline-topics.read`）与住院（`inpatient.guideline-topics.read`）提供零模型调用的同步专题依据读取，直接返回核验通过的原文段落、限定语、当前患者已落库客观指标（复用六项确定性临床评分及已签发心电图、心超 LVEF、冠脉造影狭窄率／FFR、糖化血红蛋白与有效 PCI 选型计划）与具体缺项清单；一旦来源缺失、撤回、人群隔离不匹配或页码限定语残缺，立即明确降级为 `unavailable` 并说明原因，严禁截断限定语输出残缺依据。门诊诊疗建议在可见病例命中注册专题时优先并入已核验专题段落并按正文去重，剩余预算再补充常规全文检索。专题注册表与手术单解耦见[共享指南专题注册表决策](../decisions/implemented/architecture/2026-11-17-shared-guideline-topic-registry.md)。

## 门诊诊疗建议与住院只读指南参考意见

### 门诊五类诊疗建议、分批收敛与请求预算

门诊诊疗建议绑定 `Workspace`、`Epoch`、负责医生、病例与建议类别（检验、放射、病理、诊断、处方），通过 `POST .../recommendations/:kind/actions/generate` 入持久 outbox 异步执行，不直接创建任何正式临床资源。建议输入仅限授权公开病例、完整问诊与 12 字段病历正文、已签发报告、可见既往史（含符合白名单的本院已出院住院摘要）、当前院内目录及已核验指南原文，严禁读取 `Case Truth`、私有 `Persona`、影像／切片像素或 DSH 会话原始记录；输入指纹按结构化字段精确比对临床内容，纯草稿版本号或保存时间变化不打断在途任务或重开建议。

执行计划分为历史筛选、目录筛选、候选生成与独立核验四个稳定阶段并持久保存已完成私有步骤：

- **可观察请求硬上限与未知恢复**：同一阶段批次含首次最多发起 3 次真实模型请求，单次 `generation` 跨全部批次累计最多允许 4 次额外请求（限流重发、格式修复、自动恢复与人工继续共享派发前原子预占计数）；已派发但超时、断流或重启结果未明的请求记为 `MODEL_OUTCOME_UNKNOWN` 并保留已耗额度、禁止自动重发；医生可通过 `continueGeneration`（`refresh:false`）沿原模型与剩余额度续跑未完成步骤，或通过 `refresh:true` 开启新 `generation`（见[模型执行恢复](storage.md#模型执行恢复)与[模型请求控制与恢复决策](../decisions/implemented/architecture/2026-10-21-model-request-control-recovery.md)）。
- **UTF-8 字节分批打包与收敛**：必读本次资料与安全信息始终完整保留，其余既往史在溢出时按单包 12 KiB（单次桥接信封上限 256 KiB）无损拆分筛选（相同筛选哈希跨类别持久复用）；当必读与已选历史合入生成请求超限时，触发 `history-consolidation` 收敛轮按容量保留关键记录（容量为 0 则仅保留必读资料并附通知），若必读资料本身超限则明确返回 `missing-evidence` 而绝不截断证据原文。
- **独立核验与思路降级**：可采纳候选 `items` 先锁定真实目录编码，再经独立请求逐项复核指南条款支持、病例事实支持、适用性与限定语（处方额外核对本院药品实际规格、允许给药途径 `allowedRouteCodes` 与各字段依据，无明确依据的剂量、频次、途径、疗程或数量保持 `null` 待医生补全）；非处方候选若仅缺指南条款支持而病例与适用性核验成立，自动降级为只读待核实思路 `considerations`（无采纳入口，候选与思路合计最多 8 项；处方建议绝不输出无指南思路）。取舍见[门诊指南诊疗建议决策](../decisions/implemented/architecture/2026-10-13-doctor-guideline-recommendations.md)。

### 住院只读指南参考意见

住院只读指南参考意见（`InpatientGuidelineAdvice`）解耦对单一手术申请单的强绑定，按 `Workspace`、`Epoch`、住院、专题 `topicId`、可选手术申请 `requestId` 与意图版本保存固定患者资料、专题原文与核验结论：

- **绑定 PCI 手术计划路径（`topicId = 'pci-stent'` 且 `requestId` 非空）**：保存有效 PCI 手术申请时原子留下自动准备意图，优先采用正式造影报告带入的测量参数；一旦手术开始、完成或取消即停止准备。
- **无手术单内科住院路径（`requestId = null`）**：不依赖手术申请单，主管医生可在围术期水化、血运重建指征评估（如多支冠脉造影提示临界狭窄但 `FFR > 0.80` 拟行药物保守治疗而不申请 PCI）、出院双抗二级预防或合并糖肾用药阶段，按选定 `topicId` 显式调用 `inpatient.guideline-advice.request`；在院期间诊断、医嘱、确定性评分、造影报告或指南来源变化使旧指纹自动失效，进入待出院、已出区或归档后转为历史只读。

儿科或 `all-only` 患者请求成人专题时在派发前以 `population-mismatch` 直接拦截并返回 `no-evidence`（零模型调用）。缺少客观测量或报告时允许输出 `conditional` 条件性参考，但严禁将患者适用性表述为已确认，也绝不产出具体耗材产品、规格、默认数量、医嘱、预留或收费；结论经生成与独立核验一致通过后带逐字原句、页码定位、推荐强度与例外条件发布，一旦底层指南来源撤回或失效立即隐藏旧意见与引文（幂等回执重放也不恢复正文）。

## 双层事中临床质控与受审计 Clinical Override

### 四大责任关口与红线／警示双层规则

门诊与住院在四个关键临床写操作关口共用一套基于正式临床事实与确定性 `ckd-epi-2021-egfr` 算子的零模型事中临床质控纯引擎，并通过 `encounter.clinical-quality.read` 与 `inpatient.clinical-quality.read` 暴露无副作用只读预检：

1. **门诊处方与住院医嘱签发关口**（`encounter.issue-prescription`、门诊处方准备确认、`inpatient.order.issue`）：联合声明式药事安全规则与近期客观肾功能记录，区分绝对用药红线与缺血肌酐／抗菌药指征条件警示（既有药事拒绝同步附带 `error.clinicalQuality` 阻断摘要）。
2. **门诊完诊关口**（`encounter.complete`）：核对急性胸痛主诉或诊断病例是否已完成已签发 12 导联心电图及心肌损伤标志物评估（`CHEST_PAIN_WORKUP_INCOMPLETE`）。
3. **冠脉介入计划与选型确认关口**（PCI 术式 `inpatient.surgery.request`、同台造影转 PCI `inpatient.surgery.convert-to-pci`、`inpatient.pci-selection.confirm`）：核对最新已签发冠脉造影报告是否存在功能学非缺血临界病变（`FFR > 0.80`）仍拟行 PCI 介入（`PCI_NON_ISCHEMIC_LESION`）；造影前已先开立 PCI 申请并由造影报告自动生成选型草稿时，耗材清单整批确认前必须先经 `inpatient.pci-selection.confirm` 完成质控核对或越权登记。
4. **住院出院医嘱与离院后病案提交关口**（`inpatient.discharge.issue`、离院后 `inpatient.record.submit`）：对冠心病或本次住院已实施 PCI 病例，按出院医嘱截止时点核对是否已开立长期抗血小板（`DISCHARGE_ANTIPLATELET_MISSING`）与他汀类（`DISCHARGE_STATIN_MISSING`）二级预防医嘱（停嘱时点追溯同时覆盖 `inpatient.order.request-stop` 以及 `stop-on-completion` 手术终结的 `inpatient.surgery.complete` / `inpatient.surgery.execute` / `inpatient.surgery.finalize-standby` 审计事件；在院期间仅保存主操作预分组快照不触发出院质控；出院医嘱与离院首页提交各自独立校验并留存越权记录）。

两层质控规则实行严格的越权边界隔离：

- **第一层药事与生理安全红线（`CLINICAL_QUALITY_RED_LINE`）**：包含已证实 `ckd-epi-2021-egfr < 30` 拟开立二甲双胍或达格列净（`RENAL_CONTRAINDICATED_MEDICATION`）、明确有效药物过敏冲突（`MEDICATION_ALLERGY_CONFLICT`）、超出单次或单日剂量极量（`MEDICATION_DOSE_LIMIT_EXCEEDED`）以及互斥药理类别重复叠加（`MEDICATION_CLASS_DUPLICATION`）。命中第一层红线时，即使请求附带 `clinicalOverride` 也一律以 `409` 硬性拒绝，不写入任何正式事实。
- **第二层临床路径与指南偏离警示（`CLINICAL_QUALITY_ALERT`）**：包含开立双胍／SGLT2i／MRA 时缺少近期血肌酐记录（`RENAL_CREATININE_MISSING`，与上述已证实 `eGFR < 30` 硬红线严格区分）、单纯病毒性呼吸道感染无细菌指征开立抗菌药（`ANTIBIOTIC_WITHOUT_BACTERIAL_INDICATION`）以及上述第 2–4 关口路径偏离。未附有效越权声明时返回结构化 `409` 警示；负责医生或经授权 Agent 使用新幂等键提交覆盖当前全部触发警示编码的受控 `reasonCode`（禁忌／高出血风险、外院或床旁结果已核实、已同步开单并安排随访、患者知情拒绝、专科个体化判断、急危重症优先处置）与医学说明 `note` 后，共享 Command 在同一 SQLite 事务内原子提交业务事实、`clinical_quality_override` 记录、回执 `clinicalQuality` 摘要、`AuditEvent` 详情与 `Action Trace` 的 `ClinicalQualityOverride/<id>` 引用（门诊 DSH 提案支持在确认条内遇到 `409` 警示时原位补填越权说明，无需二次消耗提案审批门禁）。分层架构见[双层事中临床质控决策](../decisions/implemented/architecture/2026-11-18-two-tier-clinical-quality-gates.md)。

### 与门诊病历完备性质控的职责边界

双层事中临床质控引擎与[门诊病历完备性质控](outpatient-workflows.md#页头主诉投影与病历完备性质控)职责正交、互不替代：前者是运行在共享写 Command 事务内的零模型确定性规则门禁，针对正式医嘱、完诊、介入手术与出院四个不可逆临床责任节点执行硬性安全阻断与受审计越权留痕；后者是经 outbox 异步执行的模型辅助文书审校，针对 12 字段病历草稿检查模板漏项、问诊前后矛盾与自动整理引用归属，仅提供纯提示定位与直接正文编辑引导，不阻断病历签署、也不要求填写越权理由。

## 临床事实总账与可插拔专病包底座

### 只读按需的临床事实总账与受审计核实

门诊（`doctor.case.clinical-fact-ledger.read`）与住院（`inpatient.clinical-fact-ledger.read`）共用只读、按需生成的 `Clinical Fact Ledger` 引擎（`@clinmesh/contracts/clinical-fact-ledger` 与 `@clinmesh/core/clinical-fact-ledger`），不另外落库复制正本，统一通过三套来源规则将本院 FHIR R5 正式资源（含完整批次且认人通过的院内多源接入结果，保留各来源 `sourceSystemId`）、`Visible Source History` 与 `Clinical Risk Assessment` 誊写为覆盖八类临床数据的 14 字段标准化事实（排除草稿、未签发报告、病历全文与 `Case Truth`）。总账严格保持方法隔离（例如高敏肌钙蛋白 I、常规肌钙蛋白 I 与肌钙蛋白 T 独立成账）、支持任意 `asOf` 截止时点无回漏重现（仅纳入当时已入库且未作废版本，报告更正时精确保留旧时点视图）及公共层默认有效期校验；并在誊写期标出三类确定性拦截标记——`suspicious`（非白名单单位、超生理范围、报告早于开单、性别常识矛盾）、`conflict`（同标本同项目矛盾结果双双保留）与 `external-unverified`（外院历史默认待核实）。任一标记事实及过期事实默认标记 `eligibleForScoringAndRedLine: false`，不参与临床评分与药事/肾功能红线判定，直至责任医生通过受审计写命令（`doctor.case.clinical-fact-verification.record` / `inpatient.clinical-fact-verification.record`，落库 `clinical_fact_verification` 并写入 `AuditEvent` 与 `Action Trace`）正式核实并放行至同一截止时点之后（取舍见[临床事实总账与院内本地接入决策](../decisions/implemented/architecture/2026-11-24-clinical-fact-ledger-and-local-ingestion.md)）。

### 纯数据专病包格式、三层叠覆与受控运行时

平台合同（`@clinmesh/contracts/guideline-topics`、`@clinmesh/contracts/order-set-templates` 与 `@clinmesh/contracts/inpatient-guideline-advice`）已解除专题、科室与组套 ID 的封闭枚举耦合，改由纯数据文件夹形式的 `Disease Pack`（支持 `full` 与 `recognition` 两种类型，`@clinmesh/contracts/disease-pack` 与 `@clinmesh/core/disease-pack`）及运行期注册表校验已注册条目（未注册标识返回 `404`）。包加载器在入库前强制校验数据指纹、拦截任何可执行代码片段（`PACK_CODE_FORBIDDEN`）并核对版本化平台公式库引用（`PACK_FORMULA_VERSION_NOT_FOUND`）；公共层、病种包与医院适配层按“本地化映射与模板可替换、安全类条款（红线、禁止动作、有效期上限、触发条件与考卷门槛）只准收紧不准放宽”的规则合并三层配置，试图削弱安全限制时立即拒绝加载并指明越界字段（`HOSPITAL_OVERLAY_SAFETY_RELAXATION_FORBIDDEN`）。

专病包运行时（`DiseasePackRuntimeService`）基于 `Clinical Fact Ledger` 自动求值跨时间、跨就诊结构化触发条件（显式指定比较时间戳字段）与诊疗阶段切换（阶段变化自动审计），并合并医生通过受审计 Command 提交的手动启停覆写；同时提供按任务声明过滤最小必要字段的只读任务视图（仅返回当前任务声明的关键项与次要项，隐藏无关护理与费用明细）、三档就绪门禁（`ready` / `missing-secondary` / `missing-critical`，其中被标为可疑、冲突或未核实的外院事实按缺项处理，缺关键项时直接拒绝 `PCI 术前指南参考意见` 等任务起草，仅缺次要项时允许带缺项批注起草）以及挂载在业务与 DSH 工具入口上的包工具白名单与禁止动作网关（越权调用返回 `403` 并记录 `AuditEvent`；详细取舍见[专病包格式、三层叠覆与受控运行时决策](../decisions/implemented/architecture/2026-11-24-disease-pack-format-and-runtime.md)）。

### 概念词表映射门禁、知识主张发布与离线知识治理

平台以本院目录项、平台概念与国家/国际标准三层受控词表（`@clinmesh/contracts/concept-vocabulary` 与 `@clinmesh/core/concept-vocabulary`）统一药物与检验概念语义（既有药理分类已迁移为受控词表节点并保留兼容导出；医院适配层可通过 `HospitalOverlay.conceptVocabulary` 挂载仅限叶节点的本院扩展词表并与公共层、病种包层共同完成三层确定性合并），显式声明 SKOS 四类映射关系（`exact`、`close`、`broader`、`narrower`）与四态复核生命周期（`proposed`、`reviewed`、`approved`、`deprecated`）。临床评分与第一层药事/肾功能安全红线仅放行 `approved + exact` 映射，`close`、`broader`、`narrower` 或未完成批准与已弃用映射一律给出结构化拒绝原因码，仅在检索召回场景使用已批准同义扩展；词表结构通过全平台只读入口 `catalog.concept-vocabulary.read` 对外查询（支持按 `hospitalId` 过滤叠加本院适配层词表）。

专病知识采用“专题导航 + 原子知识主张”双层结构（`@clinmesh/contracts/knowledge-claims` 与 `@clinmesh/core/knowledge-claims`），绑定结构化适用条件、概念编码与带来源 `sha256` 及页码定位的逐字引文锚点，并以九状态发布状态机（`imported` -> `draft` -> `concept-mapped` -> `auto-verified` -> `clinician-reviewed` -> `published`，以及 `rejected`、`superseded`、`retracted`）与不可变 `KnowledgeSnapshot` 版本快照管理生命周期：推进至 `clinician-reviewed` 或 `published` 强制核验已登记执业医生审核记录，自动校对态 `auto-verified` 仅以 `试用版` 展示并强制携带 `未经医生检查，仅用于仿真` 免责声明；门诊与住院只读操作（`doctor.case.disease-pack-knowledge.read` 与 `inpatient.disease-pack-knowledge.read`）支持按任意 `asOf` 截止时间重放历史生效快照及对比最新版差异，一旦底层指南来源撤回、段落失配或哈希变化，关联引文与主张立即判定为失活（`anchorValid: false`、`active: false`）并附带停用原因，不篡改既有快照历史。

离线知识治理流水线（`@clinmesh/contracts/knowledge-pipeline` 与 `@clinmesh/core/knowledge-pipeline`）限定以受控确定性模型流起草候选主张，并由结构化校验器强制执行五类拒收门禁（缺原文锚点 `CLAIM_ANCHOR_MISSING`、来源或哈希不匹配 `CLAIM_SOURCE_UNVERIFIED`、逐字引文失配 `CLAIM_QUOTE_MISMATCH`、超出锚点范围的未证实数值阈值或规格细节 `CLAIM_UNSUPPORTED_DETAIL`、未纳入受控词表的概念编码 `CLAIM_CONCEPT_UNMAPPED`）。合成测试指南必须明确标记 `SYNTHETIC_TEST_GUIDELINE_NOT_CLINICAL` 与不冒充真实临床指南声明；指南版本升级仅生成受影响专题、主张、规则与考题差异报告并将冲突推入专家仲裁队列，绝不自动改写既有已发布主张；映射降级时输出受影响包规则与主张评估报告，指南全文检索自动通过已批准精确同义词扩展召回，全平台临床运行时保持零在线写知识 Agent 工具或 CLI 命令（详细取舍见[概念词表、知识主张与离线治理流水线决策](../decisions/implemented/architecture/2026-11-25-concept-vocabulary-and-knowledge-claims.md)）。

### Agent 输出双轨评测、捏造单列与医生修改统计

针对 Agent 起草文书与临床建议的质量评测（`@clinmesh/contracts/agent-output-scorer` 与 `@clinmesh/core/agent-output-scorer`），平台基于指定 `asOf` 的患者 `Clinical Fact Ledger`（仅采信通过有效性及确定性核查放行 `eligibleForScoringAndRedLine: true` 的正式事实）与版本化专病任务评分量表执行正分命中与条件必答漏报双轨计分，并将三类临床捏造事实（引用总账中不存在的检验检查 `NONEXISTENT_LAB_OR_EXAM`、与总账正式数值或单位矛盾 `CONTRADICTORY_VALUE`、将未核实外院记录或高风险待确认事实当作已证实结论引用 `UNVERIFIED_EXTERNAL_USED_AS_FACT`）独立列于 `fabrications[]` 明细而不混入普通覆盖项；同时按字符级最长公共子序列统计医生最终定稿相对 Agent 草稿的逐字段 `addedChars`、`removedChars`、`editRatio` 及增删改汇总指标。

评测结果默认保持 `Agent 输出未评测` 状态徽标，受控流仿真评测强制携带仿真口径免责声明并确保零实时模型调用；任何请求以 `live-model` 模式运行评测却未提供绑定当次运行且明确授予许可凭证的请求，一律以 `403 LIVE_MODEL_SCORING_PERMISSION_REQUIRED` 硬性拒绝且不调用真实模型，离线与仿真评测接口归入受控排除路由列表而不暴露为在线临床 Agent Grant（详细取舍见[Agent 输出双轨评测与医生修改统计决策](../decisions/implemented/architecture/2026-11-25-agent-output-scorer.md)）。
