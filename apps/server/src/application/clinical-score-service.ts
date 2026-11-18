import {
  clinicalRiskAssessmentValuesSchema,
  inpatientVitalSignsValuesSchema,
  outpatientRiskAssessmentResponseSchema,
  type ClinicalRiskAssessmentFieldsInput,
  type ClinicalRiskAssessmentRecord,
  type ClinicalRiskAssessmentValues,
  type ClinicalScoreBundle,
  type ClinicalScoreSourceReference,
  type ClinicalScoreVitalSummary,
  type EffectiveStSegmentDeviation,
  type InpatientRiskAssessmentInput,
  type InpatientVitalSignsInput,
  type InpatientVitalSignsRecord,
  type OutpatientRiskAssessmentInput,
} from '@clinmesh/contracts/clinical-scores'
import { inpatientFullClinicalResponseSchema } from '@clinmesh/contracts/inpatient-clinical'
import { investigationResultContentSchema } from '@clinmesh/contracts/scenario'
import {
  calculateCkdEpi2021Egfr,
  evaluateClinicalScores,
  type ClinicalScoreObjectiveFacts,
} from '@clinmesh/core/clinical-scores'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository, RepositoryContext } from '../infrastructure/sqlite/fhir-repository.ts'
import {
  type ActorContext,
  type CommandEffect,
  CommandExecutor,
  type CommandTransaction,
  provenanceAgents,
} from './command-executor.ts'
import { businessDate } from './inpatient-orders.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { triageRecordContentSchema, type OutpatientWorkflowContext } from './outpatient-workflow-context.ts'
import { standardMedicationSafety } from './scenario-data/standard-medications.ts'
import { WorkflowError } from './workflow-error.ts'

const RISK_ASSESSMENT_SYSTEM = 'urn:clinmesh:clinical-risk-assessment'
const ANTIHYPERTENSIVE_CLASSES = new Set([
  'acei',
  'arb',
  'arni',
  'beta-blocker',
  'calcium-channel-blocker',
  'loop-diuretic',
  'mra',
  'thiazide',
])
const ANTIHYPERTENSIVE_TEXT_PATTERN = /氨氯地平|硝苯地平|非洛地平|培哚普利|依那普利|贝那普利|雷米普利|缬沙坦|氯沙坦|厄贝沙坦|替米沙坦|奥美沙坦|沙库巴曲缬沙坦|美托洛尔|比索洛尔|卡维地洛|呋塞米|托拉塞米|螺内酯|氢氯噻嗪|吲达帕胺|amlodipine|nifedipine|perindopril|valsartan|losartan|irbesartan|telmisartan|metoprolol|bisoprolol|carvedilol|furosemide|spironolactone|hydrochlorothiazide|indapamide/i
const PURE_ANTIHYPERTENSIVE_TEXT_PATTERN = /氨氯地平|硝苯地平|非洛地平|拉西地平|氢氯噻嗪|吲达帕胺|amlodipine|nifedipine|felodipine|lacidipine|hydrochlorothiazide|indapamide|chlorthalidone/i
const LIPID_LOWERING_CLASSES = new Set([
  'cholesterol-absorption-inhibitor',
  'ezetimibe',
  'fibrate',
  'pcsk9-inhibitor',
  'statin',
])
const LIPID_LOWERING_TEXT_PATTERN =
  /他汀|阿托伐他汀|瑞舒伐他汀|辛伐他汀|匹伐他汀|普伐他汀|氟伐他汀|洛伐他汀|依折麦布|海博麦布|依洛尤单抗|阿利西尤单抗|英克司兰|血脂康|非诺贝特|吉非罗齐|苯扎贝特|statin|atorvastatin|rosuvastatin|simvastatin|pravastatin|pitavastatin|fluvastatin|lovastatin|ezetimibe|evolocumab|alirocumab|inclisiran|fenofibrate|gemfibrozil|bezafibrate/i
const LIPID_WASHOUT_MS = 28 * 86_400_000

const EMPTY_RISK_VALUES: ClinicalRiskAssessmentValues = Object.freeze({
  anginaEpisodes24h: null,
  aspirinUsedLast7Days: null,
  cardiacArrestOnAdmission: null,
  familyHistoryPrematureCad: null,
  killipClass: null,
  knownCoronaryStenosisGe50: null,
  priorBleedingHistory: null,
  smokingStatus: null,
  stSegmentDeviation: null,
})

const vitalSignsRowSchema = z.object({
  observation_id: z.string().min(1),
  observation_version: z.string().min(1),
  provenance_id: z.string().min(1),
  recorded_at: z.string().min(1),
  recorded_by: z.string().min(1),
  revision: z.number().int().positive(),
  vital_json: z.string().min(1),
})

const riskAssessmentRowSchema = z.object({
  assessment_json: z.string().min(1),
  observation_id: z.string().min(1),
  observation_version: z.string().min(1),
  provenance_id: z.string().min(1),
  recorded_at: z.string().min(1),
  recorded_by: z.string().min(1),
  revision: z.number().int().positive(),
})

const codingItemSchema = z.object({
  code: z.string().optional(),
  display: z.string().optional(),
  system: z.string().optional(),
}).loose()

const observationResourceSchema = z.object({
  category: z.array(z.object({
    coding: z.array(codingItemSchema).optional(),
  }).loose()).optional(),
  code: z.object({
    coding: z.array(codingItemSchema).optional(),
    text: z.string().optional(),
  }).loose().optional(),
  effectiveDateTime: z.string().optional(),
  encounter: z.object({ reference: z.string().optional() }).loose().optional(),
  id: z.string().min(1),
  interpretation: z.array(z.object({
    coding: z.array(codingItemSchema).optional(),
    text: z.string().optional(),
  }).loose()).optional(),
  meta: z.object({ versionId: z.string().optional() }).loose().optional(),
  referenceRange: z.array(z.object({
    high: z.object({ value: z.number().finite().optional() }).loose().optional(),
    low: z.object({ value: z.number().finite().optional() }).loose().optional(),
  }).loose()).optional(),
  specimen: z.object({ reference: z.string().optional() }).loose().optional(),
  status: z.string().optional(),
  valueBoolean: z.boolean().optional(),
  valueCodeableConcept: z.object({
    coding: z.array(codingItemSchema).optional(),
    text: z.string().optional(),
  }).loose().optional(),
  valueQuantity: z.object({
    code: z.string().optional(),
    unit: z.string().optional(),
    value: z.number().finite().optional(),
  }).loose().optional(),
  valueString: z.string().optional(),
}).loose()

const diagnosticReportResourceSchema = z.object({
  effectiveDateTime: z.string().optional(),
  id: z.string().min(1),
  issued: z.string().optional(),
  meta: z.object({ versionId: z.string().optional() }).loose().optional(),
  result: z.array(z.object({ reference: z.string().optional() }).loose()).optional(),
  status: z.string().optional(),
}).loose()

const conditionResourceSchema = z.object({
  clinicalStatus: z.object({ coding: z.array(codingItemSchema).optional() }).loose().optional(),
  code: z.object({ coding: z.array(codingItemSchema).optional(), text: z.string().optional() }).loose().optional(),
  encounter: z.object({ reference: z.string().optional() }).loose().optional(),
  id: z.string().min(1),
  identifier: z.array(z.object({ system: z.string().optional(), value: z.string().optional() }).loose()).optional(),
  meta: z.object({ versionId: z.string().optional() }).loose().optional(),
  onsetDateTime: z.string().optional(),
  onsetPeriod: z.object({ start: z.string().optional() }).loose().optional(),
  recordedDate: z.string().optional(),
  verificationStatus: z.object({ coding: z.array(codingItemSchema).optional() }).loose().optional(),
}).loose()

const procedureResourceSchema = z.object({
  code: z.object({ coding: z.array(codingItemSchema).optional(), text: z.string().optional() }).loose().optional(),
  encounter: z.object({ reference: z.string().optional() }).loose().optional(),
  id: z.string().min(1),
  meta: z.object({ versionId: z.string().optional() }).loose().optional(),
  performedDateTime: z.string().optional(),
  performedPeriod: z.object({ start: z.string().optional() }).loose().optional(),
  status: z.string().optional(),
}).loose()

const durationQuantitySchema = z.object({
  code: z.string().optional(),
  unit: z.string().optional(),
  value: z.number().finite().positive().optional(),
}).loose()

const medicationAdministrationResourceSchema = z.object({
  effectiveDateTime: z.string().optional(),
  effectivePeriod: z.object({ end: z.string().optional(), start: z.string().optional() }).loose().optional(),
  occurenceDateTime: z.string().optional(),
  occurencePeriod: z.object({ end: z.string().optional(), start: z.string().optional() }).loose().optional(),
  occurrenceDateTime: z.string().optional(),
  occurrencePeriod: z.object({ end: z.string().optional(), start: z.string().optional() }).loose().optional(),
  recorded: z.string().optional(),
  status: z.string().optional(),
}).loose()

const medicationDispenseResourceSchema = z.object({
  daysSupply: durationQuantitySchema.optional(),
  status: z.string().optional(),
  whenHandedOver: z.string().optional(),
  whenPrepared: z.string().optional(),
}).loose()

function findLatestSameSpecimenTcHdlPair<
  TTc extends { source: ClinicalScoreSourceReference; specimenKey: string; value: { unit: string; value: number } },
  THdl extends { source: ClinicalScoreSourceReference; specimenKey: string; value: { unit: string; value: number } },
>(
  tcChronological: readonly TTc[],
  hdlChronological: readonly THdl[],
): { hdl: THdl; tc: TTc } | undefined {
  const latestHdlBySpecimen = new Map<string, THdl>()
  for (const hdl of hdlChronological) {
    latestHdlBySpecimen.set(hdl.specimenKey, hdl)
  }
  for (let i = tcChronological.length - 1; i >= 0; i--) {
    const tc = tcChronological[i]!
    const hdl = latestHdlBySpecimen.get(tc.specimenKey)
    if (hdl !== undefined) {
      return { hdl, tc }
    }
  }
  return undefined
}

const medicationRequestResourceSchema = z.object({
  authoredOn: z.string().optional(),
  dispenseRequest: z.object({
    expectedSupplyDuration: durationQuantitySchema.optional(),
    validityPeriod: z.object({ end: z.string().optional(), start: z.string().optional() }).loose().optional(),
  }).loose().optional(),
  dosageInstruction: z.array(z.object({
    timing: z.object({
      repeat: z.object({
        boundsDuration: durationQuantitySchema.optional(),
        boundsPeriod: z.object({ end: z.string().optional(), start: z.string().optional() }).loose().optional(),
      }).loose().optional(),
    }).loose().optional(),
  }).loose()).optional(),
  effectiveDosePeriod: z.object({ end: z.string().optional(), start: z.string().optional() }).loose().optional(),
  encounter: z.object({ reference: z.string().optional() }).loose().optional(),
  id: z.string().min(1),
  medication: z.object({
    concept: z.object({ coding: z.array(codingItemSchema).optional(), text: z.string().optional() }).loose().optional(),
    reference: z.object({ display: z.string().optional(), reference: z.string().optional() }).loose().optional(),
  }).loose().optional(),
  meta: z.object({ versionId: z.string().optional() }).loose().optional(),
  reason: z.array(z.object({
    concept: z.object({ coding: z.array(codingItemSchema).optional(), text: z.string().optional() }).loose().optional(),
    reference: z.object({ reference: z.string().optional() }).loose().optional(),
  }).loose()).optional(),
  status: z.string().optional(),
  statusChanged: z.string().optional(),
}).loose()

function completedAgeYears(birthDate: string | undefined, referenceDate: string): number | undefined {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return undefined
  const [by, bm, bd] = birthDate.split('-').map(Number)
  const [ry, rm, rd] = referenceDate.split('-').map(Number)
  if (by === undefined || bm === undefined || bd === undefined || ry === undefined || rm === undefined || rd === undefined) return undefined
  let age = ry - by
  if (rm < bm || (rm === bm && rd < bd)) age -= 1
  return age >= 0 && age <= 130 ? age : undefined
}

function mergeRiskValues(
  previous: ClinicalRiskAssessmentValues,
  patch: ClinicalRiskAssessmentFieldsInput,
): ClinicalRiskAssessmentValues {
  return {
    anginaEpisodes24h: patch.anginaEpisodes24h === undefined ? previous.anginaEpisodes24h : patch.anginaEpisodes24h,
    aspirinUsedLast7Days: patch.aspirinUsedLast7Days === undefined ? previous.aspirinUsedLast7Days : patch.aspirinUsedLast7Days,
    cardiacArrestOnAdmission: patch.cardiacArrestOnAdmission === undefined ? previous.cardiacArrestOnAdmission : patch.cardiacArrestOnAdmission,
    familyHistoryPrematureCad: patch.familyHistoryPrematureCad === undefined ? previous.familyHistoryPrematureCad : patch.familyHistoryPrematureCad,
    killipClass: patch.killipClass === undefined ? previous.killipClass : patch.killipClass,
    knownCoronaryStenosisGe50: patch.knownCoronaryStenosisGe50 === undefined ? previous.knownCoronaryStenosisGe50 : patch.knownCoronaryStenosisGe50,
    priorBleedingHistory: patch.priorBleedingHistory === undefined ? previous.priorBleedingHistory : patch.priorBleedingHistory,
    smokingStatus: patch.smokingStatus === undefined ? previous.smokingStatus : patch.smokingStatus,
    stSegmentDeviation: patch.stSegmentDeviation === undefined ? previous.stSegmentDeviation : patch.stSegmentDeviation,
  }
}

export function buildVitalObservationComponents(vitals: {
  bloodPressure: { diastolicMmHg: number; systolicMmHg: number }
  heightCm?: number | undefined
  oxygenSaturationPct: number
  pulseBpm: number
  respirationBpm: number
  temperatureC: number
  weightKg?: number | undefined
}) {
  return [
    { code: { coding: [{ code: '8310-5', system: 'http://loinc.org' }] }, valueQuantity: { code: 'Cel', system: 'http://unitsofmeasure.org', unit: '°C', value: vitals.temperatureC } },
    { code: { coding: [{ code: '8867-4', system: 'http://loinc.org' }] }, valueQuantity: { code: '/min', system: 'http://unitsofmeasure.org', unit: '/min', value: vitals.pulseBpm } },
    { code: { coding: [{ code: '9279-1', system: 'http://loinc.org' }] }, valueQuantity: { code: '/min', system: 'http://unitsofmeasure.org', unit: '/min', value: vitals.respirationBpm } },
    { code: { coding: [{ code: '8480-6', system: 'http://loinc.org' }] }, valueQuantity: { code: 'mm[Hg]', system: 'http://unitsofmeasure.org', unit: 'mmHg', value: vitals.bloodPressure.systolicMmHg } },
    { code: { coding: [{ code: '8462-4', system: 'http://loinc.org' }] }, valueQuantity: { code: 'mm[Hg]', system: 'http://unitsofmeasure.org', unit: 'mmHg', value: vitals.bloodPressure.diastolicMmHg } },
    { code: { coding: [{ code: '59408-5', system: 'http://loinc.org' }] }, valueQuantity: { code: '%', system: 'http://unitsofmeasure.org', unit: '%', value: vitals.oxygenSaturationPct } },
    ...(vitals.weightKg === undefined
      ? []
      : [{ code: { coding: [{ code: '29463-7', system: 'http://loinc.org' }] }, valueQuantity: { code: 'kg', system: 'http://unitsofmeasure.org', unit: 'kg', value: vitals.weightKg } }]),
    ...(vitals.heightCm === undefined
      ? []
      : [{ code: { coding: [{ code: '8302-2', system: 'http://loinc.org' }] }, valueQuantity: { code: 'cm', system: 'http://unitsofmeasure.org', unit: 'cm', value: vitals.heightCm } }]),
  ]
}

function buildRiskObservationComponents(values: ClinicalRiskAssessmentValues) {
  const components: Array<Record<string, unknown>> = []
  if (values.killipClass !== null) {
    components.push({
      code: { coding: [{ code: 'killip-class', system: RISK_ASSESSMENT_SYSTEM }] },
      valueCodeableConcept: { coding: [{ code: values.killipClass, system: RISK_ASSESSMENT_SYSTEM }], text: `Killip ${values.killipClass}` },
    })
  }
  if (values.cardiacArrestOnAdmission !== null) {
    components.push({
      code: { coding: [{ code: 'cardiac-arrest-on-admission', system: RISK_ASSESSMENT_SYSTEM }] },
      valueBoolean: values.cardiacArrestOnAdmission,
    })
  }
  if (values.anginaEpisodes24h !== null) {
    components.push({
      code: { coding: [{ code: 'angina-episodes-24h', system: RISK_ASSESSMENT_SYSTEM }] },
      valueInteger: values.anginaEpisodes24h,
    })
  }
  if (values.stSegmentDeviation !== null) {
    components.push({
      code: { coding: [{ code: 'st-segment-deviation-bedside', system: RISK_ASSESSMENT_SYSTEM }] },
      valueBoolean: values.stSegmentDeviation,
    })
  }
  if (values.aspirinUsedLast7Days !== null) {
    components.push({
      code: { coding: [{ code: 'aspirin-used-last-7-days', system: RISK_ASSESSMENT_SYSTEM }] },
      valueBoolean: values.aspirinUsedLast7Days,
    })
  }
  if (values.smokingStatus !== null) {
    components.push({
      code: { coding: [{ code: 'smoking-status', system: RISK_ASSESSMENT_SYSTEM }] },
      valueCodeableConcept: { coding: [{ code: values.smokingStatus, system: RISK_ASSESSMENT_SYSTEM }], text: values.smokingStatus },
    })
  }
  if (values.priorBleedingHistory !== null) {
    components.push({
      code: { coding: [{ code: 'prior-bleeding-history', system: RISK_ASSESSMENT_SYSTEM }], text: '既往自发性出血史' },
      valueCodeableConcept: { coding: [{ code: values.priorBleedingHistory, system: RISK_ASSESSMENT_SYSTEM }], text: values.priorBleedingHistory },
    })
  }
  if (values.familyHistoryPrematureCad !== null) {
    components.push({
      code: { coding: [{ code: 'family-history-premature-cad', system: RISK_ASSESSMENT_SYSTEM }], text: '早发冠心病家族史' },
      valueBoolean: values.familyHistoryPrematureCad,
    })
  }
  if (values.knownCoronaryStenosisGe50 !== null) {
    components.push({
      code: { coding: [{ code: 'known-coronary-stenosis-ge50', system: RISK_ASSESSMENT_SYSTEM }], text: '已知冠脉狭窄 ≥50%' },
      valueBoolean: values.knownCoronaryStenosisGe50,
    })
  }
  return components
}

function extractEncounterStartIso(rawEncounter: unknown): string | undefined {
  const parsed = z.object({
    actualPeriod: z.object({ start: z.string().optional() }).loose().optional(),
    period: z.object({ start: z.string().optional() }).loose().optional(),
    plannedStartDate: z.string().optional(),
  }).loose().safeParse(rawEncounter)
  if (!parsed.success) return undefined
  return parsed.data.actualPeriod?.start ?? parsed.data.period?.start ?? parsed.data.plannedStartDate
}

function extractEncounterEndIso(rawEncounter: unknown): string | undefined {
  const parsed = z.object({
    actualPeriod: z.object({ end: z.string().optional() }).loose().optional(),
    period: z.object({ end: z.string().optional() }).loose().optional(),
  }).loose().safeParse(rawEncounter)
  if (!parsed.success) return undefined
  return parsed.data.actualPeriod?.end ?? parsed.data.period?.end
}

