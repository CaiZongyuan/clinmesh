---
name: clinmesh-inpatient
description: ClinMesh 住院登记、诊断、医嘱校对执行、发药给药、检查检验、转科交接、手术、出院结算和病案审核归档 CLI 工作流。用于登记员、负责门诊医生、住院医生、病区护士及病案、药师与收费岗位的住院事实读取与已授权操作。
---

# ClinMesh 住院

先读 [`../clinmesh-shared/SKILL.md`](../clinmesh-shared/SKILL.md)。以受信岗位读取目录和住院事实；住院医生与病区护士只操作自己科室、病区。跨岗位交接必须使用对应 Grant。

下方带 `--yes` 的财务命令为 human mode 示例；Agent mode 省略此标志，按 shared Skill 的受信 Capability Grant 规则执行。

```bash
clinmesh inpatient catalog
clinmesh inpatient list
clinmesh inpatient read --admission-id <admission-id>
clinmesh operations schema inpatient.admission.read
clinmesh operations schema inpatient.admission.register
```

判断欠费时读取住院概要的 `outstandingFen`：正数为当前尚应收整数分，0为当前无待收，`null` 表示资金或医保待确认；旧回执缺失该字段时刷新当前概要。待确认时先由收费员核对原尝试或医保来源，确认后再审阅收退款。`chargesFen` 与 `depositFen` 分别保留费用及预交金，不能相减作为当前欠费；首次结算及归档后仍以当前摘要核对后续更正，不把已归档解释为永远无欠费。完整资金明细继续按岗位授权读取。

默认环境为一个住院科、一个病区，住院医生与护士各一个默认岗位。目录的 `acceptingAdmissions=true` 表示可接收新的直接入院、转院登记或新签发住院证；旧病区仍可查询但不作为这些新意图的目标，错误为 `INPATIENT_WARD_UNAVAILABLE`。已签发住院证继续使用其原 `wardId`，不因目录的新入院标记而修改原目标；原岗位仍负责旧住院与转科任务，不能用显示去重或默认配置替代授权。

登记员先搜索合成患者，直接入院或转院时填写原受信 context 的 `expectedEpoch`、`patientId`、`patientVersion`、`admissionRoute`、`wardId`、整数分 `depositFen`。门诊转收使用负责门诊医生已开出的住院证，`admissionRoute=outpatient` 并传 `referralId`；住院证不可重复转收。每次住院分配独立住院号。零预交金不形成资金交易；正数预交金随登记原子入账。同一意图重试保留完整原输入（包括 `expectedEpoch`、患者和原预期版本）与同一幂等键，先查询原 Command receipt；新入院标记变化不改变原键重放合同。`expectedEpoch` 仅为事务前置断言，不能选择 Workspace 或 Epoch；场景已变化时原意图返回 `INPATIENT_EPOCH_CONFLICT`，核对原住院与费用事实后才能开始新意图。

`admission.json` 的直接入院示例；首次提交前用受信 context、患者及病区读取结果替换示例值，恢复原意图时保持原文件不变：

```json
{
  "expectedEpoch": "epoch-1",
  "patientId": "synthetic-patient",
  "patientVersion": "1",
  "admissionRoute": "direct",
  "wardId": "ward-general",
  "depositFen": 100000
}
```

```bash
clinmesh inpatient referrals
clinmesh inpatient register --input @admission.json --idempotency-key <key>
clinmesh inpatient refer --input @referral.json --idempotency-key <key>
```

住院证由负责门诊医生使用本次 `encounterId`、`encounterVersion`、目标 `wardId` 与 `reason` 开具。病区护士接诊和转床传 `admissionId`、当前 `encounterVersion` 与目录返回的 `bedId`；换床传两次住院的 ID 与版本。只允许同病区转床、换床，冲突时重新读取两次住院；不得改变幂等键盲重试。转科是单独工作流。

```bash
clinmesh inpatient receive --input @bed.json --idempotency-key <key>
clinmesh inpatient move-bed --input @bed.json --idempotency-key <key>
clinmesh inpatient swap-bed --input @swap.json --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.admission.receive --idempotency-key <key>
```

虚拟时间由场景控制人工推进，医院业务 Grant 不拥有时钟权限。床位费只在上海业务日午夜由场景推进触发，不由读取队列或真实时间流逝触发。

## 诊断、医嘱与执行

管理员可读取 `pci-data`，核对固定版本的合成病例底稿、药耗、检验、编码、来源报价及合成补充后，用当前受信 `expectedEpoch` 准备首例资料。住院医生只读该资料。准备只补院内目录和基础库存，实际患者及就诊由正常业务另行建立；重复准备保留既有库存余额、明确价格与业务事实。

```bash
clinmesh inpatient pci-data
clinmesh inpatient prepare-pci-data --expected-epoch <epoch> --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.pci-data.prepare --idempotency-key <key>
```

`INPATIENT_PCI_EPOCH_CONFLICT` 要求核对当前场景后再决定新意图，不能为恢复原请求替换 Epoch；响应丢失先查原 Command receipt，保留原完整输入和幂等键。`groupingTarget` 是后续核验的目标病组，底稿及准备结果不表示已经实施手术、完成分组或产生模拟核定。

先读取本次住院的当前状态、正式诊断、医嘱和任务。住院医生按 [clinmesh-doctor 的 Reference 检索示例](../clinmesh-doctor/SKILL.md)检索已安装的完整诊断 Reference Catalog；确认时只提交目录 ID、主次、明确入院病情及备注，server 解析并冻结编码、版本、来源定位和当时 Release。目录不可用时保留显式合成院内目录，不把其修订号当作国家临床版本。

```bash
clinmesh inpatient catalog-search --kind medication --source hospital --page 1 --page-size 20
clinmesh inpatient catalog-search --kind laboratory --source reference --query 血常规 --page 1 --page-size 20
clinmesh inpatient clinical-catalog
clinmesh inpatient clinical --admission-id <admission-id>
clinmesh inpatient confirm-diagnosis --input @diagnoses.json --idempotency-key <key>
clinmesh inpatient issue-order --input @order.json --idempotency-key <key>
clinmesh inpatient verify-order --input @verification.json --idempotency-key <key>
clinmesh inpatient request-stop-order --input @stop.json --idempotency-key <key>
clinmesh inpatient verify-stop-order --input @verification.json --idempotency-key <key>
clinmesh inpatient request-prn --input @prn.json --idempotency-key <key>
clinmesh inpatient dispense --input @dispense.json --idempotency-key <key>
clinmesh inpatient administer --input @execution.json --idempotency-key <key>
clinmesh inpatient complete-service --input @execution.json --idempotency-key <key>
clinmesh inpatient reverse-charge --input @reversal.json --idempotency-key <key>
```

