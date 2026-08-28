import type {
  ScenarioDatasetContent,
  ScenarioHospitalServiceCatalogItem,
  ScenarioProductMedicationCatalogItem,
} from '@clinmesh/contracts/scenario'
import type {
  ReferenceMedicalService,
  ReferenceMedicationProduct,
  ReferenceValueSetEntry,
} from '@clinmesh/contracts/reference-data'
import {
  investigationLoincCoding,
  resolveUcumUnit,
} from './reference-coding-package.ts'
import { canonicalJsonHash } from './canonical-json.ts'

const hospitalId = 'hospital-synthetic-renhe'

type HospitalBaseline = Omit<
  Pick<ScenarioDatasetContent, 'catalog' | 'hospital' | 'inventory'>,
  'catalog'
> & {
  catalog: Omit<ScenarioDatasetContent['catalog'], 'medications' | 'services'> & {
    medications: ScenarioProductMedicationCatalogItem[]
    services: ScenarioHospitalServiceCatalogItem[]
  }
}

function regulatoryVerification(product: {
  approvalNumber: string
  genericName: string
  manufacturer: string
}) {
  return {
    evidenceUrl: 'https://www.nmpa.gov.cn/datasearch/home-index.html',
    result: 'synthetic-match' as const,
    source: 'nmpa-manual-check' as const,
    verifiedAt: '2026-08-28T00:00:00+08:00',
    verifiedFieldsHash: canonicalJsonHash({
      approvalNumber: product.approvalNumber,
      genericName: product.genericName,
      manufacturer: product.manufacturer,
    }),
  }
}

function selectedMedicationProduct(
  products: readonly ReferenceMedicationProduct[],
  code: string,
): ReferenceMedicationProduct {
  const matches = products.filter(product => (
    product.code === code
    && product.system === 'urn:clinmesh:reference:nhsa-medication-product'
  ))
  if (matches.length !== 1) {
    throw new Error(`Medication Product snapshot must contain exactly one ${code}`)
  }
  const product = matches[0]!
  if (product.status !== 'active') throw new Error(`Medication Product ${code} is not active`)
  return product
}

function selectedProductSnapshot(product: ReferenceMedicationProduct) {
  return {
    approvalNumber: product.approvalNumber,
    brandName: product.brandName,
    code: product.code,
    dosageForm: product.dosageForm,
    genericName: product.genericName,
    id: product.id,
    manufacturer: product.manufacturer,
    packageDescription: product.packageDescription,
    strength: product.strength,
    system: 'urn:clinmesh:reference:nhsa-medication-product' as const,
    version: product.version,
  }
}

function selectedMedicalService(
  services: readonly ReferenceMedicalService[],
  code: string,
): ReferenceMedicalService {
  const matches = services.filter(service => (
    service.code === code
    && service.system === 'urn:clinmesh:reference:nhc-medical-service'
  ))
  if (matches.length !== 1) {
    throw new Error(`Medical Service snapshot must contain exactly one ${code}`)
  }
  const service = matches[0]!
  if (service.status !== 'active') throw new Error(`Medical Service ${code} is not active`)
  return service
}

function selectedValueSetEntry(
  entries: readonly ReferenceValueSetEntry[],
  system: string,
  code: string,
) {
  const matches = entries.filter(entry => entry.system === system && entry.code === code)
  if (matches.length !== 1) throw new Error(`WS/T snapshot must contain exactly one ${system}|${code}`)
  const entry = matches[0]!
  if (entry.status !== 'active') throw new Error(`WS/T value ${system}|${code} is not active`)
  return {
    code: entry.code,
    display: entry.display,
    system: entry.system,
    valueSet: entry.valueSet,
    version: entry.version,
  }
}

