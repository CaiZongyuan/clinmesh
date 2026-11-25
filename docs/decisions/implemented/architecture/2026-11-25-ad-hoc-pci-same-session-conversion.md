# Agent Note: 同台冠脉造影直接转 PCI（Ad-hoc PCI）单申请双阶段闭环与单次专科护理去重

Status: implemented

## Problem

在介入心脏病学临床实践中，患者行冠状动脉造影（`88.5500` / `88.5600`）且术前已签署造影及必要时介入联合知情同意书时，若造影发现显著缺血性狭窄，常规在同一导管室操作台次直接转为经皮冠状动脉介入治疗（Ad-hoc PCI，如 `36.0700`），无需患者下台另行提交第二次手术申请、重签知情同意书或重做病区护士术前核对。

改造前，ClinMesh 仅支持分台路径：每份 `inpatient_surgery_request` 与 `inpatient_surgery_execution` 一对一绑定，且耗材预计、术前清单确认与耗材预留均按 `request_id` 单键索引；同时，冠脉造影与 PCI 各自完成后都会独立计收一笔 `术中介入专科护理`（`80.00` 元），且强迫医生二次走申请、同意书与护士核对流程，既偏离真实导管室工作流，又会导致同台连台被重复计收专科护理费。

## Decision

1. **单 `ServiceRequest` + 顺序双 `Procedure` 的阶段隔离模型**：
   - `inpatient.surgery.request`（v5）仅对冠脉造影（`88.5500` / `88.5600`）开放可选布尔字段 `standbyAdHocPci`（非造影术式传 `true` 返回 `400`），同步投影至 FHIR R5 `ServiceRequest.orderDetail` 的 `standby-ad-hoc-pci` 参数。
   - `resolveSurgicalConsentTemplate(procedureCode, standbyAdHocPci)` 新增第五套联合模板 `coronary-angiography-ad-hoc-pci`（《冠状动脉造影及必要时同台经皮冠状动脉介入治疗（PCI）知情同意书》），同时告知造影与支架/球囊介入专有风险。
   - 迁移 `0122_surgery-ad-hoc-pci.sql` 为 `inpatient_surgery_request` 增加 `'standby-pci'` 状态、`standby_ad_hoc_pci`、`ad_hoc_pci_json` 与 `standby_finalization_json`；为 `inpatient_surgery_execution` 增加 `execution_stage`（`'primary' | 'ad-hoc-pci'`）与唯一索引 `(workspace_id, epoch, request_id, execution_stage)` 以及 `same_session_nursing_included`；为 `inpatient_material_estimate`、`inpatient_material_plan_confirmation`、`inpatient_material_reservation` 增加 `surgery_stage`（默认 `'primary'`）实现阶段隔离（其中 `inpatient_material_estimate.authorization_operation` 扩展允许 `'inpatient.surgery.convert-to-pci'`）。
   - 开启 `standbyAdHocPci` 的造影完成后进入 `'standby-pci'`（FHIR `ServiceRequest` 保持 `active`，阻断出院、转科与归档），在造影报告产出有效结果后提供两个受审计共享 Command：
     - `inpatient.surgery.convert-to-pci`（v1）：重验 `standby-pci`、联合同意书模板、造影已完成、有效造影报告（`final` 或含临床所见的 `partial`，拒绝 `processing`、`unavailable` 与无临床所见的空 `partial`）及 PCI 术式，执行既有的 `#523` `inpatientPciPlan`（`FFR > 0.80` `PCI_NON_ISCHEMIC_LESION`）双层事中临床质控与受审计 `clinicalOverride`，在同一事务自动触发 `pciSelection.prepareDraft` 与 `ad-hoc-pci` 阶段单次耗材预计；免二次手术申请、免二次同意书与护士术前核对。
     - `inpatient.surgery.finalize-standby`（v1）：关闭 `standby-pci` 收口为 `completed`（若已转 PCI 尚未实施则强制填写放弃理由，并在同一事务释放全部 `ad-hoc-pci` 阶段预留、取消 `ad-hoc-pci` 预计与 `pci-stent` 指南意见，完整保留造影执行与计费）。
   - 阶段 2 Ad-hoc PCI 的 FHIR `Procedure` 通过 `partOf` 引用阶段 1 造影 `Procedure`，阶段 2 的 `start` / `record-material` / `preview-completion` / `complete` / `execute` 严格限定只能消耗 `surgery_stage = 'ad-hoc-pci'` 或未绑定申请的通用预留，禁止跨阶段借用造影预留。
2. **同台术中介入专科护理单次计费去重**：
   - 阶段 1 造影完成按原有绑定计收一次 `术中介入专科护理`（`80.00` 元）。
   - 阶段 2 Ad-hoc PCI 命中同 `serviceId` 护理绑定且同申请 `primary` 阶段已计收该项护理时，不再生成第二条护理费用行，省略 `linkedNursing` 并在 `previewCompletion` 与已完成 `execution` 上显式返回 `sameSessionNursingIncluded: true`；`InpatientDrg.costProjection` 同步排除重复护理承诺；两阶段术式费（`800 + 1,800` 元）、实际耗材与各自 `MedicationAdministration.partOf` 指向本阶段 `Procedure` 的台内基数用药照常全额计费。
3. **显式在院主操作确认与兼容零漂移**：
   - 绝不自动改写病案主操作；Web 手术页在同台 PCI 完成后提供一键显式 CTA（「确认 `36.0700` 为在院主操作」）调用 `inpatient.record.submit` 保存并刷新 DRG 预分组至 `FM39`。
   - 所有新增契约字段均设为可选，并在普通单阶段／历史记录上省略输出，保持既有分台 PCI 黄金基线、归档 `sourcesHash` 与 `pciDataPackage` 零漂移；不新增住院 DSH 写工具（沿用 `#527` 边界）。

## Alternatives considered

1. **在 `convert-to-pci` 时服务端隐式创建第二份子 `ServiceRequest`**：
   - 否定原因：会凭空制造第二份手术申请单并迫使系统伪造“豁免同意书/核对”的虚拟准备记录，破坏 `ServiceRequest` 与真实联合同意书一单一签的审计归属，也使历史记录出现冗余假申请。
2. **仅用单个 `Procedure` 并在转 PCI 后原地把 `88.5500` 覆盖为 `36.0700`**：
   - 否定原因：会丢失造影阶段的真实执行时间、术式费（`800` 元）、造影台内基数用药 `partOf` 关联、造影报告 `DiagnosticReport -> Procedure` 溯源，以及病案首页多操作明细。
3. **两阶段重复计收两笔 `术中介入专科护理` 或自动改写病案主操作**：
   - 否定原因：违反真实公立医院同台连台介入护理按台次单次计收规范，且自动改写病案主操作违背 ClinMesh“病案主操作仅由医生显式确认”的不可变溯源原则。

## Consequences

- 冠脉造影同台转 PCI 与传统分台 PCI 双轨并存：未勾选 `standbyAdHocPci` 的原有分台流程、黄金账本和 E2E 回归保持原行为不变。
- `inpatient_surgery_request`、`inpatient_surgery_execution`、`inpatient_material_estimate`、`inpatient_material_plan_confirmation` 与 `inpatient_material_reservation` 具备完整的阶段维隔离，术后 DRG 核查、耗材补登/更正与费用推演均按 `(requestId, stage)` 精确归属。
- 未来若扩展其他同台联合术式（如检查转介入治疗），可沿用 `execution_stage` / `surgery_stage` 阶段隔离与同台护理去重模式，而不必破坏既有单阶段记录的哈希与语义。
