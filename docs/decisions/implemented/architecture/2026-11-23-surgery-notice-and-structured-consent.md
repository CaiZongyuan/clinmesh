# Agent Note: 住院手术申请单临床六要素与一术一议结构化知情同意书

Status: implemented

## Problem

既有住院手术申请单（`InpatientSurgeryRequest`）仅记录计划术式、计划时间与申请理由，缺少中国公立医院手术通知单核心临床六要素中的手术类型（择期／限期／急诊／日间）、手术执行地点、主刀医师及可选第一助手、拟行麻醉方式，导致导管室介入操作与中心手术室外科手术在领域快照和 FHIR R5 `ServiceRequest` 投影上无法区分资源排程与术者分工。同时，术前知情同意（`inpatient.surgery.confirm-consent`）仅保存一句泛化文本备注，无论冠脉造影、药物洗脱支架置入、球囊扩张成形还是普通外科手术均共用同一行内短语，既缺乏一术一议的专有并发症与替代方案告知条款，也未固化签署当时的患者基本信息、确认主诊断、谈话医师及本人／受托人身份快照。

## Decision

1. **手术通知单临床六要素建模与 FHIR R5 投影**：在 `@clinmesh/contracts/inpatient-surgery` 与 `@clinmesh/core/inpatient-surgery-consent` 统一定义手术类型（`elective`、`semi-elective`、`emergency`、`day-surgery`）、执行地点（`location-catheterization-lab`、`location-operating-center`、`location-endoscopy-suite`、`location-outpatient-or`）、麻醉方式（`local-infiltration`、`local-sedation`、`general`、`neuraxial`、`nerve-block`）及临床医师快照，`inpatient.surgery.catalog`（v3）同步返回启用手术地点与有效临床医师候选（排除护士与收费等非医师岗位，且新增高年资外科／介入医师 `Practitioner` 不注册额外登录 `PractitionerRole`，维持单住院科默认岗位边界）。`inpatient.surgery.request`（v4）强制校验六要素及主刀与一助互斥，并将优先级、类别、地点、带角色扩展的 `performer` 与麻醉参数 `orderDetail` 确定性投影至 FHIR R5 `ServiceRequest`。
2. **一术一议结构化手术知情同意书快照**：在共享内核建立按 ICD-9-CM-3 术式代码路由的四套合成教学同意书模板（`coronary-angiography`、`coronary-des-pci`、`coronary-balloon-pci`、`general-surgery`），强制附带非真实医疗法律文书声明。`inpatient.surgery.confirm-consent`（v3）要求显式提交预期住院诊断修订版本 `expectedDiagnosisRevision`、签署方身份（`patient` 或带关系说明的 `family-proxy`）、签署人姓名、同意选择及可选个体化风险与备注，在写事务内核对 `diagnosis.revision === expectedDiagnosisRevision`（防止审阅后主诊断并发变更导致审阅正文与落盘快照不一致），并由服务端权威拼装 `Patient`、住院号、当前已确认主诊断（未确认时如实置 `null`）、手术通知单快照与当前登录谈话医师，生成不可变 `consentConfirmation.document` 快照；已确认或已开始的手术严禁覆盖重签。
3. **存储升级与下游指纹零漂移**：SQLite `0120_surgery-notice-and-consent.sql` 对 `inpatient_surgery_request` 执行原地可空列追加（不重建含五张下游复合外键子表的原表），输出合同对历史空列与旧版无 `document` 同意记录保持可选兼容。`document` 封装于既有 `consentConfirmation` 内，被单次耗材预计 `materialEstimateBasisSchema` 显式剔除且不进入病案首页 `sourcesHash`，确保既有耗材测算基准指纹与病案归档哈希零漂移。
4. **工作台与 DSH 窄只读对齐**：手术申请弹窗按术式类别提供可覆盖的地点与麻醉默认推荐，知情同意升级为完整全文预览与签署模态弹窗，已签手术及病案页按需折叠区提供只读「查看知情同意书」入口；住院 DSH Surface 在 `surgery` 与 `record` 阶段新增窄只读工具 `inpatient.surgery.read`（`clinmesh_read_inpatient_surgeries`），不新增住院端 DSH 写工具。

## Alternatives considered

- **新建独立 FHIR `Consent` 资源与关系表**：虽然可独立检索，但知情同意在本系统中严格从属单张 `InpatientSurgeryRequest` 双准备状态机且不对外声明 FHIR `Consent` 能力；内聚在 `consent_confirmation_json` 内既能与申请版本 CAS 原子绑定，又能避免 capability 膨胀与跨表孤儿快照。
- **由客户端拼装知情同意书全文后直传服务端落库**：客户端自报的患者信息、主诊断、谈话医师或风险条款不可信，且可能与写事务提交时刻的正式临床状态不一致；改为客户端仅传签署人身份、关系、个体化风险补充与备注，全文与头部临床事实一律由服务端在事务内权威生成。
- **重建 `inpatient_surgery_request` 表将新增列设为 `NOT NULL`**：该表被耗材预留、单次耗材预计、术前清单确认与手术执行等多张复合外键表引用，重建表既增加外键迁移风险，又会破坏升级前历史测试库与既有快照回读，故采用可空列追加加输入边界强校验。

## Consequences

- `inpatient.surgery.request`（v4）与 `inpatient.surgery.confirm-consent`（v3）输入合同升级并同步刷新 Catalog hash，直接调用写接口的测试、CLI 与 `clinmesh-inpatient` Skill 示例统一携带六要素与结构化签署字段。
- 医生、护士与病案人员可在手术页、病案页及 DSH Surface 只读工具中核查完整的手术通知单六要素与一术一议知情同意书快照，而不会引入电子签名合规宣称、耗材预计失效或病案归档哈希漂移。