function hospitalService(input: {
  itemId: string
  localCode: string
  name: string
  nationalService: ReferenceMedicalService
  componentServiceIds?: string[]
  priceFen: number
  reportTemplate: string
  requestCatalogItemIds: string[]
  tatMinutes: number
  valueSetEntries: readonly ReferenceValueSetEntry[]
}): ScenarioHospitalServiceCatalogItem {
  return {
    ...catalogBase({
      code: input.localCode,
      id: input.itemId,
      name: input.name,
      priceFen: input.priceFen,
    }),
    availableScopes: ['outpatient'],
    billingUnit: selectedValueSetEntry(
      input.valueSetEntries,
      'urn:clinmesh:wst:billing-unit',
      input.nationalService.billingUnitCode,
    ),
    category: selectedValueSetEntry(
      input.valueSetEntries,
      'urn:clinmesh:wst:service-category',
      input.nationalService.categoryCode,
    ),
    chargeDefinition: {
      currency: 'CNY',
      effectiveOn: '2026-08-28',
      id: `charge-definition-${input.itemId}`,
      priceFen: input.priceFen,
    },
    componentServiceIds: input.componentServiceIds ?? [],
    executingDepartmentId: 'department-laboratory',
    nationalService: {
      code: input.nationalService.code,
      display: input.nationalService.display,
      id: input.nationalService.id,
      system: 'urn:clinmesh:reference:nhc-medical-service',
      version: input.nationalService.version,
    },
    reportTemplate: input.reportTemplate,
    requestCatalogItemIds: input.requestCatalogItemIds,
    tatMinutes: input.tatMinutes,
  }
}

function catalogBase(input: { code: string; id: string; name: string; priceFen: number }) {
  return {
    active: true,
    code: input.code,
    id: input.id,
    name: input.name,
    organizationId: hospitalId,
    priceFen: input.priceFen,
    status: 'active' as const,
  }
}

function investigation(input: {
  allowedIndicationCodes?: string[]
  assayCv?: number
  available?: boolean
  category?: 'examination' | 'imaging' | 'laboratory'
  code: string
  componentItemIds?: string[]
  criticalMaximum?: number
  criticalMinimum?: number
  id: string
  maximum?: number
  mean?: number
  minimum?: number
  name: string
  physiologyGeneratorId?: string
  priceFen: number
  referenceRange: string
  reportTemplate: string
  standardDeviation?: number
  tatMinutes: number
  unit?: string
  valueType?: 'boolean' | 'codeable' | 'panel' | 'quantity' | 'string'
}): ScenarioDatasetContent['catalog']['investigations'][number] {
  const normalDistribution = input.assayCv !== undefined
    && input.maximum !== undefined
    && input.mean !== undefined
    && input.minimum !== undefined
    && input.standardDeviation !== undefined
    ? {
        assayCv: input.assayCv,
        maximum: input.maximum,
        mean: input.mean,
        minimum: input.minimum,
        standardDeviation: input.standardDeviation,
      }
    : undefined
  const coding = investigationLoincCoding(input.id)
  const unit = input.unit === undefined ? undefined : resolveUcumUnit({ display: input.unit })
  if (input.unit !== undefined && unit === undefined) {
    throw new Error(`Investigation ${input.id} has an unknown UCUM unit: ${input.unit}`)
  }
  return {
    ...catalogBase(input),
    allowedIndicationCodes: input.allowedIndicationCodes ?? (input.category === 'examination'
      ? ['clinical-assessment']
      : ['fever', 'type-2-diabetes']),
    available: input.available ?? true,
    category: input.category ?? 'laboratory',
    ...(coding === undefined ? {} : { coding }),
    ...(input.componentItemIds === undefined ? {} : { componentItemIds: input.componentItemIds }),
    contraindicatedAllergyCodes: [],
    ...(input.criticalMaximum === undefined ? {} : { criticalMaximum: input.criticalMaximum }),
    ...(input.criticalMinimum === undefined ? {} : { criticalMinimum: input.criticalMinimum }),
    ...(normalDistribution === undefined ? {} : { normalDistribution }),
    ...(input.physiologyGeneratorId === undefined
      ? {}
      : { physiologyGeneratorId: input.physiologyGeneratorId }),
    referenceRanges: [{
      appliesToGender: 'any',
      ...(input.maximum === undefined ? {} : { maximum: input.maximum }),
      ...(input.minimum === undefined ? {} : { minimum: input.minimum }),
      text: input.referenceRange,
    }],
    reportTemplate: input.reportTemplate,
    tatMinutes: input.tatMinutes,
    ...(unit === undefined ? {} : { unit }),
    valueType: input.valueType ?? 'quantity',
  }
}

