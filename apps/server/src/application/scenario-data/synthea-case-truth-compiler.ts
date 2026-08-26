import { createHash } from 'node:crypto'
import {
  scenarioPatientSchema,
  type ScenarioGenerationRequest,
  type ScenarioInvestigationResult,
  type ScenarioPatient,
} from '@clinmesh/contracts/scenario'
import { z } from 'zod'

export const syntheaR4ResourceTypes = [
  'AllergyIntolerance',
  'CarePlan',
  'CareTeam',
  'Claim',
  'Condition',
  'Coverage',
  'Device',
  'DiagnosticReport',
  'Encounter',
  'ExplanationOfBenefit',
  'Goal',
  'ImagingStudy',
  'Immunization',
  'Location',
  'Medication',
  'MedicationRequest',
  'Observation',
  'Organization',
  'Patient',
  'Practitioner',
  'Procedure',
  'Provenance',
  'SupplyDelivery',
] as const

const referenceSchema = z.object({ reference: z.string().min(1) }).passthrough()
const codingSchema = z.object({
  code: z.string().min(1).optional(),
  display: z.string().min(1).optional(),
  system: z.string().url().optional(),
}).passthrough()
const conceptSchema = z.object({
  coding: z.array(codingSchema).optional(),
  text: z.string().min(1).optional(),
}).passthrough()
const periodSchema = z.object({
  end: z.iso.datetime({ offset: true }).optional(),
  start: z.iso.datetime({ offset: true }).optional(),
}).passthrough()

const patientSchema = z.object({
  birthDate: z.iso.date(),
  gender: z.enum(['female', 'male', 'other', 'unknown']),
  id: z.string().min(1),
  resourceType: z.literal('Patient'),
}).passthrough()

const encounterSchema = z.object({
  class: codingSchema.optional(),
  id: z.string().min(1),
  period: periodSchema.optional(),
  resourceType: z.literal('Encounter'),
  status: z.string().min(1).optional(),
  subject: referenceSchema,
  type: z.array(conceptSchema).optional(),
}).passthrough()

const conditionSchema = z.object({
  clinicalStatus: conceptSchema.optional(),
  code: conceptSchema.optional(),
  encounter: referenceSchema.optional(),
  id: z.string().min(1),
  onsetDateTime: z.iso.datetime({ offset: true }).optional(),
  recordedDate: z.iso.datetime({ offset: true }).optional(),
  resourceType: z.literal('Condition'),
  subject: referenceSchema,
}).passthrough()

const quantitySchema = z.object({
  code: z.string().min(1).optional(),
  system: z.string().url().optional(),
  unit: z.string().min(1).optional(),
  value: z.number(),
}).passthrough()

const observationSchema = z.object({
  code: conceptSchema,
  effectiveDateTime: z.iso.datetime({ offset: true }).optional(),
  encounter: referenceSchema.optional(),
  id: z.string().min(1),
  interpretation: z.array(conceptSchema).optional(),
  referenceRange: z.array(z.object({ text: z.string().min(1).optional() }).passthrough()).optional(),
  resourceType: z.literal('Observation'),
  status: z.string().min(1),
  subject: referenceSchema,
  valueBoolean: z.boolean().optional(),
  valueCodeableConcept: conceptSchema.optional(),
  valueQuantity: quantitySchema.optional(),
  valueString: z.string().min(1).optional(),
}).passthrough()

const medicationRequestSchema = z.object({
  authoredOn: z.iso.datetime({ offset: true }).optional(),
  encounter: referenceSchema.optional(),
  id: z.string().min(1),
  intent: z.string().min(1),
  medicationCodeableConcept: conceptSchema.optional(),
  medicationReference: referenceSchema.optional(),
  resourceType: z.literal('MedicationRequest'),
  status: z.string().min(1),
  subject: referenceSchema,
}).passthrough()

const allergySchema = z.object({
  clinicalStatus: conceptSchema.optional(),
  code: conceptSchema.optional(),
  id: z.string().min(1),
  patient: referenceSchema,
  recordedDate: z.iso.datetime({ offset: true }).optional(),
  resourceType: z.literal('AllergyIntolerance'),
}).passthrough()

