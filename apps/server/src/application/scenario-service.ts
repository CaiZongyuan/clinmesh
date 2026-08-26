import { createHash } from 'node:crypto'
import { scenarioStateSchema } from '@clinmesh/contracts/his'
import {
  scenarioDatasetContentSchema,
  type ScenarioDatasetContent,
} from '@clinmesh/contracts/scenario'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository } from '../infrastructure/sqlite/fhir-repository.ts'
import { z } from 'zod'
import type {
  ActorContext,
  CommandHandlerResult,
  CommandResponse,
} from './command-executor.ts'
import { CommandExecutor } from './command-executor.ts'
import { syntheticAccounts } from './identity-service.ts'

const clinicalReviewSchema = z.record(z.string(), z.unknown())

const laboratoryResultsHiddenFact = {
  code: 'laboratory-results',
  value: {
    'lab-cbc': {
      conclusion: '白细胞计数升高，其余血常规指标在参考范围内。',
      results: [{
        code: '6690-2',
        display: '白细胞计数',
        interpretation: 'high',
        referenceRange: { high: 9.5, low: 3.5, text: '3.5-9.5 x10^9/L' },
        unit: { code: '10*9/L', display: '10^9/L', system: 'http://unitsofmeasure.org' },
        value: 11.2,
      }, {
        code: '718-7',
        display: '血红蛋白',
        interpretation: 'normal',
        referenceRange: { high: 150, low: 115, text: '115-150 g/L' },
        unit: { code: 'g/L', display: 'g/L', system: 'http://unitsofmeasure.org' },
        value: 135,
      }, {
        code: '777-3',
        display: '血小板计数',
        interpretation: 'normal',
        referenceRange: { high: 350, low: 125, text: '125-350 x10^9/L' },
        unit: { code: '10*9/L', display: '10^9/L', system: 'http://unitsofmeasure.org' },
        value: 210,
      }],
    },
    'lab-crp': {
      conclusion: 'C 反应蛋白升高。',
      results: [{
        code: '1988-5',
        display: 'C 反应蛋白',
        interpretation: 'high',
        referenceRange: { high: 8, low: 0, text: '0-8 mg/L' },
        unit: { code: 'mg/L', display: 'mg/L', system: 'http://unitsofmeasure.org' },
        value: 18.6,
      }],
    },
  },
} as const

interface CandidateVirtualPatientSeed {
  answers: readonly [string, string, string]
  birthDate: string
  chiefComplaint: string
  gender: 'female' | 'male'
  hiddenCause?: boolean
  id: string
  name: string
  patientId: string
  priorCondition?: { display: string; recordedDate: string }
  summary: string
  vitalSigns: {
    bloodPressure: { diastolicMmHg: number; systolicMmHg: number }
    oxygenSaturationPct: number
    pulseBpm: number
    respirationBpm: number
    temperatureC: number
  }
}

function candidateVirtualPatient(seed: CandidateVirtualPatientSeed) {
  return {
    birthDate: seed.birthDate,
    gender: seed.gender,
    id: seed.id,
    name: seed.name,
    patientId: seed.patientId,
    presentation: {
      chiefComplaint: seed.chiefComplaint,
      summary: seed.summary,
      vitalSigns: seed.vitalSigns,
    },
    ...(seed.priorCondition === undefined ? {} : { priorCondition: seed.priorCondition }),
    questions: [{
      answer: seed.answers[0],
      code: 'symptom-onset',
      factCode: null,
      ordinal: 1,
      revealedAnswer: null,
      text: '什么时候开始不舒服？',
      version: 1,
    }, {
      answer: seed.answers[1],
      code: 'associated-symptoms',
      factCode: null,
      ordinal: 2,
      revealedAnswer: null,
      text: '还有哪些伴随症状？',
      version: 1,
    }, {
      answer: seed.answers[2],
      code: 'relevant-history',
      factCode: seed.hiddenCause === true ? 'respiratory-pathogen' : null,
      ordinal: 3,
      revealedAnswer: seed.hiddenCause === true ? '检验结果显示是甲型流感病毒感染。' : null,
      text: seed.hiddenCause === true ? '知道是什么感染引起的吗？' : '近期是否用药或有相关病史？',
      version: 1,
    }],
    version: 1,
  }
}

