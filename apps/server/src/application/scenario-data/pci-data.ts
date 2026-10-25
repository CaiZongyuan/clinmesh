import { inpatientPciDataPackageSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { laboratoryServiceSnapshotSchema } from '@clinmesh/contracts/his'
import { referenceConceptSnapshotSchema, referenceMedicationProductSchema } from '@clinmesh/contracts/reference-data'
import products from './pci-medication-products.json' with { type: 'json' }
import laboratoryCodings from './pci-laboratory-codings.json' with { type: 'json' }
import clopidogrelQuotation from './pci-clopidogrel-quotation.json' with { type: 'json' }
import { cardiovascularMaterials } from './cardiovascular-materials.ts'
import { syntheticInpatientSurgeryCatalog } from './inpatient-surgery-catalog.ts'
import { syntheticPciDrgPaymentParameters } from './pci-drg-payment-parameters.ts'

const version = '2026-10-25.r1'
const referenceReleaseId = 'clinmesh-cn-health-2026-09-02.r1'
const medicationProducts = referenceMedicationProductSchema.array().parse(products)
const laboratoryReferences = referenceConceptSnapshotSchema.array().parse(laboratoryCodings)
const diagnosis = {
  id: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I25.103',
  system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022', code: 'I25.103',
  display: '冠状动脉粥样硬化性心脏病', sourceLocator: 'cn-health:nhc-icd10-clinical@2022.r4:diagnosis:12670',
}
const medicationDefinitions = [
  ['aspirin', 'XB01ACA056A012010100002', '片', 50, 100, 'mg', 3, '100 mg', 1, 'QD', '口服', 1000],
  ['clopidogrel', 'XB01ACL190A001010209639', '片', 80, 75, 'mg', 4, '75 mg', 1, 'QD', '口服', 1000],
  ['atorvastatin', 'XC10AAA067A001010100042', '片', 70, 10, 'mg', 8, '20 mg', 2, 'QD', '口服', 1000],
  ['heparin', 'XB01ABG047B002010100651', 'mL', 200, 6250, 'IU', 2, '1 mL', 1, 'PRN', '注射', 1000],
  ['iohexol', 'XV08ABD107B002010100014', 'mL', 150, 1, 'mL', 100, '50 mL', 50, 'PRN', '血管内注射', 2000],
] as const

function loinc(code: string) {
  const coding = laboratoryReferences.find(item => item.code === code)
  if (coding === undefined) throw new Error(`The fixed PCI reference excerpt is missing LOINC ${code}`)
  return coding
}
// 数值与参考区间为固定合成底稿；2160-0 是质量浓度，使用 mg/dL，不冒充物质的量浓度。
const laboratoryDefinitions = [
  ['wbc', '6690-2', '白细胞计数', '10*9/L', 3.5, 9.5, 6.2, 'whole-blood', '全血', 800],
  ['hemoglobin', '718-7', '血红蛋白', 'g/L', 130, 175, 145, 'whole-blood', '全血', 800],
  ['platelets', '777-3', '血小板计数', '10*9/L', 125, 350, 220, 'whole-blood', '全血', 800],
  ['creatinine', '2160-0', '肌酐（质量浓度）', 'mg/dL', 0.6, 1.3, 0.9, 'serum', '血清', 1000],
  ['inr', '6301-6', '国际标准化比值 INR', '1', 0.8, 1.2, 1, 'citrated-plasma', '枸橼酸盐抗凝血浆', 2000],
  ['alt', '1742-6', '丙氨酸氨基转移酶', 'U/L', 0, 50, 25, 'serum', '血清', 1000],
  ['ast', '1920-8', '天冬氨酸氨基转移酶', 'U/L', 0, 40, 24, 'serum', '血清', 1000],
  ['potassium', '2823-3', '钾', 'mmol/L', 3.5, 5.3, 4.2, 'serum', '血清', 800],
  ['sodium', '2951-2', '钠', 'mmol/L', 137, 147, 141, 'serum', '血清', 800],
] as const

export const pciDataPackage = inpatientPciDataPackageSchema.parse({
  id: 'clinmesh-inpatient-pci-data', version, synthetic: true,
  caseDraft: {
    id: 'pci-elective-single-stent-v1', name: '合成冠脉病例甲', birthDate: '1965-04-12', gender: 'male',
    chiefComplaint: '活动后胸部闷痛三个月，加重一周，休息后缓解。',
    history: '固定合成底稿：择期、非急诊，无心肌梗死、心力衰竭、肾功能不全或复杂并发症。既往外院评估考虑稳定性冠心病，拟入院评估；静息无胸痛，无已知药物过敏。既往心电资料描述为活动相关缺血改变。本院检查、诊断、造影及支架植入须在实际就诊中依法定动作形成，底稿不表示本院已实施。',
    baselineObservations: laboratoryDefinitions.map(([, code, , unit, , , value]) => ({ coding: loinc(code), value, unit })),
    plannedStentCount: 1, intendedUse: 'authoring-only',
  },
  diagnosis,
  procedures: syntheticInpatientSurgeryCatalog.procedures.filter(item => ['hospital-surgery-3', 'hospital-surgery-7'].includes(item.id)),
  groupingTarget: { code: 'FM39', status: 'target-only', note: '编码核对目标为 I25.103 与主要操作 36.0700；与医保版同码核对后供 #279 加载版本规则实际分组，本数据包不产生分组结果。' },
  medications: medicationDefinitions.map(([suffix, code, unit, priceFen, basisAmount, basisUnit, maximum, suggestedDoseText, suggestedQuantity, frequency, route, initialStock]) => ({
    id: `medication-pci-${suffix}`, product: medicationProducts.find(product => product.code === code), referenceReleaseId,
    hospitalSupplement: { synthetic: true, unit, priceFen, doseBasis: { amount: basisAmount, unit: basisUnit }, maxDoseQuantity: maximum,
      suggestedDoseText, suggestedQuantity, frequencyCodes: [frequency], route, initialStock,
      note: '合成院内收费、启用范围、库存与有界仿真规则，不是临床处方建议。含量换算按明确规格；注射剂以 mL 库存与计价，实际每次用量由医生填写，仅支持可精确发药的整 mL。' },
    ...(suffix === 'clopidogrel' ? { sourceQuotation: { recordId: clopidogrelQuotation.id,
      sourceLocator: `${clopidogrelQuotation.source.path}#${clopidogrelQuotation.source.worksheet}!N321`,
      priceFen: 700, unit: null, basis: 'denominator_unverified', original: clopidogrelQuotation } } : {}),
  })),
  materials: ([
    [60, 'guidewire', '冠脉导丝，0.014英寸，合成院内规格', '根'],
    [102, 'guiding-catheter', '冠脉导引导管，6F，合成院内规格', '根'],
    [122, 'balloon', '预扩球囊，2.5×15 mm，合成院内规格', '个'],
    [223, 'stent', '药物洗脱支架，3.0×18 mm，合成院内规格', '枚'],
  ] as const).map(([row, suffix, specification, unit]) => {
    const source = cardiovascularMaterials.find(item => item.reference?.row === row)!
    return { item: { id: `hospital-material-pci-${suffix}`, version: 1, display: `合成院内 ${specification}`, reference: source.reference,
      chargeDefinition: { id: `hospital-charge-pci-${suffix}`, priceFen: source.reference!.priceFen, unit, synthetic: true, trigger: 'execution' } },
    hospitalSupplement: { synthetic: true, specification, note: '沿用来源金额；计费单位与规格为独立的合成院内声明，原表空值及地区/时效适用性保持原样，不声称已确认原报价分母。' } }
  }),
  laboratories: laboratoryDefinitions.map(([suffix, code, nameZh, unit, low, high, , specimenCode, specimenDisplay, priceFen]) => laboratoryServiceSnapshotSchema.parse({
    id: `hospital-lab-pci-${suffix}`, version: 1, localCode: `PCI-LAB-${suffix.toUpperCase()}`, nameZh, priceFen,
    allowedIndicationCodes: ['clinical-assessment'], componentServiceIds: [], doctorOrderable: true,
    executingDepartmentId: 'department-laboratory', referenceConcept: loinc(code), referenceReleaseId,
    reportDefinition: { conclusionTemplate: 'ClinMesh 固定合成资料支持的检验结果，仅用于仿真。', results: [{
      referenceConcept: loinc(code), referenceRange: { low, high, text: `${low}-${high} ${unit}（合成院内参考区间）` },
      unit: { code: unit, display: unit, system: 'http://unitsofmeasure.org' }, valueType: 'quantity',
    }] }, specimen: { code: specimenCode, display: specimenDisplay }, serviceKind: 'laboratory', tatMinutes: 30,
    publicationPolicyVersion: `clinmesh-pci-laboratory-${version}`,
  })),
  paymentParameters: syntheticPciDrgPaymentParameters,
  note: '有版本的合成病例与院内目录前置。准备不物化 Patient、门诊、住院、挂号费、实际诊断/实施、归档或核定。原始参考数据与合成补充分别保留；实际来源绑定和整链验收归 #279。',
})