const ignoredResourceTypes = [
  'CarePlan',
  'CareTeam',
  'Claim',
  'Coverage',
  'Device',
  'DiagnosticReport',
  'ExplanationOfBenefit',
  'Goal',
  'ImagingStudy',
  'Immunization',
  'Location',
  'Medication',
  'Organization',
  'Practitioner',
  'Procedure',
  'Provenance',
  'SupplyDelivery',
] as const

const ignoredResourceSchema = z.object({
  id: z.string().min(1),
  resourceType: z.enum(ignoredResourceTypes),
}).passthrough()

const compileableResourceSchema = z.discriminatedUnion('resourceType', [
  allergySchema,
  conditionSchema,
  encounterSchema,
  medicationRequestSchema,
  observationSchema,
  patientSchema,
])

export const syntheaR4BundleSchema = z.object({
  entry: z.array(z.object({
    fullUrl: z.string().min(1).optional(),
    resource: z.union([compileableResourceSchema, ignoredResourceSchema]),
  }).passthrough()).min(1).max(20_000),
  resourceType: z.literal('Bundle'),
  type: z.enum(['batch', 'collection', 'transaction']),
}).passthrough()

type Concept = z.infer<typeof conceptSchema>
type R4Bundle = z.infer<typeof syntheaR4BundleSchema>
type R4Observation = z.infer<typeof observationSchema>

const chineseNames = [
  '林安宁',
  '王嘉禾',
  '李思远',
  '张清和',
  '刘知夏',
  '陈景明',
  '赵文舒',
  '周允康',
] as const

const codeMappings = new Map<string, { code: string; display: string }>([
  ['386661006', { code: 'R50.9', display: '发热，原因待查' }],
  ['44054006', { code: 'E11.65', display: '2型糖尿病伴高血糖' }],
  ['38341003', { code: 'I10', display: '高血压' }],
])

const observationMappings = new Map<string, {
  catalogItemId: string
  code: string
  feeFen: number
  name: string
  referenceRange: string
  report: (value: string, unit: string) => string
  tatMinutes: number
}>([
  ['8310-5', {
    catalogItemId: 'lab-body-temperature',
    code: 'BODY-TEMP',
    feeFen: 0,
    name: '体温',
    referenceRange: '36.0-37.3 °C',
    report: (value, unit) => `体温 ${value} ${unit}`,
    tatMinutes: 0,
  }],
  ['4548-4', {
    catalogItemId: 'lab-hba1c',
    code: 'HBA1C',
    feeFen: 4_500,
    name: '糖化血红蛋白',
    referenceRange: '4.0-6.0 %',
    report: (value, unit) => `糖化血红蛋白 ${value} ${unit}`,
    tatMinutes: 120,
  }],
  ['2339-0', {
    catalogItemId: 'lab-random-glucose',
    code: 'GLUCOSE',
    feeFen: 500,
    name: '随机血糖',
    referenceRange: '3.9-11.1 mmol/L',
    report: (value, unit) => `随机血糖 ${value} ${unit}`,
    tatMinutes: 30,
  }],
])

function firstCoding(concept: Concept | undefined): z.infer<typeof codingSchema> | undefined {
  return concept?.coding?.find(coding => coding.code !== undefined || coding.display !== undefined)
}

function conceptDisplay(concept: Concept | undefined, fallback: string): string {
  return concept?.text ?? firstCoding(concept)?.display ?? fallback
}

function conceptCode(concept: Concept | undefined): string | undefined {
  return firstCoding(concept)?.code
}

function clinicalStatus(concept: Concept | undefined, fallback: string): string {
  return conceptCode(concept) ?? fallback
}

function localReferenceId(reference: string | undefined, bundle: R4Bundle): string | undefined {
  if (reference === undefined) return undefined
  const referencedEntry = bundle.entry.find(entry => (
    entry.fullUrl === reference
    || `${entry.resource.resourceType}/${entry.resource.id}` === reference
  ))
  return referencedEntry?.resource.id
}

function stableHistoryId(resourceType: string, id: string): string {
  const prefix = resourceType.toLowerCase().replace(/[^a-z0-9]/g, '-')
  const suffix = id.replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 48)
  return `history-${prefix}-${suffix}`.slice(0, 64)
}

function r5EncounterStatus(status: string | undefined): string {
  if (status === 'finished') return 'completed'
  if (status === 'cancelled') return 'cancelled'
  return status ?? 'completed'
}

