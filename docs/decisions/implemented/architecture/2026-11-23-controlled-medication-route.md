# Agent Note: 门诊处方与住院医嘱受控给药途径

Status: implemented

## Problem

门诊处方与住院药物医嘱原本只结构化表达剂量、频次、疗程与数量，缺少受控给药途径（Route）：硝酸甘油舌下含服与口服、普通肝素静脉注射与静脉滴注或皮下注射等关键药事差异无法由目录约束、药房审方与护士三查七对统一核验。若用自由文本备注承载途径，前后端与 FHIR 资源无法做确定性枚举校验；若直接修改国家参考目录 SQLite 物理表补充途径列，则会破坏锁定 Reference Release 的 `content_hash`；若允许护理服务医嘱共用默认途径字段或把途径拼入收费、DRG 推演与归档哈希，则会污染非药品医嘱语义并造成无关的账务或缓存失效。

## Decision

在共享合同 `@clinmesh/contracts/medication-safety` 与 `@clinmesh/core/medication-safety` 建立单一受控枚举 `MedicationRoute`（`PO`、`IVGTT`、`IV`、`IM`、`IH`、`SL`、`TOP`、`INH` 八项标准编码及中英文临床标签）。Hospital Baseline 常备药与 PCI 前置准备安装的药品显式声明 `defaultRouteCode` 与非空去重子集 `allowedRouteCodes`（`defaultRouteCode` 必须属于 `allowedRouteCodes`；未声明新字段的自定义测试配置在读取边界通过 `resolveCatalogMedicationRoutes` 按剂型／名称确定性解析，不执行活动 Epoch 旧目录静默原地回填）。国家参考目录保持 `reference_medication_product` 物理表结构与发布 `content_hash` 不变，在 `ReferenceDataService` 读取边界按剂型与通用名确定性派生 `defaultRouteCode` 与 `allowedRouteCodes` 随公开检索及详情响应返回。

门诊处方草稿、直接签发、准备清单确认、已完诊病例详情与药房队列，以及住院药物医嘱签发、护士校对、停嘱核停、药房集中发药、护士实际给药／PRN 与出院后住院摘要全链路携带强类型非空 `routeCode`；提交不在对应目录 `allowedRouteCodes` 内的编码统一返回 `409 CATALOG_CONFLICT`（门诊 `PRESCRIPTION_ROUTE_NOT_ALLOWED`、住院 `MEDICATION_ROUTE_NOT_ALLOWED`）并整单或单笔回滚。SQLite 前向迁移 `0119_medication-route.sql` 为 `prescription_item` 增加非空 `route_code` 受控约束，并为 `inpatient_order` 建立 `(kind = 'medication' AND route_code IS NOT NULL) OR (kind = 'service' AND route_code IS NULL)` 表级检查约束，确保健康教育等护理服务医嘱在存储、接口与界面全链路不携带、不展示给药途径，同时按目录默认编码前向回填存量处方明细、药物医嘱、已存处方草稿与关联 `command_receipt` 响应快照以保持幂等回放兼容。正式签发与实际给药在 FHIR R5 中以固定本地 canonical `https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/medication-route` 同步写入 `MedicationRequest.dosageInstruction[0].route` 与 `MedicationAdministration.dosage.route`。

门诊处方诊疗建议模型输出与可采纳条目携带可空 `routeCode`：指南或病例无明确给药途径依据，或模型输出编码不在该药 `allowedRouteCodes` 内时，统一将 `routeCode` 重置为 `null` 并保留可采纳条目，交由医生在待办面板按药品允许集合显式补全后再确认；心血管专病医嘱组套模板显式声明标准 `routeCode` 并在预装配草稿中直传。收费与医保结算指纹、住院 DRG 费用推演输入与指纹、住院只读指南参考意见 `basis_fingerprint` 以及病案首页归档 `sourcesHash` 均不纳入 `routeCode`，保持临床给药途径与计价分组边界正交隔离。当前目录、开方、调剂与护理执行行为由[处方、医嘱与药事合同](../../../architecture/orders-and-pharmacy.md)拥有。

## Alternatives considered

- 在自由文本 `instructions` 中手填给药途径：无法拦截超范围途径（如口服片剂误填静脉注射），也无法为药师审方、护士给药核对和 FHIR `CodeableConcept` 提供稳定结构化编码。
- 在 Reference Data SQLite 物理表新增途径字段并重发锁定包：国家参考目录原始发布源不含院内受控途径子集，改动物理表会破坏既有 `reference-data.lock.json` 的 `content_hash` 与离线核验契约。
- 为 `inpatient_order` 统一设置默认 `'PO'` 并在护理医嘱隐藏：会在持久层为健康教育等服务医嘱写入错误的口服药事事实，违背药物与护理医嘱的严格判别联合边界。
- 将 `routeCode` 纳入 DRG 模拟输入、收费指纹或归档哈希：同一药品切换允许途径（如舌下含服与口服、静注与静滴）不改变制剂数量、单价或 ICD/CHS-DRG 编码，纳入指纹会导致切换途径时已审阅费用预计无故失效。

## Consequences

门诊与住院全链路具备统一受控的八类给药途径约束、中文药事缩写展示与 FHIR R5 标准互操作投影，同时严格守住护理服务医嘱零途径污染、国家参考库零哈希漂移与计费／DRG 零指纹耦合。前向迁移同步维护持久回执与已存草稿的 schema 兼容性，DSH Surface 工具数量、512 字符描述与客户端包体积均保持在既有预算之内。
