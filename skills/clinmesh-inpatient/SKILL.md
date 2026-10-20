---
name: clinmesh-inpatient
description: ClinMesh 住院登记、诊断、医嘱校对执行、发药给药、手术最小闭环和费用冲正 CLI 工作流。用于登记员、负责门诊医生、住院医生、病区护士及病案、药师与收费岗位的住院事实读取与已授权操作。
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

## 出院、结算、清床与召回

```bash
clinmesh inpatient discharge-events --admission-id <admission-id>
clinmesh inpatient issue-discharge --input @discharge.json --idempotency-key <key>
clinmesh inpatient depart --input @departure.json --idempotency-key <key>
clinmesh inpatient settlement-preview --admission-id <admission-id>
clinmesh inpatient settle --input @settlement.json --idempotency-key <key>
clinmesh inpatient clear-bed --input @discharge.json --idempotency-key <key>
clinmesh inpatient recall --input @discharge.json --idempotency-key <key>
clinmesh command receipt get --operation-id inpatient.discharge.settle --idempotency-key <key>
```

医生开出院医嘱只进入 `discharge-pending`，不出区、不结算、不释放床位。`discharge.json` 传 `admissionId/encounterVersion/reason`；护士出区使用相同字段，并显式选择 `departureMethod`：`home`医嘱离院、`transfer`医嘱转院、`against-advice`非医嘱离院、`death`死亡、`other`其他。这是本院仿真字段，不宣称国家上报编码。出区前医嘱须全部 stopped/completed，任务全部 completed/cancelled；待出院仍允许医生申请停嘱和护士核停，禁止新增、校对和执行医嘱。已发未给任务可核停取消，保留发药、库存和费用，不强迫补给药或自动退库存。尚未出区期间继续产生声明的床日费，实际出区后停止。

收费员只能读取窄财务预览和结算回执，不能读取出院临床说明或离院方式。首次结算前读取 `settlement-preview`，保留其完整 `encounterVersion/fingerprint/chargesFen/balanceFen`；正 balanceFen 为补缴，负数为退款，零元不产生补退款交易。退款关联原预交金交易，原入金不改写。使用 `settlement.json` 提交：

```json
{
  "admissionId": "synthetic-admission",
  "encounterVersion": "4",
  "fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "expectedChargesFen": 5000,
  "expectedBalanceFen": -95000
}
```

示例指纹不可用于真实提交；首次提交前用实际预览替换，重试保持原文件不变。server 在 Command 事务重读逐项费用、冲正、资金与状态，校验原指纹及金额；Encounter版本不变或费用净额相同也不证明明细未变。`INPATIENT_SETTLEMENT_PREVIEW_STALE` 表示原预览失效，须重新审阅新明细并显式取得新预览后开始新意图，不能自动刷新金额后盲重做。结果未知先查原 `inpatient.discharge.settle` receipt，继续原完整输入与原幂等键，不重复补缴或退款。已结算封账，禁止新增或冲正费用；只有护士清床才释放床位。

召回只允许当前负责住院医生在已出区、未结算、未清床且原床仍由本次住院保留时办理；与结算竞争仅一个成功。召回追加关联原出区的逆向事件与床位 period，保留原出区时间、离院方式和审计，不恢复旧医嘱。结算后再次收治通过新的 register 创建独立住院。