function observedResult(observation: R4Observation): ScenarioInvestigationResult | undefined {
  const interpretation = conceptCode(observation.interpretation?.[0])
  const referenceRange = observation.referenceRange?.find(range => range.text !== undefined)?.text
  if (observation.valueQuantity !== undefined) {
    return {
      ...(interpretation === undefined ? {} : { flag: interpretation }),
      outcome: 'reported',
      ...(referenceRange === undefined ? {} : { referenceRange }),
      ...(observation.valueQuantity.unit === undefined ? {} : { unit: observation.valueQuantity.unit }),
      value: observation.valueQuantity.value,
    }
  }
  if (observation.valueString !== undefined) {
    return {
      ...(interpretation === undefined ? {} : { flag: interpretation }),
      outcome: 'reported',
      ...(referenceRange === undefined ? {} : { referenceRange }),
      value: observation.valueString,
    }
  }
  if (observation.valueBoolean !== undefined) {
    return { outcome: 'reported', value: observation.valueBoolean }
  }
  if (observation.valueCodeableConcept !== undefined) {
    return {
      ...(interpretation === undefined ? {} : { flag: interpretation }),
      outcome: 'reported',
      ...(referenceRange === undefined ? {} : { referenceRange }),
      value: conceptDisplay(observation.valueCodeableConcept, '已记录'),
    }
  }
  return undefined
}

function dateAtEnd(request: ScenarioGenerationRequest): string {
  return `${request.timeRange.end}T09:00:00+08:00`
}

function formatResultValue(result: ScenarioInvestigationResult): { unit: string; value: string } {
  if (result.outcome !== 'reported') return { unit: '', value: result.message }
  return {
    unit: result.unit ?? '',
    value: typeof result.value === 'boolean' ? String(result.value) : String(result.value),
  }
}

function mappedCondition(condition: z.infer<typeof conditionSchema>) {
  const sourceCode = conceptCode(condition.code)
  const sourceDisplay = conceptDisplay(condition.code, '未命名临床问题')
  const normalized = sourceDisplay.toLowerCase()
  const mapped = sourceCode === undefined ? undefined : codeMappings.get(sourceCode)
  if (mapped !== undefined) return mapped
  if (normalized.includes('type 2 diabetes') || normalized.includes('2型糖尿病')) {
    return { code: 'E11.65', display: '2型糖尿病伴高血糖' }
  }
  if (normalized.includes('fever') || normalized.includes('发热')) {
    return { code: 'R50.9', display: '发热，原因待查' }
  }
  if (normalized.includes('hypertension') || normalized.includes('高血压')) {
    return { code: 'I10', display: '高血压' }
  }
  return { code: null, display: sourceDisplay }
}

function deterministicPersona(ordinal: number) {
  const occupations = ['教师', '公交驾驶员', '社区工作人员', '个体经营者'] as const
  return {
    attitude: '希望尽快明确原因并获得可执行的门诊建议。',
    character: ordinal % 2 === 0 ? '表达直接，愿意配合。' : '谨慎，回答简短。',
    healthLiteracy: '一般，能描述症状和既往用药，但不会主动使用检验术语。',
    occupation: occupations[ordinal % occupations.length]!,
    speechStyle: '使用简短、自然的中文口语。',
  }
}

function hematologyGenerators(): ScenarioPatient['physiologyBaseline']['generators'] {
  return [{
    assayCv: 0.02,
    id: 'hemoglobin',
    kind: 'normal',
    maximum: 165,
    mean: 148,
    minimum: 130,
    source: 'scenario:normal-routine-lab',
    standardDeviation: 4,
    unit: 'g/L',
  }, {
    assayCv: 0.03,
    id: 'red-blood-cells',
    kind: 'normal',
    maximum: 5.8,
    mean: 4.7,
    minimum: 3.8,
    source: 'scenario:hematology-baseline',
    standardDeviation: 0.35,
    unit: '10^12/L',
  }, {
    assayCv: 0.02,
    id: 'mean-corpuscular-volume',
    kind: 'normal',
    maximum: 100,
    mean: 90,
    minimum: 80,
    source: 'scenario:hematology-baseline',
    standardDeviation: 4,
    unit: 'fL',
  }, {
    dependencies: ['red-blood-cells', 'mean-corpuscular-volume'],
    formula: 'hematocrit-from-rbc-mcv',
    id: 'hematocrit',
    kind: 'derived',
    source: 'scenario:rbc-mcv',
    unit: 'L/L',
  }]
}

