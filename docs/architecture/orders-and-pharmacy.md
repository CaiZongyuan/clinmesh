# 处方、医嘱与药事

本文定义门诊本院药房与国家外延处方分轨、无需用药结论与处方撤回、住院长期与临时医嘱生命周期、门诊与住院共享声明式药事安全规则、药房集中调剂发药与已证明库存增量、以及病区护士医嘱校对、集中核停与实际给药／PRN 执行的完整合同。门诊完诊门禁见[门诊业务流程](outpatient-workflows.md#主接诊责任与七项完诊门禁)，住院入科、转科与出院门禁见[住院与手术流程](inpatient-workflows.md)，处方与医嘱收费及医保分摊见[收费、结算与医保](billing-and-insurance.md)，专病医嘱组套预筛与药事安全双层事中质控见[临床决策支持与质控](clinical-decision-support.md)。

## 门诊处方分轨、无需用药结论与撤回

### 本院药房与国家参考目录分轨开具

门诊处方草稿是病例级 domain-native 聚合，保存 1–8 条受控药品、单次剂量、频次、疗程与数量，并以 `Encounter` expected version 和单调递增的 `expectedDraftVersion` 执行 CAS 更新；临床目录通过 `prescriptionConclusionSupported` 声明当前 Epoch 是否启用独立用药结论能力。草稿支持同窗连续加入、逐行编辑与移除（已加入行的本地未保存修改必须先保存，才允许提交正式开具或应用 Agent 建议覆盖），保存或删除草稿均不创建 FHIR `MedicationRequest`。

门诊药品来源显式划分为默认选中的「本院药房」（当前启用的门诊可用院内常备药目录）与「国家参考目录」（电子外延处方品规）。单张处方在草稿保存、直接正式开具与建议待办确认三个入口统一强制单一目录来源，混选两类来源一律返回 `CATALOG_CONFLICT`（`PRESCRIPTION_MIXED_CATALOG_SOURCES`）。正式开具按整张处方单笔 Command 原子执行：事务内重新读取目录与最新已确认正式诊断，核验药品联合禁忌、诊断适应证、有效药物过敏、单次／单日剂量、频次、疗程与总数量（任一药品不满足即整单回滚并保留全部待开行；网络超时等结果未知时通过限定病例与 `prescription` 类别的医生 Session 回执接口恢复），由 `prescription_authorship` 通过 `workspace_actor` 与 `Practitioner Role` 复合外键记录负责身份，清空草稿正文并递增草稿版本：

- **本院药房处方**：原子创建带稳定处方号的 `Prescription` 聚合、每种药品一条 `active` FHIR R5 `MedicationRequest`、药品 `ChargeItem` 与 `Charge Record`；当门诊 `Encounter` 已完诊且处方保持 `signed` 未撤回时向收费员开放收费与医保结算，全额收齐后移交本院药房调剂发药。
- **国家参考目录外延处方**：同样创建稳定处方号、`Prescription` 与 `MedicationRequest`，满足门诊完诊的“用药结论已记录”门禁并支持未撤回时按统一规则撤回，但不创建 `0 元` `ChargeItem` 或 `Charge Record`，不进入本院收费队列与本院药房发药流转。分轨取舍见[门诊本院药房与国家外延处方分轨决策](../decisions/implemented/architecture/2026-11-05-outpatient-external-prescription-split.md)。

### 无需用药结论与受控处方撤回

`无需用药` 结论是独立的 domain-native 正式事实，记录负责 Actor、`Practitioner Role` 与虚拟业务时间，绝不用空 `Prescription` 或空 `MedicationRequest` 冒充。有效未撤回处方与无需用药结论严格互斥；确认无需用药同步清空处方草稿并递增草稿版本，已开具处方在合法撤回后方可改记无需用药结论。

处方撤回通过追加不可变的 `prescription_withdrawal` 事实表达（`prescription.withdraw`），严禁物理删除或覆盖原 `Prescription`。仅当处方处于 `signed` 或 `paid`、尚未发生任何药房调剂、不存在未知或部分收款、且不存在有效医保分配时，才允许携带 `Prescription` expected version 与全部关联 `MedicationRequest` expected versions 执行撤回（即使基金与个人账户支付均为零的医保分配也可能已累计患者年度起付线，须先由收费员撤销原医保待遇并追加年度补偿后才能撤回处方）。撤回成功后，全部 `MedicationRequest` 更新为 `cancelled` 并保留完整 FHIR 历史，`Prescription` 版本递增且读模型投影为 `withdrawn`；未收款的药品费用移出收费员待收队列，已全额收款的记录保留原支付历史且不隐式触发退款（由收费员按需办理费用冲减与原款退回），药房队列、审核与发药入口全面拒绝已撤回处方。

## 住院长期与临时医嘱生命周期

### 住院诊断入院病情、目录检索与整数制剂换算

住院医生正式确认主次诊断时，必须逐项显式指定入院病情（POA：`1 有`、`2 临床未确定`、`3 情况不明`、`4 无`），并以 `ordinal` 持久保存诊断排序（不按备注、时间或生成 ID 推断次序），生成关联当前住院 `Encounter` 的 FHIR R5 `Condition` 与 `Encounter.diagnosis`。服务端优先解析活动 Reference Data Release 的标准诊断条目并冻结 `system/version/code/display/sourceLocator` 与 `releaseId`（编码来源见[住院病案编码与召回研究](../research/2026-10-20-inpatient-record-coding-and-recall.md)），院内合成兜底条目以 `operational:diagnosis_catalog` 明确区分。

住院医生通过 `catalog-search` 分页检索院内与 Reference 药品及检验候选，明确区分可用、待补齐（列明缺失的规格、计价单位、价格、适用范围或药事规则）与已停用条目，仅唯一完整匹配的院内启用项目返回可开立身份与版本；管理员与只读临床入口可通过 `pci-data` / `prepare-pci-data` 幂等补齐固定版本 PCI 共享目录与初始合成库存批次，保留既有价格、库存余额与历史业务而不自动物化患者或临床事件（见[心血管耗材与共享目录决策](../decisions/implemented/architecture/2026-10-22-cardiovascular-material-catalog.md)）。住院药品开立填写 `doseText` 与频次，前后端共用纯剂量换算逻辑：按明确制剂单位直填或经每制剂含量 `inpatientDoseBasis` 换算为正整数制剂数量 `doseQuantity`，并核对单次上限 `inpatientMaxDoseQuantity`；缺少换算依据、单位不兼容、超单次上限或出现分片／小数制剂数量时一律拒绝。

### 医嘱聚合、上海时区班次展开与状态流转

```text
SIGNED (医生签发长期/临时/PRN医嘱)
  -> VERIFIED (病区护士校对并生成首轮待执行 Task)
  -> IN_EXECUTION (药师按任务调剂发药 / 护士按时点给药或完成服务)
  -> COMPLETED (临时医嘱或单次任务执行完毕)

SIGNED / VERIFIED / IN_EXECUTION
  -> STOP_REQUESTED (医生填写理由申请停嘱，立即冻结新排班/发药/给药)
  -> STOP_VERIFIED / STOPPED (病区护士核停，取消 pending/dispensed 未执行任务)
```

住院医嘱由 `InpatientService` 下的 `InpatientOrders` 拥有：药品医嘱与健康教育／护理医嘱分别映射 FHIR R5 `MedicationRequest` 与 `ServiceRequest`，本地校对与停嘱步骤由领域聚合、执行 `Task` 与 `Provenance` 联合表达，每次签发、校对、申请停嘱、核停与执行均为独立受控 Command 与审计事件。读写权限按岗位最小化隔离：住院医生与病区护士须匹配患者当前责任科室与病区；药师仅通过独立药房清单和窄详情读取药嘱、执行任务、库存批次、发药记录与已确认药物过敏；收费员仅读取账项标签、净额与财务状态，不读取诊断、POA 或给药临床细节。

医嘱开立弹窗支持连续加入最多 20 条长期或临时药品／护理医嘱，按队首顺序逐条调用原单项开立 Command（携带可选 DRG 预计指纹时，首条成功入库后其余待开行的旧预计自动标为过期，要求重新预计审阅；连续办理私稿与回执恢复见[连续办理私稿与逐项原回执恢复](clinical-workflows.md#连续办理私稿与逐项原回执恢复)）。本院仿真排班固定采用上海时区虚拟班次：`QD -> 08:00`、`BID -> 08:00/20:00`、`TID -> 08:00/14:00/20:00`、`QN -> 22:00`。护士校对首日仅生成校对虚拟时间尚未过去的班次时点；`ONCE` 仅允许用于临时医嘱（长期医嘱选用 `ONCE` 返回 `MEDICATION_ONCE_REQUIRES_TEMPORARY`），临时医嘱仅生成单次任务；`PRN` 按需医嘱在校对后不自动排程，仅由病区护士凭明确临床理由按需发起。场景虚拟时间跨日推进时，按业务日幂等展开在执长期医嘱的当日执行 `Task`，绝不自动生成已给药事实。住院医嘱排班、集中发药与集中核停取舍见[住院医嘱与执行决策](../decisions/implemented/architecture/2026-10-21-inpatient-orders-and-administration.md)。

## 门诊与住院共享声明式药事安全规则

Hospital Baseline 默认启用 22 种心血管及基础内科常备药并初始化合成药房批次，统一覆盖门诊本院药房与住院医嘱。全部 22 种默认常备药与 PCI 准备安装的碘海醇注射液均随门诊临床目录与住院药品目录提供可选只读结构化合成说明书摘要（`packageInsert`，固定声明「合成教学参考，非真实上市产品法定说明书」，与声明式药事安全、事中临床质控及专病医嘱组套规则保持一致），供门诊选药弹窗、处方待开清单及住院开医嘱器在不打断草稿的前提下只读查阅；未配置摘要的院内品规或国家参考目录外延药品显示「暂无院内说明书摘要」，该元数据就地回填时不递增目录版本、不计入住院目录缺项，也不进入处方快照、收费账项、FHIR 资源、病案归档指纹或诊疗建议输入目录（取舍见[合成药品说明书摘要决策](../decisions/implemented/architecture/2026-11-20-synthetic-medication-package-insert.md)）。全部药品、价格、剂量限制、说明书摘要与监管核验标记均为固定合成规则，不代表临床建议或真实医保资格。每项药品通过声明式 `safety` 配置定义药理类别、ICD-10 适应证编码前缀及单次／单日剂量极量，由前后端共享纯函数校验（未配置 `safety` 的存量旧基线条目兼容保留原枚举剂量、组合白名单与精确适应证匹配）：

- **药理互斥与联合用药**：默认允许跨药理类别联合用药；明确拦截 `ACEI + ARB`、`ACEI + ARNI`、`ARB + ARNI`、双 `P2Y12` 受体拮抗剂、双他汀类以及同一药品有效期内重复开具。
- **适应证前缀与过敏阻断**：适应证直接读取本次就诊／住院最新确认 `Condition` 冻结的 ICD-10 编码执行不区分大小写前缀匹配（Reference Data 诊断无需重复录入本院诊断目录，后续目录变更也不溯及已确认依据）；患者存在有效已确认药物过敏时硬性阻断开具。
- **疗程、极量与 PRN 保守上界**：门诊处方疗程限定 1–30 天，发药总数量须为正整数且不超过单日制剂极量乘疗程（硬上限 1,000），单次剂量结合频次同步核验单次与单日极量；住院 `PRN` 医嘱开立按每日最多 4 次的保守上界核算单日极量，并在上海时区单个业务日内严格限制同一医嘱非取消 `PRN` 任务不超过 4 次且累计制剂不超过单日极量（临时 `PRN` 最多 1 次）。

药事安全拒绝在门诊返回 `PRESCRIPTION_*`、在住院返回 `MEDICATION_*` 细分原因并保留用户输入；其中绝对药事／肾功能红线（不可越权）与缺血肌酐或无细菌指征抗菌药等第二层临床路径警示（支持受审计 `Clinical Override`）的分层边界见[临床决策支持与质控](clinical-decision-support.md#四大责任关口与红线警示双层规则)，共享规则设计见[共享声明式药事安全决策](../decisions/implemented/architecture/2026-11-13-shared-medication-safety.md)。

## 药房集中调剂发药与已证明库存增量

药房在调剂阶段按先到期先出或场景批次策略分配真实库存批次，不要求医生在处方或医嘱开立阶段绑定物理批号；每次实际调剂均原子创建 `MedicationDispense` 与不可变库存流水 `InventoryMovement`，严禁覆盖历史库存移动记录。

门诊药房仅受理 `Encounter` 已完诊、未撤回且费用（含患者实收与有效医保覆盖）已收齐的本院处方；完成发药后触发统一的 `Scenario Run` 完成条件检查（若仍存在未完诊门诊、未归档住院、待转收住院证或未结清的门诊检查取消退款责任，则保持 `Scenario Run` 为 `active`）。已发药项目在办理退费前必须先满足退药或受控豁免条件。

住院药师可在同一患者、同次住院内集中核对最多 20 张待发药执行任务，逐项审阅药品、完整制剂剂量、目标库存批次与计划执行时点后按序调用 `inpatient.dispense` Command：每单独立校验医嘱有效状态、任务状态与批次库存 CAS，原子写入 `MedicationDispense`、库存扣减流水以及按 `dispense` 触发点计收的住院药品账项（归属发生时患者所在科室），但不生成 `MedicationAdministration` 给药事实。同一集中办理批次内的后续项目仅认可本批前序回执已证明成功的库存扣减增量；一旦检测到外部并发库存变动则要求刷新重审，遇到网络未知结果立即暂停余项并在查明原回执后重新核对。

## 病区护士校对、集中核停与实际给药执行

### 新医嘱集中校对与停嘱理由集中核停

病区护士可在同患者、同次住院内集中校对最多 20 条 `signed` 新医嘱（不与停嘱核对混办），逐条审阅药品或护理项目、途径、剂量、频次及长期／临时／PRN 属性后顺序执行 `inpatient.order.verify`，校验当前科室病区责任、在院状态与医嘱预期版本，生成首轮待执行 `Task` 与校对审计，不产生发药、给药或收费事实。

主管医生申请停嘱（`request-stop`）与病区护士核停（`verify-stop`）各自支持同患者、同次住院最多 20 条集中办理：医生可填写共同停嘱理由并逐项覆盖（显式清空某项覆盖将保持空值并阻止提交），停嘱事务立即冻结该医嘱的新任务展开、药房发药与护士给药，并将 `stopReason` 同步投影至原 `MedicationRequest` 或 `ServiceRequest` 的 `note.id=clinmesh-stop-reason`（历史无标记记录在界面明确显示理由缺失，仍允许按权限正常核停）；护士核停展示原医嘱、停嘱理由及受影响任务，将尚未执行的 `pending` 与已发未给的 `dispensed` 任务明确置为 `cancelled`，同时完整保留已发生的发药记录、库存扣减、已完成给药与历史费用，绝不自动退回药房库存（收费员在首次结算封账前可对错收账项执行关联原账的全额反向冲正）。患者处于 `discharge-pending` 待出院期间仍开放申请停嘱与护士核停；一旦财务结算关闭、病案归档或转出当前病区责任范围则拒绝写入。

### 实际给药、健康教育完成与按需 PRN 发起

病区护士的实际给药（`inpatient.execution.administer`）、健康教育／护理服务完成（`inpatient.execution.complete`）与按需 `PRN` 发起（`inpatient.execution.request-prn`）是三类严格分立的连续办理动作，各自上限 20 项（每页 10 项）：

- **逐项核实前置**：给药与健康教育必须先由护士逐项核实临床已实际发生的事实后才开放勾选，不设默认勾选，也不提供跳过逐项核实的全选捷径；给药要求对应任务已完成药房实际发药且到达执行时点，成功后创建一次对应的 FHIR R5 `MedicationAdministration`（绝不预建 `completed` 给药资源充当排班计划）；健康教育完成后结清原 `Task` 并在同一事务按 `execution` 触发点记入住院服务费用。
- **PRN 显式理由发起**：`PRN` 发起支持共同理由与逐项覆盖（空理由阻止提交），仅创建带本次理由的 `pending` 执行记录与待执行 `Task`（药品 `PRN` 继而进入药房待发药队列），不直接产生给药完成或收费事实。
- **离院／归档后的只读回执收敛**：病例进入 `discharge-pending`、已出区或已归档只读状态后，若浏览器本地仍留有未提交草稿或未决原写意图，仍允许打开只读清单清理本地私稿或查询结清历史原回执（回执返回 `404` 且病例已非在院可写时保留原键禁止重发，遵循[连续办理私稿与逐项原回执恢复](clinical-workflows.md#连续办理私稿与逐项原回执恢复)）。
