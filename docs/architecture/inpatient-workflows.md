# 住院与手术流程

本文定义住院建档分床、三方转科、住院手术最小闭环与耗材核实、冠脉造影与 PCI 单次耗材预计、术后基准核查与交接、出区召回清床、病案首页不可变归档以及 DRG 评估、医保办核定、后台跟进与直接分组记录核对的完整合同。住院医嘱、药房发药与护理执行见[处方、医嘱与药事](orders-and-pharmacy.md)，住院检验检查送检与报告阅读见[检验、检查与报告](examinations-and-reports.md)，住院预交金、首次冻结结算、手术／DRG 费用口径与结算后财务更正见[收费、结算与医保](billing-and-insurance.md)，住院指南参考意见与事中临床质控见[临床决策支持与质控](clinical-decision-support.md)。

## 住院建档、入科分床与三方转科

### 住院登记、单住院科默认与床位互斥

```text
住院证 ServiceRequest / 直接入院 / 转院登记
  -> 登记员办理登记 + 收取可选预交金 -> Encounter.class=IMP (planned) + Account
  -> 病区护士接诊分床 -> 床位占用互斥 + Encounter (in-progress / admitted)
  -> 住院医生确认诊断(POA) + 长期/临时医嘱 + 医技申请 + 手术计划/实施
  -> 护士校对送检/给药执行 + 药师集中发药 + 术前双准备与耗材核实
  -> 医生开出院医嘱 (discharge-pending) -> 护士办理实际出区 (departed)
  -> 收费员首次冻结结算 (settled) -> 护士清床释放床位 (cleared / completed)
  -> 医生提交完整首页 -> 病案人员编码审核并不可变归档 (archived) -> 医保办 DRG 核定
```

住院业务由独立的 `InpatientService` 经共享 `CommandExecutor` 驱动，不借用门诊病例表、门诊 `Registration` 或门诊支付外键。每次住院登记校验当次受信上下文的 `expectedEpoch` 前置断言，生成独立住院号、`Encounter.class=IMP` 与专属 `Account`（`registered` 映射标准 `planned`，病区护士接诊分床后推进为 `admitted` / `in-progress`）；门诊医生开具的住院证以 `ServiceRequest` 记录，经门诊转收登记后一次核销且不可重复转收；正整数分预交金生成关联共享收款账的资金交易，零预交金不产生交易。登记时仅在可唯一确定同 `Workspace/Epoch` 的 `synthetic_case_materialization` 时绑定内部私有 `source_case_id`（门诊转收须与住院证患者及来源 `Encounter` 一致，多来源直接入院须显式指定来源 `Encounter`，无合成来源手工建档保持空值且禁止为后续检查凭空伪造合成真值）。

临床、行政、财务与病案生命周期分列独立字段维护，禁止压缩塞入单一 `Encounter.status` 或滥用 `Encounter.subjectStatus`：入科、转科、待出院、已出区、待清床与召回由领域状态、`Encounter.location` 时段及独立 `Task` 联合表达；科室责任归属通过 `Organization` 参与者／`serviceProvider` 记录，严禁将科室伪装成 `Location`。床位占用由领域互斥表维护起止时间与双唯一约束（同一时刻一张床位仅能被一个有效住院占用，一个在院患者仅占用一张有效床位），`Encounter.location` 仅作互操作投影；病区护士接诊分床、同病区转床与双人互换床位均为单笔原子 Command，任一侧版本、占用或审计失败整事务回滚。

Scenario 默认提供单一“住院科”（`organization-inpatient-medicine`）、单一“住院病区”（`ward-general`）、一间病房与三张床位，住院医生与病区护士各设一个默认 `Practitioner Role`。病区目录以 `acceptingAdmissions` 控制新收治入口：新直接入院、转院登记与新签发住院证仅接受默认病区，其他病区返回 `INPATIENT_WARD_UNAVAILABLE`；已签发历史住院证仍按原目标病区幂等转收，存量多病区数据、历史占用、归档与回执在升级后原样保留，不自动转科或停嘱。住院领域模型与默认病区收敛见[住院闭环模型决策](../decisions/implemented/architecture/2026-10-21-inpatient-closed-loop-model.md)与[单住院科默认配置决策](../decisions/implemented/simplification/2026-10-21-single-inpatient-default.md)，CLI 与运行时操作见[住院 Skill](../../skills/clinmesh-inpatient/SKILL.md)。