function renalGenerators(): ScenarioPatient['physiologyBaseline']['generators'] {
  return [{
    assayCv: 0.03,
    id: 'serum-creatinine',
    kind: 'normal',
    maximum: 104,
    mean: 75,
    minimum: 45,
    source: 'scenario:renal-baseline',
    standardDeviation: 12,
    unit: 'μmol/L',
  }, {
    dependencies: ['serum-creatinine'],
    formula: 'egfr-ckd-epi-2021',
    id: 'estimated-gfr',
    kind: 'derived',
    source: 'scenario:ckd-epi-2021',
    unit: 'mL/min/1.73m²',
  }]
}

function bodyMassIndexGenerator(): ScenarioPatient['physiologyBaseline']['generators'][number] {
  return {
    dependencies: ['vital:weightKg', 'vital:heightCm'],
    formula: 'bmi',
    id: 'body-mass-index',
    kind: 'derived',
    source: 'scenario:height-weight',
    unit: 'kg/m²',
  }
}

function urineGlucoseGenerator(): ScenarioPatient['physiologyBaseline']['generators'][number] {
  return {
    dependencies: ['random-glucose'],
    formula: 'urine-glucose-from-blood-glucose',
    id: 'urine-glucose',
    kind: 'derived',
    source: 'scenario:renal-glucose-threshold',
    unit: 'qualitative',
  }
}

function feverCaseTruth(input: {
  conditions: Array<z.infer<typeof conditionSchema>>
  observations: R4Observation[]
}) {
  const temperature = input.observations.find(observation => conceptCode(observation.code) === '8310-5')
    ?.valueQuantity?.value ?? 38.6
  const primary = input.conditions.map(mappedCondition).find(condition => condition.code === 'R50.9')
    ?? { code: 'R50.9', display: '发热，原因待查' }
  return {
    costBaseline: {
      note: '费用仅用于合成门诊场景，不代表真实医院价格。',
      overInvestigationThresholdFen: 50_000,
      reasonableRangeFen: [2_500, 15_000] as [number, number],
      referencePath: '血常规、C 反应蛋白等按临床需要选择。',
    },
    diagnosisSpace: {
      comorbidities: [],
      differentials: [{
        code: 'J10.1',
        display: '流感伴呼吸道表现',
        evidence: ['流行病学接触史、急性高热或全身症状'],
        expectedAction: '结合流行季节和必要的病原学检查鉴别。',
        id: 'diagnosis-differential-influenza',
      }],
      primary: {
        code: primary.code,
        display: primary.display,
        evidence: [`体温 ${temperature} °C`, '急性起病'],
        id: 'diagnosis-primary-fever',
      },
      traps: ['不能仅凭发热直接使用抗菌药物。'],
    },
    encounter: {
      openingStatement: '发热一天，伴咽部不适。',
      setting: '综合医院全科医学科门诊',
      timeStateItems: [],
    },
    examinationFindings: [{
      abnormal: [`体温 ${temperature} °C，升高`],
      finding: `神志清，体温 ${temperature} °C，咽部轻度充血。`,
      id: 'exam-vital-signs',
      name: '生命体征',
    }],
    managementSpace: {
      acceptableOptions: ['对症退热、补液和门诊随访。'],
      contraindications: ['无明确细菌感染证据时常规使用抗菌药物。'],
      followUp: '症状持续或出现呼吸困难、高热不退时及时复诊。',
      requiredElements: ['评估危险征象', '说明退热与复诊条件'],
    },
    patientKnowledge: {
      careMemory: '记得本次发热前没有接受相关检查。',
      chiefComplaint: '发热一天，伴咽部不适。',
      healthLiteracy: '知道自己发热，但不知道具体病因。',
      lifestyle: [],
      medicationMemory: '只记得曾用过普通退热药，具体名称不确定。',
      neverKnows: ['本次尚未告知的检查数值', '尚未由医生告知的诊断结论'],
      toldDiagnoses: [],
    },
    physiologyBaseline: {
      generators: [{
        assayCv: 0.005,
        id: 'body-temperature',
        kind: 'constant' as const,
        source: 'synthea-r4:Observation/8310-5',
        unit: '°C',
        value: temperature,
      }, ...hematologyGenerators(), {
        assayCv: 0.02,
        id: 'random-glucose',
        kind: 'normal',
        maximum: 7.8,
        mean: 5.4,
        minimum: 3.9,
        source: 'scenario:normal-glucose-baseline',
        standardDeviation: 0.7,
        unit: 'mmol/L',
      }, ...renalGenerators(), bodyMassIndexGenerator(), urineGlucoseGenerator()],
      vitalSigns: {
        heightCm: 165,
        oxygenSaturationPct: 98,
        pulseBpm: 92,
        respirationBpm: 18,
        temperatureC: temperature,
        weightKg: 60,
      },
    },
    symptomResponses: [{
      avoids: [],
      denies: ['没有明显胸痛或呼吸困难。'],
      id: 'symptom-fever',
      name: '发热与起病经过',
      passive: false,
      responsePoints: ['昨天下午开始觉得发热，咽部有些不舒服。'],
    }],
  }
}

