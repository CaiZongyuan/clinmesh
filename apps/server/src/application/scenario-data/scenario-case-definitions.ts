import type {
  ScenarioInvestigationResult,
  ScenarioModule,
  ScenarioPatient,
} from '@clinmesh/contracts/scenario'
import { ucumUnit } from './reference-coding-package.ts'

export type ScenarioCatalogCollection = 'diagnoses' | 'investigations' | 'medications' | 'services'
export type ScenarioCoverageRequirement =
  | 'critical-truth'
  | 'workflow-required'
  | 'history-only'
  | 'explicitly-ignored'

interface SourceCoding {
  code: string
  display: string
  system: string
  version?: string
}

export interface ScenarioCatalogDependency {
  collection: ScenarioCatalogCollection
  mappingKind?: 'diagnosis' | 'medication' | 'observation'
  requirement: 'critical-truth' | 'workflow-required'
  source?: SourceCoding
  targetId: string
}

export interface ScenarioCoverageOnlyDependency {
  requirement: 'explicitly-ignored' | 'history-only'
  resolution: 'hospital-not-enabled' | 'mapped' | 'not-applicable'
  source: SourceCoding | { resourceType: string }
  targetId?: string
}

export interface ScenarioCaseDefinition {
  buildCaseTruth: (input: ScenarioCaseTruthInput) => ScenarioAuthoredCaseTruth
  builtInSource: {
    conditions: readonly { code: string; display: string }[]
    medications: readonly { code: string; display: string }[]
    observations: readonly {
      code: string
      display: string
      unit: string
      value: number
    }[]
  }
  catalogDependencies: readonly ScenarioCatalogDependency[]
  coverageOnlyDependencies: readonly ScenarioCoverageOnlyDependency[]
  investigationTruth: readonly ScenarioPatient['investigations'][number][]
  module: ScenarioModule
  syntheaModules: readonly string[]
  version: string
}

export interface ScenarioCaseTruthInput {
  conditions: readonly { code: string | null; display: string }[]
  observations: ReadonlyMap<string, ScenarioInvestigationResult>
}

type ScenarioAuthoredCaseTruth = Pick<
  ScenarioPatient,
  | 'costBaseline'
  | 'diagnosisSpace'
  | 'encounter'
  | 'examinationFindings'
  | 'managementSpace'
  | 'patientKnowledge'
  | 'physiologyBaseline'
  | 'symptomResponses'
>

function numericObservation(
  input: ScenarioCaseTruthInput,
  catalogItemId: string,
  fallback: number,
): number {
  const result = input.observations.get(catalogItemId)
  return result?.outcome === 'reported' && typeof result.value === 'number'
    ? result.value
    : fallback
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
    unit: ucumUnit('g/L'),
  }, {
    assayCv: 0.03,
    id: 'red-blood-cells',
    kind: 'normal',
    maximum: 5.8,
    mean: 4.7,
    minimum: 3.8,
    source: 'scenario:hematology-baseline',
    standardDeviation: 0.35,
    unit: ucumUnit('10*12/L'),
  }, {
    assayCv: 0.02,
    id: 'mean-corpuscular-volume',
    kind: 'normal',
    maximum: 100,
    mean: 90,
    minimum: 80,
    source: 'scenario:hematology-baseline',
    standardDeviation: 4,
    unit: ucumUnit('fL'),
  }, {
    dependencies: ['red-blood-cells', 'mean-corpuscular-volume'],
    formula: 'hematocrit-from-rbc-mcv',
    id: 'hematocrit',
    kind: 'derived',
    source: 'scenario:rbc-mcv',
    unit: ucumUnit('L/L'),
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
    unit: ucumUnit('umol/L'),
  }, {
    dependencies: ['serum-creatinine'],
    formula: 'egfr-ckd-epi-2021',
    id: 'estimated-gfr',
    kind: 'derived',
    source: 'scenario:ckd-epi-2021',
    unit: ucumUnit('mL/min/{1.73_m2}'),
  }]
}

function bodyMassIndexGenerator(): ScenarioPatient['physiologyBaseline']['generators'][number] {
  return {
    dependencies: ['vital:weightKg', 'vital:heightCm'],
    formula: 'bmi',
    id: 'body-mass-index',
    kind: 'derived',
    source: 'scenario:height-weight',
    unit: ucumUnit('kg/m2'),
  }
}