### 三方责任转科

跨科转移通过独立的转科 `Task`（`requested` -> `handed-over` -> `completed` | `cancelled`）由当前主管医生发起申请、原病区护士确认交接、目标病区护士接收分床三步协同完成；目标病区的 `incoming` 待接收列表仅向目标病区开放接收所需的窄字段，在接收完成前普通临床详情读写权限仍归原责任科室与病区。

交接与接收在同一共享 Command 事务内重验全部在途阻塞条件：原科室医嘱必须已申请停嘱并由原护士核停，未完成的护理／给药执行任务必须已取消，未送检医技申请必须完成送检或取消，未实施手术申请必须完成或取消；已由原病区送检的在途检验检查继续执行并在转科完成后由新科室自动接管报告阅读与后续处理。目标护士接收时原子核验 `Task` 与 `Encounter` 版本、阻塞清零及目标空床可用性，结束原床位占用、建立新床位占用并切换住院当前科室／病区及 FHIR 位置历史；转科前已发生的发药、库存扣减与费用保留原科室归属，转科后的新医嘱执行与午夜床日费计入新科室。

## 住院手术最小闭环与耗材核实

### 手术申请、双准备、目录与耗材预留

`InpatientService.surgery` 统一拥有手术申请、术前双准备、取消与实际实施事实。`inpatient.surgery.catalog`（v3）向住院医生、病区护士与病案人员返回手术操作子集、耗材目录、院内启用手术执行地点（导管室、中心手术室、内镜室、门诊手术室）及本院有效临床医师候选（排除护理与收费等非医师岗位）。手术申请（`inpatient.surgery.request` v4）强制校验临床六要素——手术类型（择期／限期／急诊／日间）、计划术式、计划手术时间、手术执行地点、主刀医师及可选第一助手（主刀与一助不得同人）、拟行麻醉方式——以及申请理由，冻结快照并同步投影至 FHIR R5 `ServiceRequest`（含 `priority`、`category`、`location`、带主刀／一助角色扩展的 `performer` 与麻醉方式 `orderDetail`；PCI 术式申请同步受功能学非缺血病变事中质控约束，见[临床决策支持与质控](clinical-decision-support.md#四大责任关口与红线警示双层规则)）。术前双准备由病区护士记录术前检查核对（`check-preop` v3）、主管医生确认一术一议结构化手术知情同意书已签署（`confirm-consent` v3，属于对纸质／床旁谈话同意书的合成教学核认，附非真实医疗法律文书声明而非电子签名系统）：服务端按计划术式代码路由冠脉造影、冠脉药物洗脱支架置入、冠脉球囊扩张成形或外科通用四套差异化模板，在写事务内权威拼装患者基本信息、住院号、当前已确认主诊断（未确认时置 `null`）、手术通知单六要素、个体化风险说明、患者本人或受托近亲属签署信息及当前谈话医师，固化不可变 `consentConfirmation.document` 快照（历史旧记录缺省六要素或结构化正文时保持只读兼容，且 `document` 不进入单次耗材预计基准指纹或病案首页 `sourcesHash`，见[手术通知单与结构化知情同意决策](../decisions/implemented/architecture/2026-11-23-surgery-notice-and-structured-consent.md)）。两项准备各自保存责任人、时间与说明，全部齐备后推进为 `ready`，到计划时间绝不自动触发手术实施。尚未实际开始的 `requested` / `ready` 申请可通过 `inpatient.surgery.cancel`（v3）取消，在同一事务记录取消原因并自动释放该 `requestId` 绑定的全部活动 `reserved` 耗材预留。术后医嘱可在普通开嘱流程附带同次住院已完成的 `surgeryExecutionId`（校验非计划、非术中、非跨次住院后投影至 `MedicationRequest.supportingInformation` 或 `ServiceRequest.supportingInfo`），仍须经护士校对及药房实际发药后方可执行。

Scenario 内置八条临床版 3.0 手术操作分类有界摘录（保留完整编码、类别、来源版本与定位，见[住院病案编码与召回研究](../research/2026-10-20-inpatient-record-coding-and-recall.md#手术操作固定子集的来源)）以及心血管介入耗材目录（含基础合成耗材与归一化参考表的 52 条单位明确、按中选整数分计费的可选耗材，另 179 条 `unavailableReason=unit-unconfirmed` 仅保留参考价而禁止实际手术选用、绝不猜测规格或单位；耗材仅记录临床实际使用与计费，不涉及采购批号或物理库房扣减，见[心血管耗材目录决策](../decisions/implemented/architecture/2026-10-22-cardiovascular-material-catalog.md)）。耗材预留冻结初始数量与创建时目录单价，以 `consumedQuantity` / `remainingQuantity` / `version` 跟踪分次消耗；手工新增与释放（携带 `expectedReservationVersion` 逐项按序调用）仅关闭未用余量而不影响已发生计费，手工预留本身不构成术前确认依据或实际费用。

### 一次性实施、术中逐笔耗材与常规免填留痕

手术实施支持一次性完成（`inpatient.surgery.execute` v4）与术中分步记录（`inpatient.surgery.start` v3 -> `record-material` v3 / `correct-material` v2 -> `complete` v4）两条受控路径：

- **路径互斥与进行中隔离**：开始手术在重验双准备就绪、当前科室责任、在院状态与申请版本后创建唯一的 `in-progress` FHIR `Procedure`（暂不收取术式费）；已开始的手术归入 `surgeries.inProgress`，禁止取消、重做术前准备或再走一次性完成，病案首页与术后医嘱只能引用已完成列表 `executions`。一次性完成则在单事务内同时落库 `Procedure`、耗材使用、术式与耗材逐项费用（归属实施时当前科室）及申请完成状态。
- **常规无差异免填与偏离强制留痕**：当实际实施术式与计划术式一致、每笔耗材均显式绑定本台手术有效预留（`reservation.requestId === requestId`）且未超出预留余量、不存在遗留未消耗的本台预留、且最终用量与已确认术前清单完全一致时，开始、术中登记与完成请求均可省略人工 `note`，由服务端自动写入结构化默认留痕；一旦发生实际术式变更、无预留额外耗材使用、仅绑定全住院通用预留（`reservation.requestId === null`）、遗留未消耗本台预留、或与已确认术前清单存在数量／品种偏离，必须提供医生填写的医学说明 `note`，缺省一律以 `INPATIENT_SURGERY_NOTE_REQUIRED` 拒绝。

### 最终耗材净差额核实、术后补登记与逐笔更正

术中路径完成前通过 `inpatient.surgery.preview-completion`（v2）审阅本台手术全部当前有效使用的来源身份、按冻结依据分组核实的最终总量、显式勾选释放的本台未用预留及可选 `note`（相同冻结依据须合并行，同一预留按全部行净变化汇总校验余量，多个候选绝不按名称自动匹配，零数量不生成零使用或零收费），返回净数量与费用差额、单次术式费、未选保留预留警告及绑定全部输入、目录、使用、更正、预留与原账务状态的核实指纹。`inpatient.surgery.complete`（v3 附 `reconciliation`）在原事务重验核实指纹与上述 `note` 必填规则：同一预留内先执行减少量的临床更正与精确费用冲正、再登记增加差额（使已耗尽预留也能在总上限内跨不同冻结依据调整，已明确关闭的预留禁止再增用），仅关闭明确勾选的本台预留，原子提交净差额事实、预留变更、术式费、`Procedure` 完成与审计。

患者仍在院、财务账户开放且病案未归档时，支持两类受控修正：

- **术后漏记补登记（`inpatient.surgery.supplement-material`）**：引用已完成申请、执行身份与当前申请版本追加漏记耗材、原因依据与新增费用（显式引用有效预留时核对收费身份与单位一致后沿用冻结单价，已释放预留不可重占但可作额外使用），不重新完成手术或重收术式费，历史记录永久保留补登记来源标记。
- **临床耗材更正（`inpatient.surgery.correct-material`）**：可在术中或术后对既有 `materialUseId` 顺序准备最多 20 笔撤销、减量或替换耗材更正（不与漏记新耗材混同），每笔原子追加 `materialHistory.correction`、原费用精确冲正（已由收费员冲正的仅引用一次）与可选替代使用，按前序成功回执顺序递进申请预期版本，一旦前项改动了后项依赖的共享预留立即暂停余项供重审；更正不覆盖原记录，也不表示体内植入物取出、物理退库或现金退款完成。最终耗材核实、常规免填与补录更正取舍见[手术最终耗材核实决策](../decisions/implemented/architecture/2026-10-30-surgery-final-material-reconciliation.md)，意图恢复见[住院命令原意图恢复决策](../decisions/implemented/bug-fix/2026-10-20-inpatient-command-intent-recovery.md)。

## 冠脉造影、PCI 参数与单次耗材预计

### 诊断性冠脉造影确定性报告与 PCI 参数确认

诊断性冠脉造影（`88.5500` / `88.5600`）完成时，同一 Command 事务排入持久报告任务，由仿真执行器读取本次住院绑定病例的 `Case Truth` 冠脉造影定义，零模型确定性生成正式 `DiagnosticReport`、可选支架选型 QCA 测量、多支冠脉节段所见（`LM`、`LAD`、`LCX`、`RCA` 狭窄率、TIMI 0–3 级血流、病变特征、可选 `FFR`/`iFR` 生理学评估）与整体结论：纯诊断性多支造影伴阴性 `FFR` 且无支架选型 QCA 时正常签发完整 `final` 报告且不要求实施 PCI；多支所见缺失总体结论或数值越界时降级为 `partial` 并列明缺项；病例无造影真值来源时保持 `unavailable`，绝不从作者底稿反推或调用模型编造。报告通过 `inpatient.angiography-reports.read` 向当前有权读取该次住院的医护与病案岗位提供结构化结论与合成声明，不包含私有真值身份或造影动态影像像素（见[核心检验与多支冠脉造影决策](../decisions/implemented/feature/2026-11-12-cardiology-default-labs-and-multivessel-angiography.md)与[同源专病临床内核与像素暂缓边界](../decisions/implemented/architecture/2026-11-19-shared-specialist-clinical-kernel-and-pixel-deferral.md)）。

保存 PCI 手术计划时，`pciSelection` 将已有正式造影报告中的靶部位与测量逐字段复制到绑定该申请的 `drafts`（报告晚到时仅为尚无确认和草稿的计划补建）；保存修改（`expectedDraftVersion` CAS）与正式确认（`inpatient.pci-selection.confirm`）时，服务端逐项比对原 `DiagnosticReport` 的对象、部位、数值、单位与方法，任何改动立即标为人工修订而拒绝信任客户端自报原报告归属。确认支持省略或留空 `plannedQuantities` 与 `approvedMaterialIds`（使指南参考意见不依赖人工预填数量）；`inpatient.pci-selection.read` 将已安装耗材目录与固定版本合成选型依据包联接（当前仅核验明示合成单病变、长度 5–16 mm、近远端参考管径 3.0 mm 及四类各一件方案，不宣称真实器械 IFU），返回 `valid`、`incomplete`、`inapplicable` 或 `unavailable`，后台耗材建议仅在医生已认可且临床适用／器械兼容的候选中按预计本院收费较低优先排序（不推断医院采购成本或利润）。

### 单次耗材预计工作稿与整批预留确认

`InpatientMaterialEstimate` 独立于持续后台跟进，拥有每个受支持冠脉造影或 PCI 手术计划的单次耗材预计意图与医生工作稿：保存手术计划时原子写入自动准备意图（依据不全时保持 `incomplete` 待事实补齐后续跑，造影计划使用独立合成依据包 `clinmesh-angiography-estimate@2026-10-28.r1` 核验 1 根或 2 根合成造影导管，绝不推断支架需求），复用住院分析执行器与模型计量账守卫（`queued`/`running`/`succeeded`/`incomplete`/`stale`/`blocked`/`unknown`/`failed`/`cancelled`；未知状态在核查原尝试前禁止重派，模型受阻或失败绝不阻断正常手术流程）。申请弹窗另支持在开启自动跟进时按已确认诊断与最新正式造影报告生成最多 2,000 字的申请理由草稿，迟到草稿不覆盖医生已编辑输入。

医生工作稿（`expectedDraftRevision` + `basisFingerprint` CAS）与模型分析结果分离存储：首份有效分析仅在无稿时初始化，显式重新预计将新结果放入 `candidateItems` 供审阅采用而不覆盖人工稿；人工稿（`analysisId=null`）同样要求每项候选有效、目录版本匹配且数量符合已核验依据方可确认。`inpatient.material-estimate.confirm` 在同一共享 Command 事务内重验预计版本、工作稿修订、临床依据、`ServiceRequest`/`Encounter` 版本以及该手术计划当前完整活动预留集合的 `expectedReservationFingerprint`（集合发生新增、释放或消耗变化时返回 `INPATIENT_RESERVATION_CONFLICT` 要求重审；手工整批预留调整 `inpatient.drg.reservation.replace-batch` 复用同一集合指纹替换模块但不建立术前确认依据）。在造影报告草稿路径上，同一次确认原子串联选型确认、不可变术前清单快照 `inpatient_material_plan_confirmation`（记录确认人、临床指纹、材料版本、冻结单价、数量依据与 `supersedes` 链，不因后续预留消耗或实绩更正被改写）以及整批预留替代，任一步失败整事务回滚。单次预计与确认基准见[单次耗材预计决策](../decisions/implemented/architecture/2026-10-28-single-material-estimate.md)与[住院 Skill](../../skills/clinmesh-inpatient/SKILL.md#单次耗材预计工作稿与整批确认)。

## 术后核查与多岗位责任交接

未归档且存在已完成手术的住院病例，无需事先开启持续后台跟进即可由 `InpatientService.drgReview` 依据受信正式事实直接执行术后材料与财务核查（原人类或 Agent 授权撤销后，后续合法收费冲减与耗材更正仍继续刷新同一核查待办）。临床计划对比覆盖受支持的已完成 PCI 手术及存在术前确认依据关联的申请，按 `requestId` 输出 `drg-review.planBases`：

- **`confirmed`**：存在同来源有效术前确认快照（单次预计确认快照或匹配的持续跟进选型确认），`history` 完整保留确认来源、版本、确认人、时间、原材料快照与 `supersedes` 链。
- **`missing` / `unverifiable`**：`missing` 表示无术前确认记录；`unverifiable` 表示历史记录仅有旧确认标记而缺可核验快照，两者均保持计划数量未知，严禁从当前工作稿、剩余预留或实际消耗倒推回填。
- **`conflict`**：单次清单与持续跟进两种确认来源并存且无跨来源取代关系时，有效引用置空并生成 `plan-conflict` 待办供人工核查双方原记录，禁止拼接或按时间静默择一。

差异待办按实际手术与问题键幂等维护，由各岗位在权限边界内经 `inpatient.drg.review.todo.act` 处置：主管医生核对临床用途与计划偏差，收费员核对正式收费净额疑点（收费员响应严格剥离 `planBases`、诊断、选型参数与临床模型解释），病案人员核对分组依据缺项；仅当最新正式业务事实消除差异时自动标为 `resolved`，人工选择“无需处理”须填写理由并留存审计，模型自述或关闭提示绝不构成解决证据。当病例发生转科、撤权或停止跟进时，当前有效岗位通过 `inpatient.drg.review.handoff` 按版本交接既有核查结果与未决待办，交接不自动消解问题、不延长旧授权，也不构成出院门禁。术后核查与交接取舍见[手术流程辅助与术后核查决策](../decisions/implemented/architecture/2026-11-13-surgery-flow-assistance.md)。

## 住院出院、召回窗口与清床

`InpatientDischarge` 将出院拆分为五个职责分立的共享 Command：主管医生 `issue` 下达出院医嘱进入 `discharge-pending`（受冠心病／PCI 二级预防出院用药事中质控约束，见[临床决策支持与质控](clinical-decision-support.md#四大责任关口与红线警示双层规则)），病区护士 `depart` 记录实际出区与本院仿真离院方式（`home`、`transfer`、`against-advice`、`death`、`other`，病案首页直接只读引用而不覆盖），收费员 `settle` 办理首次冻结结算（资金与账目指纹规则见[收费、结算与医保](billing-and-insurance.md#住院预交金欠费摘要与首次冻结结算)），病区护士 `clear` 释放床位完成 `Encounter`，以及特定窗口内的主管医生 `recall` 出区召回。

`issue`、`depart` 与 `settle` 在各自写事务中独立重验在途门禁：未完成也未取消的手术（`requested`、`ready`、`in-progress`）、未完成医技申请（`issued`、`accepted`、`in-progress`、`generation-failed`；已签发 `reported`/`acknowledged` 或已取消放行，未阅报告不等同未完成检查）以及进行中转科（`requested`、`handed-over`）均阻断推进；`depart` 与 `settle` 额外要求全部医嘱已 `stopped` 或 `completed` 且全部执行单已 `completed` 或 `cancelled`。处于 `discharge-pending` 期间仅允许申请停嘱与护士核停，禁止新开医嘱、校对、发药或给药；午夜床日费仅在 `admitted` 与 `discharge-pending` 实际在院过夜时计收，`departed` 虽结束 `Encounter.location` 实际床位时段但仍保留领域床位互斥锁（不再计床日费），直至收费员完成 `settle` 后才允许护士执行 `clear` 解除床位占用。出区召回 `recall` 仅在 `departed`、财务账户仍 `open` 且未清床原床保留时可用，与 `settle` 在同一 `Admission` 状态上做 CAS 互斥竞争；召回保留原出区事件与离院方式，追加逆向召回事件与新床位时段恢复行政在院状态，已停医嘱绝不自动恢复，结算完成后再次入院须新建独立住院记录。

## 病案首页、不可变归档与 DRG 核定

### 病案首页修订、在院主操作确认与不可变归档

病案首页核心快照包含患者基本信息、住院经过（固定首次实际占床科室／病区、已完成转科链及未被召回逆转的最终出区与离院方式，禁止以当前科室覆盖首次入科）、正式主次诊断（含入院病情 POA）与本次实际实施手术操作（严格取自 `executedForAdmission` 已完成 `Procedure`，保留实施冻结的临床版 3.0 编码、术者与耗材，计划／取消／既往手术概不计入；存在已完成手术时必须由医生显式指定唯一主操作，无手术明确为空集合）以及分类费用汇总四组数据；患者在本 Epoch 首次住院生成持久病案号并在后续住院复用。

主管医生可在未归档窗口纠正住院诊断（不恢复医嘱或费用动作），并可在患者在院未结算期间通过 `inpatient.record.submit` 保存“在院主操作确认”以更新实时 DRG 预分组依据（在院保存仅追加依据快照，不进入病案编码审核队列，离院结算后仍须提交完整正式首页，见[在院主操作确认决策](../decisions/implemented/bug-fix/2026-11-13-inpatient-primary-procedure.md)）。患者实际离院后，病案人员对当前正式提交修订及确定性来源指纹（覆盖实际采用 `Patient`、诊断 `Condition`/`Encounter`、手术耗材 `Procedure`、床位转科出区、全部正反费用行与结算资金、医技申请与完整报告修订确认链）核验临床版 2022 诊断编码后执行审核通过或附理由退回；任何上游来源变化均使 `reviewCurrent` 失效并要求医生重提。`inpatient.record.archive` 在同一事务重验来源哈希、审核通过、已清床、已首次结算、核心字段完整、资金平衡且无在途任务，生成不可变完整归档快照并锁定全部临床、首次财务与报告更正写入口（既有幂等回执仍可无写重放，当前 Epoch 人类会话保留各岗位窄只读回看）。病案审核与归档采用“具名下一份”跨患者连续办理：成功后停留当前病例并展示固定目标的下一份入口，仅在人工点击并重验资格后切换。

### DRG 预分组、医保办核定与后台跟进／直接核对

未归档病例的实时 DRG 预分组直接读取当前最新确认诊断与显式主操作选择（未保存主操作时如实返回输入不完整，绝不默认猜最近手术或回退术前分组；存在多台待实施手术计划时推演分组须通过 `primarySurgeryRequestId` 指定假想主操作；临床版编码与 CHS-DRG 3.0 医保版编码按同码精确直通，不做名称模糊匹配）。病案归档在同一事务内冻结正式 DRG 分组结果及医院支付预估基线 `paymentEstimate`。医保办通过独立窄接口读取已归档冻结摘要（绑定归档来源哈希，不暴露完整病历正文，不办理患者现金收退，也不是出区或归档前置门禁），先预览服务端金额再以 `expectedFingerprint` 与 `Encounter` 版本确认核定，追加保存 `estimateDifferenceFen`（核定减归档支付预估）与 `differenceFen`（核定减归档正式收费），并沿用每页 10 份的具名下一份连续办理模式（规则启用见[运行时 DRG 规则启用](../deployment.md#运行时-drg-规则启用)，联合审阅见[DRG 联合验收与核定决策](../decisions/implemented/feature/2026-10-25-drg-joint-acceptance-and-review.md)）。

住院临床侧提供持续后台规则跟进与零前置按需记录核对两条互补路径：

- **住院后台规则跟进（`drg-followup-start` / `stop`）**：每次住院至多一个稳定任务身份，独立于浏览器会话并在每次派发与发布前复验原 Actor／岗位／Grant 与当前科室病区（转科或撤权转入 `authorization-lost` 待交接，归档转入 `archived`）；确定性规则路径无需模型即可跟踪分组与净收费变化，当正式收费净额严格超过有效正医院支付参考额 3 倍时给出非阻断特例单议仿真提醒；模型建议遇到计量不可用时以 `MODEL_METERING_UNAVAILABLE` 挂起并在运行环境恢复后无损续跑，任务明细直接关联模型用量账本供核查（见[模型用量查询](security-and-reliability.md#模型用量查询)）。
- **直接分组记录核对（`inpatient.drg.record-checks.read` / `explain`）**：无需开启持续跟进即可零模型同步读取实际 PCI 与首页主操作差异、正式分组与计划推演差异、以及分组缺项／编码不兼容三类确定性核对（归档后返回 `frozenGrouping` 原冻结结果，归档时未配规则包则 `frozenGrouping=null` 并以自然语言说明，独立预分组接口返回 `DRG_FROZEN_RESULT_MISSING`）；仅在医生显式点击展开时通过 `explain` 发起单次受控生成与独立核验解释，不改动任何正式临床或账务事实（见[DRG 直接记录核对与按需解释决策](../decisions/implemented/architecture/2026-10-30-drg-record-checks-on-demand.md)）。