`catalog-search` 的 `kind` 为 `medication` 或 `laboratory`，`source` 为 `hospital` 或 `reference`；两来源分别分页，`pageSize` 最大 50。候选返回 `available`、`incomplete` 或 `inactive`，`missingFields` 列明缺项。只用 `available` 返回的 `catalogItemId/catalogVersion` 开立；Reference ID、同名产品或不唯一映射不能替代院内身份。查询失败时保留失败原因并重新查询，空结果不表示加载成功前可自行补造项目。

每个文件使用受信读取结果的 `admissionId`。诊断确认传 `encounterVersion`、`expectedRevision` 与恰好一个 primary 的 `entries`；每项必须显式选择 `admissionCondition`（`1`有、`2`临床未确定、`3`情况不明、`4`无），输入顺序保存在正式确认中，不根据备注或日期推断病情；签发传当前 `encounterVersion`、`duration` 和受控 `selection`。药品选择含目录 ID/版本、医生本次填写的 `doseText`、`frequencyCode`、每次 `doseQuantity`；数量以目录 `unit` 计，质量单位按明确的 `doseBasis` 换算为整数制剂数量，并受 `maxDoseQuantity` 约束。`doses` 是常用建议，未填写本次剂量由医嘱表单提示。单位或含量不明确时先补资料；合成本院适应症、组合、过敏、剂量和频次不满足时不得换 ID 绕过。

`diagnoses.json` 合成示例；医生须按本次患者实际判断明确填写入院病情，并以受信读取的住院和版本替换示例值：

```json
{
  "admissionId": "synthetic-admission",
  "encounterVersion": "2",
  "expectedRevision": 0,
  "entries": [{
    "catalogItemId": "nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09",
    "role": "primary",
    "admissionCondition": "1"
  }]
}
```

校对及停嘱传 `orderId`、`expectedOrderVersion`；医生申请停嘱还需 `reason`。本院虚拟班次 QD 为上海时间08:00，BID为08:00与20:00；首日只生成护士校对时尚未过去的时点。临时医嘱一次执行，PRN仅由护士按已校对医嘱和理由显式请求，时钟推进不自动执行PRN。班次是本院仿真策略，不代表全国统一用药时间。

药师使用独立药房清单与详情；这些响应只含药嘱、执行单、相关批次、实际发药与有效药物过敏风险，不含诊断备注、服务医嘱、预交金或账目。旧 `catalog/list/read/clinical-catalog/clinical` 不授权药师。收费员从 `charges` 读取真实项目标签、逐项金额、冲正关联、净额和财务状态，不能读取 `clinical`。

```bash
clinmesh inpatient pharmacy-list
clinmesh inpatient pharmacy-read --admission-id <admission-id>
clinmesh inpatient charges --admission-id <admission-id>
clinmesh command receipt get --operation-id inpatient.execution.dispense --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.charge.reverse --idempotency-key <key>
```

发药结果及其 receipt 使用与 `pharmacy-read` 相同的窄 `data`；冲正结果及其 receipt 使用与 `charges` 相同的窄 `data`。receipt 仍绑定原岗位、操作者、Grant 和原幂等键，不能用其他岗位恢复。

药师按实际执行单发药，传 `executionId`、`expectedExecutionVersion` 和各 `lotId/expectedVersion/quantity`；合计必须等于一次执行所需数量。server 原子扣共享库存并形成 MedicationDispense；护士给药仍要单独提交执行单 ID与版本，形成引用医嘱和实际发药的 MedicationAdministration。未校对、未发药或尚未到期不能给药。通用服务完成只覆盖目录声明的健康教育，不替代检验或影像执行。

停嘱申请立即冻结新的任务、发药与给药；护士核停将尚未执行及已发未给的任务明确取消，保留历史发药、给药、费用与库存，不自动退药。收费员冲正传原 `chargeId`、`expectedChargeVersion` 与理由；反向账项关联原费用，不能传任意金额，已结算、已冲正或对冲正再冲正均拒绝。结果未知时先查询原 operation 的 receipt，保持原完整输入及原幂等键，不因刷新得到新版本而重写旧意图。

## PCI 参数确认与候选依据

```bash
clinmesh inpatient pci-selection --admission-id <admission-id>
clinmesh inpatient confirm-pci-selection --input @pci-selection.json --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.pci-selection.confirm --idempotency-key <key>
```

医生在本次住院确认 `admissionId/expectedVersion/parameters`，首次版本为0；修改使用当前 `confirmation.version`。`parameters` 包含治疗方向 `treatmentPlan`、靶部位 `targetSite`、可选本次有效 `requestId`、`measurements`、`plannedQuantities` 及医生认可的具体 `approvedMaterialIds`。测量分别保存 `kind/object/site/value/unit/method` 和 `source.reference/version/note/synthetic`；缺少测量保留空数组，未知数值或单位为null，不能由耗材规格倒推。数量逐类保存 `category/quantity/basis`，不从DRG差额推算。

读取返回当前确认和历史版本，以及本院实际安装的候选、产品版本、合成适用／兼容依据、独立数量计划、预计收费和 `missing`。仅 `eligibility=valid` 可作为后续建议输入；其他状态为 `incomplete/inapplicable/unavailable`，来源价格不能证明临床适用。当前依据仅支持明确标识的有限单病变合成仿真，不是真实器械IFU或临床金标准。本步骤不调用模型、不完成手术、不产生费用。结果未知时保持原输入、原版本及原key，先查询原receipt。

## 单次耗材预计、工作稿与整批确认

保存支持的冠脉造影／PCI 手术计划时，server 在同一事务留下单次预计意图，无需开启住院跟进。先读取 `material-estimates`，复用服务端结果与工作稿；查询本身不派发模型。历史计划列在 `unprepared`，由医生显式 `request-material-estimate` 补建，`expectedVersion=0`；已有预计重新生成时使用当前预计版本、计划版本及 `basisFingerprint`。

```bash
clinmesh inpatient material-estimates --admission-id <admission-id>
clinmesh inpatient request-material-estimate --input @material-estimate-request.json --idempotency-key <key>
clinmesh inpatient cancel-material-estimate --input @material-estimate-cancel.json --idempotency-key <key>
clinmesh inpatient save-material-estimate --input @material-estimate-draft.json --idempotency-key <key>
clinmesh inpatient confirm-material-estimate --input @material-estimate-confirm.json --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.material-estimate.request --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.material-estimate.cancel --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.material-estimate.save --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.material-estimate.confirm --idempotency-key <key>
```