function diabetesCaseTruth(input: {
  conditions: Array<z.infer<typeof conditionSchema>>
  observations: R4Observation[]
}) {
  const hba1c = input.observations.find(observation => conceptCode(observation.code) === '4548-4')
    ?.valueQuantity?.value ?? 9.2
  const glucose = input.observations.find(observation => conceptCode(observation.code) === '2339-0')
    ?.valueQuantity?.value ?? 13.8
  const primary = input.conditions.map(mappedCondition).find(condition => condition.code === 'E11.65')
    ?? { code: 'E11.65', display: '2型糖尿病伴高血糖' }
  return {
    costBaseline: {
      note: '合理费用需与并发症筛查和鉴别诊断需求共同判断。',
      overInvestigationThresholdFen: 100_000,
      reasonableRangeFen: [20_000, 60_000] as [number, number],
      referencePath: '随机血糖、HbA1c、尿常规、肝肾功能、血脂和心电图。',
    },
    diagnosisSpace: {
      comorbidities: [{
        code: 'I10',
        display: '高血压',
        evidence: ['门诊血压达到高血压范围'],
        id: 'diagnosis-comorbidity-hypertension',
        route: '需要通过查体测量，不能只依赖患者自述。',
      }],
      differentials: [{
        code: 'E05.90',
        display: '甲状腺功能亢进',
        evidence: ['近期体重下降'],
        expectedAction: '必要时检查 TSH 或在病历中解释体重下降原因。',
        id: 'diagnosis-differential-hyperthyroidism',
        truth: 'TSH 正常时排除。',
      }],
      primary: {
        code: primary.code,
        display: primary.display,
        evidence: [`随机血糖 ${glucose} mmol/L`, `HbA1c ${hba1c}%`, '多饮多尿和体重下降'],
        id: 'diagnosis-primary-type-2-diabetes',
      },
      traps: ['患者没有主动说足麻时仍需筛查并发症。', '不能只加药而忽略依从性。'],
    },
    encounter: {
      openingStatement: '这两个月总是口渴，水喝得很多，人也瘦了。',
      setting: '综合医院内科门诊',
      timeStateItems: [{
        change: '患者开始催促，希望尽快完成本次就诊。',
        id: 'time-state-visit-pressure',
        triggerAfterMinutes: 20,
      }],
    },
    examinationFindings: [{
      abnormal: ['血压 162/96 mmHg，升高'],
      finding: 'T 36.5 °C，P 88 次/分，R 16 次/分，BP 162/96 mmHg。',
      id: 'exam-vital-signs',
      name: '生命体征',
    }, {
      abnormal: ['双足远端感觉减退'],
      finding: '双足皮肤完整，足背动脉搏动存在，双足远端感觉减退。',
      id: 'exam-diabetic-foot',
      name: '糖尿病足筛查',
    }],
    managementSpace: {
      acceptableOptions: ['核对肝肾功能后优化二甲双胍方案。', '根据个体情况加用第二种降糖药。'],
      contraindications: ['在未核对肾功能前盲目强化二甲双胍。', '已确诊糖尿病时常规开 OGTT。'],
      followUp: '3 个月复查 HbA1c 和血压，并完成眼底及足部筛查。',
      requiredElements: ['核实服药依从性', '停止含糖饮料并规律进餐', '评估血压和微血管并发症'],
    },
    patientKnowledge: {
      careMemory: '记得去年社区检查说血糖控制不好，没有保存报告。',
      chiefComplaint: '口渴、多饮两个月，体重下降。',
      healthLiteracy: '只会说血糖高，不理解 HbA1c 和并发症术语。',
      lifestyle: [{
        actual: '长期饮用含糖饮料。',
        admittedOnFirstAsk: '口渴时会喝饮料。',
        concedeOnSecondAsk: true,
        id: 'sugary-drinks',
        label: '含糖饮料',
      }],
      medicationMemory: '知道服用二甲双胍，但常因跑车和进餐不规律漏服。',
      neverKnows: ['本次尚未告知的检查数值', '自己的血压值', '周围神经病变这个诊断术语'],
      toldDiagnoses: ['2型糖尿病', '血糖控制不好'],
    },
    physiologyBaseline: {
      generators: [{
        assayCv: 0.005,
        id: 'body-temperature',
        kind: 'constant' as const,
        source: 'scenario:vital-signs',
        unit: '°C',
        value: 36.5,
      }, {
        assayCv: 0.03,
        id: 'random-glucose',
        kind: 'trajectory' as const,
        maximum: 18,
        minimum: 9,
        source: 'synthea-r4:Observation/2339-0',
        target: glucose,
        unit: 'mmol/L',
        walkStep: 0.8,
      }, ...hematologyGenerators(), ...renalGenerators(), bodyMassIndexGenerator(), urineGlucoseGenerator()],
      vitalSigns: { diastolicMmHg: 96, heightCm: 172, pulseBpm: 88, systolicMmHg: 162, temperatureC: 36.5, weightKg: 80.2 },
    },
    symptomResponses: [{
      avoids: [],
      denies: [],
      id: 'symptom-polydipsia-polyuria',
      name: '多饮多尿',
      passive: false,
      responsePoints: ['这两个月渴得厉害，喝水多，夜里也要起来两三次。'],
    }, {
      avoids: [],
      denies: ['双足没有破溃。'],
      id: 'symptom-foot-numbness',
      name: '足部感觉异常',
      passive: true,
      responsePoints: ['脚底有些发木，像穿了厚袜子，已经大半年。'],
    }, {
      avoids: [],
      denies: [],
      id: 'symptom-medication-adherence',
      name: '用药依从性',
      passive: false,
      responsePoints: ['吃的是二甲双胍，但跑车时经常忘记。'],
      secondAskConcede: {
        firstResponse: '基本都按时吃。',
        revealedResponse: '说实话经常漏服，有时一天只吃一次。',
      },
    }],
  }
}

