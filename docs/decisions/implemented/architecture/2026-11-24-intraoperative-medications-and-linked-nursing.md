# Agent Note: 台内基数药记账与术中专科护理自动联动计费

Status: implemented

## Problem

导管室冠脉造影、PCI 与中心手术室普外手术中使用的造影对比剂、普通肝素、局部浸润麻醉利多卡因、硝酸甘油及台内基础液体在真实医院属于手术室／导管室台内基数药管理，随本台手术即时取用并按实际计价单位入账，而非提前走“病区医生下达 `PRN` 医嘱 → 病区护士校对 → 护士申请按需执行 → 住院中心药房按批号调剂发药 → 病区护士给药”五步长链；此前在 PCI 演示中为了给碘海醇与肝素记账不得不借道病区 `PRN` 医嘱，导致角色流转失真且额外扣减中心药房库存批次。同时，冠脉介入与腔镜手术在完成时应按本院目录联动计入术中介入或手术室专科护理服务费，并与 `preview-completion` 差额核实、住院 DRG 预计费用及存量历史手术归档哈希保持一致。

## Decision

建立独立于病区医嘱与中心药房库存的手术台内基数药记账模型，并在手术完成边界提供由服务目录驱动的术中专科护理自动联动计费：

- **台内基数药目录与分轨品规**：院内药品配置通过 `surgicalBaseStock: true` 标记允许台内基数取用的品规（如碘海醇、普通肝素、硝酸甘油、0.9%氯化钠），并支持仅对手术室开放而不暴露于门诊处方或病区常规医嘱目录的专用基数药（`availableScopes: ['surgical-base']`，如盐酸利多卡因注射液，附带结构化合成说明书摘要与 FHIR `Medication` 资源且不初始化中心药房 `inventory_lot`）。`inpatient.surgery.catalog`（v4）向住院医护与病案岗位同步返回 `baseStockMedications`、按术式编码过滤的三套台内快捷套餐 `medicationPackages`（含未安装品规的 `available: false` 状态）以及术中专科护理绑定 `nursingBindings`。
- **台内给药事实、FHIR 投影与药事红线**：新增 `STRICT` 领域表 `inpatient_surgery_medication`，支持在 `inpatient.surgery.execute`（v5）整台补录时附带 `medications` 数组（同品种不重复）或在进行中手术通过 `inpatient.surgery.record-medication`（v1）逐笔追加。每笔台内用药在同一写事务内重验受控 `allowedRouteCodes`、整数计价制剂折算与单次极量（`MEDICATION_DOSAGE_NOT_ALLOWED`）以及患者当前已确认有效药物过敏红线（`MEDICATION_ALLERGY_CONFLICT`），同时豁免病区长期／临时在执医嘱的同药重复拦截（避免病区常规抗凝或含服医嘱误杀台内给药）。成功后创建 `status = 'completed'`、经 `partOf` 指向本台 `Procedure/<executionId>` 且不挂靠病区 `MedicationRequest` 的 FHIR R5 `MedicationAdministration`（写入受控 `dosage.route`），并按品规冻结甲／乙／丙医保属性写入正式 `inpatient_charge`（`kind = 'medication'`，`source_id = medicationUseId`），不生成 `inpatient_order` / `inpatient_dispense`，也不触碰中心药房库存批次。常规台内基数药登记不触发计划外耗材的强制 `note` 门禁。
- **术中专科护理自动联动与历史无损冻结**：在 `hospital_service_catalog` 预置 `inpatientBillingTrigger = 'surgery-completion'` 的术中介入专科护理与术中手术室专科护理项目（保留完整服务目录 schema 兼容性且自动排除于病区常规护理医嘱目录之外），按术式 ID 确定性绑定冠脉造影／PCI 五项介入操作与腹腔镜胆囊切除术，保留阑尾切除与腹股沟疝修补作为无联动对照。`preview-completion`（v3）将 `nursingAmountFen` 与 `linkedNursing` 纳入差额预览及 `expectedFingerprint`；`execute` 与 `complete`（v5）在同一完成事务内自动落库 `inpatient_charge`（`kind = 'service'`，`source_id = executionId`）并将快照冻结于 `inpatient_surgery_execution.linked_nursing_json`；`inpatient.drg.simulate`（v6）将待完成手术计划的联动护理费计入 `plannedSurgeryFen`，手术完成后无缝转入正式收费净额。升级前已完成的历史手术保持 `linked_nursing_json = NULL`，不产生病案 `sourcesHash` 漂移或术后核查误报。

## Alternatives considered

- **继续复用病区 `ONCE` 或 `PRN` 医嘱并在后台静默代办校对、发药与给药**：表面少建一张表，但会伪造根本未发生的病区护士校对、中心药房批号调剂与库存扣减审计记录，违背 ClinMesh“只记录已实际发生的角色动作与库存流水”的核心领域不变量，且会被病区同药在执医嘱互斥规则误拦。
- **建立独立的手术室二级药柜批号库存、领药补货与空安瓿盘点子系统**：超出当前住院手术与 DRG 费用闭环仿真目标，引入与临床推理及医保结算无关的库房行政复杂度；当前明确将台内基数药界定为目录单价与整数计价单位驱动的临床给药记账，物理二级库房留待未来确有药事管理场景时独立立项。
- **在读取历史已完成手术时按当前目录动态反推联动护理费**：一旦目录调整或旧数据在联动上线前已完成，就会凭空改写历史手术展示或触发 `billing-mismatch` 核查异常；将完成瞬间的联动护理快照冻结在 `inpatient_surgery_execution.linked_nursing_json` 才能保证历史不可变与重放幂等。

## Consequences

- 导管室与手术室的台内对比剂、抗凝、局麻与基础液体回归医生在手术界面一键套用套餐或逐笔登记的真实职责边界，病区医嘱与中心药房集中发药仅承载真实的病区用药流转。
- 术中给药与联动专科护理费用在手术实施／完成事务内同步冻结品规级医保属性并接入住院账单、患者医保待遇、DRG 预计总额、术后收费核查与病案首页分类汇总，收费员仍可在首次封账前使用既有费用冲正链路修正错记账项。
- 新增一处窄范围住院手术写操作 `inpatient.surgery.record-medication`，同步纳入 `hisOperationCatalog`、`useInpatientWriteIntent` 原回执恢复与 `clinmesh-inpatient` Skill，同时保持 DSH 住院单阶段工具数量不膨胀。
