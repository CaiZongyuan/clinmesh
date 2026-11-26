# 仿真、病例与素材

本文拥有 Workspace/Epoch、虚拟时钟、合成病例、隐藏事实、重放及影像与病理素材的隔离和冻结规则。系统总入口见[系统架构](../architecture.md)，业务验证要求见[测试策略](../testing.md)。

## 仿真架构

<a id="101-workspace-隔离"></a>

### Workspace 隔离

每次人类演示或 Agent 任务运行使用一个 Scenario Run，并在 Workspace 内以不可复用的 Epoch 标识具体数据世代。所有运行资源、索引、领域表、session/Grant context、Command、outbox、callback 和 Action Trace 都绑定 `workspace_id + epoch`；审计保留域独立，不随 reset 删除。生成任务、Synthetic Patient Profile/Revision、Synthetic Case Instance、Persona Revision、来源 R4 artifact 和冻结的 Investigation Result Snapshot 是 Workspace 级不可变资产，故意跨 Epoch 存续。直接开始或管理员 reset/replay 才把同一 Case Revision 物化为新 Epoch 的本院 Patient 与对应门诊或住院运行资源；Visible Source History 保持来源投影，不进入本院 R5 store。

首期所有 Workspace 共用一个 SQLite 文件并按行隔离。数据库文件不是 Workspace 边界，任何运行查询和约束都必须显式携带 `workspace_id + epoch`：

- workspace/epoch 由认证上下文注入 repository，业务调用者不能选择；`X-Workspace-Id` 最多作为必须与 token 一致的断言，不能用于切换上下文。
- 每次请求重验 active epoch、membership、delegation grant 和 policy version，不能只信 token 中可能陈旧的角色或地点声明。
- 运行事实的表、唯一键、外键、索引和 SQL 都包含 Workspace/Epoch，由 schema/query lint 拒绝缺少隔离键的租户运行关系和查询；Search total、cursor、history、outbox lease、Action Trace 和 FHIR 引用解析同样拒绝跨 workspace/epoch 访问。

<a id="102-虚拟时钟"></a>

### 虚拟时钟

每个 Scenario Epoch 在 `scenario_epoch_state` 保存 `virtual_time` 与 `clock_revision`。业务发生时间从当前 Epoch 的 `virtual_time` 读取；`meta.lastUpdated`、token 过期、outbox lease、审计接收时间和系统性能指标仍使用真实提交时间。

管理员在场景数据入口通过 `POST /api/sim/v1/scenario-runs/:scenarioRunId/actions/advance-time` 提交预期当前时间、目标时间和幂等键手动推进时钟；医院岗位和医院 Agent Grant 不拥有该入口。时钟只能前进，单次跨度最多 366 天，超限返回 `VIRTUAL_TIME_ADVANCE_LIMIT` 且不改变时钟或费用，更远日期须分段推进；成功前进递增真实 `clock_revision`，同一时刻重推不递增也不产生费用。

跨越每个 `Asia/Shanghai` 午夜时，在同一 Command 事务为当前在院且占床的住院记录一笔床日费（归属当前科室，按住院与业务日期去重，带偏移时间与 UTC 按真实时刻比较），并按本院虚拟班次展开已校对且有效的长期医嘱任务（按医嘱与时点去重，PRN 和实际给药不自动执行，首日及停嘱规则见[处方、医嘱与药事](orders-and-pharmacy.md)）。未推进、同日推进或幂等重试不产生额外费用，任一收费或审计写入失败均回滚整笔推进。

<a id="103-场景定义"></a>

### 场景定义

**固定 PCI 病例准备。** 管理员通过 `POST /api/sim/v1/synthetic-cases/pci/prepare` 按预期 Epoch 幂等准备固定 PCI 黄金病例（来源标识 `clinmesh-authored`，当前身份 `clinmesh-inpatient-pci-case-source@2026-11-02.r1`，Case Truth 含九项基线 Observation 与三项造影所见）。首次准备在同一共享 Command 事务建立来源、不可变 Profile／Case 与确定性模板 Persona（`model: "clinmesh-authored-template"`，只陈述患者可知症状、既往史与用药记忆，不调用模型），返回 `brief-ready`、`activeBriefRevision=1`、`revision=2`。重复准备保留已有有效选用、人工修订及消费绑定；历史待准备病例若仍有运行中档案任务则返回 `409 PCI_SOURCE_PERSONA_RUNNING`（等待原任务结束后以原输入和幂等键恢复），仅有排队任务时在同一事务将其置为 `failed`（`PERSONA_JOB_SUPERSEDED`）并写入审计 Effect 后完成选用；已有有效选用病例若仍有排队或运行中任务同样返回该 `409`。来源哈希参与 Profile 身份，新增所见形成新病例而不改写旧 Profile Revision、旧 Case Truth 或已开始住院的来源绑定，旧病例缺少所见时报告明确无法生成。