const candidateVirtualPatients = [
  candidateVirtualPatient({
    answers: ['昨天下午开始发热，夜里最高 38.7 °C。', '咽痛，吞咽时明显，没有气促。', '目前不清楚，需要等检查结果。'],
    birthDate: '1988-03-16',
    chiefComplaint: '发热、咽痛 1 天',
    gender: 'female',
    hiddenCause: true,
    id: 'virtual-patient-fever-001',
    name: '林晓',
    patientId: 'candidate-patient-001',
    priorCondition: { display: '上呼吸道感染', recordedDate: '2025-11-08' },
    summary: '昨日傍晚开始发热，最高 38.7 °C，伴咽痛。',
    vitalSigns: { bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 }, oxygenSaturationPct: 98, pulseBpm: 96, respirationBpm: 20, temperatureC: 38.6 },
  }),
  candidateVirtualPatient({
    answers: ['三天前开始咳嗽，昨晚出现发热。', '咳少量黄痰，胸口不痛。', '服过一次对乙酰氨基酚，退热后又升高。'],
    birthDate: '1981-06-12',
    chiefComplaint: '咳嗽、发热 3 天',
    gender: 'male',
    id: 'virtual-patient-fever-002',
    name: '王晓明',
    patientId: 'candidate-patient-002',
    priorCondition: { display: '高血压', recordedDate: '2019-06-12' },
    summary: '咳嗽三天，昨夜体温升至 38.3 °C，伴少量黄痰。',
    vitalSigns: { bloodPressure: { diastolicMmHg: 86, systolicMmHg: 142 }, oxygenSaturationPct: 97, pulseBpm: 92, respirationBpm: 19, temperatureC: 38.1 },
  }),
  candidateVirtualPatient({
    answers: ['今天清晨开始畏寒和头痛。', '全身酸痛，没有呕吐。', '尚未服药，既往没有慢性病。'],
    birthDate: '1994-11-03',
    chiefComplaint: '畏寒、头痛半天',
    gender: 'female',
    id: 'virtual-patient-fever-003',
    name: '李静',
    patientId: 'candidate-patient-003',
    summary: '清晨突发畏寒、头痛及全身酸痛，体温 38.9 °C。',
    vitalSigns: { bloodPressure: { diastolicMmHg: 72, systolicMmHg: 110 }, oxygenSaturationPct: 99, pulseBpm: 104, respirationBpm: 21, temperatureC: 38.9 },
  }),
  candidateVirtualPatient({
    answers: ['两天前开始鼻塞流涕。', '偶尔干咳，不胸闷。', '自行服用过一包感冒冲剂。'],
    birthDate: '1976-02-28',
    chiefComplaint: '鼻塞、流涕 2 天',
    gender: 'male',
    id: 'virtual-patient-fever-004',
    name: '张伟',
    patientId: 'candidate-patient-004',
    summary: '鼻塞流涕两天，伴轻度咽干和偶发干咳。',
    vitalSigns: { bloodPressure: { diastolicMmHg: 82, systolicMmHg: 130 }, oxygenSaturationPct: 98, pulseBpm: 78, respirationBpm: 18, temperatureC: 37.4 },
  }),
  candidateVirtualPatient({
    answers: ['昨晚开始咽部疼痛。', '没有咳嗽，吞咽时加重。', '青霉素过敏，暂未服药。'],
    birthDate: '1985-09-21',
    chiefComplaint: '咽痛伴低热 1 天',
    gender: 'female',
    id: 'virtual-patient-fever-005',
    name: '刘洋',
    patientId: 'candidate-patient-005',
    summary: '咽痛一天，吞咽时加重，最高体温 37.9 °C。',
    vitalSigns: { bloodPressure: { diastolicMmHg: 74, systolicMmHg: 116 }, oxygenSaturationPct: 99, pulseBpm: 84, respirationBpm: 18, temperatureC: 37.8 },
  }),
  candidateVirtualPatient({
    answers: ['四天前开始反复咳嗽。', '夜间较重，有少量白痰。', '有慢性支气管炎史，近期未规律用药。'],
    birthDate: '1968-12-05',
    chiefComplaint: '反复咳嗽 4 天',
    gender: 'male',
    id: 'virtual-patient-fever-006',
    name: '陈勇',
    patientId: 'candidate-patient-006',
    priorCondition: { display: '慢性支气管炎', recordedDate: '2022-03-09' },
    summary: '咳嗽四天，夜间加重，伴少量白痰，无明显发热。',
    vitalSigns: { bloodPressure: { diastolicMmHg: 80, systolicMmHg: 128 }, oxygenSaturationPct: 96, pulseBpm: 88, respirationBpm: 20, temperatureC: 37.2 },
  }),
  candidateVirtualPatient({
    answers: ['昨天开始发热和乏力。', '胃口差，没有腹泻。', '家中有人近期也有发热。'],
    birthDate: '2000-07-14',
    chiefComplaint: '发热、乏力 1 天',
    gender: 'female',
    id: 'virtual-patient-fever-007',
    name: '赵雪',
    patientId: 'candidate-patient-007',
    summary: '发热伴明显乏力一天，最高体温 38.5 °C。',
    vitalSigns: { bloodPressure: { diastolicMmHg: 70, systolicMmHg: 108 }, oxygenSaturationPct: 99, pulseBpm: 98, respirationBpm: 19, temperatureC: 38.4 },
  }),
  candidateVirtualPatient({
    answers: ['一周前开始间断咳嗽。', '运动后稍气促，休息可缓解。', '有吸烟史，没有哮喘史。'],
    birthDate: '1972-04-30',
    chiefComplaint: '咳嗽伴活动后气促 1 周',
    gender: 'male',
    id: 'virtual-patient-fever-008',
    name: '周敏',
    patientId: 'candidate-patient-008',
    summary: '间断咳嗽一周，活动后轻度气促，无胸痛。',
    vitalSigns: { bloodPressure: { diastolicMmHg: 84, systolicMmHg: 136 }, oxygenSaturationPct: 95, pulseBpm: 90, respirationBpm: 22, temperatureC: 37.1 },
  }),
  candidateVirtualPatient({
    answers: ['今天凌晨开始高热。', '伴寒战和肌肉酸痛。', '两周前接种过流感疫苗，未服药。'],
    birthDate: '1991-01-19',
    chiefComplaint: '高热、寒战 6 小时',
    gender: 'female',
    id: 'virtual-patient-fever-009',
    name: '孙磊',
    patientId: 'candidate-patient-009',
    summary: '凌晨突发高热寒战，体温最高 39.4 °C，伴肌肉酸痛。',
    vitalSigns: { bloodPressure: { diastolicMmHg: 68, systolicMmHg: 104 }, oxygenSaturationPct: 98, pulseBpm: 112, respirationBpm: 22, temperatureC: 39.2 },
  }),
  candidateVirtualPatient({
    answers: ['两天前开始声音嘶哑。', '咽干、偶尔咳嗽，没有发热。', '职业需要频繁讲话，未服药。'],
    birthDate: '1983-08-08',
    chiefComplaint: '声音嘶哑、咽干 2 天',
    gender: 'male',
    id: 'virtual-patient-fever-010',
    name: '胡明',
    patientId: 'candidate-patient-010',
    summary: '声音嘶哑伴咽干两天，偶发干咳，无发热。',
    vitalSigns: { bloodPressure: { diastolicMmHg: 78, systolicMmHg: 124 }, oxygenSaturationPct: 99, pulseBpm: 76, respirationBpm: 17, temperatureC: 36.8 },
  }),
  candidateVirtualPatient({
    answers: ['三天前开始发热。', '伴鼻塞和耳闷，没有耳痛。', '服过布洛芬，无药物过敏史。'],
    birthDate: '1997-05-26',
    chiefComplaint: '发热、鼻塞 3 天',
    gender: 'female',
    id: 'virtual-patient-fever-011',
    name: '韩萍',
    patientId: 'candidate-patient-011',
    summary: '发热鼻塞三天，最高体温 38.2 °C，伴双侧耳闷。',
    vitalSigns: { bloodPressure: { diastolicMmHg: 73, systolicMmHg: 112 }, oxygenSaturationPct: 98, pulseBpm: 91, respirationBpm: 18, temperatureC: 37.9 },
  }),
  candidateVirtualPatient({
    answers: ['五天前开始咳嗽。', '痰少，夜间有喘鸣。', '小时候有哮喘，近几年未发作。'],
    birthDate: '1979-10-17',
    chiefComplaint: '咳嗽伴夜间喘鸣 5 天',
    gender: 'male',
    id: 'virtual-patient-fever-012',
    name: '朱凯',
    patientId: 'candidate-patient-012',
    priorCondition: { display: '支气管哮喘', recordedDate: '2016-04-21' },
    summary: '咳嗽五天，夜间出现喘鸣，活动耐量较平时下降。',
    vitalSigns: { bloodPressure: { diastolicMmHg: 79, systolicMmHg: 126 }, oxygenSaturationPct: 94, pulseBpm: 94, respirationBpm: 23, temperatureC: 37.0 },
  }),
] as const