function normalizeCutoffIso(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T23:59:59.999+08:00` : iso
}

function parseResourceTimestampMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? Date.parse(`${iso}T00:00:00+08:00`) : Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : undefined
}

function hasPositiveStDeviationText(text: string): boolean {
  const positivePattern = /ST\s*段?\s*(?:抬高|压低|下移|上抬|偏移|移位)|ST[- ]?(?:segment\s*)?(?:elevation|depression|deviation)/gi
  for (const clause of text.split(/[，。；,;！!\r\n]+/)) {
    const trimmed = clause.trim()
    if (!trimmed) continue
    for (const stMatch of trimmed.matchAll(positivePattern)) {
      const idx = stMatch.index ?? 0
      const prefix = trimmed.slice(0, idx)
      const negMatches = [...prefix.matchAll(/(?:无|未见|否认|排除|\bno\b|\bwithout\b)/gi)]
      const lastNeg = negMatches.at(-1)
      if (lastNeg !== undefined) {
        const between = prefix.slice(lastNeg.index ?? 0)
        if (!/(?:但|而|可见|伴|提示|呈|\bbut\b|\bwith\b)/i.test(between)) {
          continue
        }
      }
      return true
    }
  }
  return false
}

const FHIR_DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  a: 365.25 * 86_400_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  millisecond: 1,
  milliseconds: 1,
  min: 60_000,
  minute: 60_000,
  minutes: 60_000,
  mo: 30.4375 * 86_400_000,
  month: 30.4375 * 86_400_000,
  months: 30.4375 * 86_400_000,
  ms: 1,
  s: 1_000,
  sec: 1_000,
  second: 1_000,
  seconds: 1_000,
  w: 7 * 86_400_000,
  week: 7 * 86_400_000,
  weeks: 7 * 86_400_000,
  wk: 7 * 86_400_000,
  y: 365.25 * 86_400_000,
  year: 365.25 * 86_400_000,
  years: 365.25 * 86_400_000,
  yr: 365.25 * 86_400_000,
}

function resolveMedicationBoundsDurationMs(
  bounds: { code?: string | undefined; unit?: string | undefined; value?: number | undefined } | undefined,
): number | 'invalid' | undefined {
  if (bounds?.value === undefined) return undefined
  if (!Number.isFinite(bounds.value) || bounds.value <= 0) return 'invalid'
  const rawUnit = (bounds.code ?? bounds.unit ?? '').trim().toLowerCase()
  const multiplierMs = FHIR_DURATION_UNIT_MS[rawUnit]
  if (multiplierMs === undefined) return 'invalid'
  return bounds.value * multiplierMs
}

function countClusteredEventDays(days: readonly string[]): number {
  const sorted = [...new Set(days)].sort()
  let clusters = 0
  let anchorMs: number | undefined
  for (const day of sorted) {
    const ms = Date.parse(day)
    if (!Number.isFinite(ms)) continue
    if (anchorMs === undefined || (ms - anchorMs) / 86_400_000 > 28) {
      clusters += 1
      anchorMs = ms
    }
  }
  return clusters
}

function hasPositiveStElevationText(text: string): boolean {
  const positivePattern = /ST\s*段?\s*(?:抬高|上抬|弓背向上)|ST[- ]?(?:segment\s*)?elevation/gi
  for (const clause of text.split(/[，。；,;！!\r\n]+/)) {
    const trimmed = clause.trim()
    if (!trimmed) continue
    for (const stMatch of trimmed.matchAll(positivePattern)) {
      const idx = stMatch.index ?? 0
      const prefix = trimmed.slice(0, idx)
      if (/(?:非|non[- ]?)\s*$/i.test(prefix)) continue
      const negMatches = [...prefix.matchAll(/(?:无|未见|否认|排除|\bno\b|\bwithout\b)/gi)]
      const lastNeg = negMatches.at(-1)
      if (lastNeg !== undefined) {
        const between = prefix.slice(lastNeg.index ?? 0)
        if (!/(?:但|而|可见|伴|提示|呈|\bbut\b|\bwith\b)/i.test(between)) {
          continue
        }
      }
      return true
    }
  }
  return false
}

function isExplicitNormalStLead(value: unknown, interpretation?: string): boolean {
  if (typeof value !== 'string') return false
  if (interpretation === 'abnormal' || interpretation === 'high' || interpretation === 'low' || interpretation === 'critical') return false
  const trimmed = value.trim()
  if (!trimmed || hasPositiveStDeviationText(trimmed)) return false
  return /^(?:未见明显异常|正常|大致正常|(?:未见|无|否认)(?:明显)?\s*ST(?:[- ]?T|\s*段)?(?:\s*(?:改变|异常|抬高|压低|下移|上抬|偏移|移位|或|及|、|ST(?:\s*段)?))+)$/i.test(trimmed)
}

export class ClinicalScoreService {
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #fhir: FhirRepository
  readonly #outpatientContext: OutpatientWorkflowContext

  constructor(options: {
    commands: CommandExecutor
    database: ClinMeshDatabase
    fhir: FhirRepository
    outpatientContext: OutpatientWorkflowContext
  }) {
    this.#commands = options.commands
    this.#database = options.database
    this.#fhir = options.fhir
    this.#outpatientContext = options.outpatientContext
  }

  initialInpatientVitalSigns(
    context: Pick<RepositoryContext, 'workspaceId' | 'epoch'>,
    admissionId: string,
  ): InpatientVitalSignsRecord | undefined {
    return this.#readInpatientVitalSignsByOrder(context, admissionId, 'ASC')
  }

  initialInpatientVitalSignsWithWeight(
    context: Pick<RepositoryContext, 'workspaceId' | 'epoch'>,
    admissionId: string,
  ): InpatientVitalSignsRecord | undefined {
    return this.#readInpatientVitalSignsByOrder(context, admissionId, 'ASC', 'weightKg')
  }

  latestInpatientVitalSigns(
    context: Pick<RepositoryContext, 'workspaceId' | 'epoch'>,
    admissionId: string,
  ): InpatientVitalSignsRecord | undefined {
    return this.#readInpatientVitalSignsByOrder(context, admissionId, 'DESC')
  }

  latestInpatientVitalSignsWithHeight(
    context: Pick<RepositoryContext, 'workspaceId' | 'epoch'>,
    admissionId: string,
  ): InpatientVitalSignsRecord | undefined {
    return this.#readInpatientVitalSignsByOrder(context, admissionId, 'DESC', 'heightCm')
  }

  latestInpatientVitalSignsWithWeight(
    context: Pick<RepositoryContext, 'workspaceId' | 'epoch'>,
    admissionId: string,
  ): InpatientVitalSignsRecord | undefined {
    return this.#readInpatientVitalSignsByOrder(context, admissionId, 'DESC', 'weightKg')
  }

  #readInpatientVitalSignsByOrder(
    context: Pick<RepositoryContext, 'workspaceId' | 'epoch'>,
    admissionId: string,
    direction: 'ASC' | 'DESC',
    requiredField?: 'weightKg' | 'heightCm',
  ): InpatientVitalSignsRecord | undefined {
    const weightClause =
      requiredField === 'weightKg'
        ? "AND json_extract(vital_json, '$.weightKg') IS NOT NULL"
        : requiredField === 'heightCm'
          ? "AND json_extract(vital_json, '$.heightCm') IS NOT NULL"
          : ''
    const row = vitalSignsRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT revision, vital_json, observation_id, observation_version, provenance_id, recorded_at, recorded_by
        FROM inpatient_vital_signs
        WHERE workspace_id = ? AND epoch = ? AND admission_id = ?
          ${weightClause}
        ORDER BY revision ${direction}
        LIMIT 1
      `).get(context.workspaceId, context.epoch, admissionId),
    )
    if (row === undefined) return undefined
    const parsed = inpatientVitalSignsValuesSchema.parse(JSON.parse(row.vital_json))
    return {
      bloodPressure: parsed.bloodPressure,
      ...(parsed.heightCm === undefined ? {} : { heightCm: parsed.heightCm }),
      observationId: row.observation_id,
      observationVersion: row.observation_version,
      oxygenSaturationPct: parsed.oxygenSaturationPct,
      provenanceId: row.provenance_id,
      pulseBpm: parsed.pulseBpm,
      recordedAt: row.recorded_at,
      recordedBy: row.recorded_by,
      respirationBpm: parsed.respirationBpm,
      revision: row.revision,
      temperatureC: parsed.temperatureC,
      ...(parsed.weightKg === undefined ? {} : { weightKg: parsed.weightKg }),
    }
  }

  latestRiskAssessment(
    context: RepositoryContext,
    caseId: string,
  ): ClinicalRiskAssessmentRecord {
    const row = riskAssessmentRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT revision, assessment_json, observation_id, observation_version, provenance_id, recorded_at, recorded_by
        FROM clinical_risk_assessment
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        ORDER BY revision DESC
        LIMIT 1
      `).get(context.workspaceId, context.epoch, caseId),
    )
    const values = row === undefined
      ? { ...EMPTY_RISK_VALUES }
      : clinicalRiskAssessmentValuesSchema.parse(JSON.parse(row.assessment_json))
    const effectiveStSegmentDeviation = this.#resolveEffectiveStDeviation(
      context,
      caseId,
      values,
      row === undefined ? null : { observationId: row.observation_id, observationVersion: row.observation_version },
    )
    return {
      effectiveStSegmentDeviation,
      observationId: row?.observation_id ?? null,
      observationVersion: row?.observation_version ?? null,
      provenanceId: row?.provenance_id ?? null,
      recordedAt: row?.recorded_at ?? null,
      recordedBy: row?.recorded_by ?? null,
      revision: row?.revision ?? 0,
      values,
    }
  }

  recordOutpatientRiskAssessment(input: {
    context: ActorContext
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
    payload: OutpatientRiskAssessmentInput
  }) {
    const parsedInput = input.payload
    return this.#commands.execute({
      context: input.context,
      dataSchema: outpatientRiskAssessmentResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId, ...parsedInput },
      operation: 'encounter.risk-assessment.record',
    }, transaction => {
      this.#outpatientContext.assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#outpatientContext.caseByEncounter(input.context, input.encounterId)
      this.#outpatientContext.assertCaseResponsibility(input.context, outpatientCase.case_id)
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
      if (encounter.status !== 'in-progress' || outpatientCase.status === 'completed') {
        throw new WorkflowError('WORKFLOW_CONFLICT', '当前门诊就诊不可修改专病风险评估')
      }
      this.#outpatientContext.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const now = this.#outpatientContext.virtualTime(input.context)
      const { effects, record } = this.#persistRiskAssessment(transaction, input.context, {
        caseId: outpatientCase.case_id,
        encounterId: outpatientCase.encounter_id,
        expectedRevision: parsedInput.expectedRevision,
        fields: parsedInput.fields,
        now,
        onConflict: () => {
          throw new WorkflowError('WORKFLOW_CONFLICT', '专病风险评估修订号已变化，请刷新后重试')
        },
        patientId: outpatientCase.patient_id,
      })
      return {
        data: {
          encounterVersion: encounter.meta?.versionId ?? '1',
          riskAssessment: record,
        },
        effects,
      }
    })
  }

  recordInpatientVitalSigns(
    inpatient: InpatientService,
    context: ActorContext,
    input: InpatientVitalSignsInput,
    idempotencyKey: string,
  ) {
    return inpatient.commands.execute({
      authorize: () => {
        inpatient.assertRole(context, ['ward-nurse', 'inpatient-doctor'])
        inpatient.admissionBinding(context, input.admissionId)
      },
      context,
      dataSchema: inpatientFullClinicalResponseSchema.shape.data,
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion },
      idempotencyKey,
      input,
      operation: 'inpatient.vital-signs.record',
    }, transaction => {
      inpatient.assertNotArchived(context, input.admissionId)
      const admission = inpatient.detail(context, input.admissionId).admission
      if (!['admitted', 'discharge-pending'].includes(admission.status)) {
        throw new InpatientError('INPATIENT_STATE_CONFLICT', '患者当前不在床，不能录入护理生命体征')
      }
      const previous = this.latestInpatientVitalSigns(context, input.admissionId)
      const currentRevision = previous?.revision ?? 0
      if (currentRevision !== input.expectedRevision) {
        throw new InpatientError('INPATIENT_VITAL_SIGNS_CONFLICT', '护理生命体征修订号已变化，请刷新后重试')
      }
      const now = inpatient.virtualTime(context)
      const effects: CommandEffect[] = []
      const values = {
        bloodPressure: input.bloodPressure,
        ...(input.heightCm === undefined ? {} : { heightCm: input.heightCm }),
        oxygenSaturationPct: input.oxygenSaturationPct,
        pulseBpm: input.pulseBpm,
        respirationBpm: input.respirationBpm,
        temperatureC: input.temperatureC,
        ...(input.weightKg === undefined ? {} : { weightKg: input.weightKg }),
      }
      const observation = transaction.fhir.create(context, {
        category: [{
          coding: [{
            code: 'vital-signs',
            display: 'Vital Signs',
            system: 'http://terminology.hl7.org/CodeSystem/observation-category',
          }],
        }],
        code: { text: 'Inpatient nursing vital signs' },
        component: buildVitalObservationComponents(values),
        effectiveDateTime: now,
        encounter: { reference: `Encounter/${admission.id}` },
        id: uuidv7(),
        performer: context.practitionerId === undefined ? [] : [{ reference: `Practitioner/${context.practitionerId}` }],
        resourceType: 'Observation',
        status: 'final',
        subject: { reference: `Patient/${admission.patientId}` },
      })
      const observationVersion = observation.meta?.versionId ?? '1'
      effects.push({ kind: 'created', reference: `Observation/${observation.id}`, versionId: observationVersion })

      const provenance = transaction.fhir.createImmutable(context, {
        activity: { text: previous === undefined ? 'Inpatient nursing vital signs recording' : 'Inpatient nursing vital signs revision' },
        agent: provenanceAgents(context, 'Inpatient vital signs recorder'),
        ...(previous === undefined ? {} : { entity: [{ role: 'revision', what: { reference: `Observation/${previous.observationId}` } }] }),
        id: uuidv7(),
        recorded: now,
        resourceType: 'Provenance',
        target: [{ reference: `Observation/${observation.id}` }],
      })
      effects.push({
        kind: 'created',
        reference: `Provenance/${provenance.id}`,
        versionId: provenance.meta?.versionId ?? '1',
      })

      this.#database.driver.prepare(`
        INSERT INTO inpatient_vital_signs (
          workspace_id, epoch, admission_id, revision, vital_json,
          observation_id, observation_version, provenance_id, recorded_at, recorded_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        context.workspaceId,
        context.epoch,
        admission.id,
        currentRevision + 1,
        JSON.stringify(values),
        observation.id,
        observationVersion,
        provenance.id,
        now,
        context.actorId,
      )
      return { data: inpatient.orders.read(context, admission.id), effects }
    })
  }

  recordInpatientRiskAssessment(
    inpatient: InpatientService,
    context: ActorContext,
    input: InpatientRiskAssessmentInput,
    idempotencyKey: string,
  ) {
    return inpatient.commands.execute({
      authorize: () => {
        inpatient.assertRole(context, ['inpatient-doctor', 'ward-nurse'])
        inpatient.admissionBinding(context, input.admissionId)
      },
      context,
      dataSchema: inpatientFullClinicalResponseSchema.shape.data,
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion },
      idempotencyKey,
      input,
      operation: 'inpatient.risk-assessment.record',
    }, transaction => {
      inpatient.assertNotArchived(context, input.admissionId)
      const admission = inpatient.detail(context, input.admissionId).admission
      if (!['admitted', 'discharge-pending'].includes(admission.status)) {
        throw new InpatientError('INPATIENT_STATE_CONFLICT', '患者当前状态不能修改住院专病风险评估')
      }
      const now = inpatient.virtualTime(context)
      const { effects } = this.#persistRiskAssessment(transaction, context, {
        caseId: admission.id,
        encounterId: admission.id,
        expectedRevision: input.expectedRevision,
        fields: input.fields,
        now,
        onConflict: () => {
          throw new InpatientError('INPATIENT_RISK_ASSESSMENT_CONFLICT', '专病风险评估修订号已变化，请刷新后重试')
        },
        patientId: admission.patientId,
      })
      return { data: inpatient.orders.read(context, admission.id), effects }
    })
  }

  readOutpatientClinicalScores(context: ActorContext, caseId: string): ClinicalScoreBundle {
    let bundle: ClinicalScoreBundle
    try {
      bundle = this.outpatientSnapshot(context, caseId)
    } catch (error) {
      try { this.#commands.auditRead(context, 'doctor.case.clinical-scores.read', { caseId }, 'failed') } catch { /* preserve original error */ }
      throw error
    }
    this.#commands.auditRead(context, 'doctor.case.clinical-scores.read', { caseId }, 'success')
    return bundle
  }

  readInpatientClinicalScores(inpatient: InpatientService, context: ActorContext, admissionId: string): ClinicalScoreBundle {
    let bundle: ClinicalScoreBundle
    try {
      bundle = this.inpatientSnapshot(inpatient, context, admissionId)
    } catch (error) {
      try { inpatient.commands.auditRead(context, 'inpatient.clinical-scores.read', { admissionId }, 'failed') } catch { /* preserve original error */ }
      throw error
    }
    inpatient.commands.auditRead(context, 'inpatient.clinical-scores.read', { admissionId }, 'success')
    return bundle
  }

  outpatientSnapshot(context: ActorContext, caseId: string, referenceCutoffIso?: string): ClinicalScoreBundle {
    this.#outpatientContext.requireDoctorCase(context, caseId)
    this.#outpatientContext.assertCaseResponsibility(context, caseId)
    const row = z.object({
      case_id: z.string(),
      diagnostic_report_id: z.string().nullable(),
      encounter_id: z.string(),
      patient_id: z.string(),
      triage_observation_id: z.string().nullable(),
      triage_observation_version: z.string().nullable(),
      triage_recorded_at: z.string().nullable(),
      visit_date: z.string().nullable(),
      vital_json: z.string().nullable(),
    }).optional().parse(
      this.#database.driver.prepare(`
        SELECT outpatient_case.case_id, outpatient_case.patient_id, outpatient_case.encounter_id,
          outpatient_case.diagnostic_report_id, registration.visit_date,
          triage.vital_json, triage.recorded_at AS triage_recorded_at,
          triage.observation_id AS triage_observation_id, triage.observation_version AS triage_observation_version
        FROM outpatient_case
        LEFT JOIN registration
          ON registration.workspace_id = outpatient_case.workspace_id
         AND registration.epoch = outpatient_case.epoch
         AND registration.registration_id = outpatient_case.registration_id
        LEFT JOIN triage_record AS triage
          ON triage.workspace_id = outpatient_case.workspace_id
         AND triage.epoch = outpatient_case.epoch
         AND triage.case_id = outpatient_case.case_id
        WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ? AND outpatient_case.case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
    if (row === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The outpatient case was not found')
    const encounter = this.#fhir.read(context, 'Encounter', row.encounter_id)
    const virtualNow = this.#outpatientContext.virtualTime(context)
    const isArchivedCutoff = encounter.status === 'completed'
    const derivedCutoffIso =
      isArchivedCutoff
        ? (extractEncounterEndIso(encounter) ?? (row.visit_date ? `${row.visit_date}T23:59:59.999+08:00` : virtualNow))
        : virtualNow
    const now = normalizeCutoffIso(referenceCutoffIso ?? derivedCutoffIso)
    let vitalSummary: ClinicalScoreVitalSummary | null = null
    if (row.vital_json !== null && row.triage_recorded_at !== null) {
      const triage = triageRecordContentSchema.parse(JSON.parse(row.vital_json))
      const triageObservation = this.#resolveTriageVitalObservation(
        context,
        row.patient_id,
        row.encounter_id,
        row.triage_recorded_at,
        row.triage_observation_id,
        row.triage_observation_version,
      )
      vitalSummary = {
        bloodPressure: triage.bloodPressure,
        ...(triage.heightCm === undefined ? {} : { heightCm: triage.heightCm }),
        observationId: triageObservation?.id ?? `triage-${row.case_id}`,
        observationVersion: triageObservation?.versionId ?? '1',
        oxygenSaturationPct: triage.oxygenSaturationPct,
        pulseBpm: triage.pulseBpm,
        recordedAt: row.triage_recorded_at,
        respirationBpm: triage.respirationBpm,
        temperatureC: triage.temperatureC,
        ...(triage.weightKg === undefined ? {} : { weightKg: triage.weightKg }),
      }
    }
    const presentationIso = extractEncounterStartIso(encounter) ?? row.triage_recorded_at ?? now
    return this.#evaluateSnapshot(context, {
      caseId: row.case_id,
      encounterId: row.encounter_id,
      encounterVersion: encounter.meta?.versionId ?? '1',
      evaluatedAt: virtualNow,
      inpatient: undefined,
      inpatientTimingGate: undefined,
      isArchivedCutoff,
      legacyDiagnosticReportId: row.diagnostic_report_id,
      now,
      patientId: row.patient_id,
      presentationIso,
      vitalSummary,
    })
  }

  inpatientSnapshot(
    inpatient: InpatientService,
    context: ActorContext,
    admissionId: string,
    referenceTimeIso?: string,
  ): ClinicalScoreBundle {
    inpatient.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
    const binding = inpatient.readAdmissionBinding(context, admissionId)
    const encounter = this.#fhir.read(context, 'Encounter', admissionId)
    const virtualNow = inpatient.virtualTime(context)
    const departureIso = inpatient.discharge.activeDeparture(context, admissionId)?.virtualTime
    const isArchivedCutoff =
      departureIso !== undefined || binding.status === 'departed' || binding.status === 'cleared'
    const departedAt = isArchivedCutoff ? (departureIso ?? extractEncounterEndIso(encounter)) : undefined
    const now = normalizeCutoffIso(referenceTimeIso ?? departedAt ?? virtualNow)
    const admTiming = z.object({
      admitted_at: z.string().nullable(),
      registered_at: z.string(),
    }).optional().parse(
      this.#database.driver.prepare(`
        SELECT admitted_at, registered_at
        FROM inpatient_admission
        WHERE workspace_id = ? AND epoch = ? AND admission_id = ?
      `).get(context.workspaceId, context.epoch, admissionId),
    )
    const admissionAnchorIso = admTiming?.admitted_at ?? extractEncounterStartIso(encounter) ?? admTiming?.registered_at
    const admissionAnchorMs = parseResourceTimestampMs(admissionAnchorIso)

    const surgeryExecRows = z.array(z.object({ performed_at: z.string() })).parse(
      this.#database.driver.prepare(`
        SELECT performed_at FROM inpatient_surgery_execution
        WHERE workspace_id = ? AND epoch = ? AND admission_id = ?
      `).all(context.workspaceId, context.epoch, admissionId),
    )
    let earliestSurgeryMs: number | undefined
    for (const row of surgeryExecRows) {
      const ms = parseResourceTimestampMs(row.performed_at)
      if (ms !== undefined && (earliestSurgeryMs === undefined || ms < earliestSurgeryMs)) {
        earliestSurgeryMs = ms
      }
    }

    const medExecRows = z.array(z.object({
      administration_id: z.string().nullable(),
      scheduled_for: z.string(),
    })).parse(
      this.#database.driver.prepare(`
        SELECT e.scheduled_for, e.administration_id
        FROM inpatient_execution e
        JOIN inpatient_order o
          ON o.workspace_id = e.workspace_id
         AND o.epoch = e.epoch
         AND o.order_id = e.order_id
        WHERE e.workspace_id = ? AND e.epoch = ? AND o.admission_id = ?
          AND o.kind = 'medication' AND e.status = 'completed'
      `).all(context.workspaceId, context.epoch, admissionId),
    )
    let earliestMedExecMs: number | undefined
    for (const exec of medExecRows) {
      let adminMs: number | undefined
      if (exec.administration_id !== null) {
        try {
          const admin = medicationAdministrationResourceSchema.safeParse(
            this.#fhir.read(context, 'MedicationAdministration', exec.administration_id),
          )
          if (admin.success) {
            adminMs = parseResourceTimestampMs(
              admin.data.occurencePeriod?.start
              ?? admin.data.occurrencePeriod?.start
              ?? admin.data.effectivePeriod?.start
              ?? admin.data.occurenceDateTime
              ?? admin.data.occurrenceDateTime
              ?? admin.data.effectiveDateTime
              ?? admin.data.recorded,
            )
          }
        } catch {
          adminMs = undefined
        }
      }
      const candidateMs = adminMs ?? parseResourceTimestampMs(exec.scheduled_for)
      if (candidateMs !== undefined && (earliestMedExecMs === undefined || candidateMs < earliestMedExecMs)) {
        earliestMedExecMs = candidateMs
      }
    }

    const ADMISSION_VITALS_MAX_DELAY_MS = 6 * 60 * 60 * 1000
    const BASELINE_MAX_DELAY_MS = 24 * 60 * 60 * 1000
    const initialVitals = this.initialInpatientVitalSigns(context, admissionId)
    const latestVitals = this.latestInpatientVitalSigns(context, admissionId)
    const initialVitalsRecordedMs = parseResourceTimestampMs(initialVitals?.recordedAt)
    const qualifiesAsAdmissionVitals =
      initialVitals !== undefined
      && initialVitalsRecordedMs !== undefined
      && (admissionAnchorMs === undefined || initialVitalsRecordedMs - admissionAnchorMs <= ADMISSION_VITALS_MAX_DELAY_MS)
      && (earliestSurgeryMs === undefined || initialVitalsRecordedMs <= earliestSurgeryMs)
      && (earliestMedExecMs === undefined || initialVitalsRecordedMs <= earliestMedExecMs)

    const initialWeightedVitals = this.initialInpatientVitalSignsWithWeight(context, admissionId)
    const initialWeightRecordedMs = parseResourceTimestampMs(initialWeightedVitals?.recordedAt)
    const qualifiesAsBaselineWeight =
      initialWeightedVitals !== undefined
      && initialWeightRecordedMs !== undefined
      && (
        earliestSurgeryMs !== undefined
          ? initialWeightRecordedMs <= earliestSurgeryMs
          : (admissionAnchorMs === undefined || initialWeightRecordedMs - admissionAnchorMs <= BASELINE_MAX_DELAY_MS)
      )
      && (earliestMedExecMs === undefined || initialWeightRecordedMs <= earliestMedExecMs)

    const toVitalSummary = (v: InpatientVitalSignsRecord | undefined): ClinicalScoreVitalSummary | null =>
      v === undefined
        ? null
        : {
            bloodPressure: v.bloodPressure,
            ...(v.heightCm === undefined ? {} : { heightCm: v.heightCm }),
            observationId: v.observationId,
            observationVersion: v.observationVersion,
            oxygenSaturationPct: v.oxygenSaturationPct,
            pulseBpm: v.pulseBpm,
            recordedAt: v.recordedAt,
            respirationBpm: v.respirationBpm,
            temperatureC: v.temperatureC,
            ...(v.weightKg === undefined ? {} : { weightKg: v.weightKg }),
          }
    const latestHeightVitals = this.latestInpatientVitalSignsWithHeight(context, admissionId)
    const latestWeightVitals = this.latestInpatientVitalSignsWithWeight(context, admissionId)
    const admissionVitalSummary = qualifiesAsAdmissionVitals ? toVitalSummary(initialVitals) : null
    const baselineWeightVitalSummary = qualifiesAsBaselineWeight ? toVitalSummary(initialWeightedVitals) : null
    const latestHeightVitalSummary = toVitalSummary(latestHeightVitals)
    const latestWeightVitalSummary = toVitalSummary(latestWeightVitals)
    const vitalSummary = toVitalSummary(latestVitals)
    const presentationIso = extractEncounterStartIso(encounter) ?? initialVitals?.recordedAt ?? now
    return this.#evaluateSnapshot(context, {
      admissionVitalSummary,
      baselineWeightVitalSummary,
      caseId: admissionId,
      latestHeightVitalSummary,
      latestWeightVitalSummary,
      encounterId: admissionId,
      encounterVersion: encounter.meta?.versionId ?? '1',
      evaluatedAt: virtualNow,
      inpatient,
      inpatientTimingGate: {
        admissionAnchorMs,
        earliestMedExecMs,
        earliestSurgeryMs,
      },
      isArchivedCutoff,
      legacyDiagnosticReportId: null,
      now,
      patientId: binding.patientId,
      presentationIso,
      vitalSummary,
    })
  }

  #persistRiskAssessment(
    transaction: CommandTransaction,
    context: ActorContext,
    options: {
      caseId: string
      encounterId: string
      expectedRevision: number
      fields: ClinicalRiskAssessmentFieldsInput
      now: string
      onConflict: () => never
      patientId: string
    },
  ): { effects: CommandEffect[]; record: ClinicalRiskAssessmentRecord } {
    const existingRow = riskAssessmentRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT revision, assessment_json, observation_id, observation_version, provenance_id, recorded_at, recorded_by
        FROM clinical_risk_assessment
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        ORDER BY revision DESC
        LIMIT 1
      `).get(context.workspaceId, context.epoch, options.caseId),
    )
    const currentRevision = existingRow?.revision ?? 0
    if (currentRevision !== options.expectedRevision) options.onConflict()
    const previousValues = existingRow === undefined
      ? { ...EMPTY_RISK_VALUES }
      : clinicalRiskAssessmentValuesSchema.parse(JSON.parse(existingRow.assessment_json))
    const nextValues = mergeRiskValues(previousValues, options.fields)

    const effects: CommandEffect[] = []
    if (existingRow !== undefined) {
      const priorObservation = transaction.fhir.read(context, 'Observation', existingRow.observation_id)
      const superseded = transaction.fhir.update(
        context,
        { ...priorObservation, status: 'entered-in-error' },
        priorObservation.meta?.versionId ?? existingRow.observation_version,
      )
      effects.push({
        kind: 'updated',
        reference: `Observation/${superseded.id}`,
        versionId: superseded.meta?.versionId ?? '2',
      })
    }

    const observation = transaction.fhir.create(context, {
      category: [{
        coding: [{
          code: 'exam',
          display: 'Exam',
          system: 'http://terminology.hl7.org/CodeSystem/observation-category',
        }],
      }],
      code: {
        coding: [{ code: 'clinical-risk-assessment', display: '专病风险评估', system: RISK_ASSESSMENT_SYSTEM }],
        text: 'Clinical Risk Assessment',
      },
      component: buildRiskObservationComponents(nextValues),
      effectiveDateTime: options.now,
      encounter: { reference: `Encounter/${options.encounterId}` },
      id: uuidv7(),
      performer: context.practitionerId === undefined ? [] : [{ reference: `Practitioner/${context.practitionerId}` }],
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: `Patient/${options.patientId}` },
    })
    const observationVersion = observation.meta?.versionId ?? '1'
    effects.push({ kind: 'created', reference: `Observation/${observation.id}`, versionId: observationVersion })

    const provenance = transaction.fhir.createImmutable(context, {
      activity: { text: existingRow === undefined ? 'Clinical risk assessment recording' : 'Clinical risk assessment revision' },
      agent: provenanceAgents(context, 'Clinical risk assessment author'),
      ...(existingRow === undefined ? {} : { entity: [{ role: 'revision', what: { reference: `Observation/${existingRow.observation_id}` } }] }),
      id: uuidv7(),
      recorded: options.now,
      resourceType: 'Provenance',
      target: [{ reference: `Observation/${observation.id}` }],
    })
    effects.push({
      kind: 'created',
      reference: `Provenance/${provenance.id}`,
      versionId: provenance.meta?.versionId ?? '1',
    })

    this.#database.driver.prepare(`
      INSERT INTO clinical_risk_assessment (
        workspace_id, epoch, case_id, revision, assessment_json,
        observation_id, observation_version, provenance_id, recorded_at, recorded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      options.caseId,
      currentRevision + 1,
      JSON.stringify(nextValues),
      observation.id,
      observationVersion,
      provenance.id,
      options.now,
      context.actorId,
    )

    return {
      effects,
      record: this.latestRiskAssessment(context, options.caseId),
    }
  }

  #resolveTriageVitalObservation(
    context: RepositoryContext,
    patientId: string,
    encounterId: string,
    triageRecordedAt: string,
    persistedObservationId: string | null,
    persistedObservationVersion: string | null,
  ): { id: string; versionId: string } | undefined {
    if (persistedObservationId !== null) {
      try {
        const obs = this.#fhir.read(context, 'Observation', persistedObservationId)
        return { id: obs.id, versionId: obs.meta?.versionId ?? persistedObservationVersion ?? '1' }
      } catch {
        return { id: persistedObservationId, versionId: persistedObservationVersion ?? '1' }
      }
    }
    const params = new URLSearchParams({ _count: '100', encounter: `Encounter/${encounterId}`, patient: `Patient/${patientId}` })
    let triageTitleFallback: { id: string; versionId: string } | undefined
    for (;;) {
      const page = this.#fhir.search(context, 'Observation', params)
      for (const resource of page.resources) {
        const parsed = observationResourceSchema.safeParse(resource)
        if (!parsed.success || parsed.data.status !== 'final') continue
        const text = parsed.data.code?.text ?? ''
        if (text === 'Outpatient triage vital signs') {
          const candidate = { id: parsed.data.id, versionId: parsed.data.meta?.versionId ?? '1' }
          if (parsed.data.effectiveDateTime === triageRecordedAt) return candidate
          triageTitleFallback ??= candidate
        }
      }
      if (page.nextCursor === undefined) break
      params.set('_cursor', page.nextCursor)
    }
    return triageTitleFallback
  }

  #buildReportRevisionIndex(context: RepositoryContext) {
    const revRows = z.array(z.object({
      diagnostic_report_id: z.string(),
      revision_of_diagnostic_report_id: z.string(),
    })).parse(
      this.#database.driver.prepare(`
        SELECT diagnostic_report_id, revision_of_diagnostic_report_id
        FROM laboratory_report_revision
        WHERE workspace_id = ? AND epoch = ?
      `).all(context.workspaceId, context.epoch),
    )
    const supersededReports = new Set<string>()
    const parentByReportId = new Map<string, string>()
    for (const row of revRows) {
      supersededReports.add(row.revision_of_diagnostic_report_id)
      parentByReportId.set(row.diagnostic_report_id, row.revision_of_diagnostic_report_id)
    }

    const rootMetaCache = new Map<string, {
      obsIsoByCode: Map<string, string>
      obsIsoByIndex: Array<string | undefined>
      reportIso: string | undefined
      rootReportId: string
    }>()

    const resolveRootMeta = (reportId: string) => {
      if (!parentByReportId.has(reportId)) return undefined
      const cached = rootMetaCache.get(reportId)
      if (cached !== undefined) return cached
      let currentId = reportId
      const seen = new Set<string>()
      while (parentByReportId.has(currentId) && !seen.has(currentId)) {
        seen.add(currentId)
        currentId = parentByReportId.get(currentId)!
      }
      const rootReportId = currentId
      let reportIso: string | undefined
      const obsIsoByIndex: Array<string | undefined> = []
      const obsIsoByCode = new Map<string, string>()
      try {
        const rootReport = diagnosticReportResourceSchema.safeParse(
          this.#fhir.read(context, 'DiagnosticReport', rootReportId),
        )
        if (rootReport.success) {
          reportIso = rootReport.data.effectiveDateTime ?? rootReport.data.issued
          for (const [idx, ref] of (rootReport.data.result ?? []).entries()) {
            const obsId = ref.reference?.startsWith('Observation/') ? ref.reference.slice('Observation/'.length) : undefined
            if (!obsId) continue
            try {
              const rootObs = observationResourceSchema.safeParse(this.#fhir.read(context, 'Observation', obsId))
              if (rootObs.success) {
                const iso = rootObs.data.effectiveDateTime ?? reportIso
                obsIsoByIndex[idx] = iso
                if (iso !== undefined) {
                  for (const coding of rootObs.data.code?.coding ?? []) {
                    if (coding.code?.trim()) {
                      obsIsoByCode.set(coding.code.trim(), iso)
                    }
                  }
                }
              }
            } catch { /* ignore unreadable historical observation */ }
          }
        }
      } catch { /* ignore unreadable historical report */ }
      if (reportIso === undefined) {
        const examRow = z.object({ issued_at: z.string().nullable() }).optional().parse(
          this.#database.driver.prepare(`
            SELECT issued_at FROM examination_report_content
            WHERE workspace_id = ? AND epoch = ? AND diagnostic_report_id = ?
          `).get(context.workspaceId, context.epoch, rootReportId),
        )
        reportIso = examRow?.issued_at ?? undefined
      }
      const entry = { obsIsoByCode, obsIsoByIndex, reportIso, rootReportId }
      rootMetaCache.set(reportId, entry)
      return entry
    }

    const resolveObservationOriginalIso = (
      reportId: string | undefined,
      resultIndex: number | undefined,
      obs: z.infer<typeof observationResourceSchema>,
      fallbackReportIso: string | undefined,
    ): string | undefined => {
      if (reportId !== undefined) {
        const rootMeta = resolveRootMeta(reportId)
        if (rootMeta !== undefined) {
          for (const coding of obs.code?.coding ?? []) {
            const c = coding.code?.trim()
            if (c && rootMeta.obsIsoByCode.has(c)) {
              return rootMeta.obsIsoByCode.get(c)
            }
          }
          if (resultIndex !== undefined && rootMeta.obsIsoByIndex[resultIndex] !== undefined) {
            return rootMeta.obsIsoByIndex[resultIndex]
          }
          if (rootMeta.reportIso !== undefined) {
            return rootMeta.reportIso
          }
        }
      }
      return obs.effectiveDateTime ?? fallbackReportIso
    }

    const resolveReportOriginalIso = (reportId: string, fallbackIso: string | undefined): string | undefined => {
      const rootMeta = resolveRootMeta(reportId)
      return rootMeta?.reportIso ?? fallbackIso
    }

    return {
      resolveObservationOriginalIso,
      resolveReportOriginalIso,
      resolveRootMeta,
      supersededReports,
    }
  }

  #resolveEffectiveStDeviation(
    context: RepositoryContext,
    caseId: string,
    values: ClinicalRiskAssessmentValues,
    bedsideObservation: { observationId: string; observationVersion: string } | null,
  ): EffectiveStSegmentDeviation | null {
    const revisionIndex = this.#buildReportRevisionIndex(context)
    const ecgRows = z.array(z.object({
      authored_at: z.string().nullable(),
      content_json: z.string(),
      diagnostic_report_id: z.string(),
      issued_at: z.string().nullable(),
    })).parse(
      this.#database.driver.prepare(`
        SELECT c.diagnostic_report_id, c.content_json, c.issued_at, r.authored_at
        FROM examination_report_content c
        JOIN laboratory_request r
          ON r.workspace_id = c.workspace_id
         AND r.epoch = c.epoch
         AND r.request_id = c.request_id
         AND r.diagnostic_report_id = c.diagnostic_report_id
        JOIN examination_request_detail d
          ON d.workspace_id = c.workspace_id
         AND d.epoch = c.epoch
         AND d.request_id = c.request_id
        WHERE c.workspace_id = ? AND c.epoch = ? AND c.case_id = ?
          AND d.exam_code = 'ecg-12-lead'
          AND r.status IN ('reported', 'acknowledged')
        ORDER BY julianday(COALESCE(c.issued_at, r.authored_at)) ASC, c.diagnostic_report_id ASC
      `).all(context.workspaceId, context.epoch, caseId),
    )

    const ecgCandidates = ecgRows
      .map((ecgRow, seq) => {
        const report = this.#fhir.read(context, 'DiagnosticReport', ecgRow.diagnostic_report_id)
        const fallbackEffStr = typeof report.effectiveDateTime === 'string'
          ? report.effectiveDateTime
          : typeof report.issued === 'string'
            ? report.issued
            : (ecgRow.issued_at ?? ecgRow.authored_at ?? undefined)
        const effStr = revisionIndex.resolveReportOriginalIso(ecgRow.diagnostic_report_id, fallbackEffStr)
        const tsMs = effStr ? Date.parse(effStr) : Number.NaN
        return {
          ecgRow,
          report,
          seq,
          timestampMs: Number.isFinite(tsMs) ? tsMs : undefined,
        }
      })
      .sort((a, b) => {
        if (a.timestampMs !== undefined && b.timestampMs !== undefined && a.timestampMs !== b.timestampMs) {
          return a.timestampMs - b.timestampMs
        }
        return a.seq - b.seq
      })

    for (const { ecgRow, report } of ecgCandidates) {
      const content = investigationResultContentSchema.safeParse(JSON.parse(ecgRow.content_json))
      if (!content.success) continue
      const versionId = report.meta?.versionId ?? '1'
      const leads = content.data.results.filter(item => ['st-t-anterior', 'st-t-inferior', 'st-t-lateral'].includes(item.code))
      const hasPositiveLead = leads.some(lead => typeof lead.value === 'string' && hasPositiveStDeviationText(lead.value))
        || hasPositiveStDeviationText(content.data.conclusion)
      if (hasPositiveLead) {
        return {
          source: 'ecg-report',
          sourceReference: `DiagnosticReport/${ecgRow.diagnostic_report_id}`,
          value: true,
          versionId,
        }
      }
      if (leads.length === 3 && leads.every(lead => isExplicitNormalStLead(lead.value, lead.interpretation))) {
        return {
          source: 'ecg-report',
          sourceReference: `DiagnosticReport/${ecgRow.diagnostic_report_id}`,
          value: false,
          versionId,
        }
      }
      // Restrict ST-segment ECG resolution strictly to the earliest valid presentation 12-lead ECG
      break
    }

    if (values.stSegmentDeviation !== null && bedsideObservation !== null) {
      return {
        source: 'bedside',
        sourceReference: `Observation/${bedsideObservation.observationId}`,
        value: values.stSegmentDeviation,
        versionId: bedsideObservation.observationVersion,
      }
    }
    return null
  }

  #readMedicationDeliveryEvidence(
    context: ActorContext,
    medicationRequestId: string,
    isCurrentEncounter: boolean,
    cutoffMs: number,
    isArchivedCutoff: boolean,
  ): {
    earliestEvidenceMs: number | undefined
    hasActiveSupplyAtCutoff: boolean
    hasEvidence: boolean
    hasOpenEndedEvidence: boolean
    supplyWindows: ReadonlyArray<{ endMs: number; startMs: number }>
  } {
    let hasEvidence = false
    let earliestEvidenceMs: number | undefined
    let hasOpenEndedEvidence = false
    const supplyWindows: Array<{ endMs: number; startMs: number }> = []
    const enforceStrictCutoff = !isCurrentEncounter || !isArchivedCutoff

    const dispenseParams = new URLSearchParams({
      _count: '50',
      prescription: `MedicationRequest/${medicationRequestId}`,
    })
    for (;;) {
      const dispPage = this.#fhir.search(context, 'MedicationDispense', dispenseParams)
      for (const rawDisp of dispPage.resources) {
        const disp = medicationDispenseResourceSchema.safeParse(rawDisp)
        if (!disp.success) continue
        const status = disp.data.status ?? ''
        if (['entered-in-error', 'cancelled', 'declined', 'preparation', 'unknown', ''].includes(status)) continue
        const handedIso = disp.data.whenHandedOver ?? disp.data.whenPrepared
        const handedMs = parseResourceTimestampMs(handedIso)
        if (Number.isFinite(cutoffMs)) {
          if (handedMs === undefined) {
            if (!isCurrentEncounter && isArchivedCutoff) continue
          } else if (enforceStrictCutoff && handedMs > cutoffMs) {
            continue
          }
        }
        hasEvidence = true
        if (handedMs !== undefined) {
          if (earliestEvidenceMs === undefined || handedMs < earliestEvidenceMs) {
            earliestEvidenceMs = handedMs
          }
          const supplyMs = resolveMedicationBoundsDurationMs(disp.data.daysSupply)
          if (typeof supplyMs === 'number') {
            supplyWindows.push({ endMs: handedMs + supplyMs, startMs: handedMs })
          } else {
            hasOpenEndedEvidence = true
          }
        } else {
          hasOpenEndedEvidence = true
        }
      }
      if (dispPage.nextCursor === undefined) break
      dispenseParams.set('_cursor', dispPage.nextCursor)
    }

    const adminParams = new URLSearchParams({
      _count: '50',
      request: `MedicationRequest/${medicationRequestId}`,
    })
    for (;;) {
      const adminPage = this.#fhir.search(context, 'MedicationAdministration', adminParams)
      for (const rawAdmin of adminPage.resources) {
        const admin = medicationAdministrationResourceSchema.safeParse(rawAdmin)
        if (!admin.success) continue
        const status = admin.data.status ?? ''
        if (['entered-in-error', 'not-done', 'unknown', ''].includes(status)) continue
        const adminStartIso =
          admin.data.occurencePeriod?.start
          ?? admin.data.occurrencePeriod?.start
          ?? admin.data.effectivePeriod?.start
          ?? admin.data.occurenceDateTime
          ?? admin.data.occurrenceDateTime
          ?? admin.data.effectiveDateTime
          ?? admin.data.recorded
        const adminStartMs = parseResourceTimestampMs(adminStartIso)
        if (Number.isFinite(cutoffMs)) {
          if (adminStartMs === undefined) {
            if (!isCurrentEncounter && isArchivedCutoff) continue
          } else if (enforceStrictCutoff && adminStartMs > cutoffMs) {
            continue
          }
        }
        hasEvidence = true
        hasOpenEndedEvidence = true
        if (adminStartMs !== undefined && (earliestEvidenceMs === undefined || adminStartMs < earliestEvidenceMs)) {
          earliestEvidenceMs = adminStartMs
        }
      }
      if (adminPage.nextCursor === undefined) break
      adminParams.set('_cursor', adminPage.nextCursor)
    }

    const hasActiveSupplyAtCutoff =
      !Number.isFinite(cutoffMs)
      || supplyWindows.some(w => (!enforceStrictCutoff || cutoffMs >= w.startMs) && cutoffMs <= w.endMs)

    return {
      earliestEvidenceMs,
      hasActiveSupplyAtCutoff,
      hasEvidence,
      hasOpenEndedEvidence,
      supplyWindows,
    }
  }

  #readLocalPrescriptionMetaByMedicationRequestId(
    context: Pick<RepositoryContext, 'workspaceId' | 'epoch'>,
  ): Map<string, { courseDurationMs: number; prescriptionStatus: string }> {
    const rows = z.array(z.object({
      course_days: z.number().int().positive(),
      medication_request_id: z.string(),
      status: z.string(),
    })).parse(
      this.#database.driver.prepare(`
        SELECT pi.medication_request_id, pi.course_days, p.status
        FROM prescription_item pi
        JOIN prescription p
          ON p.workspace_id = pi.workspace_id
         AND p.epoch = pi.epoch
         AND p.prescription_id = pi.prescription_id
        WHERE pi.workspace_id = ? AND pi.epoch = ?
      `).all(context.workspaceId, context.epoch),
    )
    const map = new Map<string, { courseDurationMs: number; prescriptionStatus: string }>()
    for (const row of rows) {
      map.set(row.medication_request_id, {
        courseDurationMs: row.course_days * 86_400_000,
        prescriptionStatus: row.status,
      })
    }
    return map
  }

  #resolveExternalEncounterStartMs(
    context: RepositoryContext,
    encRef: string | undefined,
    cache: Map<string, number | undefined>,
  ): number | undefined {
    const encId = encRef?.startsWith('Encounter/') ? encRef.slice('Encounter/'.length) : undefined
    if (!encId) return undefined
    if (cache.has(encId)) return cache.get(encId)
    let startMs: number | undefined
    try {
      startMs = parseResourceTimestampMs(extractEncounterStartIso(this.#fhir.read(context, 'Encounter', encId)))
    } catch {
      startMs = undefined
    }
    cache.set(encId, startMs)
    return startMs
  }

  #evaluateSnapshot(
    context: ActorContext,
    options: {
      admissionVitalSummary?: ClinicalScoreVitalSummary | null
      baselineWeightVitalSummary?: ClinicalScoreVitalSummary | null
      caseId: string
      encounterId: string
      encounterVersion: string
      evaluatedAt: string
      inpatient: InpatientService | undefined
      inpatientTimingGate:
        | {
            admissionAnchorMs: number | undefined
            earliestMedExecMs: number | undefined
            earliestSurgeryMs: number | undefined
          }
        | undefined
      isArchivedCutoff: boolean
      latestHeightVitalSummary?: ClinicalScoreVitalSummary | null
      latestWeightVitalSummary?: ClinicalScoreVitalSummary | null
      legacyDiagnosticReportId: string | null
      now: string
      patientId: string
      presentationIso?: string
      vitalSummary: ClinicalScoreVitalSummary | null
    },
  ): ClinicalScoreBundle {
    const patient = this.#fhir.read(context, 'Patient', options.patientId)
    const patientRef: ClinicalScoreSourceReference = {
      label: '患者人口学',
      reference: `Patient/${patient.id}`,
      versionId: patient.meta?.versionId ?? '1',
    }
    const birthDateRaw = typeof patient.birthDate === 'string' ? patient.birthDate : undefined
    const age = completedAgeYears(birthDateRaw, businessDate(options.now))
    const admissionAge = completedAgeYears(birthDateRaw, businessDate(options.presentationIso ?? options.now))
    const sex = patient.gender === 'male' ? 'male' : patient.gender === 'female' ? 'female' : undefined

    const riskAssessment = this.latestRiskAssessment(context, options.caseId)
    const riskRef: ClinicalScoreSourceReference | undefined = riskAssessment.observationId !== null && riskAssessment.observationVersion !== null
      ? {
          label: '专病风险评估',
          reference: `Observation/${riskAssessment.observationId}`,
          versionId: riskAssessment.observationVersion,
        }
      : undefined

    const vitalRef: ClinicalScoreSourceReference | undefined = options.vitalSummary === null
      ? undefined
      : {
          label: '生命体征',
          reference: `Observation/${options.vitalSummary.observationId}`,
          versionId: options.vitalSummary.observationVersion,
        }
    const effectiveAdmissionVital = options.admissionVitalSummary === undefined ? options.vitalSummary : options.admissionVitalSummary
    const admissionVitalRef: ClinicalScoreSourceReference | undefined = effectiveAdmissionVital === null
      ? undefined
      : {
          label: '入院首诊生命体征',
          reference: `Observation/${effectiveAdmissionVital.observationId}`,
          versionId: effectiveAdmissionVital.observationVersion,
        }
    const effectiveBaselineWeightVital =
      options.baselineWeightVitalSummary === undefined ? options.vitalSummary : options.baselineWeightVitalSummary
    const baselineWeightRef: ClinicalScoreSourceReference | undefined = effectiveBaselineWeightVital === null
      ? undefined
      : {
          label: '基线体重记录',
          reference: `Observation/${effectiveBaselineWeightVital.observationId}`,
          versionId: effectiveBaselineWeightVital.observationVersion,
        }

    const effectiveLatestWeightVital = options.latestWeightVitalSummary ?? options.vitalSummary
    const latestWeightRef: ClinicalScoreSourceReference | undefined =
      effectiveLatestWeightVital == null
        ? undefined
        : {
            label: '体重记录',
            reference: `Observation/${effectiveLatestWeightVital.observationId}`,
            versionId: effectiveLatestWeightVital.observationVersion,
          }
    const effectiveLatestHeightVital = options.latestHeightVitalSummary ?? options.vitalSummary
    const latestHeightRef: ClinicalScoreSourceReference | undefined =
      effectiveLatestHeightVital == null
        ? undefined
        : {
            label: '身高记录',
            reference: `Observation/${effectiveLatestHeightVital.observationId}`,
            versionId: effectiveLatestHeightVital.observationVersion,
          }

    const birthDateStr = typeof patient.birthDate === 'string' ? patient.birthDate : undefined
    const cutoffMs = Date.parse(options.now)
    const labs = this.#extractLaboratoryAnalytes(
      context,
      options.caseId,
      options.legacyDiagnosticReportId,
      options.inpatientTimingGate,
    )
    let ckdChronicity: {
      ckdLt30Chronicity?: { source: ClinicalScoreSourceReference; value: 'confirmed' | 'excluded' }
      ckdLt60Chronicity?: { source: ClinicalScoreSourceReference; value: 'confirmed' | 'excluded' }
    } = {}
    if (labs.serumCreatinine !== undefined && age !== undefined && age >= 18 && age <= 120 && sex !== undefined) {
      let currentEgfr: number | undefined
      try {
        currentEgfr = calculateCkdEpi2021Egfr({
          ageYears: age,
          serumCreatinine: labs.serumCreatinine.value,
          sex,
        }).value
      } catch {
        currentEgfr = undefined
      }
      if (currentEgfr !== undefined && currentEgfr < 60) {
        ckdChronicity = this.#extractPatientEgfrChronicity(
          context,
          options.patientId,
          options.encounterId,
          birthDateStr,
          age,
          sex,
          cutoffMs,
        )
      }
    }
    const history = this.#extractClinicalHistoryFlags(
      context,
      options.patientId,
      options.encounterId,
      birthDateStr,
      sex,
      options.inpatient,
      options.caseId,
      cutoffMs,
      options.isArchivedCutoff,
    )
    const encounterApplicability = this.#extractEncounterScoreApplicability(
      context,
      options.patientId,
      options.encounterId,
      options.caseId,
      options.inpatient,
      options.now,
      options.isArchivedCutoff,
    )
    const onAntihypertensive = this.#extractAntihypertensiveFlag(
      context,
      options.patientId,
      options.encounterId,
      options.inpatient,
      options.caseId,
      options.now,
      history.hypertensionConditionRefs,
      options.isArchivedCutoff,
    )
    const lipidStratification = this.#extractPatientLipidStratification(
      context,
      options.patientId,
      options.encounterId,
      options.caseId,
      options.now,
      labs.latestLipidObservationMs,
      options.isArchivedCutoff,
    )
    const bedsideKnownStenosis =
      riskRef !== undefined && riskAssessment.values.knownCoronaryStenosisGe50 !== null
        ? { source: riskRef, value: riskAssessment.values.knownCoronaryStenosisGe50 }
        : undefined
    const effectiveKnownStenosis =
      history.knownCoronaryRevascularizationOrStenosisGe50?.value === true
        ? history.knownCoronaryRevascularizationOrStenosisGe50
        : bedsideKnownStenosis?.value === true
          ? bedsideKnownStenosis
          : (history.knownCoronaryRevascularizationOrStenosisGe50 ?? bedsideKnownStenosis)

    const facts: ClinicalScoreObjectiveFacts = {
      acsPresentation: encounterApplicability.acsPresentation,
      pciDaptIndication: encounterApplicability.pciDaptIndication,
      uaNstemiPresentation: encounterApplicability.uaNstemiPresentation,
      ...(labs.sameSpecimenTcHdl === undefined ? {} : { sameSpecimenTcHdl: labs.sameSpecimenTcHdl }),
      ...(admissionAge === undefined ? {} : { admissionAgeYears: { source: patientRef, value: admissionAge } }),
      ...(age === undefined ? {} : { ageYears: { source: patientRef, value: age } }),
      ...(sex === undefined ? {} : { sex: { source: patientRef, value: sex } }),
      admissionHeartRateBpm:
        effectiveAdmissionVital === null || admissionVitalRef === undefined
          ? null
          : { source: admissionVitalRef, value: effectiveAdmissionVital.pulseBpm },
      admissionSystolicBpMmHg:
        effectiveAdmissionVital === null
        || admissionVitalRef === undefined
        || effectiveAdmissionVital.bloodPressure.systolicMmHg <= effectiveAdmissionVital.bloodPressure.diastolicMmHg
          ? null
          : { source: admissionVitalRef, value: effectiveAdmissionVital.bloodPressure.systolicMmHg },
      ...(options.vitalSummary === null || vitalRef === undefined
        ? {}
        : {
            heartRateBpm: { source: vitalRef, value: options.vitalSummary.pulseBpm },
            ...(options.vitalSummary.bloodPressure.systolicMmHg > options.vitalSummary.bloodPressure.diastolicMmHg
              ? {
                  diastolicBpMmHg: { source: vitalRef, value: options.vitalSummary.bloodPressure.diastolicMmHg },
                  systolicBpMmHg: { source: vitalRef, value: options.vitalSummary.bloodPressure.systolicMmHg },
                }
              : {}),
          }),
      ...(effectiveLatestHeightVital == null
        || latestHeightRef === undefined
        || effectiveLatestHeightVital.heightCm === undefined
        ? {}
        : { heightCm: { source: latestHeightRef, value: effectiveLatestHeightVital.heightCm } }),
      ...(effectiveLatestWeightVital == null
        || latestWeightRef === undefined
        || effectiveLatestWeightVital.weightKg === undefined
        ? {}
        : { weightKg: { source: latestWeightRef, value: effectiveLatestWeightVital.weightKg } }),
      baselineWeightKg:
        effectiveBaselineWeightVital === null
        || baselineWeightRef === undefined
        || effectiveBaselineWeightVital.weightKg === undefined
          ? null
          : { source: baselineWeightRef, value: effectiveBaselineWeightVital.weightKg },
      admissionSerumCreatinine: labs.admissionSerumCreatinine,
      baselineSerumCreatinine: labs.baselineSerumCreatinine,
      ...(labs.serumCreatinine === undefined ? {} : { serumCreatinine: labs.serumCreatinine }),
      ...(labs.elevatedCardiacBiomarker === undefined ? {} : { elevatedCardiacBiomarker: labs.elevatedCardiacBiomarker }),
      baselineWbc: labs.baselineWbc,
      ...(labs.wbc === undefined ? {} : { wbc: labs.wbc }),
      baselineHemoglobin: labs.baselineHemoglobin,
      ...(labs.hemoglobin === undefined ? {} : { hemoglobin: labs.hemoglobin }),
      ...(labs.totalCholesterol === undefined ? {} : { totalCholesterol: labs.totalCholesterol }),
      ...(labs.hdlCholesterol === undefined ? {} : { hdlCholesterol: labs.hdlCholesterol }),
      ...(labs.ldlCholesterol === undefined ? {} : { ldlCholesterol: labs.ldlCholesterol }),
      ...(labs.nonHdlPairedTcCholesterol === undefined
        ? {}
        : { nonHdlPairedTcCholesterol: labs.nonHdlPairedTcCholesterol }),
      ...(labs.nonHdlPairedHdlCholesterol === undefined
        ? {}
        : { nonHdlPairedHdlCholesterol: labs.nonHdlPairedHdlCholesterol }),
      ...(lipidStratification.lipidLoweringMedicationActive === undefined
        ? {}
        : { lipidLoweringMedicationActive: lipidStratification.lipidLoweringMedicationActive }),
      ...(lipidStratification.pretreatmentTotalCholesterol === undefined
        ? {}
        : { pretreatmentTotalCholesterol: lipidStratification.pretreatmentTotalCholesterol }),
      ...(lipidStratification.pretreatmentHdlCholesterol === undefined
        ? {}
        : { pretreatmentHdlCholesterol: lipidStratification.pretreatmentHdlCholesterol }),
      ...(lipidStratification.pretreatmentLdlCholesterol === undefined
        ? {}
        : { pretreatmentLdlCholesterol: lipidStratification.pretreatmentLdlCholesterol }),
      ...(lipidStratification.pretreatmentNonHdlPairedTcCholesterol === undefined
        ? {}
        : { pretreatmentNonHdlPairedTcCholesterol: lipidStratification.pretreatmentNonHdlPairedTcCholesterol }),
      ...(lipidStratification.pretreatmentNonHdlPairedHdlCholesterol === undefined
        ? {}
        : { pretreatmentNonHdlPairedHdlCholesterol: lipidStratification.pretreatmentNonHdlPairedHdlCholesterol }),
      ...(lipidStratification.pretreatmentSameSpecimenTcHdl === undefined
        ? {}
        : { pretreatmentSameSpecimenTcHdl: lipidStratification.pretreatmentSameSpecimenTcHdl }),
      ...(riskRef !== undefined && riskAssessment.values.killipClass !== null
        ? { killipClass: { source: riskRef, value: riskAssessment.values.killipClass } }
        : {}),
      ...(riskRef !== undefined && riskAssessment.values.cardiacArrestOnAdmission !== null
        ? { cardiacArrestOnAdmission: { source: riskRef, value: riskAssessment.values.cardiacArrestOnAdmission } }
        : {}),
      ...(riskRef !== undefined && riskAssessment.values.anginaEpisodes24h !== null
        ? { anginaEpisodes24h: { source: riskRef, value: riskAssessment.values.anginaEpisodes24h } }
        : {}),
      ...(riskAssessment.effectiveStSegmentDeviation !== null
        ? {
            stSegmentDeviation: {
              source: {
                label: riskAssessment.effectiveStSegmentDeviation.source === 'ecg-report' ? '12 导联心电图报告' : '床旁 ST 段评估',
                reference: riskAssessment.effectiveStSegmentDeviation.sourceReference,
                versionId: riskAssessment.effectiveStSegmentDeviation.versionId,
              },
              value: riskAssessment.effectiveStSegmentDeviation.value,
            },
          }
        : {}),
      ...(riskRef !== undefined && riskAssessment.values.aspirinUsedLast7Days !== null
        ? { aspirinUsedLast7Days: { source: riskRef, value: riskAssessment.values.aspirinUsedLast7Days } }
        : {}),
      ...(riskRef !== undefined && riskAssessment.values.smokingStatus !== null
        ? { smokingStatus: { source: riskRef, value: riskAssessment.values.smokingStatus } }
        : {}),
      ...(riskRef !== undefined && riskAssessment.values.priorBleedingHistory !== null
        ? { priorBleedingHistory: { source: riskRef, value: riskAssessment.values.priorBleedingHistory } }
        : {}),
      ...(riskRef !== undefined && riskAssessment.values.familyHistoryPrematureCad !== null
        ? { familyHistoryPrematureCad: { source: riskRef, value: riskAssessment.values.familyHistoryPrematureCad } }
        : {}),
      antihypertensiveMedicationActive: onAntihypertensive,
      ...(history.cadOnsetAgeYears === undefined ? {} : { cadOnsetAgeYears: history.cadOnsetAgeYears }),
      ...(ckdChronicity.ckdLt30Chronicity === undefined ? {} : { ckdLt30Chronicity: ckdChronicity.ckdLt30Chronicity }),
      ...(ckdChronicity.ckdLt60Chronicity === undefined ? {} : { ckdLt60Chronicity: ckdChronicity.ckdLt60Chronicity }),
      confirmedDiagnoses: history.confirmedDiagnoses,
      ...(effectiveKnownStenosis === undefined
        ? {}
        : { knownCoronaryRevascularizationOrStenosisGe50: effectiveKnownStenosis }),
      ...(history.priorCoronaryRevascularization === undefined
        ? {}
        : { priorCoronaryRevascularization: history.priorCoronaryRevascularization }),
      ...(history.severeAscvdEventCount === undefined
        ? {}
        : { severeAscvdEventCount: history.severeAscvdEventCount }),
    }

    return {
      encounterId: options.encounterId,
      encounterVersion: options.encounterVersion,
      evaluatedAt: options.evaluatedAt,
      riskAssessment,
      scores: evaluateClinicalScores(facts),
      vitalSigns: options.vitalSummary,
    }
  }

  #extractEncounterScoreApplicability(
    context: ActorContext,
    patientId: string,
    encounterId: string,
    caseId: string,
    inpatient: InpatientService | undefined,
    nowIso: string,
    isArchivedCutoff: boolean,
  ): {
    acsPresentation: { source?: ClinicalScoreSourceReference; value: boolean }
    pciDaptIndication: { source?: ClinicalScoreSourceReference; value: boolean }
    uaNstemiPresentation: { source?: ClinicalScoreSourceReference; value: boolean }
  } {
    let acsSource: ClinicalScoreSourceReference | undefined
    let uaNstemiSource: ClinicalScoreSourceReference | undefined
    let stemiSource: ClinicalScoreSourceReference | undefined
    let genericAcsSource: ClinicalScoreSourceReference | undefined

    // 1. Check presentation 12-lead ECG for acute ST-segment elevation
    const ecgRows = z.array(z.object({
      authored_at: z.string().nullable(),
      content_json: z.string(),
      diagnostic_report_id: z.string(),
      issued_at: z.string().nullable(),
    })).parse(
      this.#database.driver.prepare(`
        SELECT c.diagnostic_report_id, c.content_json, c.issued_at, r.authored_at
        FROM examination_report_content c
        JOIN laboratory_request r
          ON r.workspace_id = c.workspace_id
         AND r.epoch = c.epoch
         AND r.request_id = c.request_id
         AND r.diagnostic_report_id = c.diagnostic_report_id
        JOIN examination_request_detail d
          ON d.workspace_id = c.workspace_id
         AND d.epoch = c.epoch
         AND d.request_id = c.request_id
        WHERE c.workspace_id = ? AND c.epoch = ? AND c.case_id = ?
          AND d.exam_code = 'ecg-12-lead'
          AND r.status IN ('reported', 'acknowledged')
          AND NOT EXISTS (
            SELECT 1 FROM laboratory_report_revision rev
            WHERE rev.workspace_id = r.workspace_id
              AND rev.epoch = r.epoch
              AND rev.revision_of_diagnostic_report_id = c.diagnostic_report_id
          )
        ORDER BY julianday(COALESCE(c.issued_at, r.authored_at)) ASC, c.diagnostic_report_id ASC
      `).all(context.workspaceId, context.epoch, caseId),
    )
    const revisionIndex = this.#buildReportRevisionIndex(context)
    const sortedPresentationEcgs = ecgRows
      .map((row, seq) => {
        const report = diagnosticReportResourceSchema.safeParse(this.#fhir.read(context, 'DiagnosticReport', row.diagnostic_report_id))
        const fallbackEffStr = report.success
          ? (report.data.effectiveDateTime ?? report.data.issued ?? row.issued_at ?? row.authored_at ?? undefined)
          : (row.issued_at ?? row.authored_at ?? undefined)
        const effStr = revisionIndex.resolveReportOriginalIso(row.diagnostic_report_id, fallbackEffStr)
        const tsMs = effStr ? Date.parse(effStr) : Number.NaN
        return { report, row, seq, timestampMs: Number.isFinite(tsMs) ? tsMs : undefined }
      })
      .sort((a, b) => {
        if (a.timestampMs !== undefined && b.timestampMs !== undefined && a.timestampMs !== b.timestampMs) {
          return a.timestampMs - b.timestampMs
        }
        return a.seq - b.seq
      })
    let hasExplicitNonStElevationEcg = false
    for (const { report, row } of sortedPresentationEcgs) {
      if (!report.success || !['final', 'amended', 'corrected'].includes(report.data.status ?? '')) continue
      const content = investigationResultContentSchema.safeParse(JSON.parse(row.content_json))
      if (!content.success) continue
      const combinedText = [
        content.data.conclusion,
        ...content.data.results.map(item => typeof item.value === 'string' ? item.value : ''),
      ].filter(Boolean).join('；')
      if (hasPositiveStElevationText(combinedText)) {
        stemiSource = {
          label: '首份 12 导联心电图 ST 段抬高',
          reference: `DiagnosticReport/${row.diagnostic_report_id}`,
          versionId: report.data.meta?.versionId ?? '1',
        }
      } else {
        const hasCompleteLeadStAssessment = ['st-t-anterior', 'st-t-inferior', 'st-t-lateral'].every(leadCode => {
          const entry = content.data.results.find(item => item.code === leadCode)
          return (
            entry !== undefined
            && typeof entry.value === 'string'
            && (isExplicitNormalStLead(entry.value, entry.interpretation) || hasPositiveStDeviationText(entry.value))
          )
        })
        const hasExplicitNoStElevationConclusion =
          /(?:无|未见|否认)(?:明显)?\s*ST\s*段?\s*(?:抬高|上抬)|\bno\s+ST[- ]?(?:segment\s*)?elevation\b/i.test(combinedText)
        if (hasCompleteLeadStAssessment || hasExplicitNoStElevationConclusion) {
          hasExplicitNonStElevationEcg = true
        }
      }
      // Restrict STEMI/non-ST-elevation ECG subtype evaluation strictly to the earliest valid presentation 12-lead ECG
      break
    }

    // 2. Check current Encounter Condition resources (confirmed or working provisional)
    const encCondParams = new URLSearchParams({ _count: '100', encounter: `Encounter/${encounterId}` })
    for (;;) {
      const page = this.#fhir.search(context, 'Condition', encCondParams)
      for (const raw of page.resources) {
        const parsed = conditionResourceSchema.safeParse(raw)
        if (!parsed.success) continue
        const verStatus = parsed.data.verificationStatus?.coding?.[0]?.code
        const clinStatus = parsed.data.clinicalStatus?.coding?.[0]?.code
        if (verStatus === 'entered-in-error' || verStatus === 'refuted') continue
        if (clinStatus === 'inactive' || clinStatus === 'resolved') continue
        const codes = (parsed.data.code?.coding ?? []).map(c => c.code?.trim().toUpperCase() ?? '').filter(Boolean)
        const text = [parsed.data.code?.text, ...(parsed.data.code?.coding ?? []).map(c => c.display)].filter(Boolean).join(' ')
        const ref: ClinicalScoreSourceReference = {
          label: parsed.data.code?.coding?.[0]?.display ?? parsed.data.code?.text ?? `诊断 ${parsed.data.id}`,
          reference: `Condition/${parsed.data.id}`,
          versionId: parsed.data.meta?.versionId ?? '1',
        }
        const isStemi =
          codes.some(code => /^(?:I21\.[0123]|I22\.[0189])/.test(code))
          || (
            /ST\s*段?抬高型心肌梗死|急性透壁.*心肌梗死|\bSTEMI\b/i.test(text)
            && !/非\s*ST\s*段?抬高|non[- ]?ST/i.test(text)
            && !/(?:无|否认|排除)\s*(?:ST|急性|STEMI)/i.test(text)
          )
        const isUaNstemi =
          codes.some(code => /^(?:I20\.0|I21\.4|I22\.2|I24\.[089])/.test(code))
          || (
            /不稳定型心绞痛|非\s*ST\s*段?抬高|心内膜下心肌梗死|\bNSTEMI\b|\bUA\b/i.test(text)
            && !/(?:无|否认|排除)\s*(?:不稳定|非\s*ST|心内膜下|NSTEMI|UA)/i.test(text)
          )
        const isGenericAcs =
          codes.some(code => /^(?:I21(?:\.9|$)|I22$|I23|I24\.1|394659003|22298006)/.test(code))
          || (
            /急性冠脉综合征|急性心肌梗死|acute coronary syndrome/i.test(text)
            && !/(?:无|否认|排除)\s*(?:急性冠脉|急性心肌梗死|acute coronary)/i.test(text)
          )
        if (isStemi) {
          stemiSource ??= ref
          acsSource ??= ref
        } else if (isUaNstemi) {
          uaNstemiSource ??= ref
          acsSource ??= ref
        } else if (isGenericAcs) {
          genericAcsSource ??= ref
          acsSource ??= ref
        }
      }
      if (page.nextCursor === undefined) break
      encCondParams.set('_cursor', page.nextCursor)
    }

    const effectiveUaNstemiSource =
      stemiSource !== undefined
        ? undefined
        : (uaNstemiSource ?? (genericAcsSource !== undefined && hasExplicitNonStElevationEcg ? genericAcsSource : undefined))

    // 3. Check PCI / coronary stenting + DAPT indication for PRECISE-DAPT
    const nowMs = Date.parse(nowIso)
    const encounterTimeCache = new Map<string, number | undefined>()
    let pciStentEncounterSource: ClinicalScoreSourceReference | undefined
    let priorCoronaryStentSource: ClinicalScoreSourceReference | undefined
    let hasActiveP2y12 = false
    let hasActiveAspirin = false
    let activeP2y12Source: ClinicalScoreSourceReference | undefined

    const matchesCoronaryStent = (codes: readonly string[], text: string) =>
      codes.some(code => /^(?:36\.0[67]|00\.66)/.test(code))
      || (
        /冠脉支架|冠状动脉.*支架|药物洗脱支架|经皮冠状动脉介入|\bPCI\b|coronary stent/i.test(text)
        && !/(?:无|否认|排除)/i.test(text)
      )

    if (inpatient !== undefined) {
      const surgery = inpatient.surgery.read(context, caseId)
      for (const req of surgery.requests) {
        if (req.status === 'cancelled') continue
        if (matchesCoronaryStent([req.plannedProcedure.coding.code], req.plannedProcedure.coding.display)) {
          pciStentEncounterSource ??= {
            label: req.plannedProcedure.coding.display,
            reference: `ServiceRequest/${req.id}`,
            versionId: String(req.version),
          }
        }
      }
      for (const exec of surgery.executions) {
        if (matchesCoronaryStent([exec.actualProcedure.coding.code], exec.actualProcedure.coding.display)) {
          pciStentEncounterSource ??= {
            label: exec.actualProcedure.coding.display,
            reference: `Procedure/${exec.id}`,
            versionId: '1',
          }
        }
      }
      const activeOrders = z.array(z.object({
        catalog_item_id: z.string(),
        display: z.string(),
        order_id: z.string(),
        version: z.number(),
      })).parse(
        this.#database.driver.prepare(`
          SELECT o.order_id, o.catalog_item_id, o.display, o.version
          FROM inpatient_order o
          WHERE o.workspace_id = ? AND o.epoch = ? AND o.admission_id = ?
            AND o.kind = 'medication' AND o.state IN ('signed', 'verified', 'stop-requested')
            AND EXISTS (
              SELECT 1 FROM inpatient_execution e
              WHERE e.workspace_id = o.workspace_id
                AND e.epoch = o.epoch
                AND e.order_id = o.order_id
                AND e.status = 'completed'
            )
        `).all(context.workspaceId, context.epoch, caseId),
      )
      for (const order of activeOrders) {
        const hay = `${order.catalog_item_id} ${order.display}`
        if (/氯吡格雷|替格瑞洛|普拉格雷|clopidogrel|ticagrelor|prasugrel/i.test(hay)) {
          hasActiveP2y12 = true
          activeP2y12Source ??= {
            label: `在用医嘱 ${order.display}`,
            reference: `MedicationRequest/${order.order_id}`,
            versionId: String(order.version),
          }
        }
        if (/阿司匹林|aspirin/i.test(hay)) {
          hasActiveAspirin = true
        }
      }
    }

    if (pciStentEncounterSource === undefined) {
      const procParams = new URLSearchParams({ _count: '100', patient: `Patient/${patientId}` })
      for (;;) {
        const page = this.#fhir.search(context, 'Procedure', procParams)
        for (const raw of page.resources) {
          const parsed = procedureResourceSchema.safeParse(raw)
          if (!parsed.success || !['completed', 'in-progress'].includes(parsed.data.status ?? '')) continue
          const codes = (parsed.data.code?.coding ?? []).map(c => c.code ?? '').filter(Boolean)
          const text = [parsed.data.code?.text, ...(parsed.data.code?.coding ?? []).map(c => c.display)].filter(Boolean).join(' ')
          if (matchesCoronaryStent(codes, text)) {
            const ref: ClinicalScoreSourceReference = {
              label: parsed.data.code?.coding?.[0]?.display ?? parsed.data.code?.text ?? `操作 ${parsed.data.id}`,
              reference: `Procedure/${parsed.data.id}`,
              versionId: parsed.data.meta?.versionId ?? '1',
            }
            if (parsed.data.encounter?.reference === `Encounter/${encounterId}`) {
              pciStentEncounterSource ??= ref
            } else if (parsed.data.status === 'completed') {
              const procTsMs =
                parseResourceTimestampMs(parsed.data.performedDateTime ?? parsed.data.performedPeriod?.start)
                ?? this.#resolveExternalEncounterStartMs(context, parsed.data.encounter?.reference, encounterTimeCache)
              if (Number.isFinite(nowMs) && (procTsMs === undefined ? isArchivedCutoff : procTsMs > nowMs)) continue
              priorCoronaryStentSource ??= ref
            }
          }
        }
        if (page.nextCursor === undefined) break
        procParams.set('_cursor', page.nextCursor)
      }
    }

    if (pciStentEncounterSource === undefined && priorCoronaryStentSource === undefined) {
      const stentCondParams = new URLSearchParams({ _count: '100', patient: `Patient/${patientId}` })
      for (;;) {
        const page = this.#fhir.search(context, 'Condition', stentCondParams)
        for (const raw of page.resources) {
          const parsed = conditionResourceSchema.safeParse(raw)
          if (!parsed.success || parsed.data.verificationStatus?.coding?.[0]?.code !== 'confirmed') continue
          if (parsed.data.encounter?.reference !== `Encounter/${encounterId}` && Number.isFinite(nowMs)) {
            const condTsMs =
              parseResourceTimestampMs(parsed.data.recordedDate ?? parsed.data.onsetDateTime ?? parsed.data.onsetPeriod?.start)
              ?? this.#resolveExternalEncounterStartMs(context, parsed.data.encounter?.reference, encounterTimeCache)
            if (condTsMs === undefined ? isArchivedCutoff : condTsMs > nowMs) continue
          }
          const codes = (parsed.data.code?.coding ?? []).map(c => c.code?.trim().toUpperCase() ?? '')
          const text = [parsed.data.code?.text, ...(parsed.data.code?.coding ?? []).map(c => c.display)].filter(Boolean).join(' ')
          if (
            codes.some(code => code.startsWith('Z95.5') || code.startsWith('Z98.61'))
            || (/冠脉支架置入术后|支架植入术后|PCI术后|coronary stent/i.test(text) && !/(?:无|否认|排除)/i.test(text))
          ) {
            priorCoronaryStentSource = {
              label: parsed.data.code?.coding?.[0]?.display ?? parsed.data.code?.text ?? `诊断 ${parsed.data.id}`,
              reference: `Condition/${parsed.data.id}`,
              versionId: parsed.data.meta?.versionId ?? '1',
            }
            break
          }
        }
        if (priorCoronaryStentSource !== undefined || page.nextCursor === undefined) break
        stentCondParams.set('_cursor', page.nextCursor)
      }
    }

    if (pciStentEncounterSource === undefined && priorCoronaryStentSource !== undefined && (!hasActiveP2y12 || !hasActiveAspirin)) {
      const localPrescriptionByMedReqId = this.#readLocalPrescriptionMetaByMedicationRequestId(context)
      const withdrawnIds = new Set(
        z.array(z.object({ medication_request_id: z.string() })).parse(
          this.#database.driver.prepare(`
            SELECT pi.medication_request_id
            FROM prescription_item pi
            JOIN prescription_withdrawal pw
              ON pw.workspace_id = pi.workspace_id
             AND pw.epoch = pi.epoch
             AND pw.prescription_id = pi.prescription_id
            WHERE pi.workspace_id = ? AND pi.epoch = ?
          `).all(context.workspaceId, context.epoch),
        ).map(row => row.medication_request_id),
      )
      const medParams = new URLSearchParams({ _count: '100', patient: `Patient/${patientId}` })
      for (;;) {
        const page = this.#fhir.search(context, 'MedicationRequest', medParams)
        for (const raw of page.resources) {
          const parsed = medicationRequestResourceSchema.safeParse(raw)
          if (!parsed.success || parsed.data.status !== 'active' || withdrawnIds.has(parsed.data.id)) continue
          const display = [
            parsed.data.medication?.reference?.display,
            parsed.data.medication?.concept?.text,
            ...(parsed.data.medication?.concept?.coding ?? []).map(c => c.display),
          ].filter(Boolean).join(' ')
          const isP2y12 = /氯吡格雷|替格瑞洛|普拉格雷|clopidogrel|ticagrelor|prasugrel/i.test(display)
          const isAspirin = /阿司匹林|aspirin/i.test(display)
          if (!isP2y12 && !isAspirin) continue
          const isCurrentEncounter = parsed.data.encounter?.reference === `Encounter/${encounterId}`
          if (!isCurrentEncounter && Number.isFinite(nowMs)) {
            const medTsMs =
              parseResourceTimestampMs(parsed.data.authoredOn)
              ?? this.#resolveExternalEncounterStartMs(context, parsed.data.encounter?.reference, encounterTimeCache)
            if (medTsMs === undefined ? isArchivedCutoff : medTsMs > nowMs) continue
          }
          const rawDaptBoundsMs = resolveMedicationBoundsDurationMs(
            parsed.data.dosageInstruction?.[0]?.timing?.repeat?.boundsDuration
            ?? parsed.data.dispenseRequest?.expectedSupplyDuration,
          )
          if (rawDaptBoundsMs === 'invalid') continue
          const delivery = this.#readMedicationDeliveryEvidence(
            context,
            parsed.data.id,
            isCurrentEncounter,
            nowMs,
            isArchivedCutoff,
          )
          // Ongoing outpatient DAPT requires actual dispense handover or administration evidence
          if (!delivery.hasEvidence) continue
          const daptBoundsMs = rawDaptBoundsMs ?? localPrescriptionByMedReqId.get(parsed.data.id)?.courseDurationMs
          const enforceExpiry = !isCurrentEncounter || !isArchivedCutoff
          if (enforceExpiry && Number.isFinite(nowMs)) {
            if (daptBoundsMs !== undefined) {
              const anchorMs = delivery.earliestEvidenceMs ?? parseResourceTimestampMs(parsed.data.authoredOn)
              const inCourseWindow = anchorMs !== undefined && nowMs >= anchorMs && nowMs <= anchorMs + daptBoundsMs
              if (!inCourseWindow && !delivery.hasActiveSupplyAtCutoff) continue
            } else if (!delivery.hasOpenEndedEvidence && !delivery.hasActiveSupplyAtCutoff) {
              continue
            }
          }
          if (isP2y12) {
            hasActiveP2y12 = true
            activeP2y12Source ??= {
              label: `在用处方 ${display || parsed.data.id}`,
              reference: `MedicationRequest/${parsed.data.id}`,
              versionId: parsed.data.meta?.versionId ?? '1',
            }
          }
          if (isAspirin) {
            hasActiveAspirin = true
          }
        }
        if ((hasActiveP2y12 && hasActiveAspirin) || page.nextCursor === undefined) break
        medParams.set('_cursor', page.nextCursor)
      }
    }

    const pciDaptSource =
      pciStentEncounterSource
      ?? (priorCoronaryStentSource !== undefined && hasActiveP2y12 && hasActiveAspirin
        ? (activeP2y12Source ?? priorCoronaryStentSource)
        : undefined)

    return {
      acsPresentation: acsSource === undefined ? { value: false } : { source: acsSource, value: true },
      pciDaptIndication: pciDaptSource === undefined ? { value: false } : { source: pciDaptSource, value: true },
      uaNstemiPresentation:
        effectiveUaNstemiSource !== undefined
          ? { source: effectiveUaNstemiSource, value: true }
          : stemiSource !== undefined
            ? { source: stemiSource, value: false }
            : { value: false },
    }
  }

  #extractPatientEgfrChronicity(
    context: RepositoryContext,
    patientId: string,
    encounterId: string,
    birthDateStr: string | undefined,
    fallbackAgeYears: number,
    sex: 'male' | 'female',
    cutoffMs: number,
  ): {
    ckdLt30Chronicity?: { source: ClinicalScoreSourceReference; value: 'confirmed' | 'excluded' }
    ckdLt60Chronicity?: { source: ClinicalScoreSourceReference; value: 'confirmed' | 'excluded' }
  } {
    const revisionIndex = this.#buildReportRevisionIndex(context)
    const excludedObsIds = new Set<string>()
    const reportMetaByObsId = new Map<string, { fallbackIso: string | undefined; reportId: string; resultIndex: number }>()
    const reportParams = new URLSearchParams({ _count: '100', patient: `Patient/${patientId}` })
    for (;;) {
      const page = this.#fhir.search(context, 'DiagnosticReport', reportParams)
      for (const raw of page.resources) {
        const parsed = diagnosticReportResourceSchema.safeParse(raw)
        if (!parsed.success) continue
        const isSupersededOrInvalid =
          revisionIndex.supersededReports.has(parsed.data.id)
          || !['final', 'amended', 'corrected'].includes(parsed.data.status ?? '')
        for (const [resultIndex, ref] of (parsed.data.result ?? []).entries()) {
          const obsId = ref.reference?.startsWith('Observation/') ? ref.reference.slice('Observation/'.length) : undefined
          if (!obsId) continue
          if (isSupersededOrInvalid) {
            excludedObsIds.add(obsId)
          } else {
            reportMetaByObsId.set(obsId, {
              fallbackIso: parsed.data.effectiveDateTime ?? parsed.data.issued,
              reportId: parsed.data.id,
              resultIndex,
            })
          }
        }
      }
      if (page.nextCursor === undefined) break
      reportParams.set('_cursor', page.nextCursor)
    }

    const hits: Array<{ egfr: number; source: ClinicalScoreSourceReference; timestampMs: number }> = []
    const obsParams = new URLSearchParams({ _count: '100', patient: `Patient/${patientId}` })
    for (;;) {
      const page = this.#fhir.search(context, 'Observation', obsParams)
      for (const raw of page.resources) {
        const obs = observationResourceSchema.safeParse(raw)
        if (!obs.success || excludedObsIds.has(obs.data.id)) continue
        if (!['final', 'amended', 'corrected'].includes(obs.data.status ?? '')) continue
        const codes = new Set(
          (obs.data.code?.coding ?? [])
            .map(item => item.code?.trim())
            .filter((item): item is string => Boolean(item)),
        )
        const display = [
          obs.data.code?.text,
          ...(obs.data.code?.coding ?? []).map(item => item.display),
        ].filter((item): item is string => Boolean(item)).join(' ')
        const unit = obs.data.valueQuantity?.code ?? obs.data.valueQuantity?.unit
        const quantity = obs.data.valueQuantity?.value
        if (
          quantity === undefined
          || unit === undefined
          || !(codes.has('1700404A') || codes.has('2160-0') || codes.has('14682-9') || /^(?:血?肌酐|血清肌酐)/i.test(display))
        ) {
          continue
        }
        const reportMeta = reportMetaByObsId.get(obs.data.id)
        const rawTs = revisionIndex.resolveObservationOriginalIso(
          reportMeta?.reportId,
          reportMeta?.resultIndex,
          obs.data,
          reportMeta?.fallbackIso,
        )
        const tsMs = parseResourceTimestampMs(rawTs) ?? Number.NaN
        if (!Number.isFinite(tsMs)) continue
        if (obs.data.encounter?.reference !== `Encounter/${encounterId}` && Number.isFinite(cutoffMs) && tsMs > cutoffMs) continue
        const obsAge =
          rawTs && birthDateStr
            ? (completedAgeYears(birthDateStr, rawTs.slice(0, 10)) ?? fallbackAgeYears)
            : fallbackAgeYears
        if (obsAge < 18 || obsAge > 120) continue
        try {
          const egfr = calculateCkdEpi2021Egfr({
            ageYears: obsAge,
            serumCreatinine: { unit, value: quantity },
            sex,
          }).value
          hits.push({
            egfr,
            source: {
              label: obs.data.code?.coding?.[0]?.display ?? obs.data.code?.text ?? `检验 ${obs.data.id}`,
              reference: `Observation/${obs.data.id}`,
              versionId: obs.data.meta?.versionId ?? '1',
            },
            timestampMs: tsMs,
          })
        } catch {
          // ignore malformed out-of-bounds historical value
        }
      }
      if (page.nextCursor === undefined) break
      obsParams.set('_cursor', page.nextCursor)
    }

    if (hits.length < 2) return {}
    hits.sort((a, b) => a.timestampMs - b.timestampMs)
    const latest = hits.at(-1)!
    const NINETY_DAYS_MS = 90 * 86_400_000

    const evaluateThreshold = (
      threshold: number,
    ): { source: ClinicalScoreSourceReference; value: 'confirmed' | 'excluded' } | undefined => {
      if (latest.egfr >= threshold) return undefined
      let lastAbove: (typeof hits)[number] | undefined
      let streakStart = latest
      for (let i = hits.length - 1; i >= 0; i--) {
        const item = hits[i]!
        if (item.egfr >= threshold) {
          lastAbove = item
          break
        }
        streakStart = item
      }
      if (lastAbove !== undefined && latest.timestampMs - lastAbove.timestampMs < NINETY_DAYS_MS) {
        return { source: lastAbove.source, value: 'excluded' }
      }
      if (latest.timestampMs - streakStart.timestampMs >= NINETY_DAYS_MS) {
        return { source: streakStart.source, value: 'confirmed' }
      }
      return undefined
    }

    const ckdLt60Chronicity = evaluateThreshold(60)
    const ckdLt30Chronicity = evaluateThreshold(30)
    return {
      ...(ckdLt30Chronicity === undefined ? {} : { ckdLt30Chronicity }),
      ...(ckdLt60Chronicity === undefined ? {} : { ckdLt60Chronicity }),
    }
  }

  #extractLaboratoryAnalytes(
    context: RepositoryContext,
    caseId: string,
    legacyDiagnosticReportId: string | null,
    inpatientTimingGate?:
      | {
          admissionAnchorMs: number | undefined
          earliestMedExecMs: number | undefined
          earliestSurgeryMs: number | undefined
        }
      | undefined,
  ) {
    const rows = z.array(z.object({
      diagnostic_report_id: z.string(),
      report_time: z.string().nullable(),
    })).parse(
      this.#database.driver.prepare(`
        SELECT r.diagnostic_report_id, COALESCE(r.reported_at, r.authored_at) AS report_time
        FROM laboratory_request r
        WHERE r.workspace_id = ? AND r.epoch = ? AND r.case_id = ?
          AND r.request_kind = 'laboratory'
          AND r.status IN ('reported', 'acknowledged')
          AND r.diagnostic_report_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM laboratory_report_revision rev
            WHERE rev.workspace_id = r.workspace_id
              AND rev.epoch = r.epoch
              AND rev.revision_of_diagnostic_report_id = r.diagnostic_report_id
          )
        ORDER BY julianday(COALESCE(r.reported_at, r.authored_at)) DESC, r.request_id DESC
      `).all(context.workspaceId, context.epoch, caseId),
    )
    const reportEntries = rows.map(row => ({ reportId: row.diagnostic_report_id, reportTime: row.report_time }))
    if (legacyDiagnosticReportId !== null && !reportEntries.some(item => item.reportId === legacyDiagnosticReportId)) {
      reportEntries.push({ reportId: legacyDiagnosticReportId, reportTime: null })
    }

    const creatinineHitsDesc: Array<{
      source: ClinicalScoreSourceReference
      timestampMs: number | undefined
      value: { unit: string; value: number }
    }> = []
    const troponinHitsDesc: Array<{
      elevated: boolean
      source: ClinicalScoreSourceReference
      timestampMs: number | undefined
    }> = []
    const wbcHitsDesc: Array<{
      source: ClinicalScoreSourceReference
      timestampMs: number | undefined
      value: { unit: string; value: number }
    }> = []
    const hemoglobinHitsDesc: Array<{
      source: ClinicalScoreSourceReference
      timestampMs: number | undefined
      value: { unit: string; value: number }
    }> = []
    const tcHitsDesc: Array<{
      source: ClinicalScoreSourceReference
      specimenKey: string
      timestampMs: number | undefined
      value: { unit: string; value: number }
    }> = []
    const hdlHitsDesc: Array<{
      source: ClinicalScoreSourceReference
      specimenKey: string
      timestampMs: number | undefined
      value: { unit: string; value: number }
    }> = []
    const ldlHitsDesc: Array<{
      source: ClinicalScoreSourceReference
      timestampMs: number | undefined
      value: { unit: string; value: number }
    }> = []

    const revisionIndex = this.#buildReportRevisionIndex(context)
    for (const { reportId, reportTime } of reportEntries) {
      const rawReport = this.#fhir.read(context, 'DiagnosticReport', reportId)
      const report = diagnosticReportResourceSchema.safeParse(rawReport)
      if (!report.success || !['final', 'amended', 'corrected'].includes(report.data.status ?? '')) continue
      const rootReportId = revisionIndex.resolveRootMeta(reportId)?.rootReportId ?? reportId
      const fallbackReportIso = report.data.effectiveDateTime ?? report.data.issued ?? reportTime ?? undefined
      for (const [resultIndex, ref] of (report.data.result ?? []).entries()) {
        const obsId = ref.reference?.startsWith('Observation/') ? ref.reference.slice('Observation/'.length) : undefined
        if (!obsId) continue
        const obs = observationResourceSchema.safeParse(this.#fhir.read(context, 'Observation', obsId))
        if (!obs.success || !['final', 'amended', 'corrected'].includes(obs.data.status ?? '')) continue

        const codes = new Set(
          (obs.data.code?.coding ?? [])
            .map(item => item.code?.trim())
            .filter((item): item is string => Boolean(item)),
        )
        const display = [
          obs.data.code?.text,
          ...(obs.data.code?.coding ?? []).map(item => item.display),
        ].filter((item): item is string => Boolean(item)).join(' ')
        const unit = obs.data.valueQuantity?.code ?? obs.data.valueQuantity?.unit
        const quantity = obs.data.valueQuantity?.value
        const source: ClinicalScoreSourceReference = {
          label: obs.data.code?.coding?.[0]?.display ?? obs.data.code?.text ?? `检验 ${obsId}`,
          reference: `Observation/${obs.data.id}`,
          versionId: obs.data.meta?.versionId ?? '1',
        }
        const rawObsIso = revisionIndex.resolveObservationOriginalIso(
          reportId,
          resultIndex,
          obs.data,
          fallbackReportIso,
        )
        const obsTimestampMs = parseResourceTimestampMs(rawObsIso)
        const specimenKey = obs.data.specimen?.reference ?? `DiagnosticReport/${rootReportId}`

        if (
          quantity !== undefined
          && unit !== undefined
          && (codes.has('1700404A') || codes.has('2160-0') || codes.has('14682-9') || /^(?:血?肌酐|血清肌酐)/i.test(display))
        ) {
          creatinineHitsDesc.push({
            source,
            timestampMs: obsTimestampMs,
            value: { unit, value: quantity },
          })
        }
        if (
          codes.has('2100404B') || codes.has('2100404A') || codes.has('2100504A')
          || codes.has('89579-7') || codes.has('49563-0') || codes.has('10839-9')
          || codes.has('6598-7') || codes.has('6597-9') || codes.has('67151-1') || codes.has('42757-5')
          || /肌钙蛋白|troponin/i.test(display)
        ) {
          const elevated = this.#evaluateTroponinElevation(obs.data)
          if (elevated !== undefined) {
            troponinHitsDesc.push({
              elevated,
              source,
              timestampMs: obsTimestampMs,
            })
          }
        }
        if (
          quantity !== undefined
          && unit !== undefined
          && (codes.has('0100101A') || codes.has('6690-2') || codes.has('26464-8') || /白细胞计数/i.test(display))
        ) {
          wbcHitsDesc.push({
            source,
            timestampMs: obsTimestampMs,
            value: { unit, value: quantity },
          })
        }
        if (
          quantity !== undefined
          && unit !== undefined
          && (codes.has('0100401A') || codes.has('718-7') || /^(?:血红蛋白|hemoglobin)$/i.test(display.trim()))
        ) {
          hemoglobinHitsDesc.push({
            source,
            timestampMs: obsTimestampMs,
            value: { unit, value: quantity },
          })
        }
        if (
          quantity !== undefined
          && unit !== undefined
          && (codes.has('2000104A') || codes.has('2093-3') || codes.has('14647-2') || /^(?:总胆固醇|total cholesterol)/i.test(display))
        ) {
          tcHitsDesc.push({
            source,
            specimenKey,
            timestampMs: obsTimestampMs,
            value: { unit, value: quantity },
          })
        }
        if (
          quantity !== undefined
          && unit !== undefined
          && (codes.has('2000304A') || codes.has('2085-9') || codes.has('14646-4') || /高密度脂蛋白胆固醇|HDL/i.test(display))
        ) {
          hdlHitsDesc.push({
            source,
            specimenKey,
            timestampMs: obsTimestampMs,
            value: { unit, value: quantity },
          })
        }
        if (
          quantity !== undefined
          && unit !== undefined
          && (codes.has('2000404A') || codes.has('2089-1') || codes.has('13457-7') || codes.has('18262-6') || /低密度脂蛋白胆固醇|LDL/i.test(display))
        ) {
          ldlHitsDesc.push({
            source,
            timestampMs: obsTimestampMs,
            value: { unit, value: quantity },
          })
        }
      }
    }

    const troponinChronological = [...troponinHitsDesc]
      .reverse()
      .map((item, seq) => ({ ...item, seq }))
      .sort((a, b) => {
        if (a.timestampMs !== undefined && b.timestampMs !== undefined && a.timestampMs !== b.timestampMs) {
          return a.timestampMs - b.timestampMs
        }
        return a.seq - b.seq
      })
    const ADMISSION_LAB_MAX_DELAY_MS = 24 * 60 * 60 * 1000
    const qualifiesAsInpatientAdmissionLab = (timestampMs: number | undefined): boolean => {
      if (inpatientTimingGate === undefined) return true
      if (timestampMs === undefined) return false
      if (
        inpatientTimingGate.admissionAnchorMs !== undefined
        && timestampMs - inpatientTimingGate.admissionAnchorMs > ADMISSION_LAB_MAX_DELAY_MS
      ) {
        return false
      }
      if (inpatientTimingGate.earliestSurgeryMs !== undefined && timestampMs > inpatientTimingGate.earliestSurgeryMs) {
        return false
      }
      if (inpatientTimingGate.earliestMedExecMs !== undefined && timestampMs > inpatientTimingGate.earliestMedExecMs) {
        return false
      }
      return true
    }
    const qualifiesAsInpatientBaselineLab = (timestampMs: number | undefined): boolean => {
      if (inpatientTimingGate === undefined) return true
      if (timestampMs === undefined) return false
      if (inpatientTimingGate.earliestSurgeryMs !== undefined) {
        if (timestampMs > inpatientTimingGate.earliestSurgeryMs) return false
      } else if (
        inpatientTimingGate.admissionAnchorMs !== undefined
        && timestampMs - inpatientTimingGate.admissionAnchorMs > ADMISSION_LAB_MAX_DELAY_MS
      ) {
        return false
      }
      if (inpatientTimingGate.earliestMedExecMs !== undefined && timestampMs > inpatientTimingGate.earliestMedExecMs) {
        return false
      }
      return true
    }

    const initialTroponin = troponinChronological[0]
    let elevatedCardiacBiomarker: ClinicalScoreObjectiveFacts['elevatedCardiacBiomarker']
    if (initialTroponin !== undefined && qualifiesAsInpatientAdmissionLab(initialTroponin.timestampMs)) {
      if (initialTroponin.elevated) {
        elevatedCardiacBiomarker = { source: initialTroponin.source, value: true }
      } else {
        const earlySerialPositive =
          initialTroponin.timestampMs === undefined
            ? undefined
            : troponinChronological.find(
                item =>
                  item.elevated
                  && qualifiesAsInpatientAdmissionLab(item.timestampMs)
                  && item.timestampMs !== undefined
                  && item.timestampMs - initialTroponin.timestampMs! <= 6 * 60 * 60 * 1000,
              )
        elevatedCardiacBiomarker = earlySerialPositive
          ? { source: earlySerialPositive.source, value: true }
          : { source: initialTroponin.source, value: false }
      }
    }

    const creatinineChronological = [...creatinineHitsDesc]
      .reverse()
      .map((item, seq) => ({ ...item, seq }))
      .sort((a, b) => {
        if (a.timestampMs !== undefined && b.timestampMs !== undefined && a.timestampMs !== b.timestampMs) {
          return a.timestampMs - b.timestampMs
        }
        return a.seq - b.seq
      })
    const initialScr = creatinineChronological[0]
    const latestScr = creatinineChronological.at(-1)
    const admissionSerumCreatinine: ClinicalScoreObjectiveFacts['admissionSerumCreatinine'] =
      initialScr !== undefined && qualifiesAsInpatientAdmissionLab(initialScr.timestampMs)
        ? { source: initialScr.source, value: initialScr.value }
        : null
    const baselineSerumCreatinine: ClinicalScoreObjectiveFacts['baselineSerumCreatinine'] =
      initialScr !== undefined && qualifiesAsInpatientBaselineLab(initialScr.timestampMs)
        ? { source: initialScr.source, value: initialScr.value }
        : null
    const serumCreatinine: ClinicalScoreObjectiveFacts['serumCreatinine'] =
      latestScr === undefined ? undefined : { source: latestScr.source, value: latestScr.value }

    const sortChrono = <T extends { timestampMs: number | undefined }>(desc: readonly T[]) =>
      [...desc]
        .reverse()
        .map((item, seq) => ({ ...item, seq }))
        .sort((a, b) => {
          if (a.timestampMs !== undefined && b.timestampMs !== undefined && a.timestampMs !== b.timestampMs) {
            return a.timestampMs - b.timestampMs
          }
          return a.seq - b.seq
        })
    const wbcChronological = sortChrono(wbcHitsDesc)
    const hbChronological = sortChrono(hemoglobinHitsDesc)
    const initialWbc = wbcChronological[0]
    const latestWbc = wbcChronological.at(-1)
    const initialHb = hbChronological[0]
    const latestHb = hbChronological.at(-1)
    const baselineWbc: ClinicalScoreObjectiveFacts['baselineWbc'] =
      initialWbc !== undefined && qualifiesAsInpatientBaselineLab(initialWbc.timestampMs)
        ? { source: initialWbc.source, value: initialWbc.value }
        : null
    const wbc: ClinicalScoreObjectiveFacts['wbc'] =
      latestWbc === undefined ? undefined : { source: latestWbc.source, value: latestWbc.value }
    const baselineHemoglobin: ClinicalScoreObjectiveFacts['baselineHemoglobin'] =
      initialHb !== undefined && qualifiesAsInpatientBaselineLab(initialHb.timestampMs)
        ? { source: initialHb.source, value: initialHb.value }
        : null
    const hemoglobin: ClinicalScoreObjectiveFacts['hemoglobin'] =
      latestHb === undefined ? undefined : { source: latestHb.source, value: latestHb.value }
    const tcChrono = sortChrono(tcHitsDesc)
    const hdlChrono = sortChrono(hdlHitsDesc)
    const latestTc = tcChrono.at(-1)
    const latestHdl = hdlChrono.at(-1)
    const latestLdl = sortChrono(ldlHitsDesc).at(-1)
    const sameSpecimenPair = findLatestSameSpecimenTcHdlPair(tcChrono, hdlChrono)
    const latestLipidObservationMs = [latestLdl?.timestampMs, latestTc?.timestampMs, latestHdl?.timestampMs]
      .filter((item): item is number => item !== undefined)
      .reduce<number | undefined>((max, item) => (max === undefined || item > max ? item : max), undefined)
    const sameSpecimenTcHdl =
      latestTc !== undefined && latestHdl !== undefined
        ? latestTc.specimenKey === latestHdl.specimenKey
        : undefined
    const totalCholesterol: ClinicalScoreObjectiveFacts['totalCholesterol'] =
      latestTc === undefined ? undefined : { source: latestTc.source, value: latestTc.value }
    const hdlCholesterol: ClinicalScoreObjectiveFacts['hdlCholesterol'] =
      latestHdl === undefined ? undefined : { source: latestHdl.source, value: latestHdl.value }
    const ldlCholesterol: ClinicalScoreObjectiveFacts['ldlCholesterol'] =
      latestLdl === undefined ? undefined : { source: latestLdl.source, value: latestLdl.value }
    const nonHdlPairedTcCholesterol: ClinicalScoreObjectiveFacts['nonHdlPairedTcCholesterol'] =
      sameSpecimenPair === undefined ? undefined : { source: sameSpecimenPair.tc.source, value: sameSpecimenPair.tc.value }
    const nonHdlPairedHdlCholesterol: ClinicalScoreObjectiveFacts['nonHdlPairedHdlCholesterol'] =
      sameSpecimenPair === undefined ? undefined : { source: sameSpecimenPair.hdl.source, value: sameSpecimenPair.hdl.value }

    return {
      admissionSerumCreatinine,
      baselineHemoglobin,
      baselineSerumCreatinine,
      baselineWbc,
      elevatedCardiacBiomarker,
      hdlCholesterol,
      hemoglobin,
      latestLipidObservationMs,
      ldlCholesterol,
      nonHdlPairedHdlCholesterol,
      nonHdlPairedTcCholesterol,
      sameSpecimenTcHdl,
      serumCreatinine,
      totalCholesterol,
      wbc,
    }
  }

  #evaluateTroponinElevation(obs: z.infer<typeof observationResourceSchema>): boolean | undefined {
    if (obs.valueBoolean !== undefined) return obs.valueBoolean
    const interpCodes = (obs.interpretation ?? [])
      .flatMap(item => [item.text, ...(item.coding ?? []).map(coding => coding.code)])
      .filter((item): item is string => Boolean(item))
      .map(item => item.trim().toUpperCase())
    if (interpCodes.some(code => ['H', 'HH', 'HU', 'A', 'AA', 'POS', 'POSITIVE', 'HIGH', 'CRITICAL', 'ABNORMAL'].includes(code))) {
      return true
    }
    if (interpCodes.some(code => ['N', 'NORMAL', 'NEG', 'NEGATIVE', 'L', 'LL', 'LOW'].includes(code))) {
      return false
    }
    const quantity = obs.valueQuantity?.value
    const high = obs.referenceRange?.[0]?.high?.value
    if (quantity !== undefined && high !== undefined) return quantity > high
    return undefined
  }

  #extractClinicalHistoryFlags(
    context: ActorContext,
    patientId: string,
    encounterId: string,
    patientBirthDate: string | undefined,
    patientSex: 'male' | 'female' | undefined,
    inpatient: InpatientService | undefined,
    caseId: string,
    cutoffMs: number,
    isArchivedCutoff: boolean,
  ) {
    const encounterTimeCache = new Map<string, number | undefined>()
    const confirmedDiagnoses: ClinicalScoreObjectiveFacts['confirmedDiagnoses'] = []
    let knownCad: ClinicalScoreObjectiveFacts['knownCoronaryRevascularizationOrStenosisGe50']
    let priorCoronaryRevascularization: ClinicalScoreObjectiveFacts['priorCoronaryRevascularization']
    let cadOnsetAgeYears: ClinicalScoreObjectiveFacts['cadOnsetAgeYears']
    let hasUndatedCadRecord = false
    const coronaryEpisodeDays: string[] = []
    const strokeEpisodeDays: string[] = []
    let hasAnyCoronarySevereEvent = false
    let hasAnyStrokeEvent = false
    let hasSubsequentMiCode = false
    let earliestPriorMiRecordedDay: string | undefined
    let latestActiveAcuteAcsRecordedDay: string | undefined
    let earliestPriorStrokeRecordedDay: string | undefined
    let latestActiveStrokeRecordedDay: string | undefined
    const hypertensionConditionRefs = new Set<string>()
    let firstSevereEventRef: ClinicalScoreSourceReference | undefined
    const encounterStartDayCache = new Map<string, string | undefined>()
    const resolveEncounterStartDay = (encRef: string | undefined): string | undefined => {
      if (!encRef?.startsWith('Encounter/')) return undefined
      const encId = encRef.slice('Encounter/'.length)
      if (encounterStartDayCache.has(encId)) return encounterStartDayCache.get(encId)
      let startDay: string | undefined
      try {
        const startIso = extractEncounterStartIso(this.#fhir.read(context, 'Encounter', encId))
        if (startIso && /^\d{4}-\d{2}-\d{2}/.test(startIso)) startDay = startIso.slice(0, 10)
      } catch { /* ignore unreadable external encounter */ }
      encounterStartDayCache.set(encId, startDay)
      return startDay
    }
    const recordCadEventDate = (rawIso: string | undefined, ref: ClinicalScoreSourceReference) => {
      if (!rawIso || !patientBirthDate) {
        hasUndatedCadRecord = true
        return
      }
      const dateStr = rawIso.slice(0, 10)
      const eventAge = completedAgeYears(patientBirthDate, dateStr)
      if (eventAge === undefined) {
        hasUndatedCadRecord = true
        return
      }
      if (cadOnsetAgeYears === undefined || eventAge < cadOnsetAgeYears.value) {
        cadOnsetAgeYears = { source: ref, value: eventAge }
      }
    }

    const conditionParams = new URLSearchParams({ _count: '100', patient: `Patient/${patientId}` })
    for (;;) {
      const page = this.#fhir.search(context, 'Condition', conditionParams)
      for (const raw of page.resources) {
        const parsed = conditionResourceSchema.safeParse(raw)
        if (!parsed.success) continue
        const verStatus = parsed.data.verificationStatus?.coding?.[0]?.code
        const clinStatus = parsed.data.clinicalStatus?.coding?.[0]?.code
        if (verStatus !== 'confirmed') continue
        if (parsed.data.encounter?.reference !== `Encounter/${encounterId}` && Number.isFinite(cutoffMs)) {
          const condTsMs =
            parseResourceTimestampMs(parsed.data.recordedDate ?? parsed.data.onsetDateTime ?? parsed.data.onsetPeriod?.start)
            ?? this.#resolveExternalEncounterStartMs(context, parsed.data.encounter?.reference, encounterTimeCache)
          if (condTsMs === undefined ? isArchivedCutoff : condTsMs > cutoffMs) continue
        }
        const codes = [...new Set((parsed.data.code?.coding ?? []).map(item => item.code?.trim() ?? '').filter(Boolean))]
        const text = [parsed.data.code?.text, ...(parsed.data.code?.coding ?? []).map(item => item.display)].filter(Boolean).join(' ')
        const isHistoricalAscvdOrRevasc =
          codes.some(code => /^(?:I2[0-5]|I6[356]|I70|I73\.9|G45|Z95\.[158]|Z98\.61|Z89|Z82\.4)/i.test(code))
          || codes.includes('22298006')
          || codes.includes('53741008')
          || codes.includes('230690007')
          || /冠心病|冠状动脉|心绞痛|心肌梗死|脑梗死|缺血性卒中|短暂性脑缺血|支架植入|冠脉搭桥|经皮冠状动脉介入|外周动脉|coronary|myocardial infarction|ischemic stroke/i.test(text)
        if ((clinStatus === 'inactive' || clinStatus === 'resolved') && !isHistoricalAscvdOrRevasc) continue
        const ref: ClinicalScoreSourceReference = {
          label: parsed.data.code?.coding?.[0]?.display ?? parsed.data.code?.text ?? `诊断 ${parsed.data.id}`,
          reference: `Condition/${parsed.data.id}`,
          versionId: parsed.data.meta?.versionId ?? '1',
        }
        const conditionEffectiveCodes = [...codes]
        if (!codes.some(code => /^[A-Z]\d/i.test(code))) {
          if (codes.includes('44054006') || codes.includes('73211009') || /糖尿病|diabetes/i.test(text)) {
            conditionEffectiveCodes.push('E11')
          }
          if (
            codes.includes('709044004')
            || (
              /慢性肾脏病|慢性肾功能不全|慢性肾衰竭|糖尿病肾病|chronic kidney disease/i.test(text)
              && !/(?:无|否认|排除|非)\s*(?:慢性肾|糖尿病肾|chronic kidney)/i.test(text)
            )
          ) {
            conditionEffectiveCodes.push('N18')
          }
          if (
            codes.includes('14669001')
            || (
              /急性肾损伤|急性肾衰竭|acute kidney (?:injury|failure)/i.test(text)
              && !/(?:无|否认|排除|非)\s*(?:急性肾|acute kidney)/i.test(text)
            )
          ) {
            conditionEffectiveCodes.push('N17')
          }
          if (codes.includes('38341003') || codes.includes('59621000') || /高血压|hypertension/i.test(text)) {
            conditionEffectiveCodes.push('I10')
          }
          if (codes.includes('370992007') || codes.includes('13644009') || /高脂血症|血脂异常|高胆固醇血症|dyslipidemia|hyperlipidemia/i.test(text)) {
            conditionEffectiveCodes.push('E78')
          }
          if (codes.includes('22298006') || /急性冠脉|急性心肌梗死|不稳定型心绞痛|STEMI|NSTEMI|myocardial infarction/i.test(text)) {
            conditionEffectiveCodes.push('I21')
          } else if (codes.includes('230690007') || /脑梗死|缺血性卒中|ischemic stroke/i.test(text)) {
            conditionEffectiveCodes.push('I63')
          } else if (codes.includes('53741008') || /冠心病|冠状动脉粥样硬化|心绞痛|coronary/i.test(text)) {
            conditionEffectiveCodes.push('I25')
          }
        }
        for (const code of conditionEffectiveCodes) {
          confirmedDiagnoses.push({ code, source: ref })
          if (/^I1[0-5]/i.test(code)) hypertensionConditionRefs.add(ref.reference)
        }
        if (conditionEffectiveCodes.some(code => /^(?:I2[0-5]|Z95\.[15]|Z98\.61)/i.test(code))) {
          recordCadEventDate(
            parsed.data.onsetDateTime ?? parsed.data.onsetPeriod?.start,
            ref,
          )
        }
        const isAcuteAcs = conditionEffectiveCodes.some(code => /^(?:I20\.0|I2[1-4])/i.test(code))
        const isPriorMi = conditionEffectiveCodes.some(code => /^I25\.2/i.test(code))
        const isStroke = conditionEffectiveCodes.some(code => /^I63/i.test(code))
        const onsetRaw = parsed.data.onsetDateTime ?? parsed.data.onsetPeriod?.start
        const onsetDay = onsetRaw && /^\d{4}-\d{2}-\d{2}/.test(onsetRaw) ? onsetRaw.slice(0, 10) : undefined
        const recordedDay =
          parsed.data.recordedDate && /^\d{4}-\d{2}-\d{2}/.test(parsed.data.recordedDate)
            ? parsed.data.recordedDate.slice(0, 10)
            : resolveEncounterStartDay(parsed.data.encounter?.reference)
        const isActiveClinStatus = clinStatus !== 'inactive' && clinStatus !== 'resolved'
        if (isAcuteAcs || isPriorMi) {
          hasAnyCoronarySevereEvent = true
          if (conditionEffectiveCodes.some(code => /^I22/i.test(code))) hasSubsequentMiCode = true
          if (onsetDay !== undefined) {
            coronaryEpisodeDays.push(onsetDay)
          } else if (isAcuteAcs && isActiveClinStatus && recordedDay !== undefined) {
            coronaryEpisodeDays.push(recordedDay)
          }
          if ((isPriorMi || !isActiveClinStatus) && recordedDay !== undefined && (earliestPriorMiRecordedDay === undefined || recordedDay < earliestPriorMiRecordedDay)) {
            earliestPriorMiRecordedDay = recordedDay
          }
          if (isAcuteAcs && isActiveClinStatus && recordedDay !== undefined && (latestActiveAcuteAcsRecordedDay === undefined || recordedDay > latestActiveAcuteAcsRecordedDay)) {
            latestActiveAcuteAcsRecordedDay = recordedDay
          }
          firstSevereEventRef ??= ref
        }
        if (isStroke) {
          hasAnyStrokeEvent = true
          if (onsetDay !== undefined) {
            strokeEpisodeDays.push(onsetDay)
          } else if (isActiveClinStatus && recordedDay !== undefined) {
            strokeEpisodeDays.push(recordedDay)
          }
          if (!isActiveClinStatus && recordedDay !== undefined && (earliestPriorStrokeRecordedDay === undefined || recordedDay < earliestPriorStrokeRecordedDay)) {
            earliestPriorStrokeRecordedDay = recordedDay
          }
          if (isActiveClinStatus && recordedDay !== undefined && (latestActiveStrokeRecordedDay === undefined || recordedDay > latestActiveStrokeRecordedDay)) {
            latestActiveStrokeRecordedDay = recordedDay
          }
          firstSevereEventRef ??= ref
        }
        if (
          priorCoronaryRevascularization === undefined
          && (
            codes.some(code => /^(?:Z95\.[15]|Z98\.61)/i.test(code))
            || /支架植入|冠脉搭桥|经皮冠状动脉介入|coronary angioplasty|coronary bypass/i.test(text)
          )
        ) {
          priorCoronaryRevascularization = { source: ref, value: true }
        }
        if (
          knownCad === undefined
          && (
            codes.some(code => /^(?:Z95\.[15]|Z98\.61|I25\.2)/i.test(code))
            || /支架植入|冠脉搭桥|经皮冠状动脉介入|陈旧性心肌梗死|coronary angioplasty|coronary bypass/i.test(text)
          )
        ) {
          knownCad = { source: ref, value: true }
        }
      }
      if (page.nextCursor === undefined) break
      conditionParams.set('_cursor', page.nextCursor)
    }

    const procedureParams = new URLSearchParams({ _count: '100', patient: `Patient/${patientId}` })
    for (;;) {
      const page = this.#fhir.search(context, 'Procedure', procedureParams)
      for (const raw of page.resources) {
        const parsed = procedureResourceSchema.safeParse(raw)
        if (!parsed.success || parsed.data.status !== 'completed') continue
        if (parsed.data.encounter?.reference !== `Encounter/${encounterId}` && Number.isFinite(cutoffMs)) {
          const procTsMs =
            parseResourceTimestampMs(parsed.data.performedDateTime ?? parsed.data.performedPeriod?.start)
            ?? this.#resolveExternalEncounterStartMs(context, parsed.data.encounter?.reference, encounterTimeCache)
          if (procTsMs === undefined ? isArchivedCutoff : procTsMs > cutoffMs) continue
        }
        const codes = (parsed.data.code?.coding ?? []).map(item => item.code ?? '').filter(Boolean)
        const text = [parsed.data.code?.text, ...(parsed.data.code?.coding ?? []).map(item => item.display)].filter(Boolean).join(' ')
        if (
          codes.some(code => /^(?:00\.66|36\.0[67]|36\.1)/i.test(code))
          || /经皮冠状动脉|冠脉支架|冠状动脉旁路|PCI|CABG|coronary stent|coronary angioplasty/i.test(text)
        ) {
          const ref: ClinicalScoreSourceReference = {
            label: parsed.data.code?.coding?.[0]?.display ?? parsed.data.code?.text ?? `操作 ${parsed.data.id}`,
            reference: `Procedure/${parsed.data.id}`,
            versionId: parsed.data.meta?.versionId ?? '1',
          }
          const procIso = parsed.data.performedDateTime ?? parsed.data.performedPeriod?.start
          const procPrematureCutoff = patientSex === 'female' ? 65 : 55
          if (procIso && patientBirthDate) {
            const procAge = completedAgeYears(patientBirthDate, procIso.slice(0, 10))
            if (procAge !== undefined && procAge < procPrematureCutoff && (cadOnsetAgeYears === undefined || procAge < cadOnsetAgeYears.value)) {
              cadOnsetAgeYears = { source: ref, value: procAge }
            }
          }
          priorCoronaryRevascularization ??= { source: ref, value: true }
          knownCad ??= { source: ref, value: true }
        }
      }
      if (page.nextCursor === undefined) break
      procedureParams.set('_cursor', page.nextCursor)
    }

    if (inpatient !== undefined) {
      for (const report of inpatient.angiography.reports(context, caseId)) {
        if (!['final', 'partial'].includes(report.status)) continue
        let reportVersionId = String(report.version)
        try {
          reportVersionId = this.#fhir.read(context, 'DiagnosticReport', report.id).meta?.versionId ?? reportVersionId
        } catch { /* fallback to report.version */ }
        if (report.vessels.some(vessel => vessel.stenosisPercent >= 50)) {
          const ref: ClinicalScoreSourceReference = {
            label: '冠状动脉造影报告（狭窄≥50%）',
            reference: `DiagnosticReport/${report.id}`,
            versionId: reportVersionId,
          }
          knownCad = { source: ref, value: true }
          break
        }
        if (knownCad === undefined && report.status === 'final' && report.vessels.length > 0) {
          knownCad = {
            source: {
              label: '冠状动脉造影报告（狭窄<50%）',
              reference: `DiagnosticReport/${report.id}`,
              versionId: reportVersionId,
            },
            value: false,
          }
        }
      }
    }

    const prematureCutoff = patientSex === 'female' ? 65 : 55
    if (hasUndatedCadRecord && !(cadOnsetAgeYears !== undefined && cadOnsetAgeYears.value < prematureCutoff)) {
      cadOnsetAgeYears = undefined
    }

    let coronarySevereCount = Math.max(
      countClusteredEventDays(coronaryEpisodeDays),
      hasAnyCoronarySevereEvent ? 1 : 0,
    )
    if (hasSubsequentMiCode) {
      coronarySevereCount = Math.max(coronarySevereCount, 2)
    }
    if (
      coronarySevereCount < 2
      && earliestPriorMiRecordedDay !== undefined
      && latestActiveAcuteAcsRecordedDay !== undefined
      && (Date.parse(latestActiveAcuteAcsRecordedDay) - Date.parse(earliestPriorMiRecordedDay)) / 86_400_000 > 28
    ) {
      coronarySevereCount = 2
    }
    let strokeSevereCount = Math.max(
      countClusteredEventDays(strokeEpisodeDays),
      hasAnyStrokeEvent ? 1 : 0,
    )
    if (
      strokeSevereCount < 2
      && earliestPriorStrokeRecordedDay !== undefined
      && latestActiveStrokeRecordedDay !== undefined
      && (Date.parse(latestActiveStrokeRecordedDay) - Date.parse(earliestPriorStrokeRecordedDay)) / 86_400_000 > 28
    ) {
      strokeSevereCount = 2
    }
    const severeEventTotal = coronarySevereCount + strokeSevereCount

    return {
      cadOnsetAgeYears,
      confirmedDiagnoses,
      hypertensionConditionRefs,
      knownCoronaryRevascularizationOrStenosisGe50: knownCad,
      priorCoronaryRevascularization,
      severeAscvdEventCount:
        firstSevereEventRef === undefined
          ? undefined
          : { source: firstSevereEventRef, value: severeEventTotal },
    }
  }

  #extractAntihypertensiveFlag(
    context: ActorContext,
    patientId: string,
    encounterId: string,
    inpatient: InpatientService | undefined,
    caseId: string,
    nowIso: string,
    hypertensionConditionRefs: ReadonlySet<string>,
    isArchivedCutoff: boolean,
  ): { source?: ClinicalScoreSourceReference; value: boolean } {
    if (inpatient !== undefined) {
      const activeOrders = z.array(z.object({
        catalog_item_id: z.string(),
        display: z.string(),
        order_id: z.string(),
        version: z.number(),
      })).parse(
        this.#database.driver.prepare(`
          SELECT o.order_id, o.catalog_item_id, o.display, o.version
          FROM inpatient_order o
          WHERE o.workspace_id = ? AND o.epoch = ? AND o.admission_id = ?
            AND o.kind = 'medication' AND o.state IN ('signed', 'verified', 'stop-requested')
            AND EXISTS (
              SELECT 1 FROM inpatient_execution e
              WHERE e.workspace_id = o.workspace_id
                AND e.epoch = o.epoch
                AND e.order_id = o.order_id
                AND e.status = 'completed'
            )
        `).all(context.workspaceId, context.epoch, caseId),
      )
      for (const order of activeOrders) {
        if (this.#isAntihypertensiveForHypertension(context, order.catalog_item_id, order.display, hypertensionConditionRefs.size > 0)) {
          return {
            source: {
              label: `在用医嘱 ${order.display}`,
              reference: `MedicationRequest/${order.order_id}`,
              versionId: String(order.version),
            },
            value: true,
          }
        }
      }
    }

    const nowMs = Date.parse(nowIso)
    const encounterTimeCache = new Map<string, number | undefined>()
    const localPrescriptionByMedReqId = this.#readLocalPrescriptionMetaByMedicationRequestId(context)
    const withdrawnIds = new Set(
      z.array(z.object({ medication_request_id: z.string() })).parse(
        this.#database.driver.prepare(`
          SELECT pi.medication_request_id
          FROM prescription_item pi
          JOIN prescription_withdrawal pw
            ON pw.workspace_id = pi.workspace_id
           AND pw.epoch = pi.epoch
           AND pw.prescription_id = pi.prescription_id
          WHERE pi.workspace_id = ? AND pi.epoch = ?
        `).all(context.workspaceId, context.epoch),
      ).map(row => row.medication_request_id),
    )

    const medParams = new URLSearchParams({ _count: '100', patient: `Patient/${patientId}` })
    for (;;) {
      const page = this.#fhir.search(context, 'MedicationRequest', medParams)
      for (const raw of page.resources) {
        const parsed = medicationRequestResourceSchema.safeParse(raw)
        if (!parsed.success || parsed.data.status !== 'active') continue
        if (withdrawnIds.has(parsed.data.id)) continue
        const isCurrentEncounter = parsed.data.encounter?.reference === `Encounter/${encounterId}`
        if (!isCurrentEncounter && Number.isFinite(nowMs)) {
          const medTsMs =
            parseResourceTimestampMs(parsed.data.authoredOn)
            ?? this.#resolveExternalEncounterStartMs(context, parsed.data.encounter?.reference, encounterTimeCache)
          if (medTsMs === undefined ? isArchivedCutoff : medTsMs > nowMs) continue
        }
        const rawHtnBoundsMs = resolveMedicationBoundsDurationMs(
          parsed.data.dosageInstruction?.[0]?.timing?.repeat?.boundsDuration
          ?? parsed.data.dispenseRequest?.expectedSupplyDuration,
        )
        if (rawHtnBoundsMs === 'invalid') continue
        const hasExplicitHtnReason = (parsed.data.reason ?? []).some(reason => {
          const ref = reason.reference?.reference
          if (ref !== undefined && hypertensionConditionRefs.has(ref)) return true
          const codes = (reason.concept?.coding ?? []).map(c => c.code ?? '')
          const text = [reason.concept?.text, ...(reason.concept?.coding ?? []).map(c => c.display)].filter(Boolean).join(' ')
          return codes.some(code => /^(?:I1[0-5]|38341003|59621000)/i.test(code)) || /高血压|hypertension/i.test(text)
        })
        const medRef = parsed.data.medication?.reference?.reference
        const medId = medRef?.startsWith('Medication/') ? medRef.slice('Medication/'.length) : undefined
        const display = [
          parsed.data.medication?.reference?.display,
          parsed.data.medication?.concept?.text,
          ...(parsed.data.medication?.concept?.coding ?? []).map(item => item.display),
        ].filter(Boolean).join(' ')
        if (!this.#isAntihypertensiveForHypertension(context, medId, display, hasExplicitHtnReason)) continue
        const localMeta = localPrescriptionByMedReqId.get(parsed.data.id)
        const delivery = this.#readMedicationDeliveryEvidence(
          context,
          parsed.data.id,
          isCurrentEncounter,
          nowMs,
          isArchivedCutoff,
        )
        // Local outpatient prescriptions are marked active on sign before pharmacy handover
        if (localMeta !== undefined && !delivery.hasEvidence) continue
        const htnBoundsMs = rawHtnBoundsMs ?? localMeta?.courseDurationMs
        const enforceExpiry = !isCurrentEncounter || !isArchivedCutoff
        if (enforceExpiry && Number.isFinite(nowMs)) {
          if (htnBoundsMs !== undefined) {
            const anchorMs = delivery.earliestEvidenceMs ?? parseResourceTimestampMs(parsed.data.authoredOn)
            const inCourseWindow = anchorMs !== undefined && nowMs >= anchorMs && nowMs <= anchorMs + htnBoundsMs
            if (!inCourseWindow && !delivery.hasActiveSupplyAtCutoff) continue
          } else if (!delivery.hasOpenEndedEvidence && !delivery.hasActiveSupplyAtCutoff) {
            continue
          }
        }
        return {
          source: {
            label: `在用处方 ${display || parsed.data.id}`,
            reference: `MedicationRequest/${parsed.data.id}`,
            versionId: parsed.data.meta?.versionId ?? '1',
          },
          value: true,
        }
      }
      if (page.nextCursor === undefined) break
      medParams.set('_cursor', page.nextCursor)
    }

    return { value: false }
  }

  #isAntihypertensiveForHypertension(
    context: RepositoryContext,
    catalogItemId: string | undefined,
    display: string,
    hasHypertensionIndication: boolean,
  ): boolean {
    if (catalogItemId !== undefined) {
      const safety = standardMedicationSafety(catalogItemId)
      if (safety !== undefined) {
        if (!safety.pharmacologyClasses.some(cls => ANTIHYPERTENSIVE_CLASSES.has(cls))) return false
        if (hasHypertensionIndication) return true
        return (
          safety.indicationPrefixes.length > 0
          && safety.indicationPrefixes.every(prefix => /^I1[0-5]/i.test(prefix))
        )
      }
      const row = z.object({ config_json: z.string() }).optional().parse(
        this.#database.driver.prepare(`
          SELECT config_json FROM outpatient_catalog
          WHERE workspace_id = ? AND epoch = ? AND item_id = ?
        `).get(context.workspaceId, context.epoch, catalogItemId),
      )
      if (row !== undefined) {
        const parsed = z.object({
          safety: z.object({
            indicationPrefixes: z.array(z.string()).optional(),
            pharmacologyClasses: z.array(z.string()).optional(),
          }).loose().optional(),
        }).loose().safeParse(JSON.parse(row.config_json))
        if (parsed.success && parsed.data.safety?.pharmacologyClasses?.some(cls => ANTIHYPERTENSIVE_CLASSES.has(cls))) {
          if (hasHypertensionIndication) return true
          const prefixes = parsed.data.safety.indicationPrefixes ?? []
          return prefixes.length > 0 && prefixes.every(prefix => /^I1[0-5]/i.test(prefix))
        }
      }
    }
    return hasHypertensionIndication
      ? ANTIHYPERTENSIVE_TEXT_PATTERN.test(display)
      : PURE_ANTIHYPERTENSIVE_TEXT_PATTERN.test(display)
  }

  #extractPatientLipidStratification(
    context: ActorContext,
    patientId: string,
    encounterId: string,
    caseId: string,
    nowIso: string,
    latestCurrentCaseLipidMs: number | undefined,
    isArchivedCutoff: boolean,
  ): {
    lipidLoweringMedicationActive?: { source: ClinicalScoreSourceReference; value: boolean }
    pretreatmentHdlCholesterol?: { source: ClinicalScoreSourceReference; value: { unit: string; value: number } }
    pretreatmentLdlCholesterol?: { source: ClinicalScoreSourceReference; value: { unit: string; value: number } }
    pretreatmentNonHdlPairedHdlCholesterol?: { source: ClinicalScoreSourceReference; value: { unit: string; value: number } }
    pretreatmentNonHdlPairedTcCholesterol?: { source: ClinicalScoreSourceReference; value: { unit: string; value: number } }
    pretreatmentSameSpecimenTcHdl?: boolean
    pretreatmentTotalCholesterol?: { source: ClinicalScoreSourceReference; value: { unit: string; value: number } }
  } {
    const nowMs = Date.parse(nowIso)
    const encounterTimeCache = new Map<string, number | undefined>()
    const exposures: Array<{
      endMs: number
      source: ClinicalScoreSourceReference
      startMs: number | undefined
    }> = []
    const seenMedicationRequestIds = new Set<string>()

    const readAdminTimestampMs = (adminId: string | null, preferEnd: boolean): number | undefined => {
      if (adminId === null) return undefined
      try {
        const admin = medicationAdministrationResourceSchema.safeParse(
          this.#fhir.read(context, 'MedicationAdministration', adminId),
        )
        if (!admin.success) return undefined
        const adminIso = preferEnd
          ? (
              admin.data.occurencePeriod?.end
              ?? admin.data.occurrencePeriod?.end
              ?? admin.data.effectivePeriod?.end
              ?? admin.data.occurenceDateTime
              ?? admin.data.occurrenceDateTime
              ?? admin.data.effectiveDateTime
              ?? admin.data.recorded
            )
          : (
              admin.data.occurencePeriod?.start
              ?? admin.data.occurrencePeriod?.start
              ?? admin.data.effectivePeriod?.start
              ?? admin.data.occurenceDateTime
              ?? admin.data.occurrenceDateTime
              ?? admin.data.effectiveDateTime
              ?? admin.data.recorded
            )
        const parsed = adminIso ? Date.parse(adminIso) : Number.NaN
        return Number.isFinite(parsed) ? parsed : undefined
      } catch {
        return undefined
      }
    }

    const patientOrders = z.array(z.object({
      admission_id: z.string(),
      catalog_item_id: z.string(),
      display: z.string(),
      order_id: z.string(),
      signed_at: z.string(),
      state: z.string(),
      stopped_at: z.string().nullable(),
      version: z.number(),
    })).parse(
      this.#database.driver.prepare(`
        SELECT o.admission_id, o.order_id, o.catalog_item_id, o.display, o.state, o.version, o.signed_at, o.stopped_at
        FROM inpatient_order o
        JOIN inpatient_admission a
          ON a.workspace_id = o.workspace_id
         AND a.epoch = o.epoch
         AND a.admission_id = o.admission_id
        WHERE o.workspace_id = ? AND o.epoch = ? AND a.patient_id = ?
          AND o.kind = 'medication'
      `).all(context.workspaceId, context.epoch, patientId),
    )
    const completedExecStmt = this.#database.driver.prepare(`
      SELECT scheduled_for, administration_id
      FROM inpatient_execution
      WHERE workspace_id = ? AND epoch = ? AND order_id = ? AND status = 'completed'
    `)
    for (const order of patientOrders) {
      seenMedicationRequestIds.add(order.order_id)
      if (!this.#isLipidLoweringMedication(context, order.catalog_item_id, order.display)) continue
      const completedExecs = z.array(z.object({
        administration_id: z.string().nullable(),
        scheduled_for: z.string(),
      })).parse(completedExecStmt.all(context.workspaceId, context.epoch, order.order_id))
      // An inpatient medication order does not lower serum lipids until at least one dose has been administered
      if (completedExecs.length === 0) {
        continue
      }
      let startMs: number | undefined
      let maxDoseEndMs: number | undefined
      for (const exec of completedExecs) {
        const schedMs = Date.parse(exec.scheduled_for)
        const fallbackSched = Number.isFinite(schedMs) ? schedMs : undefined
        const doseStart = readAdminTimestampMs(exec.administration_id, false) ?? fallbackSched
        const doseEnd = readAdminTimestampMs(exec.administration_id, true) ?? fallbackSched
        if (doseStart !== undefined && (startMs === undefined || doseStart < startMs)) {
          startMs = doseStart
        }
        if (doseEnd !== undefined && (maxDoseEndMs === undefined || doseEnd > maxDoseEndMs)) {
          maxDoseEndMs = doseEnd
        }
      }
      if (order.admission_id !== caseId && Number.isFinite(nowMs) && startMs !== undefined && startMs > nowMs) {
        continue
      }
      const parsedStop = order.stopped_at ? Date.parse(order.stopped_at) : Number.NaN
      const terminalMs = maxDoseEndMs !== undefined ? maxDoseEndMs : parsedStop
      const endMs =
        (order.state === 'stopped' || order.state === 'completed') && Number.isFinite(terminalMs)
          ? terminalMs + LIPID_WASHOUT_MS
          : Number.POSITIVE_INFINITY
      exposures.push({
        endMs,
        source: {
          label: `降脂医嘱 ${order.display}`,
          reference: `MedicationRequest/${order.order_id}`,
          versionId: String(order.version),
        },
        startMs,
      })
    }

    const localPrescriptionByMedReqId = this.#readLocalPrescriptionMetaByMedicationRequestId(context)
    const withdrawnIds = new Set(
      z.array(z.object({ medication_request_id: z.string() })).parse(
        this.#database.driver.prepare(`
          SELECT pi.medication_request_id
          FROM prescription_item pi
          JOIN prescription_withdrawal pw
            ON pw.workspace_id = pi.workspace_id
           AND pw.epoch = pi.epoch
           AND pw.prescription_id = pi.prescription_id
          WHERE pi.workspace_id = ? AND pi.epoch = ?
        `).all(context.workspaceId, context.epoch),
      ).map(row => row.medication_request_id),
    )
    const medParams = new URLSearchParams({ _count: '100', patient: `Patient/${patientId}` })
    for (;;) {
      const page = this.#fhir.search(context, 'MedicationRequest', medParams)
      for (const raw of page.resources) {
        const parsed = medicationRequestResourceSchema.safeParse(raw)
        if (!parsed.success) continue
        if (seenMedicationRequestIds.has(parsed.data.id) || withdrawnIds.has(parsed.data.id)) continue
        const status = parsed.data.status ?? ''
        if (['entered-in-error', 'cancelled', 'draft', 'unknown'].includes(status)) continue
        const medRef = parsed.data.medication?.reference?.reference
        const medId = medRef?.startsWith('Medication/') ? medRef.slice('Medication/'.length) : undefined
        const display = [
          parsed.data.medication?.reference?.display,
          parsed.data.medication?.concept?.text,
          ...(parsed.data.medication?.concept?.coding ?? []).map(item => item.display),
        ].filter(Boolean).join(' ')
        if (!this.#isLipidLoweringMedication(context, medId, display)) continue
        const localPrescription = localPrescriptionByMedReqId.get(parsed.data.id)
        const isCurrentEncounter = parsed.data.encounter?.reference === `Encounter/${encounterId}`
        const enforceStrictCutoff = !isCurrentEncounter || !isArchivedCutoff
        let earliestAnyDispenseMs: number | undefined
        let validDispenseCount = 0
        let hasUntimedDispense = false
        const dispenseWindows: Array<{ endMs: number; startMs: number }> = []
        const unsuppliedDispenseStarts: number[] = []
        const dispenseParams = new URLSearchParams({
          _count: '50',
          prescription: `MedicationRequest/${parsed.data.id}`,
        })
        for (;;) {
          const dispPage = this.#fhir.search(context, 'MedicationDispense', dispenseParams)
          for (const rawDisp of dispPage.resources) {
            const disp = medicationDispenseResourceSchema.safeParse(rawDisp)
            const dispStatus = disp.success ? (disp.data.status ?? '') : ''
            if (!disp.success || ['entered-in-error', 'cancelled', 'declined', 'preparation', 'unknown', ''].includes(dispStatus)) continue
            const handedIso = disp.data.whenHandedOver ?? disp.data.whenPrepared
            const handedMs = parseResourceTimestampMs(handedIso)
            if (handedMs !== undefined && (earliestAnyDispenseMs === undefined || handedMs < earliestAnyDispenseMs)) {
              earliestAnyDispenseMs = handedMs
            }
            if (Number.isFinite(nowMs)) {
              if (handedMs === undefined) {
                if (!isCurrentEncounter && isArchivedCutoff) continue
              } else if (enforceStrictCutoff && handedMs > nowMs) {
                continue
              }
            }
            validDispenseCount += 1
            if (handedMs !== undefined) {
              const supplyMs = resolveMedicationBoundsDurationMs(disp.data.daysSupply)
              if (typeof supplyMs === 'number') {
                dispenseWindows.push({ endMs: handedMs + supplyMs + LIPID_WASHOUT_MS, startMs: handedMs })
              } else {
                unsuppliedDispenseStarts.push(handedMs)
              }
            } else {
              hasUntimedDispense = true
            }
          }
          if (dispPage.nextCursor === undefined) break
          dispenseParams.set('_cursor', dispPage.nextCursor)
        }

        let earliestAnyAdminMs: number | undefined
        let validAdminCount = 0
        let latestAdminMs: number | undefined
        const adminParams = new URLSearchParams({
          _count: '50',
          request: `MedicationRequest/${parsed.data.id}`,
        })
        for (;;) {
          const adminPage = this.#fhir.search(context, 'MedicationAdministration', adminParams)
          for (const rawAdmin of adminPage.resources) {
            const admin = medicationAdministrationResourceSchema.safeParse(rawAdmin)
            const adminStatus = admin.success ? (admin.data.status ?? '') : ''
            if (!admin.success || ['entered-in-error', 'not-done', 'unknown', ''].includes(adminStatus)) continue
            const adminStartIso =
              admin.data.occurencePeriod?.start
              ?? admin.data.occurrencePeriod?.start
              ?? admin.data.effectivePeriod?.start
              ?? admin.data.occurenceDateTime
              ?? admin.data.occurrenceDateTime
              ?? admin.data.effectiveDateTime
              ?? admin.data.recorded
            const adminEndIso =
              admin.data.occurencePeriod?.end
              ?? admin.data.occurrencePeriod?.end
              ?? admin.data.effectivePeriod?.end
              ?? adminStartIso
            const adminStartMs = parseResourceTimestampMs(adminStartIso)
            const adminEndMs = parseResourceTimestampMs(adminEndIso)
            if (adminStartMs !== undefined && (earliestAnyAdminMs === undefined || adminStartMs < earliestAnyAdminMs)) {
              earliestAnyAdminMs = adminStartMs
            }
            if (Number.isFinite(nowMs)) {
              if (adminStartMs === undefined) {
                if (!isCurrentEncounter && isArchivedCutoff) continue
              } else if (enforceStrictCutoff && adminStartMs > nowMs) {
                continue
              }
            }
            validAdminCount += 1
            const effectiveLatest = adminEndMs ?? adminStartMs
            if (effectiveLatest !== undefined && (latestAdminMs === undefined || effectiveLatest > latestAdminMs)) {
              latestAdminMs = effectiveLatest
            }
          }
          if (adminPage.nextCursor === undefined) break
          adminParams.set('_cursor', adminPage.nextCursor)
        }

        // A local outpatient prescription has not begun lowering serum lipids until dispensed by pharmacy
        if (localPrescription !== undefined && validDispenseCount === 0 && validAdminCount === 0 && localPrescription.prescriptionStatus !== 'dispensed') {
          continue
        }
        const actualDeliveryStartMs =
          earliestAnyDispenseMs !== undefined && earliestAnyAdminMs !== undefined
            ? Math.min(earliestAnyDispenseMs, earliestAnyAdminMs)
            : (earliestAnyDispenseMs ?? earliestAnyAdminMs)
        const explicitStartMs = parseResourceTimestampMs(
          parsed.data.effectiveDosePeriod?.start
          ?? parsed.data.dosageInstruction?.[0]?.timing?.repeat?.boundsPeriod?.start,
        )
        const startMs =
          actualDeliveryStartMs
          ?? explicitStartMs
          ?? parseResourceTimestampMs(parsed.data.authoredOn)
          ?? this.#resolveExternalEncounterStartMs(context, parsed.data.encounter?.reference, encounterTimeCache)
        if (
          !isCurrentEncounter
          && Number.isFinite(nowMs)
          && (startMs === undefined ? isArchivedCutoff : startMs > nowMs)
        ) {
          continue
        }
        const rawBoundsMs = resolveMedicationBoundsDurationMs(
          parsed.data.dosageInstruction?.[0]?.timing?.repeat?.boundsDuration
          ?? parsed.data.dispenseRequest?.expectedSupplyDuration,
        )
        const boundsMs = rawBoundsMs === undefined ? localPrescription?.courseDurationMs : rawBoundsMs
        const explicitPeriodEndIso =
          parsed.data.effectiveDosePeriod?.end
          ?? parsed.data.dosageInstruction?.[0]?.timing?.repeat?.boundsPeriod?.end
        const parsedExplicitEnd = explicitPeriodEndIso ? Date.parse(explicitPeriodEndIso) : Number.NaN
        const source: ClinicalScoreSourceReference = {
          label: `降脂处方 ${display || parsed.data.id}`,
          reference: `MedicationRequest/${parsed.data.id}`,
          versionId: parsed.data.meta?.versionId ?? '1',
        }

        for (const w of dispenseWindows) {
          exposures.push({ endMs: w.endMs, source, startMs: w.startMs })
        }

        const allDeliveriesCoveredBySupplyWindows =
          validDispenseCount > 0
          && unsuppliedDispenseStarts.length === 0
          && !hasUntimedDispense
          && validAdminCount === 0

        if (Number.isFinite(parsedExplicitEnd)) {
          exposures.push({ endMs: parsedExplicitEnd + LIPID_WASHOUT_MS, source, startMs })
        } else if (typeof boundsMs === 'number' && startMs !== undefined) {
          exposures.push({ endMs: startMs + boundsMs + LIPID_WASHOUT_MS, source, startMs })
        } else if (!allDeliveriesCoveredBySupplyWindows) {
          let fallbackEndMs = Number.POSITIVE_INFINITY
          if (status === 'completed' || status === 'stopped') {
            let completionEvidenceMs = parsed.data.statusChanged ? Date.parse(parsed.data.statusChanged) : Number.NaN
            if (!Number.isFinite(completionEvidenceMs) && latestAdminMs !== undefined) {
              completionEvidenceMs = latestAdminMs
            }
            if (Number.isFinite(completionEvidenceMs)) {
              fallbackEndMs = completionEvidenceMs + LIPID_WASHOUT_MS
            }
          }
          if (unsuppliedDispenseStarts.length > 0 && !hasUntimedDispense && validAdminCount === 0) {
            for (const uStart of unsuppliedDispenseStarts) {
              exposures.push({ endMs: fallbackEndMs, source, startMs: uStart })
            }
          } else {
            exposures.push({ endMs: fallbackEndMs, source, startMs })
          }
        }
      }
      if (page.nextCursor === undefined) break
      medParams.set('_cursor', page.nextCursor)
    }

    if (exposures.length === 0) {
      return {}
    }

    const hasUndatedExposure = exposures.some(exp => exp.startMs === undefined)
    const activeNowExposure = exposures.find(exp =>
      exp.startMs === undefined
      || ((!Number.isFinite(nowMs) || nowMs >= exp.startMs) && (!Number.isFinite(nowMs) || nowMs <= exp.endMs)),
    )
    const latestCaseTreatedExposure =
      latestCurrentCaseLipidMs === undefined
        ? undefined
        : exposures.find(exp =>
            exp.startMs === undefined
            || (latestCurrentCaseLipidMs > exp.startMs && latestCurrentCaseLipidMs <= exp.endMs),
          )
    const relevantExposure = activeNowExposure ?? latestCaseTreatedExposure
    if (relevantExposure === undefined) {
      return {}
    }

    const isTreatedTimestamp = (tsMs: number | undefined): boolean => {
      if (hasUndatedExposure || tsMs === undefined) return true
      return exposures.some(exp => exp.startMs !== undefined && tsMs > exp.startMs && tsMs <= exp.endMs)
    }

    const revisionIndex = this.#buildReportRevisionIndex(context)
    const excludedObsIds = new Set<string>()
    const reportMetaByObsId = new Map<string, {
      fallbackIso: string | undefined
      reportId: string
      resultIndex: number
      rootReportId: string
    }>()
    const reportParams = new URLSearchParams({ _count: '100', patient: `Patient/${patientId}` })
    for (;;) {
      const page = this.#fhir.search(context, 'DiagnosticReport', reportParams)
      for (const raw of page.resources) {
        const parsed = diagnosticReportResourceSchema.safeParse(raw)
        if (!parsed.success) continue
        const isSupersededOrInvalid =
          revisionIndex.supersededReports.has(parsed.data.id)
          || !['final', 'amended', 'corrected'].includes(parsed.data.status ?? '')
        const rootReportId = revisionIndex.resolveRootMeta(parsed.data.id)?.rootReportId ?? parsed.data.id
        for (const [resultIndex, ref] of (parsed.data.result ?? []).entries()) {
          const obsId = ref.reference?.startsWith('Observation/') ? ref.reference.slice('Observation/'.length) : undefined
          if (!obsId) continue
          if (isSupersededOrInvalid) {
            excludedObsIds.add(obsId)
          } else {
            reportMetaByObsId.set(obsId, {
              fallbackIso: parsed.data.effectiveDateTime ?? parsed.data.issued,
              reportId: parsed.data.id,
              resultIndex,
              rootReportId,
            })
          }
        }
      }
      if (page.nextCursor === undefined) break
      reportParams.set('_cursor', page.nextCursor)
    }

    const untreatedTc: Array<{
      seq: number
      source: ClinicalScoreSourceReference
      specimenKey: string
      timestampMs: number
      value: { unit: string; value: number }
    }> = []
    const untreatedHdl: Array<{
      seq: number
      source: ClinicalScoreSourceReference
      specimenKey: string
      timestampMs: number
      value: { unit: string; value: number }
    }> = []
    const untreatedLdl: Array<{
      seq: number
      source: ClinicalScoreSourceReference
      timestampMs: number
      value: { unit: string; value: number }
    }> = []
    let seq = 0
    const obsParams = new URLSearchParams({ _count: '100', patient: `Patient/${patientId}` })
    for (;;) {
      const page = this.#fhir.search(context, 'Observation', obsParams)
      for (const raw of page.resources) {
        const obs = observationResourceSchema.safeParse(raw)
        if (!obs.success || excludedObsIds.has(obs.data.id)) continue
        if (!['final', 'amended', 'corrected'].includes(obs.data.status ?? '')) continue
        const unit = obs.data.valueQuantity?.code ?? obs.data.valueQuantity?.unit
        const quantity = obs.data.valueQuantity?.value
        if (quantity === undefined || unit === undefined) continue
        const reportMeta = reportMetaByObsId.get(obs.data.id)
        const rawTs = revisionIndex.resolveObservationOriginalIso(
          reportMeta?.reportId,
          reportMeta?.resultIndex,
          obs.data,
          reportMeta?.fallbackIso,
        )
        const timestampMs = parseResourceTimestampMs(rawTs)
        if (obs.data.encounter?.reference !== `Encounter/${encounterId}` && Number.isFinite(nowMs) && timestampMs !== undefined && timestampMs > nowMs) {
          continue
        }
        if (isTreatedTimestamp(timestampMs) || timestampMs === undefined) continue
        const codes = new Set(
          (obs.data.code?.coding ?? [])
            .map(item => item.code?.trim())
            .filter((item): item is string => Boolean(item)),
        )
        const display = [
          obs.data.code?.text,
          ...(obs.data.code?.coding ?? []).map(item => item.display),
        ].filter((item): item is string => Boolean(item)).join(' ')
        const source: ClinicalScoreSourceReference = {
          label: `治疗前基线 ${obs.data.code?.coding?.[0]?.display ?? obs.data.code?.text ?? `检验 ${obs.data.id}`}`,
          reference: `Observation/${obs.data.id}`,
          versionId: obs.data.meta?.versionId ?? '1',
        }
        const specimenKey =
          obs.data.specimen?.reference
          ?? (reportMeta === undefined ? `Observation/${obs.data.id}` : `DiagnosticReport/${reportMeta.rootReportId}`)
        if (codes.has('2000104A') || codes.has('2093-3') || codes.has('14647-2') || /^(?:总胆固醇|total cholesterol)/i.test(display)) {
          untreatedTc.push({ seq: seq++, source, specimenKey, timestampMs, value: { unit, value: quantity } })
        }
        if (codes.has('2000304A') || codes.has('2085-9') || codes.has('14646-4') || /高密度脂蛋白胆固醇|HDL/i.test(display)) {
          untreatedHdl.push({ seq: seq++, source, specimenKey, timestampMs, value: { unit, value: quantity } })
        }
        if (codes.has('2000404A') || codes.has('2089-1') || codes.has('13457-7') || codes.has('18262-6') || /低密度脂蛋白胆固醇|LDL/i.test(display)) {
          untreatedLdl.push({ seq: seq++, source, timestampMs, value: { unit, value: quantity } })
        }
      }
      if (page.nextCursor === undefined) break
      obsParams.set('_cursor', page.nextCursor)
    }

    const sortAsc = <T extends { seq: number; timestampMs: number }>(arr: T[]) =>
      [...arr].sort((a, b) => (a.timestampMs !== b.timestampMs ? a.timestampMs - b.timestampMs : a.seq - b.seq))
    const untreatedTcAsc = sortAsc(untreatedTc)
    const untreatedHdlAsc = sortAsc(untreatedHdl)
    const preTc = untreatedTcAsc.at(-1)
    const preHdl = untreatedHdlAsc.at(-1)
    const preLdl = sortAsc(untreatedLdl).at(-1)
    const preSameSpecimenPair = findLatestSameSpecimenTcHdlPair(untreatedTcAsc, untreatedHdlAsc)
    const pretreatmentSameSpecimenTcHdl =
      preTc !== undefined && preHdl !== undefined ? preTc.specimenKey === preHdl.specimenKey : undefined

    return {
      lipidLoweringMedicationActive: { source: relevantExposure.source, value: true },
      ...(preHdl === undefined ? {} : { pretreatmentHdlCholesterol: { source: preHdl.source, value: preHdl.value } }),
      ...(preLdl === undefined ? {} : { pretreatmentLdlCholesterol: { source: preLdl.source, value: preLdl.value } }),
      ...(preSameSpecimenPair === undefined
        ? {}
        : {
            pretreatmentNonHdlPairedHdlCholesterol: {
              source: preSameSpecimenPair.hdl.source,
              value: preSameSpecimenPair.hdl.value,
            },
            pretreatmentNonHdlPairedTcCholesterol: {
              source: preSameSpecimenPair.tc.source,
              value: preSameSpecimenPair.tc.value,
            },
          }),
      ...(pretreatmentSameSpecimenTcHdl === undefined ? {} : { pretreatmentSameSpecimenTcHdl }),
      ...(preTc === undefined ? {} : { pretreatmentTotalCholesterol: { source: preTc.source, value: preTc.value } }),
    }
  }

  #isLipidLoweringMedication(
    context: RepositoryContext,
    catalogItemId: string | undefined,
    display: string,
  ): boolean {
    if (catalogItemId !== undefined) {
      const safety = standardMedicationSafety(catalogItemId)
      if (safety !== undefined) {
        return safety.pharmacologyClasses.some(cls => LIPID_LOWERING_CLASSES.has(cls))
      }
      const row = z.object({ config_json: z.string() }).optional().parse(
        this.#database.driver.prepare(`
          SELECT config_json FROM outpatient_catalog
          WHERE workspace_id = ? AND epoch = ? AND item_id = ?
        `).get(context.workspaceId, context.epoch, catalogItemId),
      )
      if (row !== undefined) {
        const parsed = z.object({
          safety: z.object({
            pharmacologyClasses: z.array(z.string()).optional(),
          }).loose().optional(),
        }).loose().safeParse(JSON.parse(row.config_json))
        if (parsed.success && parsed.data.safety?.pharmacologyClasses !== undefined) {
          return parsed.data.safety.pharmacologyClasses.some(cls => LIPID_LOWERING_CLASSES.has(cls))
        }
      }
    }
    return LIPID_LOWERING_TEXT_PATTERN.test(display)
  }
}
