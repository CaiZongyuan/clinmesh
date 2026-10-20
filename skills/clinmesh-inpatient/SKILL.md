---
name: clinmesh-inpatient
description: ClinMesh 住院登记、诊断、医嘱校对执行、发药给药、检查检验、转科交接、手术最小闭环和费用冲正 CLI 工作流。用于登记员、负责门诊医生、住院医生、病区护士及病案、药师与收费岗位的住院事实读取与已授权操作。
---

# ClinMesh 住院

先读 [`../clinmesh-shared/SKILL.md`](../clinmesh-shared/SKILL.md)。以受信岗位读取目录和住院事实；住院医生与病区护士只操作自己科室、病区。跨岗位交接必须使用对应 Grant。

```bash
clinmesh inpatient catalog
clinmesh inpatient list
clinmesh inpatient read --admission-id <admission-id>
clinmesh operations schema inpatient.admission.register
```

登记员先搜索合成患者，直接入院或转院时填写原受信 context 的 `expectedEpoch`、`patientId`、`patientVersion`、`admissionRoute`、`wardId`、整数分 `depositFen`。门诊转收使用负责门诊医生已开出的住院证，`admissionRoute=outpatient` 并传 `referralId`；住院证不可重复转收。每次住院分配独立住院号。零预交金不形成资金交易；正数预交金随登记原子入账。同一意图重试保留完整原输入（包括 `expectedEpoch`、患者和原预期版本）与同一幂等键，先查询原 Command receipt。`expectedEpoch` 仅为事务前置断言，不能选择 Workspace 或 Epoch；场景已变化时原意图返回 `INPATIENT_EPOCH_CONFLICT`，核对原住院与费用事实后才能开始新意图。

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
