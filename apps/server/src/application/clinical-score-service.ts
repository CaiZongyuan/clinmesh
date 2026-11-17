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
  id: z.string().min(1),
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
  id: z.string().min(1),
  meta: z.object({ versionId: z.string().optional() }).loose().optional(),
  performedDateTime: z.string().optional(),
  performedPeriod: z.object({ start: z.string().optional() }).loose().optional(),
  status: z.string().optional(),
}).loose()

const medicationRequestResourceSchema = z.object({
  authoredOn: z.string().optional(),
  dosageInstruction: z.array(z.object({
    timing: z.object({
      repeat: z.object({
        boundsDuration: z.object({
          code: z.string().optional(),
          unit: z.string().optional(),
          value: z.number().finite().positive().optional(),
        }).loose().optional(),
      }).loose().optional(),
    }).loose().optional(),
  }).loose()).optional(),
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
      code: { coding: [{ code: 'prior-bleeding-history', system: RISK_ASSESSMENT_SYSTEM }], text: '既往出血史' },
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

function hasPositiveStDeviationText(text: string): boolean {
  const positivePattern = /ST\s*段?\s*(?:抬高|压低|下移|上抬|偏移|移位)|ST[- ]?(?:segment\s*)?(?:elevation|depression|deviation)/i
  for (const clause of text.split(/[，。；,;！!\r\n]+/)) {
    const trimmed = clause.trim()
    if (!trimmed || !positivePattern.test(trimmed)) continue
    const negMatch = /(?:无|未见|否认|排除)/.exec(trimmed)
    const stMatch = positivePattern.exec(trimmed)
    if (negMatch && stMatch && negMatch.index < stMatch.index && !/(?:但|而|可见|伴|提示|呈)/.test(trimmed.slice(negMatch.index))) {
      continue
    }
    return true
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

  latestInpatientVitalSigns(
    context: Pick<RepositoryContext, 'workspaceId' | 'epoch'>,
    admissionId: string,
  ): InpatientVitalSignsRecord | undefined {
    const row = vitalSignsRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT revision, vital_json, observation_id, observation_version, provenance_id, recorded_at, recorded_by
        FROM inpatient_vital_signs
        WHERE workspace_id = ? AND epoch = ? AND admission_id = ?
        ORDER BY revision DESC
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
      if (previous !== undefined) {
        const oldObservation = transaction.fhir.read(context, 'Observation', previous.observationId)
        const superseded = transaction.fhir.update(
          context,
          { ...oldObservation, status: 'entered-in-error' },
          oldObservation.meta?.versionId ?? previous.observationVersion,
        )
        effects.push({
          kind: 'updated',
          reference: `Observation/${superseded.id}`,
          versionId: superseded.meta?.versionId ?? '2',
        })
      }
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

  outpatientSnapshot(context: ActorContext, caseId: string): ClinicalScoreBundle {
    this.#outpatientContext.requireDoctorCase(context, caseId)
    const row = z.object({
      case_id: z.string(),
      diagnostic_report_id: z.string().nullable(),
      encounter_id: z.string(),
      patient_id: z.string(),
      triage_observation_id: z.string().nullable(),
      triage_observation_version: z.string().nullable(),
      triage_recorded_at: z.string().nullable(),
      vital_json: z.string().nullable(),
    }).optional().parse(
      this.#database.driver.prepare(`
        SELECT outpatient_case.case_id, outpatient_case.patient_id, outpatient_case.encounter_id,
          outpatient_case.diagnostic_report_id, triage.vital_json, triage.recorded_at AS triage_recorded_at,
          triage.observation_id AS triage_observation_id, triage.observation_version AS triage_observation_version
        FROM outpatient_case
        LEFT JOIN triage_record AS triage
          ON triage.workspace_id = outpatient_case.workspace_id
         AND triage.epoch = outpatient_case.epoch
         AND triage.case_id = outpatient_case.case_id
        WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ? AND outpatient_case.case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
    if (row === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The outpatient case was not found')
    const encounter = this.#fhir.read(context, 'Encounter', row.encounter_id)
    const now = this.#outpatientContext.virtualTime(context)
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
    return this.#evaluateSnapshot(context, {
      caseId: row.case_id,
      encounterId: row.encounter_id,
      encounterVersion: encounter.meta?.versionId ?? '1',
      inpatient: undefined,
      legacyDiagnosticReportId: row.diagnostic_report_id,
      now,
      patientId: row.patient_id,
      vitalSummary,
    })
  }

  inpatientSnapshot(inpatient: InpatientService, context: ActorContext, admissionId: string): ClinicalScoreBundle {
    inpatient.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
    const binding = inpatient.readAdmissionBinding(context, admissionId)
    const encounter = this.#fhir.read(context, 'Encounter', admissionId)
    const now = inpatient.virtualTime(context)
    const latestVitals = this.latestInpatientVitalSigns(context, admissionId)
    const vitalSummary: ClinicalScoreVitalSummary | null = latestVitals === undefined
      ? null
      : {
          bloodPressure: latestVitals.bloodPressure,
          ...(latestVitals.heightCm === undefined ? {} : { heightCm: latestVitals.heightCm }),
          observationId: latestVitals.observationId,
          observationVersion: latestVitals.observationVersion,
          oxygenSaturationPct: latestVitals.oxygenSaturationPct,
          pulseBpm: latestVitals.pulseBpm,
          recordedAt: latestVitals.recordedAt,
          respirationBpm: latestVitals.respirationBpm,
          temperatureC: latestVitals.temperatureC,
          ...(latestVitals.weightKg === undefined ? {} : { weightKg: latestVitals.weightKg }),
        }
    return this.#evaluateSnapshot(context, {
      caseId: admissionId,
      encounterId: admissionId,
      encounterVersion: encounter.meta?.versionId ?? '1',
      inpatient,
      legacyDiagnosticReportId: null,
      now,
      patientId: binding.patientId,
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

  #resolveEffectiveStDeviation(
    context: RepositoryContext,
    caseId: string,
    values: ClinicalRiskAssessmentValues,
    bedsideObservation: { observationId: string; observationVersion: string } | null,
  ): EffectiveStSegmentDeviation | null {
    const ecgRow = z.object({
      content_json: z.string(),
      diagnostic_report_id: z.string(),
    }).optional().parse(
      this.#database.driver.prepare(`
        SELECT c.diagnostic_report_id, c.content_json
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
        ORDER BY julianday(c.issued_at) DESC, c.diagnostic_report_id DESC
        LIMIT 1
      `).get(context.workspaceId, context.epoch, caseId),
    )

    if (ecgRow !== undefined) {
      const content = investigationResultContentSchema.safeParse(JSON.parse(ecgRow.content_json))
      if (content.success) {
        const report = this.#fhir.read(context, 'DiagnosticReport', ecgRow.diagnostic_report_id)
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
      }
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

  #evaluateSnapshot(
    context: ActorContext,
    options: {
      caseId: string
      encounterId: string
      encounterVersion: string
      inpatient: InpatientService | undefined
      legacyDiagnosticReportId: string | null
      now: string
      patientId: string
      vitalSummary: ClinicalScoreVitalSummary | null
    },
  ): ClinicalScoreBundle {
    const patient = this.#fhir.read(context, 'Patient', options.patientId)
    const patientRef: ClinicalScoreSourceReference = {
      label: '患者人口学',
      reference: `Patient/${patient.id}`,
      versionId: patient.meta?.versionId ?? '1',
    }
    const age = completedAgeYears(
      typeof patient.birthDate === 'string' ? patient.birthDate : undefined,
      businessDate(options.now),
    )
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

    const birthDateStr = typeof patient.birthDate === 'string' ? patient.birthDate : undefined
    const labs = this.#extractLaboratoryAnalytes(context, options.caseId, options.legacyDiagnosticReportId)
    const history = this.#extractClinicalHistoryFlags(context, options.patientId, birthDateStr, sex, options.inpatient, options.caseId)
    const onAntihypertensive = this.#extractAntihypertensiveFlag(
      context,
      options.patientId,
      options.inpatient,
      options.caseId,
      options.now,
      history.hypertensionConditionRefs,
    )

    const facts: ClinicalScoreObjectiveFacts = {
      ...(age === undefined ? {} : { ageYears: { source: patientRef, value: age } }),
      ...(sex === undefined ? {} : { sex: { source: patientRef, value: sex } }),
      ...(options.vitalSummary === null || vitalRef === undefined
        ? {}
        : {
            heartRateBpm: { source: vitalRef, value: options.vitalSummary.pulseBpm },
            systolicBpMmHg: { source: vitalRef, value: options.vitalSummary.bloodPressure.systolicMmHg },
            ...(options.vitalSummary.weightKg === undefined
              ? {}
              : { weightKg: { source: vitalRef, value: options.vitalSummary.weightKg } }),
          }),
      ...(labs.serumCreatinine === undefined ? {} : { serumCreatinine: labs.serumCreatinine }),
      ...(labs.elevatedCardiacBiomarker === undefined ? {} : { elevatedCardiacBiomarker: labs.elevatedCardiacBiomarker }),
      ...(labs.wbc === undefined ? {} : { wbc: labs.wbc }),
      ...(labs.hemoglobin === undefined ? {} : { hemoglobin: labs.hemoglobin }),
      ...(labs.totalCholesterol === undefined ? {} : { totalCholesterol: labs.totalCholesterol }),
      ...(labs.hdlCholesterol === undefined ? {} : { hdlCholesterol: labs.hdlCholesterol }),
      ...(labs.ldlCholesterol === undefined ? {} : { ldlCholesterol: labs.ldlCholesterol }),
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
      confirmedDiagnoses: history.confirmedDiagnoses,
      ...((history.knownCoronaryRevascularizationOrStenosisGe50
        ?? (riskRef !== undefined && riskAssessment.values.knownCoronaryStenosisGe50 !== null
          ? { source: riskRef, value: riskAssessment.values.knownCoronaryStenosisGe50 }
          : undefined)) === undefined
        ? {}
        : {
            knownCoronaryRevascularizationOrStenosisGe50:
              history.knownCoronaryRevascularizationOrStenosisGe50
              ?? { source: riskRef!, value: riskAssessment.values.knownCoronaryStenosisGe50! },
          }),
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
      evaluatedAt: options.now,
      riskAssessment,
      scores: evaluateClinicalScores(facts),
      vitalSigns: options.vitalSummary,
    }
  }

  #extractLaboratoryAnalytes(
    context: RepositoryContext,
    caseId: string,
    legacyDiagnosticReportId: string | null,
  ) {
    const rows = z.array(z.object({ diagnostic_report_id: z.string() })).parse(
      this.#database.driver.prepare(`
        SELECT r.diagnostic_report_id
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
    const reportIds = rows.map(row => row.diagnostic_report_id)
    if (legacyDiagnosticReportId !== null && !reportIds.includes(legacyDiagnosticReportId)) {
      reportIds.push(legacyDiagnosticReportId)
    }

    let serumCreatinine: ClinicalScoreObjectiveFacts['serumCreatinine']
    let elevatedCardiacBiomarker: ClinicalScoreObjectiveFacts['elevatedCardiacBiomarker']
    let wbc: ClinicalScoreObjectiveFacts['wbc']
    let hemoglobin: ClinicalScoreObjectiveFacts['hemoglobin']
    let totalCholesterol: ClinicalScoreObjectiveFacts['totalCholesterol']
    let hdlCholesterol: ClinicalScoreObjectiveFacts['hdlCholesterol']
    let ldlCholesterol: ClinicalScoreObjectiveFacts['ldlCholesterol']

    for (const reportId of reportIds) {
      const rawReport = this.#fhir.read(context, 'DiagnosticReport', reportId)
      const report = diagnosticReportResourceSchema.safeParse(rawReport)
      if (!report.success || !['final', 'amended', 'corrected'].includes(report.data.status ?? '')) continue
      for (const ref of report.data.result ?? []) {
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

        if (
          serumCreatinine === undefined
          && quantity !== undefined
          && unit !== undefined
          && (codes.has('1700404A') || codes.has('2160-0') || codes.has('14682-9') || /^(?:血?肌酐|血清肌酐)/i.test(display))
        ) {
          serumCreatinine = { source, value: { unit, value: quantity } }
        }
        if (
          elevatedCardiacBiomarker === undefined
          && (
            codes.has('2100404B') || codes.has('2100404A') || codes.has('2100504A')
            || codes.has('89579-7') || codes.has('49563-0') || codes.has('10839-9')
            || codes.has('6598-7') || codes.has('6597-9') || codes.has('67151-1') || codes.has('42757-5')
            || /肌钙蛋白|troponin/i.test(display)
          )
        ) {
          const elevated = this.#evaluateTroponinElevation(obs.data)
          if (elevated !== undefined) elevatedCardiacBiomarker = { source, value: elevated }
        }
        if (
          wbc === undefined
          && quantity !== undefined
          && unit !== undefined
          && (codes.has('0100101A') || codes.has('6690-2') || codes.has('26464-8') || /白细胞计数/i.test(display))
        ) {
          wbc = { source, value: { unit, value: quantity } }
        }
        if (
          hemoglobin === undefined
          && quantity !== undefined
          && unit !== undefined
          && (codes.has('0100401A') || codes.has('718-7') || /^(?:血红蛋白|hemoglobin)$/i.test(display.trim()))
        ) {
          hemoglobin = { source, value: { unit, value: quantity } }
        }
        if (
          totalCholesterol === undefined
          && quantity !== undefined
          && unit !== undefined
          && (codes.has('2000104A') || codes.has('2093-3') || codes.has('14647-2') || /^(?:总胆固醇|total cholesterol)/i.test(display))
        ) {
          totalCholesterol = { source, value: { unit, value: quantity } }
        }
        if (
          hdlCholesterol === undefined
          && quantity !== undefined
          && unit !== undefined
          && (codes.has('2000304A') || codes.has('2085-9') || codes.has('14646-4') || /高密度脂蛋白胆固醇|HDL/i.test(display))
        ) {
          hdlCholesterol = { source, value: { unit, value: quantity } }
        }
        if (
          ldlCholesterol === undefined
          && quantity !== undefined
          && unit !== undefined
          && (codes.has('2000404A') || codes.has('2089-1') || codes.has('13457-7') || codes.has('18262-6') || /低密度脂蛋白胆固醇|LDL/i.test(display))
        ) {
          ldlCholesterol = { source, value: { unit, value: quantity } }
        }
      }
    }

    return {
      elevatedCardiacBiomarker,
      hdlCholesterol,
      hemoglobin,
      ldlCholesterol,
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
    patientBirthDate: string | undefined,
    patientSex: 'male' | 'female' | undefined,
    inpatient: InpatientService | undefined,
    caseId: string,
  ) {
    const confirmedDiagnoses: ClinicalScoreObjectiveFacts['confirmedDiagnoses'] = []
    let knownCad: ClinicalScoreObjectiveFacts['knownCoronaryRevascularizationOrStenosisGe50']
    let priorCoronaryRevascularization: ClinicalScoreObjectiveFacts['priorCoronaryRevascularization']
    let cadOnsetAgeYears: ClinicalScoreObjectiveFacts['cadOnsetAgeYears']
    let hasUndatedCadRecord = false
    const coronaryExplicitEventKeys = new Set<string>()
    const strokeExplicitEventKeys = new Set<string>()
    let hasAnyCoronarySevereEvent = false
    let hasAnyStrokeEvent = false
    let hasSubsequentMiCode = false
    let earliestPriorMiRecordedDay: string | undefined
    let earliestAcuteAcsRecordedDay: string | undefined
    let latestActiveAcuteAcsRecordedDay: string | undefined
    const hypertensionConditionRefs = new Set<string>()
    let firstSevereEventRef: ClinicalScoreSourceReference | undefined
    const extractExplicitEventKey = (cond: z.infer<typeof conditionResourceSchema>): string | undefined => {
      const onsetRaw = cond.onsetDateTime ?? cond.onsetPeriod?.start
      if (onsetRaw && /^\d{4}-\d{2}-\d{2}/.test(onsetRaw)) {
        return `onset:${onsetRaw.slice(0, 10)}`
      }
      const ident = cond.identifier?.find(item => item.value?.trim())?.value?.trim()
      return ident ? `id:${ident}` : undefined
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
            parsed.data.onsetDateTime ?? parsed.data.onsetPeriod?.start ?? parsed.data.recordedDate,
            ref,
          )
        }
        const isAcuteAcs = conditionEffectiveCodes.some(code => /^(?:I20\.0|I2[1-4])/i.test(code))
        const isPriorMi = conditionEffectiveCodes.some(code => /^I25\.2/i.test(code))
        const isStroke = conditionEffectiveCodes.some(code => /^I63/i.test(code))
        const explicitEventKey = extractExplicitEventKey(parsed.data)
        const recordedDay =
          parsed.data.recordedDate && /^\d{4}-\d{2}-\d{2}/.test(parsed.data.recordedDate)
            ? parsed.data.recordedDate.slice(0, 10)
            : undefined
        if (isAcuteAcs || isPriorMi) {
          hasAnyCoronarySevereEvent = true
          if (conditionEffectiveCodes.some(code => /^I22/i.test(code))) hasSubsequentMiCode = true
          if (explicitEventKey !== undefined) coronaryExplicitEventKeys.add(explicitEventKey)
          if (isPriorMi && recordedDay !== undefined && (earliestPriorMiRecordedDay === undefined || recordedDay < earliestPriorMiRecordedDay)) {
            earliestPriorMiRecordedDay = recordedDay
          }
          if (isAcuteAcs && recordedDay !== undefined) {
            if (earliestAcuteAcsRecordedDay === undefined || recordedDay < earliestAcuteAcsRecordedDay) {
              earliestAcuteAcsRecordedDay = recordedDay
            }
            if (clinStatus !== 'inactive' && clinStatus !== 'resolved' && (latestActiveAcuteAcsRecordedDay === undefined || recordedDay > latestActiveAcuteAcsRecordedDay)) {
              latestActiveAcuteAcsRecordedDay = recordedDay
            }
          }
          firstSevereEventRef ??= ref
        }
        if (isStroke) {
          hasAnyStrokeEvent = true
          if (explicitEventKey !== undefined) strokeExplicitEventKeys.add(explicitEventKey)
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
          recordCadEventDate(parsed.data.performedDateTime ?? parsed.data.performedPeriod?.start, ref)
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

    let coronarySevereCount =
      coronaryExplicitEventKeys.size > 0 ? coronaryExplicitEventKeys.size : (hasAnyCoronarySevereEvent ? 1 : 0)
    if (hasSubsequentMiCode) {
      coronarySevereCount = Math.max(coronarySevereCount, 2)
    }
    if (
      coronarySevereCount < 2
      && earliestPriorMiRecordedDay !== undefined
      && latestActiveAcuteAcsRecordedDay !== undefined
      && (earliestAcuteAcsRecordedDay === undefined || earliestPriorMiRecordedDay < earliestAcuteAcsRecordedDay)
      && (Date.parse(latestActiveAcuteAcsRecordedDay) - Date.parse(earliestPriorMiRecordedDay)) / 86_400_000 > 28
    ) {
      coronarySevereCount = 2
    }
    const strokeSevereCount =
      strokeExplicitEventKeys.size > 0 ? strokeExplicitEventKeys.size : (hasAnyStrokeEvent ? 1 : 0)
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
    inpatient: InpatientService | undefined,
    caseId: string,
    nowIso: string,
    hypertensionConditionRefs: ReadonlySet<string>,
  ): { source?: ClinicalScoreSourceReference; value: boolean } {
    if (inpatient !== undefined) {
      const activeOrders = z.array(z.object({
        catalog_item_id: z.string(),
        display: z.string(),
        order_id: z.string(),
        version: z.number(),
      })).parse(
        this.#database.driver.prepare(`
          SELECT order_id, catalog_item_id, display, version
          FROM inpatient_order
          WHERE workspace_id = ? AND epoch = ? AND admission_id = ?
            AND kind = 'medication' AND state IN ('signed', 'verified')
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
        if (parsed.data.authoredOn !== undefined && Number.isFinite(nowMs)) {
          const authoredMs = Date.parse(parsed.data.authoredOn)
          const bounds = parsed.data.dosageInstruction?.[0]?.timing?.repeat?.boundsDuration
          if (Number.isFinite(authoredMs) && bounds?.value !== undefined) {
            const unit = (bounds.code ?? bounds.unit ?? 'd').toLowerCase()
            const multiplierMs = unit.startsWith('h') ? 3_600_000 : unit.startsWith('w') ? 7 * 86_400_000 : 86_400_000
            if (authoredMs + bounds.value * multiplierMs < nowMs) continue
          }
        }
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
        if (this.#isAntihypertensiveForHypertension(context, medId, display, hasExplicitHtnReason)) {
          return {
            source: {
              label: `在用处方 ${display || parsed.data.id}`,
              reference: `MedicationRequest/${parsed.data.id}`,
              versionId: parsed.data.meta?.versionId ?? '1',
            },
            value: true,
          }
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
}
