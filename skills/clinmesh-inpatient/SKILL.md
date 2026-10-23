---
name: clinmesh-inpatient
description: ClinMesh 住院登记、诊断、医嘱校对执行、发药给药、检查检验、转科交接、手术、出院结算和病案审核归档 CLI 工作流。用于登记员、负责门诊医生、住院医生、病区护士及病案、药师与收费岗位的住院事实读取与已授权操作。
---

# ClinMesh 住院

先读 [`../clinmesh-shared/SKILL.md`](../clinmesh-shared/SKILL.md)。以受信岗位读取目录和住院事实；住院医生与病区护士只操作自己科室、病区。跨岗位交接必须使用对应 Grant。

```bash
clinmesh inpatient catalog
clinmesh inpatient list
clinmesh inpatient read --admission-id <admission-id>
clinmesh operations schema inpatient.admission.register
```

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

先读取本次住院的当前状态、正式诊断、医嘱和任务。住院医生按 [clinmesh-doctor 的 Reference 检索示例](../clinmesh-doctor/SKILL.md)检索已安装的完整诊断 Reference Catalog；确认时只提交目录 ID、主次、明确入院病情及备注，server 解析并冻结编码、版本、来源定位和当时 Release。目录不可用时保留显式合成院内目录，不把其修订号当作国家临床版本。

```bash
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

每个文件使用受信读取结果的 `admissionId`。诊断确认传 `encounterVersion`、`expectedRevision` 与恰好一个 primary 的 `entries`；每项必须显式选择 `admissionCondition`（`1`有、`2`临床未确定、`3`情况不明、`4`无），输入顺序保存在正式确认中，不根据备注或日期推断病情；签发传当前 `encounterVersion`、`duration` 和受控 `selection`。药品选择含目录 ID/版本、`doseText`、`frequencyCode`、每次 `doseQuantity`；这里数量以目录基准单位计，三个首期产品均为片，不是盒，也不是门诊整张处方总量或疗程。合成本院适应症规则、组合、过敏、剂量和频次不满足时不得换 ID 绕过。

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

## 手术计划、准备与实际实施

```bash
clinmesh inpatient surgery-catalog
clinmesh inpatient surgeries --admission-id <admission-id>
clinmesh inpatient request-surgery --input @surgery-request.json --idempotency-key <key>
clinmesh inpatient check-surgery-preop --input @surgery-preparation.json --idempotency-key <key>
clinmesh inpatient confirm-surgery-consent --input @surgery-preparation.json --idempotency-key <key>
clinmesh inpatient execute-surgery --input @surgery-execution.json --idempotency-key <key>
clinmesh inpatient cancel-surgery --input @surgery-preparation.json --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.surgery.execute --idempotency-key <key>
```

住院医生申请传本次 `admissionId/encounterVersion`、目录 `procedureId/catalogVersion`、不早于当前虚拟时间的 `plannedFor` 和 `reason`。计划只创建 ServiceRequest，不产生已实施事实或费用，场景推进也不自动执行。目录是临床版 ICD-9-CM-3 工作表3.0的固定八条来源摘录，保留前导零、点和扩展后缀、类别、项目摘录Release与来源定位；不是全量、最新版或医保版目录。院内收费ID与临床分类码分开，价格明确为合成演示价，不得将分类编码当成收费项目ID提交。

`surgery-catalog`（operation v2）的 `materials` 保留原两项合成材料及231条心血管参考记录。新增项的 `reference` 包含来源、原字段、地区与期限、单位/规格缺项；`reference.priceFen` 为表内中选价，`baseSupplyPriceFen` 为独立的基准品拟供应价，不替代中选价。只有带 `chargeDefinition` 的条目可用于实际实施：52条明确单位的记录按表内中选价制定合成本院演示价；`unavailableReason=unit-unconfirmed` 的179条没有收费定义，单位为null，保留参考价格但不能使用，不推测单位。来源包含历史采购参考及地区限制，不代表当前实际医院价格。

护士以 `check-surgery-preop` 记录术前检查核对，医生以 `confirm-surgery-consent` 记录对已签署知情同意书的确认；这是可审计的确认事实，不提供真实电子签名。两个动作与取消均传 `requestId/expectedRequestVersion/note`，两项准备均完成才能执行。准备和执行按当前住院科室及病区责任授权，原申请作者身份不会阻止合法接管。

执行传 `admissionId/requestId/expectedRequestVersion`、实际 `procedureId/catalogVersion`、`note` 和 `materials`；耗材每项为 `materialId/catalogVersion/quantity`，未使用时显式空数组。实际术式可以不同于申请，server 按实际目录冻结手术及耗材价格，原子保存唯一 Procedure、用料、逐项账项与审计。不得传任意收费金额，不推断未记录耗材或手术；已实施不能取消删除，账项更正走收费员原费用关联冲正。未实施未取消申请阻断出院。

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
clinmesh inpatient confirm-payment --input @inpatient-confirmation.json --idempotency-key <key>
clinmesh inpatient recover-payment --input @inpatient-payment-recovery.json --idempotency-key <key>
clinmesh inpatient preview-refund --input @inpatient-refund.json --idempotency-key <key>
clinmesh inpatient confirm-refund --input @inpatient-confirmation.json --idempotency-key <key>
clinmesh inpatient recover-refund --input @inpatient-refund-recovery.json --idempotency-key <key>
clinmesh inpatient settle --input @settlement.json --idempotency-key <key>
clinmesh inpatient clear-bed --input @discharge.json --idempotency-key <key>
clinmesh inpatient recall --input @discharge.json --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.discharge.settle --idempotency-key <key>
```