export function createHospitalBaseline(
  medicationProducts: readonly ReferenceMedicationProduct[],
  medicalServices: readonly ReferenceMedicalService[],
  valueSetEntries: readonly ReferenceValueSetEntry[],
): HospitalBaseline {
  const acetaminophenProduct = selectedMedicationProduct(
    medicationProducts,
    'CM-NHSA-PRODUCT-ACETAMINOPHEN',
  )
  const metforminProduct = selectedMedicationProduct(
    medicationProducts,
    'CM-NHSA-PRODUCT-METFORMIN',
  )
  const amlodipineProduct = selectedMedicationProduct(
    medicationProducts,
    'CM-NHSA-PRODUCT-AMLODIPINE',
  )
  const cbcService = selectedMedicalService(medicalServices, 'CM-NHC-SERVICE-CBC')
  const hba1cService = selectedMedicalService(medicalServices, 'CM-NHC-SERVICE-HBA1C')
  const cbcComponentServices = ([
    ['WBC', '白细胞计数服务', 'lab-wbc', '白细胞计数 {value} x10^9/L。'],
    ['HGB', '血红蛋白服务', 'lab-hemoglobin', '血红蛋白 {value} g/L。'],
    ['RBC', '红细胞计数服务', 'lab-rbc', '红细胞计数 {value} x10^12/L。'],
    ['MCV', '平均红细胞体积服务', 'lab-mcv', '平均红细胞体积 {value} fL。'],
    ['HCT', '红细胞压积服务', 'lab-hematocrit', '红细胞压积 {value} L/L。'],
  ] as const).map(([code, name, requestCatalogItemId, reportTemplate]) => hospitalService({
    itemId: `hospital-service-${code.toLowerCase()}`,
    localCode: `HOSP-SVC-${code}`,
    name,
    nationalService: selectedMedicalService(medicalServices, `CM-NHC-SERVICE-${code}`),
    priceFen: 800,
    reportTemplate,
    requestCatalogItemIds: [requestCatalogItemId],
    tatMinutes: 20,
    valueSetEntries,
  }))
  return {
    catalog: {
      departments: [{
        ...catalogBase({ code: 'GM', id: 'department-general-medicine', name: '全科医学科', priceFen: 0 }),
        displayOrder: 10,
        parentId: hospitalId,
        registrationAvailable: true,
        type: 'department',
      }, {
        ...catalogBase({ code: 'LAB', id: 'department-laboratory', name: '检验科', priceFen: 0 }),
        displayOrder: 20,
        parentId: hospitalId,
        registrationAvailable: false,
        type: 'department',
      }],
      diagnoses: [{
        ...catalogBase({ code: 'J10.1', id: 'diagnosis-influenza', name: '流感伴呼吸道表现', priceFen: 0 }),
        codeSystem: 'http://hl7.org/fhir/sid/icd-10',
      }, {
        ...catalogBase({ code: 'J06.9', id: 'diagnosis-acute-upper-respiratory-infection', name: '急性上呼吸道感染，未特指', priceFen: 0 }),
        codeSystem: 'http://hl7.org/fhir/sid/icd-10',
      }, {
        ...catalogBase({ code: 'R50.9', id: 'diagnosis-fever', name: '发热，未特指', priceFen: 0 }),
        codeSystem: 'http://hl7.org/fhir/sid/icd-10',
      }, {
        ...catalogBase({ code: 'E11.65', id: 'diagnosis-type-2-diabetes-hyperglycemia', name: '2型糖尿病伴高血糖', priceFen: 0 }),
        codeSystem: 'http://hl7.org/fhir/sid/icd-10',
      }, {
        ...catalogBase({ code: 'I10', id: 'diagnosis-hypertension', name: '高血压', priceFen: 0 }),
        codeSystem: 'http://hl7.org/fhir/sid/icd-10',
      }, {
        ...catalogBase({ code: 'E05.90', id: 'diagnosis-hyperthyroidism', name: '甲状腺功能亢进', priceFen: 0 }),
        codeSystem: 'http://hl7.org/fhir/sid/icd-10',
      }],
      investigations: [
        investigation({
          category: 'examination',
          code: 'BODY-TEMP',
          id: 'lab-body-temperature',
          maximum: 37.3,
          mean: 36.6,
          minimum: 36,
          name: '体温',
          physiologyGeneratorId: 'body-temperature',
          priceFen: 0,
          referenceRange: '36.0-37.3 °C',
          reportTemplate: '体温 {value} °C。',
          standardDeviation: 0.2,
          assayCv: 0.005,
          tatMinutes: 0,
          unit: '°C',
        }),
        investigation({
          allowedIndicationCodes: ['type-2-diabetes'],
          category: 'examination',
          code: 'BMI',
          id: 'exam-bmi',
          maximum: 23.9,
          minimum: 18.5,
          name: '体重指数',
          physiologyGeneratorId: 'body-mass-index',
          priceFen: 0,
          referenceRange: '18.5-23.9 kg/m²',
          reportTemplate: '体重指数 {value} kg/m²。',
          tatMinutes: 0,
          unit: 'kg/m²',
        }),
        investigation({
          code: 'CBC',
          componentItemIds: ['lab-wbc', 'lab-hemoglobin', 'lab-rbc', 'lab-mcv', 'lab-hematocrit'],
          id: 'lab-cbc',
          name: '血常规',
          priceFen: 2_500,
          referenceRange: '按血细胞分类项目报告',
          reportTemplate: '{value}',
          tatMinutes: 20,
          valueType: 'panel',
        }),
        investigation({
          assayCv: 0.04,
          code: 'WBC',
          criticalMaximum: 30,
          criticalMinimum: 1,
          id: 'lab-wbc',
          maximum: 9.5,
          mean: 6.5,
          minimum: 3.5,
          name: '白细胞计数',
          priceFen: 800,
          referenceRange: '3.5-9.5 x10^9/L',
          reportTemplate: '白细胞计数 {value} x10^9/L。',
          standardDeviation: 1.2,
          tatMinutes: 20,
          unit: '10^9/L',
        }),
        investigation({
          assayCv: 0.02,
          code: 'HGB',
          criticalMaximum: 200,
          criticalMinimum: 60,
          id: 'lab-hemoglobin',
          maximum: 175,
          mean: 145,
          minimum: 115,
          name: '血红蛋白',
          physiologyGeneratorId: 'hemoglobin',
          priceFen: 800,
          referenceRange: '115-175 g/L（需结合性别）',
          reportTemplate: '血红蛋白 {value} g/L。',
          standardDeviation: 12,
          tatMinutes: 20,
          unit: 'g/L',
        }),
        investigation({
          assayCv: 0.03,
          code: 'RBC',
          id: 'lab-rbc',
          maximum: 5.8,
          mean: 4.7,
          minimum: 3.8,
          name: '红细胞计数',
          physiologyGeneratorId: 'red-blood-cells',
          priceFen: 800,
          referenceRange: '3.8-5.8 x10^12/L（需结合性别）',
          reportTemplate: '红细胞计数 {value} x10^12/L。',
          standardDeviation: 0.35,
          tatMinutes: 20,
          unit: '10^12/L',
        }),
        investigation({
          assayCv: 0.02,
          code: 'MCV',
          id: 'lab-mcv',
          maximum: 100,
          mean: 90,
          minimum: 80,
          name: '平均红细胞体积',
          physiologyGeneratorId: 'mean-corpuscular-volume',
          priceFen: 800,
          referenceRange: '80-100 fL',
          reportTemplate: '平均红细胞体积 {value} fL。',
          standardDeviation: 4,
          tatMinutes: 20,
          unit: 'fL',
        }),
        investigation({
          assayCv: 0.02,
          code: 'HCT',
          id: 'lab-hematocrit',
          maximum: 0.52,
          mean: 0.43,
          minimum: 0.35,
          name: '红细胞压积',
          physiologyGeneratorId: 'hematocrit',
          priceFen: 800,
          referenceRange: '0.35-0.52 L/L（需结合性别）',
          reportTemplate: '红细胞压积 {value} L/L。',
          standardDeviation: 0.035,
          tatMinutes: 20,
          unit: 'L/L',
        }),
        investigation({
          assayCv: 0.05,
          code: 'CRP',
          id: 'lab-crp',
          maximum: 8,
          mean: 2,
          minimum: 0,
          name: 'C 反应蛋白',
          priceFen: 4_300,
          referenceRange: '0-8 mg/L',
          reportTemplate: 'C 反应蛋白 {value} mg/L。',
          standardDeviation: 1.5,
          tatMinutes: 30,
          unit: 'mg/L',
        }),
        investigation({
          assayCv: 0.02,
          code: 'GLUCOSE',
          criticalMaximum: 27.8,
          criticalMinimum: 2.8,
          id: 'lab-random-glucose',
          maximum: 11,
          mean: 6.2,
          minimum: 3.9,
          name: '随机血糖',
          physiologyGeneratorId: 'random-glucose',
          priceFen: 500,
          referenceRange: '3.9-11.1 mmol/L',
          reportTemplate: '随机血糖 {value} mmol/L。',
          standardDeviation: 1.5,
          tatMinutes: 30,
          unit: 'mmol/L',
        }),
        investigation({
          code: 'URINE-GLUCOSE',
          id: 'lab-urine-glucose',
          name: '尿糖',
          physiologyGeneratorId: 'urine-glucose',
          priceFen: 500,
          referenceRange: '阴性',
          reportTemplate: '尿糖 {value}。',
          tatMinutes: 30,
          valueType: 'codeable',
        }),
        investigation({
          assayCv: 0.02,
          code: 'HBA1C',
          id: 'lab-hba1c',
          maximum: 6,
          mean: 5.2,
          minimum: 4,
          name: '糖化血红蛋白',
          priceFen: 4_500,
          referenceRange: '4.0-6.0 %',
          reportTemplate: '糖化血红蛋白 {value}%。',
          standardDeviation: 0.35,
          tatMinutes: 120,
          unit: '%',
        }),
        investigation({
          assayCv: 0.03,
          code: 'CREATININE',
          criticalMaximum: 700,
          id: 'lab-creatinine',
          maximum: 104,
          mean: 75,
          minimum: 45,
          name: '血清肌酐',
          physiologyGeneratorId: 'serum-creatinine',
          priceFen: 1_500,
          referenceRange: '45-104 μmol/L（需结合性别）',
          reportTemplate: '血清肌酐 {value} μmol/L。',
          standardDeviation: 12,
          tatMinutes: 60,
          unit: 'μmol/L',
        }),
        investigation({
          code: 'EGFR',
          id: 'lab-egfr',
          minimum: 60,
          name: '估算肾小球滤过率',
          physiologyGeneratorId: 'estimated-gfr',
          priceFen: 0,
          referenceRange: '>=60 mL/min/1.73m²',
          reportTemplate: '估算肾小球滤过率 {value} mL/min/1.73m²。',
          tatMinutes: 60,
          unit: 'mL/min/1.73m²',
        }),
        investigation({
          assayCv: 0.02,
          code: 'TSH',
          id: 'lab-tsh',
          maximum: 4.78,
          mean: 2.1,
          minimum: 0.55,
          name: '促甲状腺激素',
          priceFen: 18_000,
          referenceRange: '0.55-4.78 mIU/L',
          reportTemplate: '促甲状腺激素 {value} mIU/L。',
          standardDeviation: 0.8,
          tatMinutes: 240,
          unit: 'mIU/L',
        }),
        investigation({
          available: false,
          category: 'imaging',
          code: 'FUNDUS',
          id: 'exam-fundus-screening',
          name: '眼底筛查',
          priceFen: 0,
          referenceRange: '不适用',
          reportTemplate: '本院门诊未开展，可转诊眼科。',
          tatMinutes: 0,
          valueType: 'string',
        }),
        investigation({
          code: 'OGTT',
          id: 'lab-ogtt',
          name: '口服葡萄糖耐量试验',
          priceFen: 6_000,
          referenceRange: '按试验时点解释',
          reportTemplate: '{value}',
          tatMinutes: 180,
          valueType: 'panel',
        }),
      ],
      medications: [{
        ...catalogBase({ code: 'ACETAMINOPHEN', id: 'medication-acetaminophen', name: '对乙酰氨基酚片', priceFen: 120 }),
        availableScopes: ['outpatient'] as const,
        category: '解热镇痛药',
        defaultDose: '0.5 g',
        defaultFrequency: 'PRN',
        defaultRoute: '口服',
        dosageForm: '片剂',
        drugConcept: {
          code: 'CM-DRUG-ACETAMINOPHEN-500MG-ORAL-TABLET',
          conceptId: 'drug-concept-acetaminophen-500mg-oral-tablet',
          display: '对乙酰氨基酚 500 mg 口服片剂',
          kind: 'drug-concept' as const,
          system: 'urn:clinmesh:reference:drug-concept' as const,
          version: 'clinmesh-drug-concepts-2026-08-28',
        },
        product: selectedProductSnapshot(acetaminophenProduct),
        regulatoryVerification: regulatoryVerification(acetaminophenProduct),
        restriction: '注意总剂量及肝功能风险。',
        unit: '片',
        workflow: {
          allowedCombinationIds: ['medication-metformin'],
          allowedCourseDays: [3],
          allowedDiagnosisCodes: ['J10.1', 'J06.9', 'R50.9'],
          allowedDoseTexts: ['0.5 g'],
          allowedFrequencyCodes: ['PRN'],
          allowedQuantities: [6],
          defaultCourseDays: 3,
          defaultQuantity: 6,
        },
      }, {
        ...catalogBase({ code: 'METFORMIN', id: 'medication-metformin', name: '盐酸二甲双胍片', priceFen: 1_200 }),
        availableScopes: ['outpatient'] as const,
        category: '双胍类降糖药',
        defaultDose: '0.5 g',
        defaultFrequency: 'BID',
        defaultRoute: '口服',
        dosageForm: '片剂',
        drugConcept: {
          code: 'CM-DRUG-METFORMIN-HCL-500MG-ORAL-TABLET',
          conceptId: 'drug-concept-metformin-hcl-500mg-oral-tablet',
          display: '盐酸二甲双胍 500 mg 口服片剂',
          kind: 'drug-concept' as const,
          system: 'urn:clinmesh:reference:drug-concept' as const,
          version: 'clinmesh-drug-concepts-2026-08-28',
        },
        product: selectedProductSnapshot(metforminProduct),
        regulatoryVerification: regulatoryVerification(metforminProduct),
        restriction: '调整方案前评估肾功能。',
        unit: '片',
        workflow: {
          allowedCombinationIds: [],
          allowedCourseDays: [30],
          allowedDiagnosisCodes: ['E11.65'],
          allowedDoseTexts: ['0.5 g'],
          allowedFrequencyCodes: ['BID'],
          allowedQuantities: [60],
          defaultCourseDays: 30,
          defaultQuantity: 60,
        },
      }, {
        ...catalogBase({ code: 'AMLODIPINE', id: 'medication-amlodipine', name: '苯磺酸氨氯地平片', priceFen: 1_500 }),
        availableScopes: ['outpatient'] as const,
        category: '钙通道阻滞剂',
        defaultDose: '5 mg',
        defaultFrequency: 'QD',
        defaultRoute: '口服',
        dosageForm: '片剂',
        drugConcept: {
          code: 'CM-DRUG-AMLODIPINE-5MG-ORAL-TABLET',
          conceptId: 'drug-concept-amlodipine-5mg-oral-tablet',
          display: '氨氯地平 5 mg 口服片剂',
          kind: 'drug-concept' as const,
          system: 'urn:clinmesh:reference:drug-concept' as const,
          version: 'clinmesh-drug-concepts-2026-08-28',
        },
        product: selectedProductSnapshot(amlodipineProduct),
        regulatoryVerification: regulatoryVerification(amlodipineProduct),
        restriction: '开始或调整方案前评估血压和外周水肿。',
        unit: '片',
        workflow: {
          allowedCombinationIds: [],
          allowedCourseDays: [30],
          allowedDiagnosisCodes: ['I10'],
          allowedDoseTexts: ['5 mg'],
          allowedFrequencyCodes: ['QD'],
          allowedQuantities: [30],
          defaultCourseDays: 30,
          defaultQuantity: 30,
        },
      }],
      services: [hospitalService({
        componentServiceIds: cbcComponentServices.map(service => service.id),
        itemId: 'hospital-service-cbc',
        localCode: 'HOSP-SVC-CBC',
        name: '血常规服务',
        nationalService: cbcService,
        priceFen: 2_500,
        reportTemplate: '{value}',
        requestCatalogItemIds: ['lab-cbc'],
        tatMinutes: 20,
        valueSetEntries,
      }), ...cbcComponentServices, hospitalService({
        itemId: 'hospital-service-hba1c',
        localCode: 'HOSP-SVC-HBA1C',
        name: '糖化血红蛋白服务',
        nationalService: hba1cService,
        priceFen: 4_500,
        reportTemplate: '糖化血红蛋白 {value}%。',
        requestCatalogItemIds: ['lab-hba1c'],
        tatMinutes: 120,
        valueSetEntries,
      })],
    },
    hospital: {
      active: true,
      businessCode: 'CM-SYN-HOSPITAL-001',
      displayOrder: 1,
      id: hospitalId,
      locale: 'zh-CN',
      name: '仁和临床仿真医院',
      status: 'active',
      type: 'public-general-hospital',
    },
    inventory: [{
      expiresOn: '2030-12-31',
      itemId: 'medication-acetaminophen',
      lotId: 'lot-acetaminophen-synthetic-001',
      quantity: 1_000,
    }, {
      expiresOn: '2030-12-31',
      itemId: 'medication-metformin',
      lotId: 'lot-metformin-synthetic-001',
      quantity: 1_000,
    }, {
      expiresOn: '2030-12-31',
      itemId: 'medication-amlodipine',
      lotId: 'lot-amlodipine-synthetic-001',
      quantity: 1_000,
    }],
  }
}