const legacyScenarioBlueprints = {
  candidate: {
    clinicalReview: null,
    hiddenFacts: [{
      code: 'respiratory-pathogen',
      value: { code: 'influenza-a', detected: true },
    }],
    kind: 'candidate',
    revealPolicies: [{
      code: 'paid-lis-report',
      factCode: 'respiratory-pathogen',
      triggerCode: 'lis-report-final',
    }],
    schemaVersion: '1',
    seed: 20260824,
    simulatorRules: [
      { code: 'success', outcome: 'success', simulator: 'payment' },
      { code: 'decline', outcome: 'declined', simulator: 'payment' },
      { code: 'ambiguous', outcome: 'ambiguous', simulator: 'payment' },
      { code: 'deterministic-report', outcome: 'success', simulator: 'lis' },
    ],
    virtualPatients: [candidateVirtualPatients[0]],
    scenarioId: 'candidate-fever-outpatient-v1',
    version: '1.0.0',
    virtualTime: '2026-08-24T09:00:00+08:00',
  },
  density: {
    clinicalReview: null,
    hiddenFacts: [{
      code: 'respiratory-pathogen',
      value: { code: 'influenza-a', detected: true },
    }],
    kind: 'density',
    revealPolicies: [{
      code: 'paid-lis-report',
      factCode: 'respiratory-pathogen',
      triggerCode: 'lis-report-final',
    }],
    schemaVersion: '1',
    seed: 20260825,
    simulatorRules: [
      { code: 'success', outcome: 'success', simulator: 'payment' },
      { code: 'deterministic-report', outcome: 'success', simulator: 'lis' },
    ],
    virtualPatients: [],
    scenarioId: 'density-fever-outpatient-v1',
    version: '1.0.0',
    virtualTime: '2026-08-24T09:00:00+08:00',
  },
} as const

const versionTwoScenarioBlueprints = {
  candidate: {
    ...legacyScenarioBlueprints.candidate,
    hiddenFacts: [
      ...legacyScenarioBlueprints.candidate.hiddenFacts,
      laboratoryResultsHiddenFact,
    ],
    scenarioId: 'candidate-fever-outpatient-v2',
    schemaVersion: '2',
    version: '2.0.0',
  },
  density: {
    ...legacyScenarioBlueprints.density,
    hiddenFacts: [
      ...legacyScenarioBlueprints.density.hiddenFacts,
      laboratoryResultsHiddenFact,
    ],
    scenarioId: 'density-fever-outpatient-v2',
    schemaVersion: '2',
    version: '2.0.0',
  },
} as const

const installableScenarioBlueprints = {
  candidate: {
    ...versionTwoScenarioBlueprints.candidate,
    medicationRulesVersion: 'prescription-conclusion-v1',
    scenarioId: 'candidate-fever-outpatient-v3',
    schemaVersion: '3',
    version: '3.0.0',
    virtualPatients: candidateVirtualPatients,
  },
  density: {
    ...versionTwoScenarioBlueprints.density,
    medicationRulesVersion: 'prescription-conclusion-v1',
    scenarioId: 'density-fever-outpatient-v3',
    schemaVersion: '3',
    version: '3.0.0',
  },
} as const

const knownScenarioBlueprints = [
  ...Object.values(legacyScenarioBlueprints),
  ...Object.values(versionTwoScenarioBlueprints),
  ...Object.values(installableScenarioBlueprints),
] as const

interface ScenarioVirtualPatient {
  birthDate: string
  fhirHistory?: ScenarioDatasetContent['patients'][number]['fhirHistory']
  gender: 'female' | 'male' | 'other' | 'unknown'
  id: string
  name: string
  patientId: string
  presentation: {
    chiefComplaint: string
    summary: string
    vitalSigns: {
      bloodPressure: { diastolicMmHg: number; systolicMmHg: number }
      oxygenSaturationPct: number
      pulseBpm: number
      respirationBpm: number
      temperatureC: number
    }
  }
  priorCondition?: { display: string; recordedDate: string }
  questions: ReadonlyArray<{
    answer: string
    code: string
    factCode: null | string
    ordinal: number
    revealedAnswer: null | string
    secondAskAnswer?: string
    text: string
    version: number
  }>
  version: number
}

function scenarioPatientQuestions(
  patient: ScenarioDatasetContent['patients'][number],
): ScenarioVirtualPatient['questions'] {
  const questions = patient.symptomResponses.flatMap((response) => {
    const responseText = [...response.responsePoints, ...response.denies].join(' ')
      || patient.patientKnowledge.chiefComplaint
    return [{
      answer: response.secondAskConcede?.firstResponse ?? responseText,
      code: response.id,
      factCode: null,
      revealedAnswer: null,
      ...(response.secondAskConcede === undefined
        ? {}
        : { secondAskAnswer: response.secondAskConcede.revealedResponse }),
      text: response.name,
      version: 1,
    }, ...response.avoids.map((avoid, index) => ({
      answer: avoid.response,
      code: `${response.id}-avoid-${index + 1}`,
      factCode: null,
      revealedAnswer: null,
      text: avoid.questionPattern,
      version: 1,
    }))]
  })
  const availableQuestions = questions.length === 0
    ? [{
        answer: patient.patientKnowledge.chiefComplaint,
        code: 'chief-complaint',
        factCode: null,
        revealedAnswer: null,
        text: '这次主要哪里不舒服？',
        version: 1,
      }]
    : questions
  return availableQuestions.map((question, index) => ({
    ...question,
    ordinal: index + 1,
  }))
}

interface ScenarioBlueprint {
  catalog?: ScenarioDatasetContent['catalog']
  clinicalReview: null | Record<string, unknown>
  hiddenFacts: ReadonlyArray<{ code: string; value: unknown }>
  hospital?: ScenarioDatasetContent['hospital']
  inventory?: ScenarioDatasetContent['inventory']
  kind: 'candidate' | 'density' | 'golden'
  medicationRulesVersion?: string
  revealPolicies: ReadonlyArray<{ code: string; factCode: string; triggerCode: string }>
  scenarioId: string
  schemaVersion: string
  seed: number
  simulatorRules: ReadonlyArray<{ code: string; outcome: string; simulator: string }>
  version: string
  virtualPatients: readonly ScenarioVirtualPatient[]
  virtualTime: string
}

export interface ScenarioState {
  clinicalReview: null | Record<string, unknown>
  epoch: string
  initialStateHash: string
  kind: 'candidate' | 'density' | 'golden'
  scenarioId: string
  scenarioRunId: string
  seed: number
  status: 'active' | 'closed' | 'completed'
  virtualTime: string
  workspaceId: string
}

interface ScenarioStateRow {
  clinical_review_json: string | null
  epoch: string
  initial_state_hash: string
  kind: ScenarioState['kind']
  scenario_id: string
  scenario_run_id: string
  seed: number
  status: ScenarioState['status']
  virtual_time: string
  workspace_id: string
}

export class ScenarioError extends Error {
  readonly code: 'ROLE_NOT_ALLOWED' | 'SCENARIO_RUN_CONFLICT' | 'SCENARIO_STATE_MISSING'
  readonly status: 403 | 404 | 409

  constructor(
    code: 'ROLE_NOT_ALLOWED' | 'SCENARIO_RUN_CONFLICT' | 'SCENARIO_STATE_MISSING',
    message: string,
  ) {
    super(message)
    this.name = 'ScenarioError'
    this.code = code
    this.status = code === 'ROLE_NOT_ALLOWED' ? 403 : code === 'SCENARIO_STATE_MISSING' ? 404 : 409
  }
}

