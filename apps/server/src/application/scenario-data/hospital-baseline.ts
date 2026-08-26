import type { ScenarioDatasetContent } from '@clinmesh/contracts/scenario'

const hospitalId = 'hospital-synthetic-renhe'

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
  assayCv?: number
  available?: boolean
  category?: 'examination' | 'imaging' | 'laboratory'
  code: string
  criticalMaximum?: number
  criticalMinimum?: number
  id: string
  maximum?: number
  mean?: number
  minimum?: number
  name: string
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
  return {
    ...catalogBase(input),
    allowedIndicationCodes: input.category === 'examination'
      ? ['clinical-assessment']
      : ['fever', 'type-2-diabetes'],
    available: input.available ?? true,
    category: input.category ?? 'laboratory',
    contraindicatedAllergyCodes: [],
    ...(input.criticalMaximum === undefined ? {} : { criticalMaximum: input.criticalMaximum }),
    ...(input.criticalMinimum === undefined ? {} : { criticalMinimum: input.criticalMinimum }),
    ...(normalDistribution === undefined ? {} : { normalDistribution }),
    referenceRanges: [{ appliesToGender: 'any', text: input.referenceRange }],
    reportTemplate: input.reportTemplate,
    tatMinutes: input.tatMinutes,
    ...(input.unit === undefined ? {} : { unit: input.unit }),
    valueType: input.valueType ?? 'quantity',
  }
}

export function createHospitalBaseline(): Pick<
  ScenarioDatasetContent,
  'catalog' | 'hospital' | 'inventory'
> {
  return {
    catalog: {
      departments: [{
        ...catalogBase({ code: 'GM', id: 'department-general-medicine', name: '全科医学科', priceFen: 0 }),
        displayOrder: 10,
        parentId: hospitalId,
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
          priceFen: 0,
          referenceRange: '36.0-37.3 °C',
          reportTemplate: '体温 {value} °C。',
          standardDeviation: 0.2,
          assayCv: 0.005,
          tatMinutes: 0,
          unit: '°C',
        }),
        investigation({
          code: 'CBC',
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
          priceFen: 500,
          referenceRange: '3.9-11.1 mmol/L',
          reportTemplate: '随机血糖 {value} mmol/L。',
          standardDeviation: 1.5,
          tatMinutes: 30,
          unit: 'mmol/L',
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
          priceFen: 1_500,
          referenceRange: '45-104 μmol/L（需结合性别）',
          reportTemplate: '血清肌酐 {value} μmol/L。',
          standardDeviation: 12,
          tatMinutes: 60,
          unit: 'μmol/L',
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
        category: '解热镇痛药',
        defaultDose: '0.5 g',
        defaultFrequency: 'PRN',
        defaultRoute: '口服',
        dosageForm: '片剂',
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
        category: '双胍类降糖药',
        defaultDose: '0.5 g',
        defaultFrequency: 'BID',
        defaultRoute: '口服',
        dosageForm: '片剂',
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
      }],
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
    }],
  }
}