export function compileSyntheaR4Bundle(input: {
  bundle: unknown
  ordinal: number
  request: ScenarioGenerationRequest
}): ScenarioPatient {
  const bundle = syntheaR4BundleSchema.parse(input.bundle)
  const patient = bundle.entry
    .map(entry => entry.resource)
    .find(resource => resource.resourceType === 'Patient')
  if (patient === undefined) throw new Error('The Synthea Bundle does not contain a Patient')

  const encounters = bundle.entry.flatMap(entry => entry.resource.resourceType === 'Encounter' ? [entry.resource] : [])
  const conditions = bundle.entry.flatMap(entry => entry.resource.resourceType === 'Condition' ? [entry.resource] : [])
  const observations = bundle.entry.flatMap(entry => entry.resource.resourceType === 'Observation' ? [entry.resource] : [])
  const medicationRequests = bundle.entry.flatMap(entry => entry.resource.resourceType === 'MedicationRequest' ? [entry.resource] : [])
  const allergies = bundle.entry.flatMap(entry => entry.resource.resourceType === 'AllergyIntolerance' ? [entry.resource] : [])
  const fallbackDateTime = dateAtEnd(input.request)
  const module = input.request.modules[input.ordinal % input.request.modules.length] ?? 'fever'
  const authored = module === 'type-2-diabetes'
    ? diabetesCaseTruth({ conditions, observations })
    : feverCaseTruth({ conditions, observations })

  const fhirHistory = bundle.entry.flatMap((entry): ScenarioPatient['fhirHistory'] => {
    const resource = entry.resource
    if (resource.resourceType === 'Encounter') {
      return [{
        classCode: resource.class?.code ?? 'AMB',
        id: stableHistoryId(resource.resourceType, resource.id),
        period: {
          ...(resource.period?.end === undefined ? {} : { end: resource.period.end }),
          start: resource.period?.start ?? fallbackDateTime,
        },
        resourceType: resource.resourceType,
        status: r5EncounterStatus(resource.status),
      }]
    }
    if (resource.resourceType === 'Condition') {
      const mapped = mappedCondition(resource)
      const coding = firstCoding(resource.code)
      return [{
        clinicalStatus: clinicalStatus(resource.clinicalStatus, 'active'),
        code: {
          ...(mapped.code === null ? {} : { code: mapped.code }),
          display: mapped.display,
          ...(mapped.code === null
            ? (coding?.system === undefined ? {} : { system: coding.system })
            : { system: 'http://hl7.org/fhir/sid/icd-10' }),
        },
        ...(localReferenceId(resource.encounter?.reference, bundle) === undefined
          ? {}
          : { encounterId: stableHistoryId('Encounter', localReferenceId(resource.encounter?.reference, bundle)!) }),
        id: stableHistoryId(resource.resourceType, resource.id),
        ...(resource.onsetDateTime === undefined ? {} : { onsetDateTime: resource.onsetDateTime }),
        ...(resource.recordedDate === undefined ? {} : { recordedDate: resource.recordedDate }),
        resourceType: resource.resourceType,
      }]
    }
    if (resource.resourceType === 'Observation') {
      const result = observedResult(resource)
      if (result === undefined) return []
      const coding = firstCoding(resource.code)
      return [{
        code: {
          ...(coding?.code === undefined ? {} : { code: coding.code }),
          display: conceptDisplay(resource.code, '未命名观察'),
          ...(coding?.system === undefined ? {} : { system: coding.system }),
        },
        ...(resource.effectiveDateTime === undefined ? {} : { effectiveDateTime: resource.effectiveDateTime }),
        ...(localReferenceId(resource.encounter?.reference, bundle) === undefined
          ? {}
          : { encounterId: stableHistoryId('Encounter', localReferenceId(resource.encounter?.reference, bundle)!) }),
        id: stableHistoryId(resource.resourceType, resource.id),
        resourceType: resource.resourceType,
        status: resource.status,
        value: result,
      }]
    }
    if (resource.resourceType === 'MedicationRequest') {
      const medication = resource.medicationCodeableConcept
      const coding = firstCoding(medication)
      return [{
        ...(resource.authoredOn === undefined ? {} : { authoredOn: resource.authoredOn }),
        ...(localReferenceId(resource.encounter?.reference, bundle) === undefined
          ? {}
          : { encounterId: stableHistoryId('Encounter', localReferenceId(resource.encounter?.reference, bundle)!) }),
        id: stableHistoryId(resource.resourceType, resource.id),
        intent: resource.intent,
        medication: {
          ...(coding?.code === undefined ? {} : { code: coding.code }),
          display: conceptDisplay(medication, '历史用药'),
          ...(coding?.system === undefined ? {} : { system: coding.system }),
        },
        resourceType: resource.resourceType,
        status: resource.status,
      }]
    }
    if (resource.resourceType === 'AllergyIntolerance') {
      const coding = firstCoding(resource.code)
      return [{
        clinicalStatus: clinicalStatus(resource.clinicalStatus, 'active'),
        code: {
          ...(coding?.code === undefined ? {} : { code: coding.code }),
          display: conceptDisplay(resource.code, '未说明过敏原'),
          ...(coding?.system === undefined ? {} : { system: coding.system }),
        },
        id: stableHistoryId(resource.resourceType, resource.id),
        ...(resource.recordedDate === undefined ? {} : { recordedDate: resource.recordedDate }),
        resourceType: resource.resourceType,
      }]
    }
    return []
  })

  const longitudinalHistory: ScenarioPatient['longitudinalHistory'] = [
    ...encounters.map(resource => ({
      code: resource.class?.code ?? 'AMB',
      display: conceptDisplay(resource.type?.[0], '门诊就诊'),
      ...(resource.period?.end === undefined ? {} : { endedAt: resource.period.end }),
      id: `history-event-${resource.id}`,
      kind: 'encounter' as const,
      mappedCode: 'AMB',
      occurredAt: resource.period?.start ?? fallbackDateTime,
      sourceResourceId: resource.id,
      sourceResourceType: resource.resourceType,
      status: resource.status ?? 'finished',
    })),
    ...conditions.map(resource => {
      const mapped = mappedCondition(resource)
      return {
        code: conceptCode(resource.code) ?? 'unmapped',
        display: mapped.display,
        id: `history-event-${resource.id}`,
        kind: 'condition' as const,
        mappedCode: mapped.code,
        occurredAt: resource.onsetDateTime ?? resource.recordedDate ?? fallbackDateTime,
        sourceResourceId: resource.id,
        sourceResourceType: resource.resourceType,
        status: clinicalStatus(resource.clinicalStatus, 'active'),
      }
    }),
    ...observations.map(resource => ({
      code: conceptCode(resource.code) ?? 'unmapped',
      display: conceptDisplay(resource.code, '未命名观察'),
      id: `history-event-${resource.id}`,
      kind: 'observation' as const,
      mappedCode: observationMappings.get(conceptCode(resource.code) ?? '')?.code ?? null,
      occurredAt: resource.effectiveDateTime ?? fallbackDateTime,
      sourceResourceId: resource.id,
      sourceResourceType: resource.resourceType,
      status: resource.status,
    })),
    ...medicationRequests.map(resource => ({
      code: conceptCode(resource.medicationCodeableConcept) ?? 'unmapped',
      display: conceptDisplay(resource.medicationCodeableConcept, '历史用药'),
      id: `history-event-${resource.id}`,
      kind: 'medication' as const,
      mappedCode: null,
      occurredAt: resource.authoredOn ?? fallbackDateTime,
      sourceResourceId: resource.id,
      sourceResourceType: resource.resourceType,
      status: resource.status,
    })),
    ...allergies.map(resource => ({
      code: conceptCode(resource.code) ?? 'unmapped',
      display: conceptDisplay(resource.code, '未说明过敏原'),
      id: `history-event-${resource.id}`,
      kind: 'allergy' as const,
      mappedCode: conceptCode(resource.code) ?? null,
      occurredAt: resource.recordedDate ?? fallbackDateTime,
      sourceResourceId: resource.id,
      sourceResourceType: resource.resourceType,
      status: clinicalStatus(resource.clinicalStatus, 'active'),
    })),
  ].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id))

  const investigations: ScenarioPatient['investigations'] = observations.flatMap(resource => {
    const sourceCode = conceptCode(resource.code)
    const mapping = sourceCode === undefined ? undefined : observationMappings.get(sourceCode)
    const result = observedResult(resource)
    if (mapping === undefined || result === undefined) return []
    const formatted = formatResultValue(result)
    const normalizedResult: ScenarioInvestigationResult = result.outcome === 'reported'
      ? {
          ...result,
          flag: result.flag ?? (
            sourceCode === '8310-5' && typeof result.value === 'number' && result.value > 37.3 ? 'H' : 'N'
          ),
          referenceRange: result.referenceRange ?? mapping.referenceRange,
        }
      : result
    return [{
      catalogItemId: mapping.catalogItemId,
      critical: false,
      feeFen: mapping.feeFen,
      id: `investigation-${resource.id}`,
      name: mapping.name,
      report: mapping.report(formatted.value, formatted.unit),
      result: normalizedResult,
      sourceLevel: 'L1' as const,
      tatMinutes: mapping.tatMinutes,
    }]
  })

  const fingerprint = createHash('sha256')
    .update(`${input.request.seeds.population}:${patient.id}:${input.ordinal}`)
    .digest('hex')
    .slice(0, 8)

  return scenarioPatientSchema.parse({
    ...authored,
    birthDate: patient.birthDate,
    fhirHistory,
    gender: patient.gender,
    id: `synthea-patient-${patient.id}`,
    investigations,
    longitudinalHistory,
    name: chineseNames[input.ordinal % chineseNames.length]!,
    persona: {
      ...deterministicPersona(input.ordinal),
      attitude: `${deterministicPersona(input.ordinal).attitude}（合成档案 ${fingerprint}）`,
    },
  })
}
