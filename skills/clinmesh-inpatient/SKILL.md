---
name: clinmesh-inpatient
description: ClinMesh 住院登记、住院证、病区接诊与床位 CLI 工作流。用于登记员、负责门诊医生、住院医生、病区护士及病案岗位的住院事实读取与已授权操作。
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