**通用多病例 Authored Case Pack。** 管理员在“模拟数据 → PCI 演示准备”或通过 `hisOperationCatalog` 操作 `admin.authored-case-pack.read`（`GET /api/sim/v1/synthetic-cases/authored-pack`，CLI `clinmesh admin authored-case-pack get`）与 `admin.authored-case-pack.prepare`（`POST /api/sim/v1/synthetic-cases/authored-pack/prepare`，CLI `clinmesh admin authored-case-pack prepare`，持久操作名 `synthetic-case.authored-pack.prepare`）按预期 Epoch 原子幂等准备默认五例心血管与慢病专病合成病例。重复准备保留已有有效选用与就诊绑定；存在运行中 Persona 任务时返回 `409 AUTHORED_CASE_PACK_PERSONA_RUNNING`，仅有排队任务时标记 `PERSONA_JOB_SUPERSEDED` 后完成选用；清空患者库重置后再次准备会恢复已归档 Profile 并递增 Profile Revision 形成新的 `brief-ready` 实例。编译器统一支持男女人口学、零枚或多枚支架计划、无造影纯门诊慢病病例、定制 `Visible Source History`，以及分阶段检验（WS/T 886-2026 与 LOINC 双编码）、功能检查（`ECG`／`TTE` 结构化指标与精确结论）和多支冠脉造影（含可选 FFR/iFR 与 QCA）私有 `Case Truth`，并在编译期校验模板 Persona 零隐藏疾病泄漏，取舍见[通用多病例 Authored Case Pack 编译器决策](../decisions/implemented/architecture/2026-11-19-authored-case-pack-compiler.md)与[同源专病临床内核与像素暂缓边界](../decisions/implemented/architecture/2026-11-19-shared-specialist-clinical-kernel-and-pixel-deferral.md)。

**专病平台冻结黄金病例与第二模拟来源接入。** 在五例专病病例基础上，`GET/POST /api/sim/v1/synthetic-cases/golden-pack` 额外提供低危胸壁痛、家族性高胆固醇血症跨时间线索、上腹痛伴 2 型糖尿病排雷、外院未核实肌酐与妊娠期胸痛五例冻结 `Golden Case`（合计十例），统一以“ClinMesh 临床仿真医院”与“ClinMesh 仿真制药…厂”命名；对全部 `clinmesh-authored` 病例，一旦开立 `Case Truth` 未预置的检验项目或功能检查，系统严格返回 `INVESTIGATION_UNSUPPORTED`（展示为“本病例未预置该检查”），绝不回退至 `Adult Reference Baseline` 或调用模型补造。离线机考门禁（含测试夹具中的完整结构假病种包 `synthetic-test-syndrome-pack` 与七类公共陷阱题）只检验确定性机器通路而不将主观 Agent 评分纳入启用关卡，并保持 `Case Truth` 零临床泄漏。此外，`POST /api/sim/v1/local-ingestion/batches` 支持将院内第二个模拟来源系统（`clinmesh-sim-lis-v2`）的检验批次按标准化 L0 契约归一为带 `Provenance` 的 FHIR R5 `Observation`，并强制执行批次完整性与跨系统认人门槛：未到齐批次标为 `incomplete` 且绝不进入总账或评分；同名不同出生日期患者永不合并，系统标识不同但存在属性差异的候选人进入 `identity-quarantine` 隔离区，经 `administrator`/`registrar` 通过受审计 Command 确认合并后才可见（决策见[临床事实总账与院内本地接入决策](../decisions/implemented/architecture/2026-11-24-clinical-fact-ledger-and-local-ingestion.md)）。

**直接入院与持久写意图。** 病例准备不产生本院正式诊断、检查报告、医嘱、手术或费用；药耗目录与库存由独立 PCI 目录准备命令维护。登记员通过 `POST /api/his/v1/synthetic-cases/:caseId/actions/start-inpatient-visit` 提交病例／Persona 版本、当前 Epoch 与接收病区，原子创建患者及零预交金直接住院登记（不建门诊挂号或挂号费）。目录／来源准备、手工 Persona 创建／选用与直接入院共用受信会话绑定的持久写意图：响应不明时先查原 Command 回执，未找到才原键重发；未确认期间禁止覆盖输入或跨账号、岗位、病例、Epoch 串发旧意图；来源关系通过入院回执、Patient 来源扩展及管理员查询回查，普通登记和临床页不读取 Case Truth。

