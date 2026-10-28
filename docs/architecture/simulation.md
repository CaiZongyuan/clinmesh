# 仿真、病例与素材

本文拥有 Workspace/Epoch、虚拟时钟、合成病例、隐藏事实、重放及影像与病理素材的隔离和冻结规则。系统总入口见[系统架构](../architecture.md)，业务验证要求见[测试策略](../testing.md)。

## 10. 仿真架构

<a id="101-workspace-隔离"></a>

### 10.1 Workspace 隔离

每次人类演示或 Agent 任务运行使用一个 Scenario Run，并在 Workspace 内以不可复用的 Epoch 标识具体数据世代。所有运行资源、索引、领域表、session/Grant context、Command、outbox、callback 和 Action Trace 都绑定 `workspace_id + epoch`；审计保留域独立，不随 reset 删除。生成任务、Synthetic Patient Profile/Revision、Synthetic Case Instance、Persona Revision、来源 R4 artifact 和冻结的 Investigation Result Snapshot 是 Workspace 级不可变资产，故意跨 Epoch 存续。直接开始或管理员 reset/replay 才把同一 Case Revision 物化为新 Epoch 的本院 Patient 与对应门诊或住院运行资源；Visible Source History 保持来源投影，不进入本院 R5 store。

首期所有 Workspace 共用一个 SQLite 文件并按行隔离。数据库文件不是 Workspace 边界；任何查询和约束都必须显式携带 Workspace/Epoch。

安全要求：

- workspace/epoch 由认证上下文注入 repository，业务调用者不能选择；`X-Workspace-Id` 最多作为必须与 token 一致的断言，不能用于切换上下文。
- 每次请求重验 active epoch、membership、delegation grant 和 policy version，不能只信 token 中可能陈旧的角色/location claims。
- 运行事实的表、唯一键、外键、索引和 SQL 都包含 Workspace/Epoch；schema/query lint 拒绝缺少隔离键的租户运行关系和查询。Workspace 级 Case 资产只使用 Workspace 隔离，开始或 replay 时才创建绑定新 Epoch 的运行事实。
- Search total、include/revinclude、cursor、history、outbox lease、Action Trace 和 FHIR 投影同样执行隔离。
- FHIR Reference 写入解析目标并拒绝跨 workspace/epoch 引用。

### 10.2 虚拟时钟

每个 Scenario Epoch 在 `scenario_epoch_state` 保存：

```text
virtual_time
clock_revision
```

业务发生时间从当前 Epoch 的 `virtual_time` 读取。管理员在场景数据入口通过 `POST /api/sim/v1/scenario-runs/:scenarioRunId/actions/advance-time` 手动推进，提交预期当前时间、目标时间和幂等键；医院岗位和医院 Agent Grant 不拥有该入口。时钟只能前进，单次跨度最多366天，超限返回 `VIRTUAL_TIME_ADVANCE_LIMIT` 且不改变时钟或费用；需要更远的日期时分段推进。成功前进递增真实 `clock_revision`，同一时刻重推不递增，也不产生费用。

