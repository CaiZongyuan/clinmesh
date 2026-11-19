# Agent Note: 品规级甲乙丙医保属性与混合处方明细结算

Status: implemented

## Problem

既有合成医保仅按费用大类（门诊检验 10%、门诊药品 20%、住院药品 10%、住院检查 10%）统一计算先行自付，无法表达同一处方或同次住院内甲类（0%）、乙类（品规不同先行自付比例）与丙类（目录外 100% 自费）的差异，也无法验证单张混合处方的明细级分摊与目录变更后的冻结不可变性。

## Decision

1. **品规级合成医保属性**：在院内药品目录（`outpatient_catalog`）与医技/服务目录（`hospital_service_catalog`）声明 `insuranceCoverage`（`{ included, priorSelfPayBps }`），分别表达甲类（`included: true, priorSelfPayBps: 0`）、乙类（`included: true, priorSelfPayBps: 1..9999`）与丙类（`included: false, priorSelfPayBps: 0`）。已发布 `laboratory-cn` 默认常规检验为甲类、专科标志物为乙类 10%，并支持在 `admin.laboratory-services.publish` 传入可选 `insuranceCoverage` 覆盖。固定 PCI 目录维持既有精确分值（PCI 5 种药品乙类 10%、9 项检验甲类 0%），不修改 `pciDataPackage` 与 `contentHash`。
2. **开立/入账冻结快照**：新增可空增量迁移 `0118_item-insurance-coverage.sql`，为 `prescription_item`、`charge_record`、`inpatient_order`、`inpatient_charge` 与 `laboratory_service_publication_job` 追加可空列。开立门诊处方/检查与住院医嘱/检查时冻结品规医保快照；仅历史 `coverage_json IS NULL` 行与直接 `InpatientBilling.record` 测试夹具回退旧大类规则，缺失映射时以 `409 INSURANCE_COVERAGE_UNAVAILABLE` 拒绝，不回退零待遇。`inpatientChargeSchema` 保持不变，确保 `inpatient_settlement.fingerprint` 与 `inpatient_record_archive.sourcesHash` 不受影响。
3. **混合处方明细级纯函数结算**：在 `@clinmesh/core/insurance` 集中实现整数分（`BigInt` 截断）品规级分摊 `allocateInsuranceBenefits` 与收费员冲减确定性比例回填 `adjustChargeItemsToTotal`。`InsuranceSource` 与 `InsuranceAllocation` 通过向后兼容的可选 `items` 字段承载明细拆分：先按明细汇总 `outsideFen`、`priorSelfPayFen`、`eligibleFen`，再在 `ChargeItem` 级别执行起付线、基金比例/封顶与仅抵扣目录内个人负担的个人账户分配。
4. **前端最小适配**：门诊 `InsurancePanel` 与住院 `InpatientFinancialInsurance` 展示紧凑甲/乙/丙/混合徽标及混合处方明细行，保持既有布局、语义标签与 DSH 客户端包体积预算。

## Alternatives considered

- 结算时动态联表读取当前目录：目录调整会导致既有未结账费用和已撤销重算的处方待遇漂移，违背冻结单据原则。
- 按药品明细拆分成多张 `ChargeItem`：会破坏门诊一张处方对应一笔药品收费的现有收款、退费和撤方合同。
- 把 `coverage_json` 加入 `inpatientChargeSchema`：会改变 `canonicalJsonHash({ charge, reversals })`、首次结算指纹与病案归档哈希。

## Consequences

门诊混合处方与住院品规级费用均支持甲/乙/丙精确整数分结算与审计溯源，目录后续调整不改变既有费用快照、历史结算与归档哈希，历史预迁移数据和 PCI 黄金账本精确兼容。详细合同由[医保模拟](../../../architecture/clinical-workflows.md#86-医保模拟)与[住院医保与首次冻结账](../../../architecture/clinical-workflows.md#住院医保与首次冻结账)拥有。