`queued/running` 等待原尝试；`incomplete` 先核对 `missing`，补齐真实缺项后自动待办可继续准备。PCI 只采用本次计划已正式确认的 `pciSelection`，测量和独立数量依据缺失时由医生核实。造影采用独立的有限合成方案；具体支持范围见[单次预计合同](../../docs/architecture/clinical-workflows.md#手术计划的单次耗材预计)。`blocked/failed` 读取 `failureCode`，未配置或不记账的模型会在派发前阻断；`unknown` 保留原尝试，先核查原结果，不能换 key 重新预计。`stale/cancelled` 保留历史，核对当前计划、依据和授权后再决定新意图。模型失败或缺参数不阻止正常手术工作流。

第一份有效分析仅在尚无工作稿时初始化 `draft`。医生修改通过 `save-material-estimate` 保存到服务端，使用预计 `expectedVersion`、`expectedDraftRevision` 和当前 `expectedBasisFingerprint`；首次工作稿修订为0。刷新或同库重启后继续读取该稿。显式重新预计保留手改稿，新分析放在 `candidateItems`；医生审阅后以新 `analysisId` 保存采用，晚到结果不覆盖工作稿。人工准备时 `analysisId=null`，确认仍逐项核对当前候选的适用、兼容、目录版本与独立数量依据。

以下文件是独立合成形状示例。首次提交前，将 ID、版本及示例 hash 换成当前受信读取结果；各示例版本不能作为临床默认值。恢复已提交意图时保留其原文件与原 key。

`material-estimate-request.json`，为 `unprepared` 计划补建预计：

```json
{
  "admissionId": "synthetic-admission",
  "requestId": "synthetic-request",
  "expectedRequestVersion": 1,
  "expectedVersion": 0,
  "expectedBasisFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

`material-estimate-cancel.json`，取消当前预计并保留原尝试和工作稿：

```json
{
  "admissionId": "synthetic-admission",
  "requestId": "synthetic-request",
  "expectedRequestVersion": 1,
  "expectedVersion": 1,
  "expectedBasisFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

`material-estimate-draft.json`，正式计划为 `88.5600` 且当前候选已核验两根合成造影导管时的人工稿：

```json
{
  "admissionId": "synthetic-admission",
  "requestId": "synthetic-request",
  "expectedVersion": 1,
  "expectedDraftRevision": 0,
  "expectedBasisFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "analysisId": null,
  "items": [{ "materialId": "hospital-material-catheter", "catalogVersion": 1, "quantity": 2, "reason": "已核对本次合成双导管造影方案" }],
  "note": "合成医生人工核对稿"
}
```

确认前重新读取 `material-estimates`、`surgeries`、住院概要和 `drg-reservations`，核对同计划全部活动预留及其版本。将同一次预留读取响应中 `reservationSets` 对应 `requestId` 的 `fingerprint` 原样作为 `expectedReservationFingerprint`；无活动预留时也使用该计划的空集合指纹，不自行计算或逐项回传旧记录。已开始手术或存在已消耗的预留时转入实际用量工作流。服务端在一个 Command 中核对并替代完整原清单，保存确认关系，任一项失败整批回滚；单位、规格和价格冻结在预留。`confirmedRevision/reservationIds` 用于回查确认结果，同修订重复确认返回 `INPATIENT_ESTIMATE_ALREADY_CONFIRMED`。`stale/cancelled/unknown/queued/running` 不能确认；`incomplete/blocked/failed` 仅在人工保存的每项均独立核验有效且数量符合当前依据时可确认。预计、工作稿与预留均不产生实际使用、库存移动或正式费用。

`material-estimate-confirm.json`，首次确认且同计划无活动预留：

```json
{
  "admissionId": "synthetic-admission",
  "requestId": "synthetic-request",
  "expectedVersion": 1,
  "expectedDraftRevision": 1,
  "expectedBasisFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "expectedRequestVersion": 1,
  "encounterVersion": "2",
  "expectedReservationFingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "reason": "医生已核对合成预计清单与当前依据"
}
```

同计划的手工整批预留调整使用下面的独立入口，逐项核对当前目录和原预留，原样提交同次读取中该计划的集合指纹；`items=[]` 表示明确释放该已审阅集合的全部原预留。该入口与预计确认复用同一事务内替代模块，保留其他计划及未绑定预留。

```bash
clinmesh inpatient replace-material-reservations --input @material-reservations.json --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.drg.reservation.replace-batch --idempotency-key <key>
```

`material-reservations.json`：

```json
{
  "admissionId": "synthetic-admission",
  "requestId": "synthetic-request",
  "expectedRequestVersion": 1,
  "encounterVersion": "2",
  "items": [{ "materialId": "hospital-material-catheter", "catalogVersion": 1, "quantity": 2, "reason": "已核对合成造影方案与当前目录" }],
  "expectedReservationFingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "reason": "医生明确替代本计划全部原预留"
}
```

`INPATIENT_ESTIMATE_CONFLICT` 表示预计、工作稿、计划或依据已变化，重新读取差异并由医生审阅；`INPATIENT_RESERVATION_CONFLICT` 表示预留集合已变化或存在部分使用，重新读取并核对变化，不静默换用新指纹重试；`INPATIENT_DRG_PLAN_UNSUPPORTED` 要求核实候选及数量依据。响应丢失先查对应 operation 的原 receipt，保留原完整输入（包括原集合指纹）和原幂等键。

## 持续跟进中的耗材建议与人工确认

```bash
clinmesh inpatient drg-agent --admission-id <admission-id>
clinmesh inpatient confirm-drg-plan --input @drg-plan.json --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.drg.agent.confirm --idempotency-key <key>
```

医生开启住院跟进并确认本次有效手术计划的参数后，后台按完整依据版本生成并独立核验耗材建议；实际模型请求进入本住院任务的用量账。规则检查本身不产生模型请求。`status=incomplete/stale/blocked/unknown/failed` 时先读取 `missing/failureCode`，未知结果保持待核查，不新建任务或换幂等键重发。停止、失权或归档后只保留历史结果，不继续临床分析。

确认输入为 `admissionId/analysisId/expectedBasisFingerprint/expectedRevision/items/note`，首次计划修订为0；`items` 逐项提供 `materialId/catalogVersion/quantity/reason`。以最新 `basisFingerprint` 和产品版本为准，保留医生独立数量依据；超出当前核验范围时先更新参数并核查依据。`confirmedPlan/planHistory` 保留每次人工确认，确认计划不提交正式手术、医嘱、预留或收费。结果未知时查询原 receipt，保持原输入和原 key。

## 手术计划、准备与实际实施

```bash
clinmesh inpatient surgery-catalog
clinmesh inpatient surgeries --admission-id <admission-id>
clinmesh inpatient request-surgery --input @surgery-request.json --idempotency-key <key>
clinmesh inpatient check-surgery-preop --input @surgery-preparation.json --idempotency-key <key>
clinmesh inpatient confirm-surgery-consent --input @surgery-preparation.json --idempotency-key <key>
clinmesh inpatient start-surgery --input @surgery-start.json --idempotency-key <key>
clinmesh inpatient record-surgery-material --input @surgery-material.json --idempotency-key <key>
clinmesh inpatient correct-surgery-material --input @surgery-correction.json --idempotency-key <key>
clinmesh inpatient complete-surgery --input @surgery-complete.json --idempotency-key <key>
clinmesh inpatient execute-surgery --input @surgery-execution.json --idempotency-key <key>
clinmesh inpatient cancel-surgery --input @surgery-preparation.json --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.surgery.execute --idempotency-key <key>
```

住院医生申请传本次 `admissionId/encounterVersion`、目录 `procedureId/catalogVersion`、不早于当前虚拟时间的 `plannedFor` 和 `reason`。计划只创建 ServiceRequest，不产生已实施事实或费用，场景推进也不自动执行。目录是临床版 ICD-9-CM-3 工作表3.0的固定八条来源摘录，保留前导零、点和扩展后缀、类别、项目摘录Release与来源定位；不是全量、最新版或医保版目录。院内收费ID与临床分类码分开，价格明确为合成演示价，不得将分类编码当成收费项目ID提交。

`surgery-catalog`（operation v2）的 `materials` 保留原两项合成材料及231条心血管参考记录。新增项的 `reference` 包含来源、原字段、地区与期限、单位/规格缺项；`reference.priceFen` 为表内中选价，`baseSupplyPriceFen` 为独立的基准品拟供应价，不替代中选价。只有带 `chargeDefinition` 的条目可用于实际实施：52条明确单位的记录按表内中选价制定合成本院演示价；`unavailableReason=unit-unconfirmed` 的179条没有收费定义，单位为null，保留参考价格但不能使用，不推测单位。来源包含历史采购参考及地区限制，不代表当前实际医院价格。

护士以 `check-surgery-preop` 记录术前检查核对，医生以 `confirm-surgery-consent` 记录对已签署知情同意书的确认；这是可审计的确认事实，不提供真实电子签名。两个动作与取消均传 `requestId/expectedRequestVersion/note`，两项准备均完成才能执行。准备和执行按当前住院科室及病区责任授权，原申请作者身份不会阻止合法接管。

执行传 `admissionId/requestId/expectedRequestVersion`、实际 `procedureId/catalogVersion`、`note` 和 `materials`；耗材每项为 `materialId/catalogVersion/quantity`，未使用时显式空数组。实际术式可以不同于申请，server 按实际目录冻结手术及耗材价格，原子保存唯一 Procedure、用料、逐项账项与审计。不得传任意收费金额，不推断未记录耗材或手术；原始实施不能取消删除；独立财务冲正仍走收费员原费用关联入口，临床耗材记录更正沿下述窄 Command 办理。未实施未取消申请阻断出院。

术中逐笔入口复用同一住院、申请和实际 Procedure。`start-surgery` 传 `admissionId/requestId/expectedRequestVersion/note/procedureId/catalogVersion`，两项准备齐全后创建 `inProgress`，不登记耗材、不收术式费，也不完成手术。`surgeries.executions` 只包含已完成操作；`inProgress` 不可用于术后医嘱或首页主操作。已经开始的申请不能再取消、重做准备或走一次性 `execute-surgery`；旧一次性接口仍要求预留整笔原样替换。

`record-surgery-material` 传当前申请版本、`executionId/note` 和单个 `material`：`materialId/catalogVersion/quantity`，引用预留时另带 `reservationId/expectedReservationVersion`。每笔立即按共享收费 owner 记费，不完成术式；同产品可分多笔。预留的原数量保留，`consumedQuantity/remainingQuantity/version` 分别表达已消耗、尚未使用和当前版本；只把剩余预留计入费用推演。全耗尽才为 `replaced`，额外使用显式不引用预留。预留版本、归属、产品、单位或余量冲突均拒绝，不跨版本取价。

`correct-surgery-material` 传当前申请版本、`executionId/materialUseId/note`，可附 `replacement`（形状同 `material`）。不带 replacement 表示撤销错误记录；带 replacement 追加正确使用。原记录保存在 `materialHistory`，仅 `materials` 表达当前有效使用。`correction` 引用原费用、精确冲正和替代使用 ID；已有收费员冲正时只引用、不再次冲正。更正允许术中及术后账户尚开放、病案未归档时办理，不代表实际取出器械或退库存，不修改既有原始数量或收费金额。单独财务冲正不自动更正临床使用事实，记录／费用疑点仍需核实。

`complete-surgery` 传当前申请版本、`executionId/note`，完成同一 Procedure，只追加一次术式费，不重记已登记耗材。明确绑定该申请的未用预留余量收拢为 `released` 并保留 `releaseReason`；不释放未绑定的住院后续治疗预留。术后更正退回的该手术余量继续收拢，不恢复已结束的预留。每个写入均需原幂等键，结果未知先查对应 operation receipt；`INPATIENT_SURGERY_CONFLICT`、`INPATIENT_RESERVATION_CONFLICT` 要求重新读取和审阅，不能改写未知意图的输入或换键重做。

术后医嘱仍使用 `issue-order`（operation v2），附可选 `surgeryExecutionId`；只能引用 `surgeries.executions` 中本次住院实际完成的 ID，申请ID、已取消计划、既往史及其他住院实施ID均拒绝。医嘱继续原护士校对、药师发药和护士给药流程，不因术后关联而自动执行。结果未知时保持原输入、原版本和同一key，先查 `inpatient.surgery.execute` 原receipt，不能刷新版本换key重复实施或计费。

`surgery-execution.json` 合成示例；首次提交前以本次读取的申请、版本、实际术式及实际用量替换，恢复时保持原文件不变：

```json
{
  "admissionId": "synthetic-admission",
  "requestId": "synthetic-surgery-request",
  "expectedRequestVersion": 3,
  "procedureId": "hospital-surgery-5",
  "catalogVersion": 1,
  "note": "合成示教实际实施记录",
  "materials": [{
    "materialId": "hospital-material-suture",
    "catalogVersion": 1,
    "quantity": 2
  }]
}
```

## 检查检验与转科

```bash
clinmesh inpatient investigation-catalog
clinmesh inpatient investigations --admission-id <admission-id>
clinmesh inpatient issue-investigation --input @investigation.json --idempotency-key <key>
clinmesh inpatient send-investigation --input @investigation-action.json --idempotency-key <key>
clinmesh inpatient cancel-investigation --input @investigation-action.json --idempotency-key <key>
clinmesh inpatient retry-investigation --input @investigation-action.json --idempotency-key <key>
clinmesh inpatient acknowledge-investigation --input @report-acknowledgement.json --idempotency-key <key>
```

住院医生只从 `investigation-catalog` 选择 `available=true` 且有明确 `priceFen` 的项目。`unavailableReason=unpriced` 表示尚未声明住院价格，不表示免费；基础 WBC/HGB/CBC 的本院合成价分别为800/800/2500分，其他已声明的正数住院价按原目录执行，不宣称国家收费标准。开立固定目录版本、收费定义、执行完成触发点和本次住院的合成病例来源；无来源患者不支持生成报告，不使用其他病例或 Scenario 的正常结果代替。

`investigation.json` 合成示例；用当前受信读取的住院版本和可开展目录版本替换示例值：

```json
{
  "admissionId": "synthetic-admission",
  "encounterVersion": "2",
  "catalogVersion": 1,
  "selection": {
    "kind": "imaging",
    "serviceId": "imaging-chest-radiograph",
    "indication": "咳嗽两周，评估肺部情况"
  }
}
```

检验选择为 `kind=laboratory`、`catalogItemId` 和目录允许的 `indicationCode`。医生开立后保持待送检，病区护士校对并送检才进入原 LIS/RIS 申请内核。操作文件传 `admissionId/requestId/expectedRequestVersion/serviceRequestVersion/taskVersion`；已阅另传当前 `diagnosticReportId/diagnosticReportVersion`，影像须当前可读取。仅未送检或明确生成失败的申请可取消；已送检在途申请继续完成。来源不相容或不支持的检验不可重试，须取消。报告更正保留原报告和已阅事实，不再次收执行费。

```bash
clinmesh inpatient transfer-catalog
clinmesh inpatient transfers --admission-id <admission-id>
clinmesh inpatient incoming-transfers
clinmesh inpatient request-transfer --input @transfer.json --idempotency-key <key>
clinmesh inpatient handover-transfer --input @transfer-action.json --idempotency-key <key>
clinmesh inpatient receive-transfer --input @transfer-receive.json --idempotency-key <key>
clinmesh inpatient cancel-transfer --input @transfer-action.json --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.investigation.issue --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.transfer.receive --idempotency-key <key>
```

转科依次由医生申请、原病区护士交接、目标病区护士接收。目标护士从 `incoming-transfers` 读取接收所需身份、原因和任务版本；普通住院详情仍按当前科室限制，不借转科任务读取未接收患者的诊断或账目。交接及接收前原科医嘱须停嘱并核停，未执行任务明确取消，未送检申请须送检或取消，未实施手术须完成或取消。已发未给的取消保留实际发药、库存和费用；已送检的检查在途报告继续归本次住院，由新科责任医生处理。

转科申请传 `admissionId/encounterVersion/targetWardId/reason`；交接和取消传 `admissionId/encounterVersion/transferId/expectedTransferVersion`，接收另传目标病区空床 `bedId`。接收事务再次核验全部前置条件，并一起切换床位占用、科室、病区和 Encounter；旧科随后无权读写，新执行与床费归新科，既往费用不改。重复与结果不明继续保留完整原输入和同一幂等键，先查原 receipt，不换版本盲重发。

## 出院、结算、清床与召回

```bash
clinmesh inpatient discharge-events --admission-id <admission-id>
clinmesh inpatient issue-discharge --input @discharge.json --idempotency-key <key>
clinmesh inpatient depart --input @departure.json --idempotency-key <key>
clinmesh inpatient settlement-preview --admission-id <admission-id>
clinmesh inpatient payments --admission-id <admission-id>
clinmesh inpatient preview-payment --input @inpatient-payment.json --idempotency-key <key>
clinmesh inpatient confirm-payment --input @inpatient-confirmation.json --idempotency-key <key> --yes
clinmesh inpatient recover-payment --input @inpatient-payment-recovery.json --idempotency-key <key> --yes
clinmesh inpatient preview-refund --input @inpatient-refund.json --idempotency-key <key>
clinmesh inpatient confirm-refund --input @inpatient-confirmation.json --idempotency-key <key> --yes
clinmesh inpatient recover-refund --input @inpatient-refund-recovery.json --idempotency-key <key> --yes
clinmesh inpatient settle --input @settlement.json --idempotency-key <key> --yes
clinmesh inpatient clear-bed --input @discharge.json --idempotency-key <key>
clinmesh inpatient recall --input @discharge.json --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.discharge.settle --idempotency-key <key>
```

医生开出院医嘱只进入 `discharge-pending`，不出区、不结算、不释放床位。`discharge.json` 传 `admissionId/encounterVersion/reason`；护士出区使用相同字段，并显式选择 `departureMethod`：`home`医嘱离院、`transfer`医嘱转院、`against-advice`非医嘱离院、`death`死亡、`other`其他。这是本院仿真字段，不宣称国家上报编码。出院医嘱、出区及结算都重查未收口手术、检查检验和转科；检查已reported但未阅可放行，不套用门诊全已阅门禁。出区前医嘱须全部 stopped/completed，任务全部 completed/cancelled；待出院仍允许医生申请停嘱和护士核停，禁止新增、校对和执行医嘱。已发未给任务可核停取消，保留发药、库存和费用，不强迫补给药或自动退库存。尚未出区期间继续产生声明的床日费，实际出区后停止。

收费员只能读取窄财务和资金记录，不能读取出院临床说明或离院方式。`payments` 读取当前首次结算的原款、成功收退款、剩余差额及未知尝试。登记原预交金继续有效；追加预交金用 `kind=deposit`，已出区补缴用 `kind=supplement`，输入正整数分 `amountFen` 与合计相等的 `tenders`（cash、bank-card、mobile各最多一项）。合成渠道显式选 `simulatorRule`：success、decline、ambiguous、ambiguous-decline或ambiguous-pending。先预览，再将响应的 `admissionId/previewId/commitToken` 写入确认文件；确认只消费原预览，不能追加金额或方式。

单笔退款上限为 `1_000_000_000` 分（1000万元），超限请求在预览时拒绝，大额须分多次退。每次重新读取剩余应退差额及原款余额，再预览、审阅并确认；未知结果先恢复原尝试。默认现金结清的差额超过该单笔上限时返回 `INPATIENT_FUNDS_REQUIRED`，先分次办理收退款再重新预览结算。

`inpatient-refund.json` 为单笔上限示例，首次提交前替换实际住院及原款ID：

```json
{"admissionId":"synthetic-admission","sourceId":"synthetic-payment","amountFen":1000000000,"simulatorRule":"success"}
```

`inpatient-payment.json` 合成示例，首次提交前替换本次住院ID：

```json
{
  "admissionId": "synthetic-admission",
  "kind": "deposit",
  "amountFen": 10000,
  "tenders": [{ "method": "cash", "amountFen": 4000 }, { "method": "mobile", "amountFen": 6000 }],
  "simulatorRule": "success"
}
```

退款预览传本次 `admissionId`、`payments.sources` 返回的原款 `sourceId`、正数 `amountFen` 与 `simulatorRule`；须在已出区、未封账窗口且不超过应退差额和原款可退余额。成功补缴也可作为原款，退款按冻结方式分配，保留原入金。收款恢复文件传 `admissionId/paymentId/expectedPaymentVersion`，退款恢复传 `admissionId/refundId/expectedRefundVersion`；恢复查询原尝试，不能换key重收退。`ambiguous` 不计成功资金，并占用退款原款；未知时 `INPATIENT_FUNDS_PENDING` 阻止新收退款和封账，但医生出院医嘱、护士出区仍按原临床条件办理。拒绝释放占用，持续未知保留原尝试继续查询。

首次结算前读取 `settlement-preview`，保留完整 `encounterVersion/fingerprint/chargesFen/balanceFen`；该预览仍展示费用与原预交金的原始补退口径，实际尚应收退以 `payments.remainingFen` 为准。已有独立收退款尝试时，须先使剩余差额为零，再明确重新预览并封账；`INPATIENT_FUNDS_REQUIRED` 要求继续按差额收退。尚无独立尝试的旧结算调用保留人工审阅后默认现金结清兼容；已有拒绝或未知时不能走默认路径绕过。使用 `settlement.json` 提交：

```json
{
  "admissionId": "synthetic-admission",
  "encounterVersion": "4",
  "fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "expectedChargesFen": 5000,
  "expectedBalanceFen": -95000
}
```

示例指纹不可用于真实提交；首次提交前用实际预览替换，重试保持原文件不变。server 在 Command 事务重读逐项费用、冲正、资金与状态，校验原指纹及金额；Encounter版本不变或费用净额相同也不证明明细未变。`INPATIENT_SETTLEMENT_PREVIEW_STALE` 或 `INPATIENT_PAYMENT_PREVIEW_STALE` 要求重新审阅新明细并显式取得新预览后开始新意图。传输结果未知先查对应operation原receipt，继续原完整输入与原幂等键；渠道 `ambiguous` 则查询原资金尝试，两种恢复不能相互替代。已结算封账，普通新增或冲正费用拒绝；只有护士清床才释放床位。

召回只允许当前负责住院医生在已出区、未结算、未清床且原床仍由本次住院保留时办理；与结算竞争仅一个成功。召回追加关联原出区的逆向事件与床位 period，保留原出区时间、离院方式和审计，不恢复旧医嘱。结算后再次收治通过新的 register 创建独立住院。

## 病案首页、编码审核与归档

结算后的费用补计、冲减及原款收退款使用[后续财务更正](#结算清床及归档后的财务更正)，不通过普通临床写入或解档处理。

1. 用 `record` 读取四组核心字段、当前 `sourcesHash` 与首页 `revision`。诊断来自正式诊断确认，操作只来自本次实际执行；有实际操作时主管医生显式选 `mainProcedureExecutionId`，无操作时明确 `null`。需要补充出区后诊断时仍用 `confirm-diagnosis`，可在清床后未归档窗口纠正，其他医嘱、库存和资金动作不因此恢复。
2. 主管医生提交首页修订；病案人员核编码来源，针对同一修订与来源审核通过或附原因退回。临床版2022诊断保留完整编码、固定Release和来源定位；院内备用编码可提交待审稿，但须通过正式诊断入口更正后才可批准。临床版来源不证明医保等价或原始工作簿权威身份独立核验，操作3.0为有界摘录。
3. 归档要求已结算、已清床、核心字段完整、唯一主诊断、本次有效实际主操作、当前审核通过、无在途事项且账目资金一致。归档读取固定快照；归档后普通写入及报告更正拒绝，既有原receipt无写重放仍可用。当前Epoch内Scenario完成后人类会话仍可读归档；已失效Agent Grant不因此恢复。

```bash
clinmesh inpatient record --admission-id <admission-id>
clinmesh inpatient submit-record --input @record-submit.json --idempotency-key <key>
clinmesh inpatient review-record --input @record-review.json --idempotency-key <key>
clinmesh inpatient archive-record --input @record-archive.json --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.record.archive --idempotency-key <key>
```

`record-submit.json`（示例hash必须换成实际审阅后的来源指纹）：

```json
{
  "admissionId": "synthetic-admission",
  "expectedRevision": 0,
  "expectedSourcesHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "mainProcedureExecutionId": null
}
```

`record-review.json`：

```json
{
  "admissionId": "synthetic-admission",
  "expectedRevision": 1,
  "expectedSourcesHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "outcome": "approved"
}
```

`record-archive.json`：

```json
{
  "admissionId": "synthetic-admission",
  "expectedRevision": 1,
  "expectedSourcesHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

`INPATIENT_RECORD_STALE` 表示来源或修订变化，旧审核已失效；重新审阅事实，由医生提交新首页再审核。`INPATIENT_RECORD_CODING_UNSUPPORTED` 要求使用正式诊断确认更正固定编码。`INPATIENT_RECORD_ARCHIVED` 表示当前病案只读。结果未知先查同operation原receipt，保留原输入、修订/hash和幂等键；不能自动刷新hash或换key重做。

## 结算、清床及归档后的财务更正

首次结算后，收费员先读取 `financial-adjustments`，分别核对首次冻结费用、净资金和当前更正差异。病案人员可只读此差异；医生、护士、医保或管理员岗位不取得收退款权限。当前 Workspace/Epoch 的人类收费会话可在 active/completed Run 办理窄财务更正，closed Run 与失效 Agent Grant 不开放新写。

```bash
clinmesh inpatient financial-adjustments --admission-id <admission-id>
clinmesh inpatient adjust-finance --input @financial-adjustment.json --idempotency-key <key> --yes
clinmesh inpatient preview-financial-refund --input @financial-refund.json --idempotency-key <key>
clinmesh inpatient confirm-financial-refund --input @financial-confirm.json --idempotency-key <key> --yes
clinmesh inpatient recover-financial-refund --input @financial-refund-recovery.json --idempotency-key <key> --yes
clinmesh inpatient preview-financial-payment --input @financial-payment.json --idempotency-key <key>
clinmesh inpatient confirm-financial-payment --input @financial-confirm.json --idempotency-key <key> --yes
clinmesh inpatient recover-financial-payment --input @financial-payment-recovery.json --idempotency-key <key> --yes
clinmesh command receipt get --operation-id inpatient.financial.refund.confirm --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.financial.payment.confirm --idempotency-key <key>
```

`financial-adjustment.json` 引用本次住院有效的正数原费用，`direction` 为 `decrease` 冲减或 `increase` 补计，金额为正整数分。冲减不超过当前剩余费用。用当前读取指纹替换示例后，人工确认方向、金额和具体原因；更正只追加费用差异，不发送资金：

```json
{"admissionId":"synthetic-admission","chargeId":"synthetic-charge","direction":"decrease","amountFen":2000,"expectedFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reason":"合成床日费核对冲减"}
```

未投保住院的 `financial-refund.json` 使用当前冲减的 `adjustmentId`、成功原交易与其余额版本。退款同时受该依据剩余额度、全账待退净额和原款可退余额约束；成功/未知退款共享同一原交易及原方式余额，不能换原交易绕过依据额度。投保住院先完成下述医保更正，再按患者现金差额办理：

```json
{"admissionId":"synthetic-admission","adjustmentId":"synthetic-adjustment","sourceKind":"inpatient-deposit","sourceId":"synthetic-payment","amountFen":2000,"expectedSourceVersion":1,"expectedFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","simulatorRule":"ambiguous"}
```

未投保住院的 `financial-payment.json` 只关联 `increase` 补计依据，以当前待收净差额为上限，组合 `tenders` 合计须等于金额；示例中的依据与指纹需替换为实际读取结果：

```json
{"admissionId":"synthetic-admission","adjustmentId":"synthetic-adjustment","amountFen":1500,"tenders":[{"method":"cash","amountFen":1000},{"method":"bank-card","amountFen":500}],"expectedFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","simulatorRule":"ambiguous"}
```

`financial-confirm.json` 只使用对应预览返回的 `previewId/commitToken`，五分钟内由原岗位上下文人工审阅后确认。预览过期或 `INPATIENT_FINANCIAL_PREVIEW_STALE` 时重新读取并审阅，不自动换指纹确认：

```json
{"admissionId":"synthetic-admission","previewId":"synthetic-preview","commitToken":"replace-with-original-preview-token"}
```

响应丢失先查原 Command receipt，并保留完整原输入和幂等键。渠道结果未知时，新的补收及退款预览或确认返回 `INPATIENT_FUNDS_PENDING`，即使仍有剩余差额或改选其他原交易也须先查询原尝试。`financial-refund-recovery.json` 与 `financial-payment-recovery.json` 分别使用实际原 ID 和版本，不接受金额或 outcome；取得确定结果后重新读取差额并审阅新预览：

```json
{"admissionId":"synthetic-admission","refundId":"synthetic-refund","expectedRefundVersion":1}
```

```json
{"admissionId":"synthetic-admission","paymentId":"synthetic-payment","expectedPaymentVersion":1}
```

成功、拒绝、未知分别保留原尝试和追加查询结果；未知金额预占，不得重收重退。确定拒绝后可按最新依据和差额重新预览。未投保住院的相反方向费用更正先抵消未处理差额，未知资金仍待查明。后续调整不改写原费用、首次结算及归档快照，不恢复床位、不撤销出区或解档；后续未知只使该调整待处理，首次财务完成与清床归档不倒退。

### 后续患者医保更正

首次结算含医保时，每次只办理一个未完成财务更正。追加费用调整后，读取 `financial-adjustments.insurance`，核对 `original` 首次待遇、当前 `active`、原年度 `balance` 和 `cycles` 的原待遇／补偿／新待遇引用。先补偿当前有效待遇，再按更正后权威费用、原年度及原方案预览并确认；不能通过普通 `insurance cancel/confirm` 绕开首次封账。

```bash
clinmesh inpatient financial-insurance cancel --input @insurance-compensation.json --idempotency-key <key>
clinmesh inpatient financial-insurance preview --input @insurance-correction-preview.json --idempotency-key <key>
clinmesh inpatient financial-insurance confirm --input @insurance-correction-confirm.json --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.financial.insurance.cancel --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.financial.insurance.confirm --idempotency-key <key>
```

三个输入均带 `admissionId/adjustmentId`。补偿另传当前 `settlementId/expectedBalanceVersion/expectedFingerprint`；预览传当前 `expectedFingerprint`；确认只传原预览的 `previewId/commitToken`。输入不接受患者、年度、方案或自行计算的费用。补偿恢复原待遇的精确影响，后来其他就诊的账户与统筹累计继续保留。跨年仍修正原待遇年度。

原年度余额或更正费用变化导致 `INPATIENT_INSURANCE_PREVIEW_STALE` 时，重新读取并审阅新预览，保留原失败结果，不自动替换金额确认。响应丢失先查原 Command receipt，保持原输入和幂等键。`insurance.ready` 后，按 `remainingCollectFen/remainingRefundFen` 使用现有后续收退款命令；医保患者现金差额不受费用更正方向或金额限制，例如冲减费用后，其他就诊占用账户仍可产生补收。未知收退只使当前更正 `unknown`，查原尝试恢复后才可开始下一次更正。

## DRG 预分组、处方推演与医保办核定

1. 临床岗位对未归档住院用 `drg-pregroup` 读取当前正式诊断与实际操作；未提交首页时 `recordRevision=0`，归档病例直读冻结结果，不重算。医保办仅可读归档冻结分组，未归档返回 `INPATIENT_DRG_NOT_ARCHIVED`，不能读取完整首页；复核病例摘要使用 `drg-payer-review-preview`。响应附双轨编码口径与解释路径：病案首页保留临床版 2022 编码，分组器按医保版码域映射，两个口径在结果中分别可追溯。
2. `drg-simulate` 把草稿医嘱对照正式收费、在途承诺、材料预留与草稿推演金额，附依赖指纹及独立的合成医院支付参考。`estimatedFen=null` 表示目录缺价，不以零值填充。推演不产生费用、预留或核定事实。用与待开具单项相同的草稿推演并审阅后，`issue-order` 携带 `expectedDrgFingerprint`；服务端按实际选择重算，`INPATIENT_DRG_EVALUATION_STALE` 要求重新推演与审阅。病例、目录或事实变化均不可继续使用旧指纹，响应丢失先查原回执，沿用原输入和幂等键。
3. 住院医生为计划手术预留材料：`encounterVersion` 做预期版本校验，绑定目录 ID、版本与原因；预留不改变临床事实与库存。仅预留态可释放并须附原因。
4. 归档后先用 `drg-payer-review-preview` 读取冻结分组、`caseSummary` 中的病例与编码来源摘要、固定版本合成核定金额，医保办审阅后用 `drg-payer-review` 携带预览的 `encounterVersion` 和 `expectedFingerprint` 核定。`paymentEstimate` 是归档时冻结的医院支付预估；`estimateDifferenceFen` 为核定减原预估，`differenceFen` 为核定减归档收费。旧归档没有预估时前两项为 null，不用当前参数回填。金额由服务端确定性产生，不落真实支付；未归档、缺参数或过期预览明确拒绝，`INPATIENT_DRG_PAYER_PREVIEW_STALE` 后须重新读取与审阅。`drg-payer-reviews` 回查历次核定及依据。

```bash
clinmesh inpatient drg-pregroup --admission-id <admission-id>
clinmesh inpatient drg-simulate --input @simulation.json
clinmesh inpatient drg-reservations --admission-id <admission-id>
clinmesh inpatient drg-reserve-material --input @reservation.json --idempotency-key <key>
clinmesh inpatient drg-release-reservation --input @release.json --idempotency-key <key>
clinmesh inpatient drg-payer-review-preview --admission-id <admission-id>
clinmesh inpatient drg-payer-review --input @payer-review.json --idempotency-key <key>
clinmesh inpatient drg-payer-reviews --admission-id <admission-id>
clinmesh command receipt get --operation-id inpatient.drg.reservation.create --idempotency-key <key>
```

预留创建、释放与核定均返回标准 Command 回执，业务列表位于 `data`，`effects/auditId/requestId` 用于核对提交结果。响应丢失先按原 operation 和幂等键查 receipt，再核对业务列表；不能因未拿到列表换键重做。

`simulation.json`（推演草稿；空草稿等价于只对照已记账事实）：

多个待实施手术计划时，在完整推演中用 `draft.primarySurgeryRequestId` 明确假想主操作；唯一计划可省略。该选择只改变 projected 主次顺序，formal 仍读取首页实际主操作。未选择时 projected 明确输入不完整；`INPATIENT_DRG_PLAN_CONFLICT` 表示计划已取消、完成或不属本次住院，刷新后重新选择。单项医嘱审阅使用与 `issue-order` 实际选择一致的 medications/services 草稿。

```json
{
  "admissionId": "synthetic-admission",
  "draft": {
    "medications": [{ "catalogItemId": "synthetic-medication", "catalogVersion": 1, "doseText": "0.5g", "frequencyCode": "BID", "doseQuantity": 2 }],
    "services": [{ "serviceId": "hospital-service-diabetes-education", "serviceVersion": 1, "quantity": 1 }]
  }
}
```

`reservation.json`：

```json
{
  "admissionId": "synthetic-admission",
  "encounterVersion": "2",
  "materialId": "synthetic-material",
  "catalogVersion": 1,
  "quantity": 1,
  "reason": "合成计划手术材料预留"
}
```

`release.json`：

```json
{
  "admissionId": "synthetic-admission",
  "encounterVersion": "2",
  "reservationId": "synthetic-reservation",
  "reason": "合成手术取消释放预留"
}
```

`payer-review.json`：

```json
{
  "admissionId": "synthetic-admission",
  "encounterVersion": "2",
  "expectedFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "reason": "合成医保办模拟核定"
}
```

`CATALOG_CONFLICT` 表示耗材目录、版本或计价单位不可用，换目录条目前先与临床核对。`INPATIENT_RESERVATION_CONFLICT` 表示预留归属、状态、数量或版本冲突，重新读取预留、计划与目录并审阅；预留不锁库存。`INPATIENT_RESERVATION_NOT_FOUND` 只在预留不存在或已释放时出现。`INPATIENT_DRG_NOT_ARCHIVED` 表示核定只针对归档冻结分组。结果未知先查同operation原receipt，保留原输入与幂等键，不换key重做。

## 住院后台规则跟进

医生先用 `drg-followup` 读取本次住院和任务版本，再用 `drg-followup-start` 提交 `admissionId`、`encounterVersion` 与 `expectedTaskVersion`（尚无任务时为 0）。同次住院重复开启沿用唯一任务；停止或失权后的显式重新开启仍保留原任务身份，不重置模型账。规则跟进不派发模型；缺规则、分组依据或有效正支付参考额时显示不完整，不把缺项当零。

```bash
clinmesh inpatient drg-followup --admission-id <admission-id>
clinmesh inpatient drg-followup-start --input @followup-start.json --idempotency-key <key>
clinmesh inpatient drg-followup-stop --input @followup-stop.json --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.drg.followup.start --idempotency-key <key>
```

```json
{
  "admissionId": "synthetic-admission",
  "encounterVersion": "2",
  "expectedTaskVersion": 0
}
```

停止输入另需非空 `reason`，并使用当前 `task.version`。`INPATIENT_DRG_FOLLOWUP_CONFLICT` 要求刷新任务再审阅；`INPATIENT_DRG_FOLLOWUP_INACTIVE` 表示已经停止、失权或归档，不能继续原分析。写入返回标准 Command 回执；结果未知先查原 operation 与幂等键的 receipt，保留原输入，不换键重复开启。

关闭页面或切换患者不改变任务病例；每次分析重新核对原 Actor／岗位有效性与本次住院当前科室、病区。撤权、转科或责任变化后停止新分析并保留待交接结果，归档后不因后续财务或核定恢复临床分析。正式收费净额严格超过当前有效正 DRG 支付参考额的 3 倍才提醒，恰好 3 倍不提醒；合法冲正后重新核对。提醒仅建议住院诊疗结束后由医保办人工评估，不自动申请、控制 5% 比例、修改分组或预测补付，也不新增出院门禁。

## 术后核查、岗位待办与归档交接

```bash
clinmesh inpatient drg-review --admission-id <admission-id>
clinmesh inpatient drg-review-todo --input @drg-todo.json --idempotency-key <key>
clinmesh inpatient drg-review-handoff --input @drg-handoff.json --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.drg.review.todo.act --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.drg.review.handoff --idempotency-key <key>
```

`drg-review` 仅对本次住院受支持的已完成实际 PCI 术式，或已有冻结人工计划明确关联的申请，按选型确认身份与版本匹配该申请的人工冻结术前计划，分别比较额外、未使用、非计划产品及真实更正；不同手术的问题独立保留；独立造影等不要求 PCI 耗材计划，其正式事实仍由原 owner 保存。材料有效使用、原费用与合法冲正由原 owner 提供，正式分组与后续已有治疗计划费用复用原推演，不凭耗材数量提高病组。读取保留审计；收费员只收到财务待办和正式收费，不返回诊断、参数、计划详情或模型临床解释。

待办的 `id/version/evidenceFingerprint/ownerRole` 与当前核查 `fingerprint` 来自读取结果。对应岗位用 `in-progress` 记录处理中，`dismiss` 必须附人工无需处理理由，`recheck` 按最新正式业务事实复查。`resolve` 只有问题已被正式事实消除才允许；关闭提示、修改状态或模型自述不能作为解决证据。同 key 同依据不重复，事实已消除的问题再次出现会重新打开。实际记录或账务应在其原业务入口更正，不能在待办中改诊断、用量或金额。

`drg-todo.json` 合成示例；提交前替换为实际读回的身份、版本和指纹，恢复未知结果时保留原文件与幂等键：

```json
{
  "admissionId": "synthetic-admission",
  "todoId": "synthetic-todo",
  "expectedTodoVersion": 1,
  "expectedFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "action": "in-progress",
  "note": "对应岗位核实原业务事实及来源"
}
```

术后语义解释沿现有生成及独立核验两个模型步骤，逐项引用核查原问题与来源；只有核验支持的解释才作为当前结果发布。规则与待办不依赖模型成功；控制拒绝、核验否决、未知请求及历史已发布结果分别表达。未知请求不自动重发，同依据成功步骤复用；原任务重新开启不重建身份或重置用量。用量的阶段、选型版本、实际使用／更正及分组费用依据触发引用来自服务端真实输入差异。

归档、停止或失权后不再发起新临床分析，当前有效病例岗位通过 `drg-review-handoff` 提交 `admissionId/expectedVersion/note` 收拢已有结果及未解决责任。交接不自动解决待办、不增加出院门禁，不延长旧权限；归档后的财务或核定不能重启临床分析。重新开启同任务会清除旧轮交接标记，历史仍保留。`INPATIENT_DRG_REVIEW_STALE` 要求刷新后重新审阅，`INPATIENT_DRG_TODO_UNRESOLVED` 表示正式事实仍未消除问题；`INPATIENT_DRG_TODO_FORBIDDEN` 拒绝越岗处置。