function urineGlucoseGenerator(): ScenarioPatient['physiologyBaseline']['generators'][number] {
  return {
    dependencies: ['random-glucose'],
    formula: 'urine-glucose-from-blood-glucose',
    id: 'urine-glucose',
    kind: 'derived',
    source: 'scenario:renal-glucose-threshold',
    unit: ucumUnit('{qualitative}'),
  }
}

function feverCaseTruth(input: ScenarioCaseTruthInput): ScenarioAuthoredCaseTruth {
  const temperature = numericObservation(input, 'lab-body-temperature', 38.6)
  const primary = input.conditions.find(condition => condition.code === 'R50.9')
    ?? { code: 'R50.9', display: '发热，原因待查' }
  return {
    costBaseline: {
      note: '费用仅用于合成门诊场景，不代表真实医院价格。',
      overInvestigationThresholdFen: 50_000,
      reasonableRangeFen: [2_500, 15_000],
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
        code: primary.code ?? 'R50.9',
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
        kind: 'constant',
        source: 'synthea-r4:Observation/8310-5',
        unit: ucumUnit('Cel'),
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
        unit: ucumUnit('mmol/L'),
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

function diabetesCaseTruth(input: ScenarioCaseTruthInput): ScenarioAuthoredCaseTruth {
  const hba1c = numericObservation(input, 'lab-hba1c', 9.2)
  const glucose = numericObservation(input, 'lab-random-glucose', 13.8)
  const primary = input.conditions.find(condition => condition.code === 'E11.65')
    ?? { code: 'E11.65', display: '2型糖尿病伴高血糖' }
  return {
    costBaseline: {
      note: '合理费用需与并发症筛查和鉴别诊断需求共同判断。',
      overInvestigationThresholdFen: 100_000,
      reasonableRangeFen: [20_000, 60_000],
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
        code: primary.code ?? 'E11.65',
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
        kind: 'constant',
        source: 'scenario:vital-signs',
        unit: ucumUnit('Cel'),
        value: 36.5,
      }, {
        assayCv: 0.03,
        id: 'random-glucose',
        kind: 'trajectory',
        maximum: 18,
        minimum: 9,
        source: 'synthea-r4:Observation/2339-0',
        target: glucose,
        unit: ucumUnit('mmol/L'),
        walkStep: 0.8,
      }, ...hematologyGenerators(), ...renalGenerators(), bodyMassIndexGenerator(), urineGlucoseGenerator()],
      vitalSigns: {
        diastolicMmHg: 96,
        heightCm: 172,
        pulseBpm: 88,
        systolicMmHg: 162,
        temperatureC: 36.5,
        weightKg: 80.2,
      },
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

function hypertensionCaseTruth(input: ScenarioCaseTruthInput): ScenarioAuthoredCaseTruth {
  const primary = input.conditions.find(condition => condition.code === 'I10')
    ?? { code: 'I10', display: '高血压' }
  return {
    costBaseline: {
      note: '费用仅用于合成高血压门诊场景，不代表真实医院价格。',
      overInvestigationThresholdFen: 60_000,
      reasonableRangeFen: [4_000, 20_000],
      referencePath: '复测血压并按需要评估血常规、肾功能和继发因素。',
    },
    diagnosisSpace: {
      comorbidities: [],
      differentials: [],
      primary: {
        code: primary.code ?? 'I10',
        display: primary.display,
        evidence: ['多次血压达到 162/96 mmHg', '既往已被告知高血压'],
        id: 'diagnosis-primary-hypertension',
      },
      traps: ['不能仅凭一次血压读数盲目叠加多种降压药。'],
    },
    encounter: {
      openingStatement: '最近量血压总是偏高，偶尔头晕。',
      setting: '综合医院全科医学科门诊',
      timeStateItems: [],
    },
    examinationFindings: [{
      abnormal: ['血压 162/96 mmHg，升高'],
      finding: 'T 36.6 °C，P 82 次/分，R 16 次/分，BP 162/96 mmHg，双下肢无水肿。',
      id: 'exam-vital-signs',
      name: '生命体征与外周水肿',
    }],
    managementSpace: {
      acceptableOptions: ['确认肾功能后使用氨氯地平 5 mg 每日一次。'],
      contraindications: ['未复测血压或未核对既往用药时直接联合多种降压药。'],
      followUp: '2 至 4 周复查血压、用药依从性和外周水肿。',
      requiredElements: ['复测并记录血压', '核对既往降压药', '评估肾功能和外周水肿'],
    },
    patientKnowledge: {
      careMemory: '两年前体检后被告知血压高，之后没有规律复诊。',
      chiefComplaint: '最近量血压总是偏高，偶尔头晕。',
      healthLiteracy: '知道高血压需要长期管理，但不理解具体分级和并发症。',
      lifestyle: [{
        actual: '工作日外卖较多，口味偏咸。',
        admittedOnFirstAsk: '平时吃饭口味有一点重。',
        concedeOnSecondAsk: true,
        id: 'high-sodium-diet',
        label: '高盐饮食',
      }],
      medicationMemory: '以前短期吃过降压药，药名和剂量记不清，近半年没有规律服用。',
      neverKnows: ['本次尚未告知的检查数值', '自己的心血管风险分层'],
      toldDiagnoses: ['高血压'],
    },
    physiologyBaseline: {
      generators: [{
        assayCv: 0.005,
        id: 'body-temperature',
        kind: 'constant',
        source: 'scenario:vital-signs',
        unit: ucumUnit('Cel'),
        value: 36.6,
      }, {
        assayCv: 0.02,
        id: 'random-glucose',
        kind: 'normal',
        maximum: 7.8,
        mean: 5.5,
        minimum: 3.9,
        source: 'scenario:normal-glucose-baseline',
        standardDeviation: 0.7,
        unit: ucumUnit('mmol/L'),
      }, ...hematologyGenerators(), ...renalGenerators(), bodyMassIndexGenerator(), urineGlucoseGenerator()],
      vitalSigns: {
        diastolicMmHg: 96,
        heightCm: 164,
        pulseBpm: 82,
        respirationBpm: 16,
        systolicMmHg: 162,
        temperatureC: 36.6,
        weightKg: 68,
      },
    },
    symptomResponses: [{
      avoids: [],
      denies: ['没有胸痛、气促或肢体无力。'],
      id: 'symptom-dizziness',
      name: '头晕与危险征象',
      passive: false,
      responsePoints: ['最近一周偶尔头晕，没有晕倒。'],
    }, {
      avoids: [],
      denies: ['双下肢没有明显水肿。'],
      id: 'symptom-medication-adherence',
      name: '既往用药',
      passive: false,
      responsePoints: ['以前吃过一阵降压药，后来觉得没不舒服就停了。'],
      secondAskConcede: {
        firstResponse: '之前基本按时吃。',
        revealedResponse: '其实已经有半年没规律吃了，药名也记不清。',
      },
    }],
  }
}

const ignoredUsRuntimeResources = [
  'Claim',
  'Coverage',
  'ExplanationOfBenefit',
  'Organization',
  'Practitioner',
].map(resourceType => ({
  requirement: 'explicitly-ignored' as const,
  resolution: 'not-applicable' as const,
  source: { resourceType },
}))

export const scenarioCaseDefinitions = {
  fever: {
    buildCaseTruth: feverCaseTruth,
    builtInSource: {
      conditions: [{ code: '386661006', display: 'Fever' }],
      medications: [],
      observations: [{
        code: '8310-5',
        display: 'Body temperature',
        unit: '°C',
        value: 38.6,
      }],
    },
    catalogDependencies: [{
      collection: 'diagnoses',
      mappingKind: 'diagnosis',
      requirement: 'critical-truth',
      source: {
        code: '386661006',
        display: 'Fever',
        system: 'http://snomed.info/sct',
      },
      targetId: 'diagnosis-fever',
    }, {
      collection: 'investigations',
      mappingKind: 'observation',
      requirement: 'critical-truth',
      source: {
        code: '8310-5',
        display: 'Body temperature',
        system: 'http://loinc.org',
      },
      targetId: 'lab-body-temperature',
    }, {
      collection: 'medications',
      mappingKind: 'medication',
      requirement: 'critical-truth',
      source: {
        code: '198440',
        display: 'Acetaminophen 500 MG Oral Tablet',
        system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
      },
      targetId: 'medication-acetaminophen',
    }, ...['lab-cbc', 'lab-crp'].map(targetId => ({
      collection: 'investigations' as const,
      requirement: 'workflow-required' as const,
      targetId,
    })), {
      collection: 'diagnoses',
      requirement: 'workflow-required',
      targetId: 'diagnosis-influenza',
    }],
    coverageOnlyDependencies: ignoredUsRuntimeResources,
    investigationTruth: [{
      catalogItemId: 'lab-body-temperature',
      critical: false,
      feeFen: 0,
      id: 'investigation-case-definition-body-temperature',
      name: '体温',
      report: '体温 38.6 °C',
      result: {
        flag: 'H',
        outcome: 'reported',
        referenceRange: '36.0-37.3 °C',
        unit: ucumUnit('Cel'),
        value: 38.6,
      },
      sourceLevel: 'L1',
      tatMinutes: 0,
    }],
    module: 'fever',
    syntheaModules: ['sinusitis'],
    version: '1',
  },
  'type-2-diabetes': {
    buildCaseTruth: diabetesCaseTruth,
    builtInSource: {
      conditions: [
        { code: '44054006', display: 'Diabetes mellitus type 2' },
        { code: '38341003', display: 'Hypertension' },
      ],
      medications: [],
      observations: [{
        code: '2339-0',
        display: 'Glucose [Mass/volume] in Blood',
        unit: 'mmol/L',
        value: 13.8,
      }, {
        code: '4548-4',
        display: 'Hemoglobin A1c/Hemoglobin.total in Blood',
        unit: '%',
        value: 9.2,
      }],
    },
    catalogDependencies: [{
      collection: 'diagnoses',
      mappingKind: 'diagnosis',
      requirement: 'critical-truth',
      source: {
        code: '44054006',
        display: 'Diabetes mellitus type 2',
        system: 'http://snomed.info/sct',
      },
      targetId: 'diagnosis-type-2-diabetes-hyperglycemia',
    }, {
      collection: 'diagnoses',
      mappingKind: 'diagnosis',
      requirement: 'critical-truth',
      source: {
        code: '38341003',
        display: 'Hypertension',
        system: 'http://snomed.info/sct',
      },
      targetId: 'diagnosis-hypertension',
    }, {
      collection: 'investigations',
      mappingKind: 'observation',
      requirement: 'critical-truth',
      source: {
        code: '2339-0',
        display: 'Glucose [Mass/volume] in Blood',
        system: 'http://loinc.org',
      },
      targetId: 'lab-random-glucose',
    }, {
      collection: 'investigations',
      mappingKind: 'observation',
      requirement: 'critical-truth',
      source: {
        code: '4548-4',
        display: 'Hemoglobin A1c/Hemoglobin.total in Blood',
        system: 'http://loinc.org',
      },
      targetId: 'lab-hba1c',
    }, {
      collection: 'medications',
      mappingKind: 'medication',
      requirement: 'critical-truth',
      source: {
        code: '860975',
        display: 'Metformin hydrochloride 500 MG Oral Tablet',
        system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
      },
      targetId: 'medication-metformin',
    }, ...[
      'exam-bmi',
      'lab-urine-glucose',
      'lab-creatinine',
      'lab-egfr',
      'lab-tsh',
      'exam-fundus-screening',
    ].map(targetId => ({
      collection: 'investigations' as const,
      requirement: 'workflow-required' as const,
      targetId,
    })), {
      collection: 'diagnoses',
      requirement: 'workflow-required',
      targetId: 'diagnosis-hyperthyroidism',
    }, {
      collection: 'services',
      requirement: 'workflow-required',
      targetId: 'hospital-service-fundus',
    }, {
      collection: 'services',
      requirement: 'workflow-required',
      targetId: 'hospital-service-diabetes-education',
    }],
    coverageOnlyDependencies: ignoredUsRuntimeResources,
    investigationTruth: [{
      catalogItemId: 'lab-random-glucose',
      critical: false,
      feeFen: 500,
      id: 'investigation-case-definition-random-glucose',
      name: '随机血糖',
      report: '随机血糖 13.8 mmol/L',
      result: {
        flag: 'H',
        outcome: 'reported',
        referenceRange: '3.9-11.1 mmol/L',
        unit: ucumUnit('mmol/L'),
        value: 13.8,
      },
      sourceLevel: 'L1',
      tatMinutes: 30,
    }, {
      catalogItemId: 'lab-hba1c',
      critical: false,
      feeFen: 4_500,
      id: 'investigation-case-definition-hba1c',
      name: '糖化血红蛋白',
      report: '糖化血红蛋白 9.2 %',
      result: {
        flag: 'H',
        outcome: 'reported',
        referenceRange: '4.0-6.0 %',
        unit: ucumUnit('%'),
        value: 9.2,
      },
      sourceLevel: 'L1',
      tatMinutes: 120,
    }],
    module: 'type-2-diabetes',
    syntheaModules: ['metabolic_syndrome_disease', 'metabolic_syndrome_care'],
    version: '1',
  },
  hypertension: {
    buildCaseTruth: hypertensionCaseTruth,
    builtInSource: {
      conditions: [{ code: '59621000', display: 'Essential hypertension (disorder)' }],
      medications: [{ code: '308136', display: 'amLODIPine 2.5 MG Oral Tablet' }],
      observations: [],
    },
    catalogDependencies: [{
      collection: 'diagnoses',
      mappingKind: 'diagnosis',
      requirement: 'critical-truth',
      source: {
        code: '59621000',
        display: 'Essential hypertension (disorder)',
        system: 'http://snomed.info/sct',
      },
      targetId: 'diagnosis-hypertension',
    }, {
      collection: 'medications',
      requirement: 'critical-truth',
      targetId: 'medication-amlodipine',
    }, ...['lab-cbc', 'lab-creatinine', 'lab-egfr'].map(targetId => ({
      collection: 'investigations' as const,
      requirement: 'workflow-required' as const,
      targetId,
    }))],
    coverageOnlyDependencies: [{
      requirement: 'history-only',
      resolution: 'mapped',
      source: {
        code: '308136',
        display: 'amLODIPine 2.5 MG Oral Tablet',
        system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
      },
      targetId: 'drug-concept-amlodipine-2.5mg-oral-tablet',
    }, {
      requirement: 'history-only',
      resolution: 'hospital-not-enabled',
      source: {
        code: '310798',
        display: 'Hydrochlorothiazide 25 MG Oral Tablet',
        system: 'RxNorm',
      },
    }, {
      requirement: 'history-only',
      resolution: 'hospital-not-enabled',
      source: {
        code: '314076',
        display: 'Lisinopril 10 MG Oral Tablet',
        system: 'RxNorm',
      },
    }, ...ignoredUsRuntimeResources],
    investigationTruth: [{
      catalogItemId: 'lab-creatinine',
      critical: false,
      feeFen: 1_500,
      id: 'investigation-case-definition-creatinine',
      name: '血清肌酐',
      report: '血清肌酐 78 μmol/L。',
      result: {
        flag: 'N',
        outcome: 'reported',
        referenceRange: '45-104 μmol/L（需结合性别）',
        unit: ucumUnit('umol/L'),
        value: 78,
      },
      sourceLevel: 'L1',
      tatMinutes: 60,
    }, {
      catalogItemId: 'lab-egfr',
      critical: false,
      feeFen: 0,
      id: 'investigation-case-definition-egfr',
      name: '估算肾小球滤过率',
      report: '估算肾小球滤过率 92 mL/min/1.73m²。',
      result: {
        flag: 'N',
        outcome: 'reported',
        referenceRange: '>=60 mL/min/1.73m²',
        unit: ucumUnit('mL/min/{1.73_m2}'),
        value: 92,
      },
      sourceLevel: 'L1',
      tatMinutes: 60,
    }],
    module: 'hypertension',
    syntheaModules: ['hypertension'],
    version: '1',
  },
} as const satisfies Record<ScenarioModule, ScenarioCaseDefinition>