医生开出院医嘱只进入 `discharge-pending`，不出区、不结算、不释放床位。`discharge.json` 传 `admissionId/encounterVersion/reason`；护士出区使用相同字段，并显式选择 `departureMethod`：`home`医嘱离院、`transfer`医嘱转院、`against-advice`非医嘱离院、`death`死亡、`other`其他。这是本院仿真字段，不宣称国家上报编码。出院医嘱、出区及结算都重查未收口手术、检查检验和转科；检查已reported但未阅可放行，不套用门诊全已阅门禁。出区前医嘱须全部 stopped/completed，任务全部 completed/cancelled；待出院仍允许医生申请停嘱和护士核停，禁止新增、校对和执行医嘱。已发未给任务可核停取消，保留发药、库存和费用，不强迫补给药或自动退库存。尚未出区期间继续产生声明的床日费，实际出区后停止。

收费员只能读取窄财务和资金记录，不能读取出院临床说明或离院方式。`payments` 读取当前首次结算的原款、成功收退款、剩余差额及未知尝试。登记原预交金继续有效；追加预交金用 `kind=deposit`，已出区补缴用 `kind=supplement`，输入正整数分 `amountFen` 与合计相等的 `tenders`（cash、bank-card、mobile各最多一项）。合成渠道显式选 `simulatorRule`：success、decline、ambiguous、ambiguous-decline或ambiguous-pending。先预览，再将响应的 `admissionId/previewId/commitToken` 写入确认文件；确认只消费原预览，不能追加金额或方式。

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
clinmesh inpatient adjust-finance --input @financial-adjustment.json --idempotency-key <key>
clinmesh inpatient preview-financial-refund --input @financial-refund.json --idempotency-key <key>
clinmesh inpatient confirm-financial-refund --input @financial-confirm.json --idempotency-key <key>
clinmesh inpatient recover-financial-refund --input @financial-refund-recovery.json --idempotency-key <key>
clinmesh inpatient preview-financial-payment --input @financial-payment.json --idempotency-key <key>
clinmesh inpatient confirm-financial-payment --input @financial-confirm.json --idempotency-key <key>
clinmesh inpatient recover-financial-payment --input @financial-payment-recovery.json --idempotency-key <key>
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

1. 未归档住院用 `drg-pregroup` 按首页快照实时预分组；归档病例直读冻结结果，不重算。响应附双轨编码口径与解释路径：病案首页保留临床版 2022 编码，分组器按医保版码域映射，两个口径在结果中分别可追溯。
2. `drg-simulate` 把草稿医嘱对照正式收费、在途承诺、材料预留与草稿推演金额，附依赖指纹；目录或版本变化使指纹失效，须重新推演。`estimatedFen=null` 表示目录缺价，不以零值填充。推演不产生费用、预留或核定事实。
3. 住院医生为计划手术预留材料：`encounterVersion` 做预期版本校验，绑定目录 ID、版本与原因；预留不改变临床事实与库存。仅预留态可释放并须附原因。
4. 归档后医保办岗位用 `drg-payer-review` 按冻结分组与固定版本合成参数模拟核定，金额由服务端确定性产生，不落真实支付；未归档住院拒绝核定。`drg-payer-reviews` 回查历次核定及依据。

```bash
clinmesh inpatient drg-pregroup --admission-id <admission-id>
clinmesh inpatient drg-simulate --input @simulation.json
clinmesh inpatient drg-reservations --admission-id <admission-id>
clinmesh inpatient drg-reserve-material --input @reservation.json --idempotency-key <key>
clinmesh inpatient drg-release-reservation --input @release.json --idempotency-key <key>
clinmesh inpatient drg-payer-review --input @payer-review.json --idempotency-key <key>
clinmesh inpatient drg-payer-reviews --admission-id <admission-id>
clinmesh command receipt get --operation-id inpatient.drg.reservation.create --idempotency-key <key>
```

`simulation.json`（推演草稿；空草稿等价于只对照已记账事实）：

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
  "reason": "合成医保办模拟核定"
}
```

`CATALOG_CONFLICT` 表示耗材目录、版本或计价单位不可用，换目录条目前先与临床核对。`INPATIENT_RESERVATION_CONFLICT` 表示库存或版本竞争，重新读取预留与目录后再试；`INPATIENT_RESERVATION_NOT_FOUND` 只在预留不存在或已释放时出现。`INPATIENT_DRG_NOT_ARCHIVED` 表示核定只针对归档冻结分组。结果未知先查同operation原receipt，保留原输入与幂等键，不换key重做。
