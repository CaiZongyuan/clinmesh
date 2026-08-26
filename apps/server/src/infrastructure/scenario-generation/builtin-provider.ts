import { createHash } from 'node:crypto'
import type {
  ScenarioDatasetContent,
  ScenarioGenerationRequest,
  ScenarioProviderCapabilities,
} from '@clinmesh/contracts/scenario'
import type {
  ScenarioGenerationProvider,
  SourcePatientCorpus,
} from '../../application/scenario-data/provider.ts'

const syntheticNames = ['林晓', '王晓明', '李静', '张伟', '刘洋', '陈勇'] as const

function deterministicNumber(input: unknown): number {
  return Number.parseInt(createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 8), 16)
}

function birthDate(request: ScenarioGenerationRequest, ordinal: number): string {
  const span = request.population.age.maximum - request.population.age.minimum + 1
  const age = request.population.age.minimum
    + deterministicNumber([request.seeds.population, ordinal, 'age']) % span
  return `${Number(request.timeRange.end.slice(0, 4)) - age}-01-01`
}

function gender(request: ScenarioGenerationRequest, ordinal: number): 'female' | 'male' {
  if (request.population.gender !== 'any') return request.population.gender
  return deterministicNumber([request.seeds.population, ordinal, 'gender']) % 2 === 0
    ? 'female'
    : 'male'
}

function patient(request: ScenarioGenerationRequest, ordinal: number) {
  const module = request.modules[ordinal % request.modules.length] ?? 'fever'
  const idSuffix = createHash('sha256')
    .update(JSON.stringify([request.seeds, ordinal, module]))
    .digest('hex')
    .slice(0, 12)
  const isDiabetes = module === 'type-2-diabetes'
  return {
    birthDate: birthDate(request, ordinal),
    diagnosisSpace: {
      primary: isDiabetes ? '2型糖尿病血糖控制不佳' : '急性上呼吸道感染',
    },
    examinationFindings: {
      general: isDiabetes ? '神志清，查体合作。' : '神志清，咽部充血。',
    },
    gender: gender(request, ordinal),
    id: `synthetic-patient-${idSuffix}`,
    investigations: isDiabetes
      ? [{ code: 'hba1c', level: 'L1', value: 9.2, unit: '%' }]
      : [{ code: 'cbc', level: 'L1', value: 11.2, unit: '10^9/L' }],
    longitudinalHistory: [{
      code: isDiabetes ? 'type-2-diabetes' : 'fever',
      occurredOn: request.timeRange.end,
      source: 'builtin',
    }],
    managementSpace: {
      options: isDiabetes ? ['依从性教育', '评估肝肾功能后优化降糖方案'] : ['对症治疗', '门诊随访'],
    },
    name: syntheticNames[deterministicNumber([request.seeds.population, ordinal, 'name']) % syntheticNames.length]!,
    patientKnowledge: {
      chiefComplaint: isDiabetes ? '口渴、多饮两个月' : '发热、咽痛一天',
    },
    physiologyBaseline: isDiabetes
      ? { glucoseMmolL: 13.8, heightCm: 172, weightKg: 80.2 }
      : { oxygenSaturationPct: 98, temperatureC: 38.6 },
    symptomResponses: [{
      answer: isDiabetes ? '这两个月总是口渴，水喝得很多。' : '昨天下午开始发热，夜里最高 38.7 度。',
      topic: isDiabetes ? 'polydipsia' : 'symptom-onset',
    }],
  }
}

export class BuiltInScenarioGenerationProvider implements ScenarioGenerationProvider {
  async capabilities(): Promise<ScenarioProviderCapabilities> {
    return {
      available: true,
      maxPopulation: 1_000,
      modules: ['fever', 'type-2-diabetes'],
      providerId: 'builtin',
      providerName: 'ClinMesh 内置生成器',
    }
  }

  async generate(request: ScenarioGenerationRequest): Promise<SourcePatientCorpus> {
    const content: ScenarioDatasetContent = {
      catalog: {
        departments: [{ code: 'GM', id: 'department-general-medicine', name: '全科医学科', priceFen: 0 }],
        investigations: [
          { code: 'CBC', id: 'lab-cbc', name: '血常规', priceFen: 2_500 },
          { code: 'HBA1C', id: 'lab-hba1c', name: '糖化血红蛋白', priceFen: 4_500 },
        ],
        medications: [{ code: 'MED-SYN-001', id: 'medication-synthetic-001', name: '合成示例药品', priceFen: 1_200 }],
      },
      hiddenFacts: [],
      hospital: { id: 'hospital-synthetic-renhe', locale: 'zh-CN', name: '仁和医院' },
      inventory: [{
        expiresOn: '2030-12-31',
        itemId: 'medication-synthetic-001',
        lotId: 'lot-synthetic-001',
        quantity: 1_000,
      }],
      patients: Array.from({ length: request.population.count }, (_, index) => patient(request, index)),
      reproduction: {
        clinicalSeed: request.seeds.clinical,
        generator: 'clinmesh-builtin-v1',
        modules: request.modules,
        populationSeed: request.seeds.population,
        timeRange: request.timeRange,
        timeZone: request.timeZone,
      },
      revealPolicies: [],
      schemaVersion: '1',
      simulatorRules: [],
    }
    return { content, kind: 'case-truth' }
  }
}