**Synthea 动态生成与定向病例。** 固定 commit 的 Synthea Provider 支持全模块或有界模块过滤、人数、年龄、性别、时间范围与双 seed，也可选择已发布的放射或病理适配条目做定向生成：Server 从条目推导保留条件（须存在／不存在的疾病与操作编码，病理另有五项 Observation 编码值；病理历史跨度不足 `matching.json` 要求年数时在调用前以 `TARGET_HISTORY_TOO_SHORT` 失败），Synthea 限时 4 分钟筛选存活患者，Server 再用病例准备的同一匹配规则复核（每位患者最多十次尝试，全部未命中以 `IMAGING_TARGET_NOT_MET` 失败）；生成成功后随即运行目标素材包准备，准备失败仅在成功任务记录 `IMAGING_PREPARATION_FAILED` 或 `PATHOLOGY_PREPARATION_FAILED` 警告而不回滚患者。系统确定性选择最后一个含临床资源或明确 reason 的 Encounter（跳过纯行政、账单和单纯疫苗 Encounter）作为 Index Encounter，无合格 Encounter 时整体失败不留半成品。Index Encounter 之前的闭包构成按时间排序的 Visible Source History（临床岗位分页可读摘要与经可见性检查的原始 R4 详情），Index Encounter 与当次 episode 关联资源构成私有 Case Truth，病例类型推断为 `new-problem`、`follow-up` 或 `preventive`；缺译保留来源英文并保存有界 translation warning，FHIR 结构、引用、catalog hash 或 provenance 无效仍失败关闭。