function blueprintHash(blueprint: ScenarioBlueprint): string {
  return createHash('sha256').update(JSON.stringify(blueprint)).digest('hex')
}

export class ScenarioService {
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #fhir: FhirRepository

  constructor(database: ClinMeshDatabase, fhir: FhirRepository, commands: CommandExecutor) {
    this.#commands = commands
    this.#database = database
    this.#fhir = fhir
  }

  ensureInitialEpoch(input: {
    epoch: string
    scenarioRunId: string
    workspaceId: string
  }): void {
    this.#installDefinitions()
    const existing = this.#database.driver.prepare(`
      SELECT 1 AS present
      FROM scenario_epoch_state
      WHERE workspace_id = ? AND epoch = ?
    `).get(input.workspaceId, input.epoch)
    if (existing !== undefined) return
    this.#database.driver.exec('BEGIN IMMEDIATE')
    try {
      this.#seedEpoch({
        blueprint: installableScenarioBlueprints.candidate,
        epoch: input.epoch,
        scenarioRunId: input.scenarioRunId,
        workspaceId: input.workspaceId,
      })
      this.#database.driver.exec('COMMIT')
    } catch (error) {
      this.#database.driver.exec('ROLLBACK')
      throw error
    }
  }

  current(context: ActorContext): ScenarioState {
    const row = this.#database.driver.prepare(`
      SELECT
        state.workspace_id,
        state.epoch,
        state.scenario_run_id,
        state.scenario_id,
        definition.kind,
        definition.clinical_review_json,
        state.deterministic_seed AS seed,
        state.virtual_time,
        state.initial_state_hash,
        run.status
      FROM workspace
      JOIN scenario_epoch_state AS state
        ON state.workspace_id = workspace.workspace_id
       AND state.epoch = workspace.active_epoch
      JOIN scenario_definition AS definition
        ON definition.scenario_id = state.scenario_id
      JOIN scenario_run AS run
        ON run.workspace_id = state.workspace_id
       AND run.epoch = state.epoch
       AND run.scenario_run_id = state.scenario_run_id
      WHERE workspace.workspace_id = ?
        AND workspace.active_epoch = ?
        AND state.scenario_run_id = ?
    `).get(context.workspaceId, context.epoch, context.scenarioRunId) as ScenarioStateRow | undefined
    if (row === undefined) {
      throw new ScenarioError('SCENARIO_STATE_MISSING', 'The active Scenario state was not found')
    }
    return this.#mapState(row)
  }

  reset(input: {
    context: ActorContext
    idempotencyKey: string
    scenarioRunId: string
  }): CommandResponse<ScenarioState> {
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: scenarioStateSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: { scenarioRunId: input.scenarioRunId },
      operation: 'scenario.reset',
    }, () => {
      if (input.context.roleCode !== 'administrator') {
        throw new ScenarioError('ROLE_NOT_ALLOWED', 'Only an administrator can reset a Scenario Run')
      }
      if (input.scenarioRunId !== input.context.scenarioRunId) {
        throw new ScenarioError('SCENARIO_RUN_CONFLICT', 'The Scenario Run is no longer active')
      }
      const currentState = this.current(input.context)
      const blueprint = knownScenarioBlueprints.find(
        candidate => candidate.scenarioId === currentState.scenarioId,
      ) ?? this.#packageBlueprint(input.context.workspaceId, currentState.scenarioId)
        ?? installableScenarioBlueprints.candidate
      return this.#transitionEpoch(input.context, blueprint)
    })
  }

  install(input: {
    context: ActorContext
    idempotencyKey: string
    kind: keyof typeof installableScenarioBlueprints
  }): CommandResponse<ScenarioState> {
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: scenarioStateSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: { kind: input.kind },
      operation: 'scenario.install',
    }, () => {
      if (input.context.roleCode !== 'administrator') {
        throw new ScenarioError('ROLE_NOT_ALLOWED', 'Only an administrator can install a Scenario')
      }
      return this.#transitionEpoch(input.context, installableScenarioBlueprints[input.kind])
    })
  }

  installPackage(input: {
    content: ScenarioDatasetContent
    context: ActorContext
    packageId: string
    version: number
  }): CommandHandlerResult<ScenarioState> {
    if (input.context.roleCode !== 'administrator') {
      throw new ScenarioError('ROLE_NOT_ALLOWED', 'Only an administrator can install a Scenario Package')
    }
    const blueprint = this.#blueprintFromPackage(input.packageId, input.version, input.content)
    this.#database.driver.prepare(`
      INSERT INTO scenario_definition (
        scenario_id, version, kind, schema_version, clinical_review_json
      ) VALUES (?, ?, 'candidate', ?, NULL)
    `).run(blueprint.scenarioId, blueprint.version, blueprint.schemaVersion)
    return this.#transitionEpoch(input.context, blueprint)
  }

  #transitionEpoch(context: ActorContext, blueprint: ScenarioBlueprint) {
    const sequence = (this.#database.driver.prepare(`
      SELECT COUNT(*) AS count FROM workspace_epoch WHERE workspace_id = ?
    `).get(context.workspaceId) as { count: number }).count + 1
    const epoch = `epoch-${sequence}`
    const scenarioRunId = `scenario-run-${sequence}`
    const now = new Date().toISOString()
    this.#database.driver.prepare(`
      INSERT INTO workspace_epoch (
        workspace_id, epoch, state, scenario_id, created_at, activated_at
      ) VALUES (?, ?, 'building', ?, ?, ?)
    `).run(context.workspaceId, epoch, blueprint.scenarioId, now, now)
    this.#database.driver.prepare(`
      INSERT INTO scenario_run (
        workspace_id, epoch, scenario_run_id, scenario_id, status, started_at
      ) VALUES (?, ?, ?, ?, 'active', ?)
    `).run(context.workspaceId, epoch, scenarioRunId, blueprint.scenarioId, now)
    this.#database.driver.prepare(`
      INSERT INTO audit_head (workspace_id, epoch, sequence, hash)
      VALUES (?, ?, 0, ?)
    `).run(context.workspaceId, epoch, '0'.repeat(64))
    this.#seedEpoch({
      blueprint,
      epoch,
      scenarioRunId,
      workspaceId: context.workspaceId,
    })
    this.#database.driver.prepare(`
      UPDATE outbox_event
      SET status = 'abandoned', lease_owner = NULL, leased_until = NULL, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND status IN ('queued', 'claimed')
    `).run(now, context.workspaceId, context.epoch)
    this.#database.driver.prepare(`
      UPDATE scenario_run
      SET status = 'closed', completed_at = ?
      WHERE workspace_id = ? AND epoch = ? AND scenario_run_id = ?
        AND status = 'active'
    `).run(now, context.workspaceId, context.epoch, context.scenarioRunId)
    this.#database.driver.prepare(`
      UPDATE workspace_epoch
      SET state = 'closed', closed_at = ?
      WHERE workspace_id = ? AND epoch = ?
    `).run(now, context.workspaceId, context.epoch)
    this.#database.driver.prepare(`
      UPDATE workspace_epoch SET state = 'active' WHERE workspace_id = ? AND epoch = ?
    `).run(context.workspaceId, epoch)
    this.#database.driver.prepare(`
      UPDATE workspace SET active_epoch = ? WHERE workspace_id = ?
    `).run(epoch, context.workspaceId)
    const state: ScenarioState = {
      clinicalReview: blueprint.clinicalReview,
      epoch,
      initialStateHash: blueprintHash(blueprint),
      kind: blueprint.kind,
      scenarioId: blueprint.scenarioId,
      scenarioRunId,
      seed: blueprint.seed,
      status: 'active',
      virtualTime: blueprint.virtualTime,
      workspaceId: context.workspaceId,
    }
    return {
      data: state,
      effects: [{
        kind: 'created' as const,
        reference: `ScenarioRun/${scenarioRunId}`,
        versionId: '1',
      }],
    }
  }

  #installDefinitions(): void {
    const insert = this.#database.driver.prepare(`
      INSERT OR IGNORE INTO scenario_definition (
        scenario_id, version, kind, schema_version, clinical_review_json
      ) VALUES (?, ?, ?, ?, ?)
    `)
    for (const blueprint of knownScenarioBlueprints) {
      insert.run(
        blueprint.scenarioId,
        blueprint.version,
        blueprint.kind,
        blueprint.schemaVersion,
        blueprint.clinicalReview === null ? null : JSON.stringify(blueprint.clinicalReview),
      )
    }
  }

  #packageBlueprint(workspaceId: string, packageId: string): ScenarioBlueprint | undefined {
    const row = this.#database.driver.prepare(`
      SELECT content_json, source_dataset_version
      FROM scenario_package
      WHERE workspace_id = ? AND package_id = ?
    `).get(workspaceId, packageId) as {
      content_json: string
      source_dataset_version: number
    } | undefined
    if (row === undefined) return undefined
    return this.#blueprintFromPackage(
      packageId,
      row.source_dataset_version,
      scenarioDatasetContentSchema.parse(JSON.parse(row.content_json)),
    )
  }

  #blueprintFromPackage(
    packageId: string,
    version: number,
    content: ScenarioDatasetContent,
  ): ScenarioBlueprint {
    return {
      clinicalReview: null,
      hiddenFacts: content.hiddenFacts,
      kind: 'candidate',
      medicationRulesVersion: 'prescription-conclusion-v1',
      catalog: content.catalog,
      hospital: content.hospital,
      inventory: content.inventory,
      revealPolicies: content.revealPolicies.map(policy => ({
        code: policy.code,
        factCode: policy.factCode,
        triggerCode: policy.triggerCode,
      })),
      scenarioId: packageId,
      schemaVersion: content.schemaVersion,
      seed: content.reproduction.clinicalSeed,
      simulatorRules: content.simulatorRules,
      version: `dataset-${version}`,
      virtualPatients: content.patients.map((patient) => {
        const chiefComplaint = patient.patientKnowledge.chiefComplaint
        const physiology = patient.physiologyBaseline.vitalSigns
        return {
          birthDate: patient.birthDate,
          gender: patient.gender === 'other' || patient.gender === 'unknown' ? 'female' : patient.gender,
          id: `virtual-${patient.id}`,
          name: patient.name,
          patientId: patient.id,
          presentation: {
            chiefComplaint,
            summary: chiefComplaint,
            vitalSigns: {
              bloodPressure: {
                diastolicMmHg: typeof physiology.diastolicMmHg === 'number' ? physiology.diastolicMmHg : 76,
                systolicMmHg: typeof physiology.systolicMmHg === 'number' ? physiology.systolicMmHg : 118,
              },
              oxygenSaturationPct: typeof physiology.oxygenSaturationPct === 'number' ? physiology.oxygenSaturationPct : 98,
              pulseBpm: typeof physiology.pulseBpm === 'number' ? physiology.pulseBpm : 88,
              respirationBpm: typeof physiology.respirationBpm === 'number' ? physiology.respirationBpm : 18,
              temperatureC: typeof physiology.temperatureC === 'number' ? physiology.temperatureC : 36.8,
            },
          },
          questions: scenarioPatientQuestions(patient),
          fhirHistory: patient.fhirHistory,
          version: 1,
        }
      }),
      virtualTime: `${content.reproduction.timeRange.end}T09:00:00+08:00`,
    }
  }

  #mapState(row: ScenarioStateRow): ScenarioState {
    return {
      clinicalReview: row.clinical_review_json === null
        ? null
        : clinicalReviewSchema.parse(JSON.parse(row.clinical_review_json)),
      epoch: row.epoch,
      initialStateHash: row.initial_state_hash,
      kind: row.kind,
      scenarioId: row.scenario_id,
      scenarioRunId: row.scenario_run_id,
      seed: row.seed,
      status: row.status,
      virtualTime: row.virtual_time,
      workspaceId: row.workspace_id,
    }
  }

  #seedEpoch(input: {
    blueprint: ScenarioBlueprint
    epoch: string
    scenarioRunId: string
    workspaceId: string
  }): void {
    const { blueprint } = input
    this.#database.driver.prepare(`
      INSERT INTO scenario_epoch_state (
        workspace_id, epoch, scenario_run_id, scenario_id, deterministic_seed,
        virtual_time, initial_state_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.workspaceId,
      input.epoch,
      input.scenarioRunId,
      blueprint.scenarioId,
      blueprint.seed,
      blueprint.virtualTime,
      blueprintHash(blueprint),
    )
    const insertFact = this.#database.driver.prepare(`
      INSERT INTO scenario_hidden_fact (
        workspace_id, epoch, fact_code, value_json
      ) VALUES (?, ?, ?, ?)
    `)
    for (const fact of blueprint.hiddenFacts) {
      insertFact.run(input.workspaceId, input.epoch, fact.code, JSON.stringify(fact.value))
    }
    const insertPolicy = this.#database.driver.prepare(`
      INSERT INTO scenario_reveal_policy (
        workspace_id, epoch, policy_code, trigger_code, fact_code
      ) VALUES (?, ?, ?, ?, ?)
    `)
    for (const policy of blueprint.revealPolicies) {
      insertPolicy.run(
        input.workspaceId,
        input.epoch,
        policy.code,
        policy.triggerCode,
        policy.factCode,
      )
    }
    const insertRule = this.#database.driver.prepare(`
      INSERT INTO scenario_simulator_rule (
        workspace_id, epoch, simulator, rule_code, outcome, config_json
      ) VALUES (?, ?, ?, ?, ?, '{}')
    `)
    for (const rule of blueprint.simulatorRules) {
      insertRule.run(input.workspaceId, input.epoch, rule.simulator, rule.code, rule.outcome)
    }
    const insertCatalog = this.#database.driver.prepare(`
      INSERT INTO outpatient_catalog (
        workspace_id, epoch, item_id, kind, code, name_zh, name_en,
        price_fen, version, active, config_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
    `)
    const supportsPrescriptionConclusion = blueprint.medicationRulesVersion === 'prescription-conclusion-v1'
    const packageDiagnosisCatalog = blueprint.catalog?.diagnoses.filter(
      diagnosis => diagnosis.active && diagnosis.status === 'active',
    )
    const diagnosisIdByCode = new Map(
      packageDiagnosisCatalog?.map(diagnosis => [diagnosis.code, diagnosis.id]),
    )
    const legacyCatalog = [
      ['department-general-medicine', 'department', 'GM', '全科医学科', 'General Medicine', 0, '{}'],
      ['visit-general', 'visit-type', 'GENERAL', '普通门诊挂号费', 'General outpatient registration', 2000, '{}'],
      ['lab-fever-panel', 'laboratory', 'FEVER-PANEL', '发热检验组合', 'Fever laboratory panel', 6800, '{"allowedIndicationCodes":["fever"],"contraindicatedAllergyCodes":[]}'],
      ['lab-cbc', 'laboratory', 'CBC', '血常规', 'Complete blood count', 2500, '{"allowedIndicationCodes":["fever"],"contraindicatedAllergyCodes":[]}'],
      ['lab-crp', 'laboratory', 'CRP', 'C 反应蛋白', 'C-reactive protein', 4300, '{"allowedIndicationCodes":["fever"],"contraindicatedAllergyCodes":[]}'],
      ['medication-oseltamivir', 'medication', 'OSELTAMIVIR', '磷酸奥司他韦胶囊', 'Oseltamivir phosphate capsules', 760, supportsPrescriptionConclusion
        ? '{"dose":"75 mg","frequency":"BID","allowedDoseTexts":["75 mg"],"allowedFrequencyCodes":["BID"],"allowedCombinationIds":["medication-acetaminophen"],"allowedCourseDays":[5],"allowedDiagnosisCatalogItemIds":["diagnosis-influenza"],"allowedQuantities":[10],"defaultCourseDays":5,"defaultQuantity":10}'
        : '{"dose":"75 mg","frequency":"BID","allowedDoseTexts":["75 mg"],"allowedFrequencyCodes":["BID"],"allowedCombinationIds":["medication-acetaminophen"]}'],
      ['medication-acetaminophen', 'medication', 'ACETAMINOPHEN', '对乙酰氨基酚片', 'Acetaminophen tablets', 120, supportsPrescriptionConclusion
        ? '{"dose":"0.5 g","frequency":"PRN","allowedDoseTexts":["0.5 g"],"allowedFrequencyCodes":["PRN"],"allowedCombinationIds":["medication-oseltamivir"],"allowedCourseDays":[3],"allowedDiagnosisCatalogItemIds":["diagnosis-influenza","diagnosis-acute-upper-respiratory-infection","diagnosis-fever"],"allowedQuantities":[6],"defaultCourseDays":3,"defaultQuantity":6}'
        : '{"dose":"0.5 g","frequency":"PRN","allowedDoseTexts":["0.5 g"],"allowedFrequencyCodes":["PRN"],"allowedCombinationIds":["medication-oseltamivir"]}'],
    ] as const
    const catalog = blueprint.catalog === undefined
      ? legacyCatalog
      : [
          legacyCatalog[0],
          legacyCatalog[1],
          ...blueprint.catalog.departments
            .filter(item => item.active && item.status === 'active')
            .map(item => [
              item.id,
              'department',
              item.code,
              item.name,
              item.name,
              item.priceFen,
              '{}',
            ] as const),
          ...blueprint.catalog.investigations
            .filter(item => item.active && item.available && item.status === 'active'
              && item.category === 'laboratory')
            .map(item => [
              item.id,
              'laboratory',
              item.code,
              item.name,
              item.name,
              item.priceFen,
              JSON.stringify({
                allowedIndicationCodes: item.allowedIndicationCodes,
                contraindicatedAllergyCodes: item.contraindicatedAllergyCodes,
              }),
            ] as const),
          ...blueprint.catalog.medications
            .filter(item => item.active && item.status === 'active')
            .map(item => [
              item.id,
              'medication',
              item.code,
              item.name,
              item.name,
              item.priceFen,
              JSON.stringify({
                allowedCombinationIds: item.workflow.allowedCombinationIds,
                allowedCourseDays: item.workflow.allowedCourseDays,
                allowedDiagnosisCatalogItemIds: item.workflow.allowedDiagnosisCodes.flatMap((code) => {
                  const diagnosisId = diagnosisIdByCode.get(code)
                  return diagnosisId === undefined ? [] : [diagnosisId]
                }),
                allowedDoseTexts: item.workflow.allowedDoseTexts,
                allowedFrequencyCodes: item.workflow.allowedFrequencyCodes,
                allowedQuantities: item.workflow.allowedQuantities,
                defaultCourseDays: item.workflow.defaultCourseDays,
                defaultQuantity: item.workflow.defaultQuantity,
                dose: item.defaultDose,
                frequency: item.defaultFrequency,
              }),
            ] as const),
        ]
    const installedCatalog = new Map(catalog.map(item => [item[0], item])).values()
    for (const item of installedCatalog) {
      insertCatalog.run(input.workspaceId, input.epoch, ...item)
    }
    const insertDiagnosisCatalog = this.#database.driver.prepare(`
      INSERT INTO diagnosis_catalog (
        workspace_id, epoch, item_id, code_system, code, name_zh, name_en,
        version, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)
    `)
    const legacyDiagnosisCatalog = [
      [
        'diagnosis-influenza',
        'http://hl7.org/fhir/sid/icd-10',
        'J10.1',
        '流感伴其他呼吸道表现，季节性流感病毒已标明',
        'Influenza with other respiratory manifestations, seasonal influenza virus identified',
      ],
      [
        'diagnosis-acute-upper-respiratory-infection',
        'http://hl7.org/fhir/sid/icd-10',
        'J06.9',
        '急性上呼吸道感染，未特指',
        'Acute upper respiratory infection, unspecified',
      ],
      ['diagnosis-fever', 'http://hl7.org/fhir/sid/icd-10', 'R50.9', '发热，未特指', 'Fever, unspecified'],
    ] as const
    const diagnosisCatalog = packageDiagnosisCatalog === undefined
      ? legacyDiagnosisCatalog
      : packageDiagnosisCatalog.map(diagnosis => [
          diagnosis.id,
          diagnosis.codeSystem,
          diagnosis.code,
          diagnosis.name,
          diagnosis.name,
        ] as const)
    for (const diagnosis of diagnosisCatalog) {
      insertDiagnosisCatalog.run(input.workspaceId, input.epoch, ...diagnosis)
    }
    const insertLot = this.#database.driver.prepare(`
      INSERT INTO inventory_lot (
        workspace_id, epoch, lot_id, medication_id, location_id,
        lot_number, expires_on, quantity_on_hand, version
      ) VALUES (?, ?, ?, ?, 'location-pharmacist', ?, ?, ?, 1)
    `)
    const inventory = blueprint.inventory ?? [{
      expiresOn: '2027-12-31',
      itemId: 'medication-oseltamivir',
      lotId: 'lot-oseltamivir-202608',
      lotNumber: 'SYN-OSE-202608',
      quantity: 1_000,
    }, {
      expiresOn: '2027-12-31',
      itemId: 'medication-acetaminophen',
      lotId: 'lot-acetaminophen-202608',
      lotNumber: 'SYN-ACE-202608',
      quantity: 1_000,
    }]
    for (const lot of inventory) {
      insertLot.run(
        input.workspaceId,
        input.epoch,
        lot.lotId,
        lot.itemId,
        'lotNumber' in lot ? lot.lotNumber : lot.lotId,
        lot.expiresOn,
        lot.quantity,
      )
    }
    this.#seedFhirResources(input)
    const insertVirtualPatient = this.#database.driver.prepare(`
      INSERT INTO virtual_patient (
        workspace_id, epoch, virtual_patient_id, version, patient_id,
        clinical_summary_json, available
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
    `)
    const insertQuestionRule = this.#database.driver.prepare(`
      INSERT INTO virtual_patient_question_rule (
        workspace_id, epoch, virtual_patient_id, question_code,
        rule_version, ordinal, question_text, answer_text,
        fact_code, revealed_answer_text, second_ask_answer_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const patient of blueprint.virtualPatients) {
      insertVirtualPatient.run(
        input.workspaceId,
        input.epoch,
        patient.id,
        patient.version,
        patient.patientId,
        JSON.stringify(patient.presentation),
      )
      for (const question of patient.questions) {
        insertQuestionRule.run(
          input.workspaceId,
          input.epoch,
          patient.id,
          question.code,
          question.version,
          question.ordinal,
          question.text,
          question.answer,
          question.factCode,
          question.revealedAnswer,
          question.secondAskAnswer ?? null,
        )
      }
    }
  }

  #seedFhirResources(input: {
    blueprint: ScenarioBlueprint
    epoch: string
    workspaceId: string
  }): void {
    const context = { epoch: input.epoch, workspaceId: input.workspaceId }
    const hospital = input.blueprint.hospital
    this.#fhir.create(context, {
      resourceType: 'Organization',
      id: 'organization-clinmesh',
      active: hospital?.active ?? true,
      identifier: [{
        system: 'https://caizongyuan.github.io/clinmesh/fhir/sid/synthetic-organization',
        value: hospital?.businessCode ?? 'CM-SYN-HOSPITAL-001',
      }],
      name: hospital?.name ?? '安康市临床仿真医院',
      alias: ['Ankang Clinical Simulation Hospital'],
    })
    const locations: Array<readonly [string, string, string]> = [
      ['location-outpatient', '门诊诊疗区', 'Outpatient clinic'] as const,
      ['location-laboratory', '合成检验科', 'Synthetic laboratory'] as const,
      ...syntheticAccounts.map(account => [
        `location-${account.roleCode}`,
        `${account.name}工作区`,
        `${account.roleCode} workspace`,
      ] as const),
    ]
    for (const [id, nameZh, nameEn] of locations) {
      this.#fhir.create(context, {
        resourceType: 'Location',
        id,
        status: 'active',
        name: nameZh,
        alias: [nameEn],
        managingOrganization: { reference: 'Organization/organization-clinmesh' },
        ...(id === 'location-outpatient'
          ? {
              type: [{
                coding: [{
                  code: 'outpatient-registration',
                  system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/location-purpose',
                }],
              }],
            }
          : {}),
      })
    }
    for (const account of syntheticAccounts) {
      this.#fhir.create(context, {
        resourceType: 'Practitioner',
        id: account.practitionerId,
        active: true,
        identifier: [{
          system: 'https://caizongyuan.github.io/clinmesh/fhir/sid/synthetic-practitioner',
          value: `CM-SYN-${account.roleCode.toUpperCase()}`,
        }],
        name: [{ text: account.name }],
      })
      this.#fhir.create(context, {
        resourceType: 'PractitionerRole',
        id: `practitioner-role-${account.roleCode}`,
        active: true,
        practitioner: { reference: `Practitioner/${account.practitionerId}` },
        organization: { reference: 'Organization/organization-clinmesh' },
        code: [{ text: account.roleCode }],
        location: [{ reference: `Location/location-${account.roleCode}` }],
      })
    }
    const medications = input.blueprint.catalog?.medications
      .filter(medication => medication.active && medication.status === 'active')
      .map(medication => ({
        code: medication.code,
        id: medication.id,
        name: medication.name,
      })) ?? [{
        id: 'medication-oseltamivir',
        code: 'OSELTAMIVIR',
        name: '磷酸奥司他韦胶囊',
      }, {
        id: 'medication-acetaminophen',
        code: 'ACETAMINOPHEN',
        name: '对乙酰氨基酚片',
      }]
    for (const medication of medications) {
      this.#fhir.create(context, {
        resourceType: 'Medication',
        id: medication.id,
        status: 'active',
        code: {
          coding: [{
            system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/synthetic-medication',
            code: medication.code,
            display: medication.name,
          }],
          text: medication.name,
        },
      })
    }
    if (input.blueprint.kind === 'candidate') {
      for (const [index, patient] of input.blueprint.virtualPatients.entries()) {
        const sequence = String(index + 1).padStart(3, '0')
        this.#fhir.create(context, {
          resourceType: 'Patient',
          id: patient.patientId,
          active: true,
          identifier: [{
            system: 'https://caizongyuan.github.io/clinmesh/fhir/sid/synthetic-patient',
            value: `MZ20260826${sequence}`,
          }],
          name: [{ text: patient.name }],
          gender: patient.gender,
          birthDate: patient.birthDate,
          extension: [{
            url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/synthetic-data',
            valueBoolean: true,
          }],
        })
        this.#seedPatientFhirHistory(context, patient)
        if (patient.priorCondition === undefined) continue
        this.#fhir.create(context, {
          resourceType: 'Condition',
          id: `candidate-prior-condition-${sequence}`,
          clinicalStatus: {
            coding: [{
              code: 'active',
              system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
            }],
          },
          code: { text: patient.priorCondition.display },
          subject: { reference: `Patient/${patient.patientId}` },
          recordedDate: patient.priorCondition.recordedDate,
        })
      }
    }
    const inventoryLots = this.#database.driver.prepare(`
      SELECT lot.lot_id, lot.lot_number, lot.expires_on, lot.quantity_on_hand,
        lot.location_id, lot.medication_id, catalog.code, catalog.name_zh
      FROM inventory_lot AS lot
      JOIN outpatient_catalog AS catalog
        ON catalog.workspace_id = lot.workspace_id
       AND catalog.epoch = lot.epoch
       AND catalog.item_id = lot.medication_id
      WHERE lot.workspace_id = ? AND lot.epoch = ?
      ORDER BY lot.lot_id
    `).all(input.workspaceId, input.epoch) as Array<{
      code: string
      expires_on: string
      location_id: string
      lot_id: string
      lot_number: string
      medication_id: string
      name_zh: string
      quantity_on_hand: number
    }>
    for (const lot of inventoryLots) {
      this.#fhir.createProjection(context, {
        resourceType: 'InventoryItem',
        id: lot.lot_id,
        identifier: [{
          system: 'https://caizongyuan.github.io/clinmesh/fhir/sid/synthetic-inventory-lot',
          value: lot.lot_number,
        }],
        status: 'active',
        category: [{ text: 'Synthetic medication lot' }],
        code: [{
          coding: [{
            system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/synthetic-medication',
            code: lot.code,
            display: lot.name_zh,
          }],
          text: lot.name_zh,
        }],
        baseUnit: {
          coding: [{ system: 'http://unitsofmeasure.org', code: '1', display: 'unit' }],
          text: 'unit',
        },
        netContent: {
          value: lot.quantity_on_hand,
          unit: 'unit',
          system: 'http://unitsofmeasure.org',
          code: '1',
        },
        instance: {
          lotNumber: lot.lot_number,
          expiry: lot.expires_on,
          location: { reference: `Location/${lot.location_id}` },
        },
        productReference: { reference: `Medication/${lot.medication_id}` },
      })
    }
    if (input.blueprint.kind !== 'density') return
    for (let index = 1; index <= 120; index += 1) {
      const sequence = String(index).padStart(3, '0')
      this.#fhir.create(context, {
        resourceType: 'Patient',
        id: `density-patient-${sequence}`,
        active: true,
        identifier: [{
          system: 'https://caizongyuan.github.io/clinmesh/fhir/sid/synthetic-patient',
          value: `CM-DENSITY-${sequence}`,
        }],
        name: [{ text: `合成密度患者${sequence}` }],
        gender: index % 2 === 0 ? 'female' : 'male',
        birthDate: `${1970 + index % 35}-06-15`,
        extension: [{
          url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/synthetic-data',
          valueBoolean: true,
        }],
      })
    }
  }

  #seedPatientFhirHistory(
    context: { epoch: string; workspaceId: string },
    patient: ScenarioVirtualPatient,
  ): void {
    for (const resource of patient.fhirHistory ?? []) {
      if (resource.resourceType === 'Encounter') {
        this.#fhir.create(context, {
          actualPeriod: resource.period,
          class: [{
            coding: [{
              code: resource.classCode,
              display: 'ambulatory',
              system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
            }],
          }],
          id: resource.id,
          resourceType: resource.resourceType,
          serviceProvider: { reference: 'Organization/organization-clinmesh' },
          status: resource.status,
          subject: { reference: `Patient/${patient.patientId}` },
        })
        continue
      }
      const encounter = 'encounterId' in resource && resource.encounterId !== undefined
        ? { encounter: { reference: `Encounter/${resource.encounterId}` } }
        : {}
      if (resource.resourceType === 'Condition') {
        this.#fhir.create(context, {
          clinicalStatus: {
            coding: [{
              code: resource.clinicalStatus,
              system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
            }],
          },
          code: {
            ...(resource.code.code === undefined
              ? {}
              : {
                  coding: [{
                    code: resource.code.code,
                    display: resource.code.display,
                    ...(resource.code.system === undefined ? {} : { system: resource.code.system }),
                  }],
                }),
            text: resource.code.display,
          },
          ...encounter,
          id: resource.id,
          ...(resource.onsetDateTime === undefined ? {} : { onsetDateTime: resource.onsetDateTime }),
          ...(resource.recordedDate === undefined ? {} : { recordedDate: resource.recordedDate }),
          resourceType: resource.resourceType,
          subject: { reference: `Patient/${patient.patientId}` },
        })
        continue
      }
      if (resource.resourceType === 'Observation') {
        const result = resource.value.outcome === 'reported'
          ? typeof resource.value.value === 'number'
            ? {
                valueQuantity: {
                  ...(resource.value.unit === undefined ? {} : { unit: resource.value.unit }),
                  value: resource.value.value,
                },
              }
            : typeof resource.value.value === 'boolean'
              ? { valueBoolean: resource.value.value }
              : { valueString: resource.value.value }
          : { valueString: resource.value.message }
        this.#fhir.create(context, {
          code: {
            ...(resource.code.code === undefined
              ? {}
              : {
                  coding: [{
                    code: resource.code.code,
                    display: resource.code.display,
                    ...(resource.code.system === undefined ? {} : { system: resource.code.system }),
                  }],
                }),
            text: resource.code.display,
          },
          ...(resource.effectiveDateTime === undefined ? {} : { effectiveDateTime: resource.effectiveDateTime }),
          ...encounter,
          id: resource.id,
          ...(resource.value.outcome !== 'reported' || resource.value.flag === undefined
            ? {}
            : {
                interpretation: [{
                  coding: [{
                    code: resource.value.flag,
                    system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
                  }],
                }],
              }),
          resourceType: resource.resourceType,
          status: resource.status,
          subject: { reference: `Patient/${patient.patientId}` },
          ...result,
        })
        continue
      }
      if (resource.resourceType === 'MedicationRequest') {
        this.#fhir.create(context, {
          ...(resource.authoredOn === undefined ? {} : { authoredOn: resource.authoredOn }),
          ...encounter,
          id: resource.id,
          intent: resource.intent,
          medication: {
            concept: {
              ...(resource.medication.code === undefined
                ? {}
                : {
                    coding: [{
                      code: resource.medication.code,
                      display: resource.medication.display,
                      ...(resource.medication.system === undefined ? {} : { system: resource.medication.system }),
                    }],
                  }),
              text: resource.medication.display,
            },
          },
          resourceType: resource.resourceType,
          status: resource.status,
          subject: { reference: `Patient/${patient.patientId}` },
        })
        continue
      }
      this.#fhir.create(context, {
        clinicalStatus: {
          coding: [{
            code: resource.clinicalStatus,
            system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
          }],
        },
        code: {
          ...(resource.code.code === undefined
            ? {}
            : {
                coding: [{
                  code: resource.code.code,
                  display: resource.code.display,
                  ...(resource.code.system === undefined ? {} : { system: resource.code.system }),
                }],
              }),
          text: resource.code.display,
        },
        id: resource.id,
        patient: { reference: `Patient/${patient.patientId}` },
        ...(resource.recordedDate === undefined ? {} : { recordedDate: resource.recordedDate }),
        resourceType: resource.resourceType,
      })
    }
  }
}
