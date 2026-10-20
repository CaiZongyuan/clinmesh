---
name: clinmesh-inpatient
description: ClinMesh 住院登记、诊断、医嘱校对执行、发药给药和费用冲正 CLI 工作流。用于登记员、负责门诊医生、住院医生、病区护士及病案、药师与收费岗位的住院事实读取与已授权操作。
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