**Patient Persona、模型绑定与隐藏诊断出口检查。** 一般动态病例由管理员显式请求异步 Persona，通过严格 schema 与隐藏诊断泄漏检查后保存为不可变修订（失败不覆盖既有成功修订；管理员手工编辑命中泄漏检查时返回警告，显式强制保存才接受），选定有效修订后病例才能开始，已开始病例的绑定保持不变。DSH“设置 → 通用 → ClinMesh 模型”按 Profile 持久化模型选择（运行配置见[部署指南](../deployment.md#4-配置-ai-provider患者档案必需)）：Persona 与目录任务入队前固定模型，问诊和需模型的检验在首次实际生成时固定于 `ai_model_binding`，结构化修复、自动重试与重启恢复沿用该绑定；新的问诊人工重试按 Actor 与幂等键建立独立尝试，新的检验人工重试将申请版本作为尝试号写入 outbox，开始生成时读取当前模型选择；问诊模型输入不带医生 Session 的 transcript、系统提示或 Tools，取舍见[DSH 业务 Agent 装配与模型绑定决策](../decisions/implemented/architecture/2026-10-07-dsh-business-agent-harness.md)。Persona 生成、人工编辑与问诊出口共用基于可见既往 `Condition` 的文字检查：完整已知病名子串及明确命名 1/2 型糖尿病既往并发症的基础病名豁免（仅忽略病名内横向空白，保留标点与换行，不跨括号或破折号拼词），其余新增未知诊断、未知子型或编码一律拦截，见[已知病史与隐藏诊断的文字边界](../decisions/implemented/bug-fix/2026-10-06-persona-known-diagnosis-boundary.md)。

**开始就诊、患者库队列与重置模式。** 开始就诊是带 expected revision 与幂等键的一次性 Command，创建本院 R5 Patient 及门诊（Registration、Encounter、Queue Task、问诊）或直接住院（Encounter/Account）运行状态，不复制来源历史或参考目录。管理员“重置数据”默认保留患者库并在新 Epoch 重放同一 Case Revision（复用 Persona、Case Truth 与成功 Investigation Snapshot，零 Synthea／模型调用）；勾选清空模式则归档当前患者库并退役关联 Case（拒绝运行中生成任务并取消排队任务），两种模式均保留标准目录、已启用检验服务、账号与历史审计。患者库连续开始门诊逐人确认并提供具名下一位：候选须由有界详情确认为 `brief-ready` 且有活动 Persona（不能仅凭列表 `activeVisit=false` 判定），搜索或翻页重置当前选择，迟到生成结果不覆盖在办患者；发送前持久保存原输入、预期修订、完整 Actor 与幂等键，响应不明时在同一身份下先查 `registration.synthetic-case.start` 原回执，明确未找到才原键同体重发（其他账号／岗位／Epoch 的 404 或单凭 Case 已开始均不构成重发或成功依据），见[连续办理私稿与逐项原回执恢复决策](../decisions/implemented/architecture/2026-11-10-clinical-batch-draft-and-receipt-recovery.md)。

<a id="104-确定性与故障注入"></a>

### 确定性与故障注入

- 生成请求固定 Provider commit、localization hash、模块模式、人口参数和 seed；相同来源 Bundle 的 Index Encounter 选择、历史／真值闭包与 case type 保持确定。
- Investigation resolver 先匹配 Case Truth 完全兼容的冻结 coding，并支持隐藏检验与功能检查 `Observation` 通过扩展 `urn:clinmesh:synthetic:truth-stage`（`initial`、`inpatient`、`repeat`、`follow-up` 及无标记兜底）按就诊阶段确定性选值：出院后跨就诊门诊复诊（`outpatient_case_source`）始终优先取 `follow-up`，同次就诊已有同编码终态报告时优先取 `repeat`，住院首次优先 `inpatient -> initial`，门诊首次优先 `initial`；所选阶段与就诊上下文计入 `inputHash` 独立冻结 `Investigation Result Snapshot`，在新 Epoch 重放时精确复用。功能检查同时支持 `urn:clinmesh:examination:ecg`／`tte` 指标与按 `exam-code` 区分的 `urn:clinmesh:examination:conclusion` 精确结论，保留 `clinmesh-authored` 零正常兜底与同阶段冲突拦截。作者来源快照标记 `case-truth-exact`，Synthea 快照标记 `synthea-exact`；缺失时按 Adult Reference Baseline 确定性生成，仅无规则 LOINC 叶子调用受限模型。
- 支付与 LIS 模拟器确定性覆盖 `success`、`declined`、`ambiguous` 及 outbox retryable failure、租约回收与重复消费；当前 replay 是 Case Revision 到新 Epoch 的重新物化，而非 command-log replay。
- 数据库备份的 canonical state hash 覆盖 FHIR current/history 与除派生 Search 索引、迁移和运行时元数据外的全部持久领域表，递归排除 FHIR `lastUpdated`、自引用哈希列以及问诊对话表 `message_text`／回执 `messageText`（轮次顺序、来源、档案版本和审计元数据仍参与计算）；`db:restore` 合并最新按日门诊号高水位后重算的新目标库 hash 允许与旧备份不同，见[数据库运维](storage.md#database-operations)与[部署指南](../deployment.md#生产构建与-nodejs-直跑)。

<a id="105-case-truthpersona-与-action-trace"></a>

### Case Truth、Persona 与 Action Trace

Case Truth 表示普通岗位不能直接读取、只能通过问诊和合规检查发现的隐藏病例事实。管理员在模拟数据患者详情展开默认折叠的“本次病例真值”时才请求 `GET /api/sim/v1/admin/synthetic-cases/:caseId/truth`（校验受信 administrator 会话与 Workspace，返回 `Cache-Control: no-store`，非管理员 403、不存在 404，收起或切换患者立即销毁正文）；该入口不加入 Operation Catalog、CLI、Page Context 或 Agent Tools。Patient Persona、Case Truth 与 Investigation Result Snapshot 均不进入普通 FHIR Search、Visible Source History 或 HIS 查询。

Action Trace 按 Scenario Run 记录 Command 尝试、结果、Effect 引用和资源版本，事件时间使用当前 Epoch Virtual Time（Audit Event 继续保存真实接收时间）；它本身不记录普通读取或模型 chain-of-thought，也不内建自动评分规则或 evaluator service account（面向离线与仿真基准的受控 Agent 输出双轨评测见[临床决策支持与质控](clinical-decision-support.md)）。

<a id="106-重置与-epoch-隔离"></a>

### 重置与 Epoch 隔离

`workspace_epoch` 使用 `building`、`active`、`closing` 和 `closed` 四种状态，没有 purge 入口。直接开始或管理员 reset/replay 协议如下：

1. 普通开始只能消费一次具有活动成功 Persona 的 Case；只有管理员可执行 reset/replay，Command 先在新 Epoch 的 `building` 状态写入本院运行事实。
2. 同一事务把仍为 `active` 的旧 Scenario Run 转为 `closed`（保留已 `completed` Run 的状态与 `completed_at`），关闭旧 Epoch、把旧 queued/claimed outbox 标为 `abandoned`、激活新 Epoch 并切换 `workspace.active_epoch`。
3. 既有浏览器 session 在下次请求重新解析 `workspace.active_epoch` 与当前 Scenario Run 自动进入新世代；旧预览、receipt、cursor 和业务引用因绑定旧 Epoch 自动失效。
4. outbox dispatcher 提交结果前重验 active Epoch，reset 后迟到的旧 claim 转为 `abandoned`，不产生新 Epoch 业务 Effect。

<a id="107-影像素材与病例影像准备"></a>

### 影像素材与病例影像准备

放射检查与乳腺切片病理会诊使用公开数据集中授权、去标识的真实影像作为“只使用合成数据”规则的唯一窄例外：仓库只提交[影像素材清单](../../imaging-assets/README.md)与[病理切片素材清单](../../pathology-assets/README.md)，像素与来源文件只存于本地素材目录（安装、校验、修复与备份命令见[影像部署](../deployment.md#影像素材)、[病理部署](../deployment.md#病理切片素材)及[影像指南](../imaging.md)、[病理指南](../pathology.md)），患者身份、病史和就诊事实仍全部为合成数据。放射与病理各自拥有独立的摄取适配器、清单与素材目录，任一缺失或损坏不影响另一方或 Server 启动（对应服务仅显示未开展）。

- **摄取与核对签署发布**：通用素材存储负责来源哈希与 UID 核对、原子发布和离线修复；放射仅接受未压缩 DICOM 并转码为单块 `<= 2 MiB` 的规范帧数据（超限胸片按固定参数降采样），病理从 TCGA-BRCA 公开切片提取组织金字塔（丢弃缩略图／标签图／宏观图，最高 20 倍、缺失 10 倍自动生成，JPEG 2000 统一转基线 JPEG 并打包单瓦片 `<= 2 MiB` 偏移索引，剥离文件头受试者标识，保存但不应用 ICC profile）。中文报告草稿由模型仅据来源结构化标注或临床字段整理（零像素输入）：放射自动核对病灶数量、侧别、图像序号与大小且阴性素材禁出阳性所见；病理自动核对组织学类型与受体一致、禁写分级／淋巴结判断／无依据分期且拒绝 HER2 矛盾素材。通过自动核对后须由人工在管理员复核预览中签署（绑定素材输出、来源哈希、许可、整理规则、适配条目、标注与报告正文哈希，任一变化签署即失效）方可发布。
- **病例影像与病理准备冻结**：放射准备按就诊开始时刻判定未缓解阳性疾病、适用阴性范围与既往手术冲突（如肺移植、胸骨切开、瓣膜置换、起搏器冲突或未覆盖疾病均不配片；单病例固定单一适配条目使胸片与 CT 同源，多候选按病例来源哈希稳定选取）。病理准备从既往来源病史读取诊断、早于本次就诊的可送检手术及 ER、PR、HER2、淋巴结、肿瘤 T 类别五项最新结果逐项比对：全一致且已安装才可用，相符但未安装记 `ASSET_NOT_INSTALLED`，任一矛盾不可用，组织学类型作为补充事实单独记录，按来源手术为键固定绑定。两类准备结果均为包含签署内容哈希的不可变修订：病例开始前随清单更新，开始后只允许追加新检查，重试与重放绝不更换已固定素材或报告哈希；设计取舍见[胸片与 CT 阅片闭环决策](../decisions/implemented/architecture/2026-10-01-chest-imaging-reading-loop.md)与[病理切片摄取与匹配决策](../decisions/implemented/architecture/2026-10-02-pathology-slide-ingest.md)。
- **私有与只读像素边界**：病例与素材绑定、匹配依据、素材标识、来源 UID 及准备／复核接口仅向管理员开放，绝不进入临床 DTO、FHIR `ImagingStudy`、Page Context、DSH Tools、CLI 或患者模型载荷。阅片路由每次校验 Workspace/Epoch、病例责任或已完诊权限、申请关联及发布状态，以 `application/octet-stream` 与 `Cache-Control: private, no-store` 按固定只读 SQL 语句返回单块 `<= 2 MiB` 的帧块或瓦片（像素文件缺失时描述返回不可用而不改写历史检查事实），不产生 Audit Event 或 Action Trace；standalone Web 与 DSH Surface 共用[阅片器](../frontend-architecture.md#阅片器)，Agent 不读取像素或渲染结果。