跨越每个 Asia/Shanghai 午夜时，在同一 Command 事务为当前在院且占床的住院记录一笔床日费，费用归属当前科室，以住院和业务日期去重。已有带偏移时间与 UTC 表达按真实时刻比较。未推进、同日推进或幂等重试不产生额外床日费；任何收费或审计写入失败均回滚整个推进。同一事务按本院虚拟班次展开已校对且有效的长期医嘱任务，以医嘱与时点去重；PRN和实际给药不自动执行，具体首日及停嘱规则见[住院医嘱](clinical-workflows.md#83-医嘱生命周期)。

真实提交时间仍用于：

- `meta.lastUpdated`
- token 过期
- lease
- 审计接收时间
- 系统性能指标

<a id="103-场景定义"></a>

### 10.3 场景定义

固定 PCI 黄金病例可通过管理员 `POST /api/sim/v1/synthetic-cases/pci/prepare` 按预期 Epoch 幂等准备，返回病例、Profile 身份、来源哈希与资料包版本。首次准备在同一共享 Command 事务建立来源、不可变 Profile／Case 与版本化合成 Persona，并选用首个修订；返回病例为 `brief-ready`，`activeBriefRevision=1`、`revision=2`，可直接交给登记员。Persona 的 `model` 标识为 `clinmesh-authored-template`，只陈述患者可知的症状、既往史与用药记忆，不调用模型。重复准备保留已有有效选用、人工修订及消费绑定；历史待准备病例已有未选用修订时选用最新已有修订，只有尚无 Persona 时才建立模板修订。已开始病例及其绑定不被重新准备改写。

该入口只接收固定来源准备意图，不接收外部 Bundle；来源标识为 `clinmesh-authored` 并保留资料包/底稿出处。Case Truth 仍为私有内容，九项基线 Observation 不等于本院已完成检验；准备不产生本院正式诊断、检查报告、医嘱、实际手术、耗材使用或费用。目录与库存仍由独立 PCI 资料准备命令拥有。登记员通过 `POST /api/his/v1/synthetic-cases/:caseId/actions/start-inpatient-visit` 提交本次返回的病例／Persona 版本、当前 Epoch 与病区，原子创建患者及直接住院登记；预交金为零，不创建门诊挂号、排队或挂号费，后续由护士接诊并按实际住院流程检查、诊疗与结算。门诊和住院共用病例一次消费校验与单一来源实体化；来源取舍见[固定 PCI 来源决策](../decisions/implemented/architecture/2026-10-26-authored-pci-inpatient-source.md)，首个 Persona 就绪取舍见[固定 PCI 档案就绪决策](../decisions/implemented/architecture/2026-10-28-fixed-pci-persona-readiness.md)。

页面入口为管理员的“模拟数据 → PCI 演示准备”：分别准备 PCI 目录与固定病例，病例准备后选中对应 Profile，并显示已选用的 Persona；无需填写九字段或另行选用首个修订，后续仍可按原入口编辑为新修订。登记员在“住院登记 → 直接入院 → 患者来源：就绪合成病例”选择同一病例与接收病区，页面只读取安全就绪摘要，并显示 Profile／Persona 修订；无就绪病例时回到管理员准备。该路径不收预交金，资金在既有独立流程办理；护士在原住院工作台接诊分床。一般动态病例继续使用原生成、修订和选择入口。

目录／来源准备与直接入院共用受信会话绑定的持久写意图；响应丢失时先查询原 Command 回执，未找到才用原幂等键与原输入重发。手工 Persona 创建与选择同样保存原意图，恢复时重放原 Command 取得幂等回执。未确认期间禁止覆盖输入或发起新意图，确定版本冲突后刷新资料并重新选择；切换账号、岗位、病例或 Epoch 不会把旧意图发送到新上下文。来源关系通过入院回执、Patient 的来源扩展以及管理员病例／Profile／Persona 查询回查，普通登记和临床页面不读取 Case Truth。

固定 commit 的 Synthea Provider 默认运行全部模块，也可接受有界模块过滤、人数、年龄、性别、时间范围和 seed。Web 每次打开生成抽屉时随机提供双 seed，管理员仍可手动修改以复现。管理员也可以选择一个已发布的放射影像适配条目或病理适配条目作为定向目标：Server 从条目推导保留条件（须存在的疾病或操作编码、须不存在的疾病与操作编码；病理条目另有五项 Observation 须取的编码值），Provider 据此生成 Synthea keep module 并只保留存活患者，Synthea 在限时 4 分钟内不限次数地尝试，未找到时按未满足保留条件返回；病理条目还要求历史起始日期不晚于结束日期前 `matching.json` 规定的年数，否则在调用 Provider 前以 `TARGET_HISTORY_TOO_SHORT` 失败；Server 再用对应病例准备的同一匹配规则复核每位患者，不满足时计入下述重试，全部未命中时以 `IMAGING_TARGET_NOT_MET` 失败。保留条件只提高命中率，是否满足条目只由匹配规则判定；定向任务成功后随即对新病例运行目标所属素材包的病例准备，准备失败不回滚患者，而是在成功的任务上记录 `IMAGING_PREPARATION_FAILED` 或 `PATHOLOGY_PREPARATION_FAILED` 警告，管理员据此重新准备。Provider 不支持定向生成时提交被拒绝。每个患者最多尝试十次；系统确定性选择最后一个包含临床资源或明确 reason 的 Encounter，跳过纯行政、账单和单纯疫苗 Encounter。没有合格 Encounter 时本次患者生成失败且不留下部分 Profile 或 Case。

一次成功生成原子保存不可变 Synthetic Patient Profile Revision、本地化 R4 Bundle 和 Synthetic Case Instance。固定 catalog 未命中的 clinical display 保留来源英文，并把有界 translation warning 与 Profile 一起保存供管理员校对；缺译不阻塞患者，FHIR 结构、引用、身份、catalog hash 或 provenance 无效仍阻塞。Index Encounter 之前的闭包构成按临床时间排序的 Visible Source History；授权临床岗位可以分页查看摘要和经过可见性检查的原始 R4 详情。Index Encounter 与当前 episode 的关联资源构成 Case Truth，保存在私有边界，不进入普通 HIS/FHIR/history/tool 响应。Case 类型由来源时间线推断为 new-problem、follow-up 或 preventive。

一般动态病例由管理员显式请求异步 Patient Persona。模型来源在 Server 启动时固定：standalone 默认使用 OpenAI-compatible transport，DSH 模式通过宿主受限 loopback 桥接复用 Provider 与凭据。业务服务使用固定版本 prompt 与严格 schema；岗位客户端不能覆盖 URL、模型、header 或生成请求体。成功结果经过结构校验和隐藏诊断泄漏检查后成为不可变 Persona Revision，失败或拒绝不会覆盖既有成功 revision。Case 必须选择一个成功 Persona Revision 才能开始。管理员可编辑为新修订；同一诊断泄漏检查命中时返回警告，明确强制保存才接受。已开始病例的绑定修订保持不变。

DSH 通用设置提供独立“ClinMesh 模型”，默认解析 DSH 默认模型，也可选择完整 Provider／model；配置按 Profile 持久化，不跟随右侧 Session。患者档案、问诊、需要模型的检验和显式 LOINC 目录补全共用该选择。Persona 与目录任务在入队前固定模型，问诊和检验在首次实际生成时固定；`ai_model_binding` 保存第一次成功解析的路由，执行中请求、结构化输出修复、后台自动重试与重启恢复沿用该值。新的问诊人工重试按 Actor 和幂等键建立独立尝试，新的检验人工重试把申请版本作为尝试编号持久化到 outbox，两者开始生成时读取当前选择；同一重试意图的传输重发复用本次绑定。已完成回复和报告快照保持不可变，确定性、精确事实和快照复用不增加调用。问诊保留模型失败的安全错误码，原始 Provider 消息不回传或写入日志；模型输入不带医生 Session 的 transcript、系统提示或 Tools，结果来源包含 Provider 和 model。取舍见 [模型绑定决策](../decisions/implemented/architecture/2026-10-07-clinmesh-dsh-model-binding.md)与[人工重试模型决策](../decisions/implemented/bug-fix/2026-10-07-generation-retry-current-model.md)，运行配置见 [部署指南](../deployment.md#4-配置-ai-provider患者档案必需)。

生成、人工编辑与问诊出口共用以可见既往 Condition 为依据的诊断文字检查。完整已知病名中的子串不视为新增诊断；明确命名 1/2 型糖尿病的既往并发症记录允许陈述该基础疾病。豁免匹配仅忽略病名内的横向空白，保留全部标点和换行，不把括号、破折号等分隔的短语拼成已知病名；来源病名自身的标点允许原样匹配。其他位置新增的未知诊断、未知子型或编码仍被拦截，不根据检查、药物或前期病变推断已知确诊。边界取舍见[已知病史与隐藏诊断的文字边界](../decisions/implemented/bug-fix/2026-10-06-persona-known-diagnosis-boundary.md)。

开始是带 expected revision 和幂等键的一次性 Command，创建本院 R5 Patient 和相应运行状态：门诊创建 Registration、Encounter、Queue Task 与问诊，直接住院创建住院 Encounter/Account；不复制来源历史或参考目录。默认重置在新 Epoch replay 同一不可变 Case Revision，并复用所选 Brief、Case Truth 和全部成功 Investigation Result Snapshot；直接住院回到默认病区待接诊，replay 不重新调用 Synthea 或模型。患者库在门诊未完成或来源绑定的住院尚未清账时显示活动就诊。管理员在模拟数据页通过带悬浮说明的“重置数据”打开二次确认，默认保留患者库，可选择同时清空。清空模式将当前患者库归档并退役关联 Case，不重放这些病例；来源病史、Brief 和真值从当前工作台移除，旧轮次诊疗及审计事实保留。清空后再次准备固定 PCI 来源会建立同一 Profile 的新修订和新 Case，保留来源哈希与旧病例，不重新消费旧 Case。两种模式都保留标准目录、已启用检验服务和账号。清空模式拒绝正在运行的患者或 Brief 生成任务，并取消尚未开始的相关生成任务。

<a id="104-确定性与故障注入"></a>

### 10.4 确定性与故障注入

- 生成请求固定 Provider commit、profile/localization hash、模块模式、人口参数和 seed；相同来源 Bundle 的 Index Encounter 选择、历史/真值闭包和 case type 保持确定。
- Investigation resolver 先匹配 Case Truth 中完全兼容的冻结 coding；作者来源精确快照标记 `case-truth-exact`，Synthea 精确快照保留 `synthea-exact`。缺失时按冻结 Adult Reference Baseline 确定性生成，只有没有该规则的 LOINC 叶子才调用受限模型。首次验证成功的结果按 input hash 冻结，重试、reset 和 replay 复用 snapshot。
- 支付规则可确定地产生 success、declined 或 ambiguous；LIS 规则确定地产生结构化报告。outbox 通过测试 handler 验证 retryable failure、lease 恢复、重复消费和结果未知。
- 数据库备份的 canonical state hash 覆盖 FHIR current/history 以及除派生 Search 索引、schema migration 和 runtime metadata 外的全部持久领域表；`*_json` 按 JSON 值规范化，递归排除 FHIR `lastUpdated` 和存放 hash 自身的列。对话表的 `message_text` 和问诊回执中的轮次 `messageText` 不参与计算，措辞不用于等价判定；轮次顺序、来源、档案版本和审计元数据仍参与，备份文件保留完整原文。它用于同一 schema 下排除这些字段的备份/恢复等价校验，不证明对话原文的逐字完整性，也不是跨版本 replay hash。
- 当前 replay 是 Case Revision 到新 Epoch 的重新物化，不是 command-log replay；当前没有逐步 state hash 或通用故障编排 API。

<a id="105-case-truthpersona-与-action-trace"></a>

### 10.5 Case Truth、Persona 与 Action Trace

Case Truth 表示普通岗位不能直接读取、只能通过问诊和合规业务观察发现的本次病例事实。管理员在模拟数据患者详情的档案下方，通过默认折叠的“本次病例真值”核对来源疾病、Index Encounter 与相关证据；展开才请求 `GET /api/sim/v1/admin/synthetic-cases/:caseId/truth`，收起后移除真值正文，切换患者重新折叠。服务端从受信会话校验 administrator 岗位和 Workspace，返回病例标识、Index Encounter 引用与冻结的 Case Truth 资源，响应禁止 HTTP 缓存；非管理员返回 403，同工作区无对应病例返回 404。该入口不加入 Operation Catalog、CLI、Page Context 或 Agent Tools，也不返回模型输入。Patient Persona 控制患者开场与自由对话扮演；Investigation Result Snapshot 控制已成功解析的检查结果。三者都不进入普通 FHIR Search、Visible Source History 或 HIS 查询。

Action Trace 按 Scenario Run 记录 Command 尝试、结果、Effect 引用和资源版本，事件时间使用当前 Epoch 的 Virtual Time；Audit Event 继续保存真实接收时间。它不记录普通读取，不保存模型 chain-of-thought，也不代替 Audit Event 或 Provenance。首期不定义评分规则、Evaluation Spec、分数变化或 evaluator service account。

<a id="106-重置与-epoch-隔离"></a>

### 10.6 重置与 Epoch 隔离

`workspace_epoch` 当前使用 `building`、`active`、`closing` 和 `closed` 状态；没有 purge 入口。直接开始或 reset/replay 协议：

1. 普通开始只能消费一次具有活动成功 Brief 的 Case；只有管理员可以 reset/replay。Command 以新 Epoch 的 `building` 状态写入本院运行事实。
2. 同一事务把仍为 `active` 的旧 Scenario Run 转为 `closed`，保留已 `completed` Run 的状态与 `completed_at`；随后关闭旧 Epoch、把旧 queued/claimed outbox 标记为 `abandoned`、激活新 Epoch，并切换 `workspace.active_epoch`。
3. 既有浏览器 session 在每个请求重新解析 `workspace.active_epoch` 和当前 Scenario Run，因此下一次读取自动进入新 Epoch；已选岗位仍由 membership 校验。旧预览、receipt、cursor 和业务引用因绑定旧 Epoch 不能在新运行复用。
4. dispatcher 的结果提交重新验证 active Epoch；reset 后返回的旧 claim 变为 `abandoned`，不产生新 Epoch 业务 Effect。

当前没有 checkpoint、command-log replay 或旧 Epoch 清理 API。旧 Epoch、审计和 Action Trace 保留在同一 SQLite 文件中；普通查询只读取 active Workspace/Epoch，Case replay 只复用不可变 Case 资产。

<a id="107-影像素材与病例影像准备"></a>

### 10.7 影像素材与病例影像准备

放射检查使用公开数据集中授权、去标识的真实影像作为仿真素材。这是“只使用合成数据”规则的窄例外：例外只覆盖清单登记的影像像素及其来源标识，患者身份、病史和本院就诊事实仍全部是合成的，来源受试者的诊断、身份和治疗记录不导入合成病例。

**素材清单与素材目录。** 清单由仓库拥有并公开提交，内容与许可署名见 [影像素材清单](../../imaging-assets/README.md)。像素与来源原始文件只存在于本地素材目录：同步按清单中的来源 UID 拉取原始 DICOM，逐文件校验哈希，转码为规范的帧数据后以原子改名发布；只接受未压缩传输语法，单个像素块不超过 2 MiB；边长超过上限的胸片在摄取阶段按固定参数降采样并记录参数，下载的文件必须与请求的来源 UID 一致。安装、校验与修复命令见 [部署教程](../deployment.md#影像素材)。素材目录为空时系统正常启动，放射服务显示为未开展。素材流水线分为通用素材包存储（来源下载与哈希校验、临时目录、原子发布、安装回执、校验、修复与读取缓存）和按素材包注入的摄取适配器（清单格式、规范化与安装文件、打开与读取寻址）；放射与病理切片各有自己的适配器、清单目录和素材目录，新增素材包不修改已有适配器或通用存储。

**病理切片素材包。** 乳腺切片病理会诊使用独立的病理素材包，清单与许可署名见 [病理切片素材清单](../../pathology-assets/README.md)；它的清单目录、素材目录、维护命令和备份都与放射分开，任何一个素材包缺失、安装失败或损坏都不影响另一个，也不影响 Server 启动。来源是 NCI Imaging Data Commons 公开存储中由 TCGA-BRCA 转换的 DICOM 切片，来源客户端只按清单登记的序列目录匿名读取，不接受任意 URL。摄取只保留组织金字塔层级，丢弃缩略图、标签图和宏观图；最高安装 20 倍，原生 40 倍的切片从 40 倍按区域均值生成 20 倍，没有原生 10 倍时从更高倍率的原生层级生成 10 倍。JPEG 瓦片原样沿用，JPEG 2000 瓦片解码后按固定参数编码为基线 JPEG，浏览器不需要 JPEG 2000 解码器；不支持的传输语法、颜色空间、组织方式或几何不一致的切片整张拒绝。每个层级打包为一个瓦片文件加偏移索引，单个瓦片不超过 2 MiB；输出登记层级几何、来源、摄取参数与文件哈希，相同来源与参数重建出相同字节。来源文件头中的受试者标识不进入安装文件、素材标识或命令输出；ICC profile 随安装保存但不应用。报告由模型依据来源的结构化临床字段整理，模型不读取像素：自动核对组织学类型和受体状态与来源一致、不写组织学分级、不对淋巴结作出判断、不写来源无法支持的大小、分期和部位，HER2 字段相互矛盾的素材不能发布；复核签署与发布规则同下。

**核对与发布。** 中文报告由模型依据来源读片标注整理成草稿，模型不读取像素。每份报告内容修订先通过自动一致性核对（病灶数量、侧别、图像序号和大小与结构化标注一致，阴性素材不得出现阳性所见），再由人工在管理员复核预览中对照影像签署。签署绑定素材输出、来源实例及其哈希、数据合集与许可、报告整理规则文件、引用该素材的适配条目、标注和报告内容的哈希，任何一项变化都使签署失效。只有已安装、通过自动核对且复核通过的修订才算已发布；未发布的素材不进入病例匹配。

**病例影像准备。** 管理员对合成病例运行影像准备，按来源编码为每项检查确定素材：来源有未缓解的阳性条目疾病时使用对应的异常素材；只有不存在这类疾病、来源从未出现过阳性条目的疾病、且本次就诊的疾病在规则明确列出的范围内时才使用阴性素材；命中未覆盖疾病、与条目列出的既往手术（例如肺移植、胸骨切开、瓣膜置换或起搏器）冲突或没有规则依据的病例不配片，不会被当作正常。未覆盖疾病清单按固定版本 Synthea 全部模块实际产生的疾病编码整理，Synthea 升级时需要重新核对。疾病是否已缓解以本次就诊的开始时间为准，就诊之后才缓解的疾病在就诊时仍是现症。一个病例只使用一个适配条目，胸片与 CT 因此来自同一来源受试者；多个条目同样适用时按病例来源哈希稳定选择。准备身份包含规则、素材输出、已发布报告修订号及其签署内容哈希；报告或整理规则改动后以同一修订号重新签署，也会使再次准备产生新的修订。准备结果是不可变的修订；病例开始前绑定随清单更新，开始后只能追加，重试和重放不更换已固定的素材或报告内容哈希；当前规则判为冲突或未覆盖时，已绑定的检查保持不变，但不再追加新的检查。

**病例病理准备。** 病理清单的适配规则只写哪些来源病例适用会诊（性别、诊断编码、可送检的手术编码），以及受体（ER、PR、HER2）、淋巴结与肿瘤 T 类别各自对应的来源 Observation 编码和编码值；适配条目不单独列举，由每份切片素材的临床字段派生，事实组合相同的素材属于同一个条目。管理员运行病理准备时，系统从病例的既往来源病史读取诊断、早于本次就诊的可送检手术和五项固定事实的最新结果，与每份已发布素材逐项比较：全部一致且已安装时可用于新绑定；有相符素材但均未安装时记为未覆盖（`ASSET_NOT_INSTALLED`）；任一项矛盾的素材不可用，全部素材都矛盾时记为冲突；来源或素材缺少某项而无法确认时记为未覆盖。定向生成同样只接受有已发布且已安装素材的条目。安装状态纳入准备身份，安装、移除或恢复后再次准备会重新评估；完整清单仍用于管理员覆盖展示与冻结绑定的补充事实读取。组织学类型来自素材，作为补充事实与来源固定事实分开记录。准备结果同样是不可变修订，绑定以来源手术为键：每个可送检的手术各有一份固定的素材选择，冻结规则与放射相同。病理准备、绑定和覆盖清单有自己的表，与放射互不影响。取舍见 [Agent Note](../decisions/implemented/architecture/2026-10-02-breast-pathology-case-matching.md)。

**私有边界。** 病例与素材的绑定、匹配依据、素材标识和来源 UID 只在管理员接口中可见。医生、Agent 的 DTO、Page Context、DSH Tools、CLI 输出、FHIR 资源和患者模型载荷都不包含它们；本院每次检查使用自己的检查标识和 Study UID。管理员的影像准备、病理准备、覆盖清单和复核预览接口不进入 Operation Catalog、CLI、Page Context 或 Agent Tools。

**影像读取边界。** 阅片通过受认证的本院检查路由读取：先读检查描述（序列、几何、像素格式和可用状态），放射检查再按序列、帧和块读取像素，病理切片按序列、层级和瓦片行列读取 JPEG 瓦片。每次读取校验 Workspace/Epoch、病例责任或已完诊读取权限、申请与检查的关联以及发布状态；响应使用 `application/octet-stream` 与 `Cache-Control: private, no-store`，失败沿用 HIS 错误 envelope。读取不产生 Audit Event 或 Action Trace，每个请求的数据库开销是固定的只读语句。像素文件缺失时描述返回不可用，不改写已经发生的检查事实或 FHIR 历史。读取边界由应用层接口表达，本地素材目录是它当前唯一的来源实现。

**阅片器。** standalone Web 与 DSH Surface 使用同一个阅片组件，由外壳和按序列类型选择的渲染引擎组成，见 [前端架构](../frontend-architecture.md#阅片器)。Agent 不读取像素或渲染结果。
