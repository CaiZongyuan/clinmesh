import { coronaryVesselSchema } from '@clinmesh/contracts/inpatient-angiography'
import {
  patientPersonaContentSchema,
  type PatientPersonaContent,
  type SyntheticPatientProfile,
} from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import { personaLeaksDiagnosis } from '../patient-persona-service.ts'
import { canonicalJsonHash } from './canonical-json.ts'
import type { SourcePatientArtifact } from './provider.ts'
import { compileSyntheaIndexCase, type CompiledSyntheaIndexCase } from './synthea-index-case.ts'
import { createSyntheticPatientProfiles } from './synthetic-patient-profile.ts'
import {
  CASE_TRUTH_STAGES,
  EXAMINATION_CONCLUSION_SYSTEM,
  EXAMINATION_ECG_SYSTEM,
  EXAMINATION_EXAM_CODE_EXTENSION_URL,
  EXAMINATION_SERVICE_SYSTEM,
  EXAMINATION_TTE_SYSTEM,
  TRUTH_STAGE_EXTENSION_URL,
  type CaseTruthStage,
} from './truth-stage.ts'

const idSchema = z.string().min(1).max(128)
const isoDateTimeSchema = z.iso.datetime({ offset: true })
const stageSchema = z.enum(CASE_TRUTH_STAGES)

export const authoredCodingSchema = z.object({
  code: z.string().min(1).max(128),
  display: z.string().min(1).max(256),
  system: z.string().min(1).max(256),
  version: z.string().min(1).max(64).optional(),
}).strict()

export const authoredConditionSchema = z.object({
  code: z.string().min(1).max(64),
  display: z.string().min(1).max(256),
  id: idSchema,
  note: z.string().min(1).max(2000).optional(),
  system: z.string().min(1).max(256),
  version: z.string().min(1).max(64).optional(),
}).strict()

export const authoredLabObservationSchema = z.object({
  codings: z.array(authoredCodingSchema).min(1).max(8),
  effectiveDateTime: isoDateTimeSchema.optional(),
  id: idSchema,
  interpretation: z.enum(['H', 'L', 'N']).optional(),
  referenceRange: z.object({
    high: z.number().finite().optional(),
    low: z.number().finite().optional(),
    text: z.string().min(1).max(500),
  }).strict().optional(),
  stage: stageSchema.optional(),
  unit: z.string().min(1).max(64),
  unitDisplay: z.string().min(1).max(64).optional(),
  value: z.number().finite(),
}).strict()

export const authoredEcgTruthSchema = z.object({
  conclusion: z.string().trim().min(1).max(1000),
  effectiveDateTime: isoDateTimeSchema.optional(),
  prIntervalMs: z.number().finite().min(0).max(1000),
  qrsDurationMs: z.number().finite().min(0).max(1000),
  qtcIntervalMs: z.number().finite().min(0).max(1000),
  rhythm: z.string().trim().min(1).max(200),
  stage: stageSchema.optional(),
  stTAnterior: z.string().trim().min(1).max(500),
  stTInferior: z.string().trim().min(1).max(500),
  stTLateral: z.string().trim().min(1).max(500),
  ventricularRateBpm: z.number().finite().min(0).max(1000),
}).strict()

export const authoredTteTruthSchema = z.object({
  conclusion: z.string().trim().min(1).max(1000),
  diastolicFunction: z.string().trim().min(1).max(500),
  effectiveDateTime: isoDateTimeSchema.optional(),
  lveddMm: z.number().finite().min(0).max(1000),
  lvefPercent: z.number().finite().min(0).max(100),
  regionalWallMotion: z.string().trim().min(1).max(500),
  stage: stageSchema.optional(),
  valves: z.string().trim().min(1).max(500),
}).strict()

export const authoredAngiographyVesselSchema = z.object({
  ffr: z.number().finite().min(0).max(1.5).optional(),
  ifr: z.number().finite().min(0).max(1.5).optional(),
  lesionCharacteristics: z.string().trim().min(1).max(1000),
  segment: z.string().trim().min(1).max(200),
  stenosisPercent: z.number().finite().min(0).max(100),
  timiFlow: z.number().int().min(0).max(3),
  vessel: coronaryVesselSchema,
}).strict()

export const authoredAngiographyTruthSchema = z.object({
  conclusion: z.string().trim().min(1).max(2000),
  qca: z.object({
    distalReferenceDiameterMm: z.number().positive().finite().max(1000),
    lesionLengthMm: z.number().positive().finite().max(1000),
    method: z.string().trim().min(1).max(200).optional(),
    proximalReferenceDiameterMm: z.number().positive().finite().max(1000),
    targetSite: z.string().trim().min(1).max(200),
  }).strict().optional(),
  vessels: z.array(authoredAngiographyVesselSchema).min(1).max(32),
}).strict()

export const authoredVisibleHistoryEventSchema = z.object({
  conditions: z.array(authoredConditionSchema).default([]),
  encounterDateTime: isoDateTimeSchema,
  id: idSchema,
  medications: z.array(z.object({
    code: z.string().min(1).max(128),
    display: z.string().min(1).max(256),
    dosageText: z.string().min(1).max(500).optional(),
    id: idSchema,
    system: z.string().min(1).max(256).default('urn:clinmesh:reference:drug-concept'),
  }).strict()).default([]),
  observations: z.array(authoredLabObservationSchema).default([]),
  reasonText: z.string().trim().min(1).max(500),
}).strict()

export const authoredCaseDefinitionSchema = z.object({
  angiography: authoredAngiographyTruthSchema.optional(),
  chiefComplaint: z.string().trim().min(1).max(500),
  ecgs: z.array(authoredEcgTruthSchema).default([]),
  id: idSchema,
  indexConditions: z.array(authoredConditionSchema).min(1),
  indexDateTime: isoDateTimeSchema,
  laboratories: z.array(authoredLabObservationSchema).min(1),
  patient: z.object({
    birthDate: z.iso.date(),
    gender: z.enum(['female', 'male']),
    id: idSchema,
    name: z.string().trim().min(1).max(128),
  }).strict(),
  persona: z.object({
    content: patientPersonaContentSchema,
    version: idSchema,
  }).strict(),
  plannedStentCount: z.number().int().min(0),
  recommendedEntry: z.enum(['outpatient', 'inpatient']),
  title: z.string().trim().min(1).max(200),
  titleEn: z.string().trim().min(1).max(200),
  ttes: z.array(authoredTteTruthSchema).default([]),
  visibleHistory: z.array(authoredVisibleHistoryEventSchema).default([]),
}).strict()

export const authoredCasePackDefinitionSchema = z.object({
  cases: z.array(authoredCaseDefinitionSchema).min(1),
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().min(1).max(200),
  version: idSchema,
}).strict()

export type AuthoredCaseDefinitionInput = z.input<typeof authoredCaseDefinitionSchema>
export type AuthoredCaseDefinition = z.infer<typeof authoredCaseDefinitionSchema>
export type AuthoredCasePackDefinitionInput = z.input<typeof authoredCasePackDefinitionSchema>
export type AuthoredCasePackDefinition = z.infer<typeof authoredCasePackDefinitionSchema>
export type AuthoredLabObservation = z.infer<typeof authoredLabObservationSchema>
export type AuthoredEcgTruth = z.infer<typeof authoredEcgTruthSchema>
export type AuthoredTteTruth = z.infer<typeof authoredTteTruthSchema>

export interface CompiledAuthoredCase {
  compiled: CompiledSyntheaIndexCase
  definition: AuthoredCaseDefinition
  persona: {
    content: PatientPersonaContent
    promptHash: string
    version: string
  }
  source: SourcePatientArtifact
}

export interface CompiledAuthoredCasePack {
  cases: readonly CompiledAuthoredCase[]
  contentHash: string
  id: string
  name: string
  nameEn: string
  version: string
}

export class AuthoredCasePackCompileError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'AuthoredCasePackCompileError'
  }
}

const ecgSystem = EXAMINATION_ECG_SYSTEM
const tteSystem = EXAMINATION_TTE_SYSTEM
const examServiceSystem = EXAMINATION_SERVICE_SYSTEM
const examConclusionSystem = EXAMINATION_CONCLUSION_SYSTEM
const angioSystem = 'urn:clinmesh:synthetic:coronary-angiography'
const ucumSystem = 'http://unitsofmeasure.org'
const loincSystem = 'http://loinc.org'
const interpretationSystem = 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation'

function stageExtension(stage: CaseTruthStage | undefined) {
  return stage === undefined ? [] : [{ url: TRUTH_STAGE_EXTENSION_URL, valueCode: stage }]
}

function buildLabObservationResource(input: {
  encounterRef: string
  fallbackTime: string
  observation: AuthoredLabObservation
  patientRef: string
  prefix: string
}) {
  const obs = input.observation
  const id = `${input.prefix}-${obs.id}`
  const extensions = stageExtension(obs.stage)
  return {
    fullUrl: `urn:uuid:${id}`,
    resource: {
      code: {
        coding: obs.codings.map(c => ({
          code: c.code,
          display: c.display,
          system: c.system,
          ...(c.version === undefined ? {} : { version: c.version }),
        })),
        text: obs.codings[0]!.display,
      },
      effectiveDateTime: obs.effectiveDateTime ?? input.fallbackTime,
      encounter: { reference: input.encounterRef },
      ...(extensions.length === 0 ? {} : { extension: extensions }),
      id,
      ...(obs.interpretation === undefined
        ? {}
        : { interpretation: [{ coding: [{ code: obs.interpretation, system: interpretationSystem }] }] }),
      ...(obs.referenceRange === undefined
        ? {}
        : {
            referenceRange: [{
              ...(obs.referenceRange.high === undefined ? {} : { high: { code: obs.unit, system: ucumSystem, unit: obs.unitDisplay ?? obs.unit, value: obs.referenceRange.high } }),
              ...(obs.referenceRange.low === undefined ? {} : { low: { code: obs.unit, system: ucumSystem, unit: obs.unitDisplay ?? obs.unit, value: obs.referenceRange.low } }),
              text: obs.referenceRange.text,
            }],
          }),
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: input.patientRef },
      valueQuantity: {
        code: obs.unit,
        system: ucumSystem,
        unit: obs.unitDisplay ?? obs.unit,
        value: obs.value,
      },
    },
  }
}

function examMetricComponent(input: {
  code: string
  display: string
  loincCode?: string
  system: string
  unit?: string
  value: number | string
}) {
  return {
    code: {
      coding: [
        { code: input.code, display: input.display, system: input.system },
        { code: input.code, display: input.display, system: examServiceSystem },
        ...(input.loincCode === undefined ? [] : [{ code: input.loincCode, display: input.display, system: loincSystem }]),
      ],
      text: input.display,
    },
    ...(typeof input.value === 'number'
      ? { valueQuantity: { code: input.unit!, system: ucumSystem, unit: input.unit!, value: input.value } }
      : { valueString: input.value }),
  }
}

function buildEcgEntries(input: {
  caseId: string
  ecg: AuthoredEcgTruth
  encounterRef: string
  fallbackTime: string
  index: number
  patientRef: string
}) {
  const stageSuffix = input.ecg.stage ?? `base-${input.index}`
  const panelId = `${input.caseId}-ecg-${stageSuffix}`
  const conclusionId = `${input.caseId}-ecg-conclusion-${stageSuffix}`
  const time = input.ecg.effectiveDateTime ?? input.fallbackTime
  const stageExts = stageExtension(input.ecg.stage)
  return [
    {
      fullUrl: `urn:uuid:${panelId}`,
      resource: {
        code: {
          coding: [{ code: 'ecg-12-lead', display: '常规十二导联心电图', system: ecgSystem }],
          text: '常规十二导联心电图',
        },
        component: [
          examMetricComponent({ code: 'rhythm', display: '心律', system: ecgSystem, value: input.ecg.rhythm }),
          examMetricComponent({ code: 'ventricular-rate', display: '心室率', loincCode: '8867-4', system: ecgSystem, unit: '/min', value: input.ecg.ventricularRateBpm }),
          examMetricComponent({ code: 'pr-interval', display: 'PR 间期', loincCode: '8625-6', system: ecgSystem, unit: 'ms', value: input.ecg.prIntervalMs }),
          examMetricComponent({ code: 'qrs-duration', display: 'QRS 时限', loincCode: '8633-0', system: ecgSystem, unit: 'ms', value: input.ecg.qrsDurationMs }),
          examMetricComponent({ code: 'qtc-interval', display: 'QTc 间期', loincCode: '8636-3', system: ecgSystem, unit: 'ms', value: input.ecg.qtcIntervalMs }),
          examMetricComponent({ code: 'st-t-anterior', display: '前壁导联组 ST-T', system: ecgSystem, value: input.ecg.stTAnterior }),
          examMetricComponent({ code: 'st-t-inferior', display: '下壁导联组 ST-T', system: ecgSystem, value: input.ecg.stTInferior }),
          examMetricComponent({ code: 'st-t-lateral', display: '侧壁导联组 ST-T', system: ecgSystem, value: input.ecg.stTLateral }),
        ],
        effectiveDateTime: time,
        encounter: { reference: input.encounterRef },
        ...(stageExts.length === 0 ? {} : { extension: stageExts }),
        id: panelId,
        resourceType: 'Observation',
        status: 'final',
        subject: { reference: input.patientRef },
      },
    },
    {
      fullUrl: `urn:uuid:${conclusionId}`,
      resource: {
        code: {
          coding: [{ code: 'ecg-12-lead', display: '心电图结论', system: examConclusionSystem }],
          text: '心电图结论',
        },
        effectiveDateTime: time,
        encounter: { reference: input.encounterRef },
        extension: [
          { url: EXAMINATION_EXAM_CODE_EXTENSION_URL, valueCode: 'ecg-12-lead' },
          ...stageExts,
        ],
        id: conclusionId,
        resourceType: 'Observation',
        status: 'final',
        subject: { reference: input.patientRef },
        valueString: input.ecg.conclusion,
      },
    },
  ]
}

function buildTteEntries(input: {
  caseId: string
  encounterRef: string
  fallbackTime: string
  index: number
  patientRef: string
  tte: AuthoredTteTruth
}) {
  const stageSuffix = input.tte.stage ?? `base-${input.index}`
  const panelId = `${input.caseId}-tte-${stageSuffix}`
  const conclusionId = `${input.caseId}-tte-conclusion-${stageSuffix}`
  const time = input.tte.effectiveDateTime ?? input.fallbackTime
  const stageExts = stageExtension(input.tte.stage)
  return [
    {
      fullUrl: `urn:uuid:${panelId}`,
      resource: {
        code: {
          coding: [{ code: 'tte', display: '经胸超声心动图', system: tteSystem }],
          text: '经胸超声心动图',
        },
        component: [
          examMetricComponent({ code: 'lvef', display: '左室射血分数 LVEF', loincCode: '10230-1', system: tteSystem, unit: '%', value: input.tte.lvefPercent }),
          examMetricComponent({ code: 'lvedd', display: '左室舒张末期内径', loincCode: '29468-6', system: tteSystem, unit: 'mm', value: input.tte.lveddMm }),
          examMetricComponent({ code: 'regional-wall-motion', display: '室壁节段运动', system: tteSystem, value: input.tte.regionalWallMotion }),
          examMetricComponent({ code: 'valves', display: '瓣膜', system: tteSystem, value: input.tte.valves }),
          examMetricComponent({ code: 'diastolic-function', display: '舒张功能', system: tteSystem, value: input.tte.diastolicFunction }),
        ],
        effectiveDateTime: time,
        encounter: { reference: input.encounterRef },
        ...(stageExts.length === 0 ? {} : { extension: stageExts }),
        id: panelId,
        resourceType: 'Observation',
        status: 'final',
        subject: { reference: input.patientRef },
      },
    },
    {
      fullUrl: `urn:uuid:${conclusionId}`,
      resource: {
        code: {
          coding: [{ code: 'tte', display: '超声心动图结论', system: examConclusionSystem }],
          text: '超声心动图结论',
        },
        effectiveDateTime: time,
        encounter: { reference: input.encounterRef },
        extension: [
          { url: EXAMINATION_EXAM_CODE_EXTENSION_URL, valueCode: 'tte' },
          ...stageExts,
        ],
        id: conclusionId,
        resourceType: 'Observation',
        status: 'final',
        subject: { reference: input.patientRef },
        valueString: input.tte.conclusion,
      },
    },
  ]
}

function buildAngiographyEntries(input: {
  angiography: NonNullable<AuthoredCaseDefinition['angiography']>
  caseId: string
  encounterRef: string
  fallbackTime: string
  patientRef: string
}) {
  const entries: Array<{ fullUrl: string; resource: Record<string, unknown> }> = []
  for (const [index, vessel] of input.angiography.vessels.entries()) {
    const id = `${input.caseId}-angio-vessel-${index + 1}`
    const components: Array<Record<string, unknown>> = [
      { code: { coding: [{ code: 'vessel', system: angioSystem }] }, valueString: vessel.vessel },
      { code: { coding: [{ code: 'segment', system: angioSystem }] }, valueString: vessel.segment },
      { code: { coding: [{ code: 'stenosis-percent', system: angioSystem }] }, valueQuantity: { code: '%', system: ucumSystem, unit: '%', value: vessel.stenosisPercent } },
      { code: { coding: [{ code: 'timi-flow', system: angioSystem }] }, valueInteger: vessel.timiFlow },
      { code: { coding: [{ code: 'lesion-characteristics', system: angioSystem }] }, valueString: vessel.lesionCharacteristics },
    ]
    if (vessel.ffr !== undefined) {
      components.push({ code: { coding: [{ code: 'ffr', system: angioSystem }] }, valueQuantity: { code: '1', system: ucumSystem, unit: '1', value: vessel.ffr } })
    }
    if (vessel.ifr !== undefined) {
      components.push({ code: { coding: [{ code: 'ifr', system: angioSystem }] }, valueQuantity: { code: '1', system: ucumSystem, unit: '1', value: vessel.ifr } })
    }
    entries.push({
      fullUrl: `urn:uuid:${id}`,
      resource: {
        bodySite: { text: vessel.segment },
        code: { coding: [{ code: 'vessel-finding', display: '冠脉节段造影所见', system: angioSystem }] },
        component: components,
        effectiveDateTime: input.fallbackTime,
        encounter: { reference: input.encounterRef },
        id,
        resourceType: 'Observation',
        status: 'final',
        subject: { reference: input.patientRef },
      },
    })
  }
  const conclusionId = `${input.caseId}-angio-conclusion`
  entries.push({
    fullUrl: `urn:uuid:${conclusionId}`,
    resource: {
      code: { coding: [{ code: 'angiography-conclusion', display: '冠脉造影总体结论', system: angioSystem }] },
      effectiveDateTime: input.fallbackTime,
      encounter: { reference: input.encounterRef },
      id: conclusionId,
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: input.patientRef },
      valueString: input.angiography.conclusion,
    },
  })
  if (input.angiography.qca !== undefined) {
    const qca = input.angiography.qca
    const method = qca.method ?? '定量冠脉造影（合成）'
    const measurements = [
      ['lesion-length', qca.targetSite, qca.lesionLengthMm],
      ['proximal-reference-diameter', `${qca.targetSite}近端参考段`, qca.proximalReferenceDiameterMm],
      ['distal-reference-diameter', `${qca.targetSite}远端参考段`, qca.distalReferenceDiameterMm],
    ] as const
    for (const [kind, site, value] of measurements) {
      const id = `${input.caseId}-angio-${kind}`
      entries.push({
        fullUrl: `urn:uuid:${id}`,
        resource: {
          bodySite: { text: site },
          code: { coding: [{ code: kind, system: angioSystem }] },
          effectiveDateTime: input.fallbackTime,
          encounter: { reference: input.encounterRef },
          id,
          method: { text: method },
          resourceType: 'Observation',
          status: 'final',
          subject: { reference: input.patientRef },
          valueQuantity: { code: 'mm', system: ucumSystem, unit: 'mm', value },
        },
      })
    }
  }
  return entries
}

function assertUniqueExamStages(caseId: string, label: string, items: readonly { stage?: CaseTruthStage | undefined }[]) {
  const seen = new Set<string>()
  for (const item of items) {
    const key = item.stage ?? '__untagged__'
    if (seen.has(key)) {
      throw new AuthoredCasePackCompileError(
        'DUPLICATE_EXAMINATION_STAGE',
        `Case ${caseId} defines duplicate ${label} entries for stage ${key}`,
      )
    }
    seen.add(key)
  }
}

export function compileAuthoredCase(rawDefinition: AuthoredCaseDefinitionInput): CompiledAuthoredCase {
  const definition = authoredCaseDefinitionSchema.parse(rawDefinition)
  assertUniqueExamStages(definition.id, 'ECG', definition.ecgs)
  assertUniqueExamStages(definition.id, 'TTE', definition.ttes)

  const indexTimeMs = Date.parse(definition.indexDateTime)
  for (const event of definition.visibleHistory) {
    if (Date.parse(event.encounterDateTime) >= indexTimeMs) {
      throw new AuthoredCasePackCompileError(
        'VISIBLE_HISTORY_AFTER_INDEX',
        `Case ${definition.id} visible history event ${event.id} must precede indexDateTime`,
      )
    }
  }

  const patientRef = `urn:uuid:${definition.patient.id}`
  const indexEncounterId = `${definition.id}-index-encounter`
  const indexEncounterRef = `urn:uuid:${indexEncounterId}`

  const entries: Array<{ fullUrl: string; resource: Record<string, unknown> }> = [
    {
      fullUrl: patientRef,
      resource: {
        birthDate: definition.patient.birthDate,
        gender: definition.patient.gender,
        id: definition.patient.id,
        name: [{ text: definition.patient.name }],
        resourceType: 'Patient',
      },
    },
  ]

  for (const event of definition.visibleHistory) {
    const encId = `${definition.id}-history-enc-${event.id}`
    const encRef = `urn:uuid:${encId}`
    entries.push({
      fullUrl: encRef,
      resource: {
        id: encId,
        period: { end: event.encounterDateTime, start: event.encounterDateTime },
        reasonCode: [{ text: event.reasonText }],
        resourceType: 'Encounter',
        status: 'finished',
        subject: { reference: patientRef },
      },
    })
    for (const condition of event.conditions) {
      const condId = `${definition.id}-history-cond-${event.id}-${condition.id}`
      entries.push({
        fullUrl: `urn:uuid:${condId}`,
        resource: {
          code: {
            coding: [{
              code: condition.code,
              display: condition.display,
              system: condition.system,
              ...(condition.version === undefined ? {} : { version: condition.version }),
            }],
            text: condition.display,
          },
          encounter: { reference: encRef },
          id: condId,
          ...(condition.note === undefined ? {} : { note: [{ text: condition.note }] }),
          recordedDate: event.encounterDateTime,
          resourceType: 'Condition',
          subject: { reference: patientRef },
        },
      })
    }
    for (const obs of event.observations) {
      entries.push(buildLabObservationResource({
        encounterRef: encRef,
        fallbackTime: event.encounterDateTime,
        observation: obs,
        patientRef,
        prefix: `${definition.id}-history-obs-${event.id}`,
      }))
    }
    for (const med of event.medications) {
      const medId = `${definition.id}-history-med-${event.id}-${med.id}`
      entries.push({
        fullUrl: `urn:uuid:${medId}`,
        resource: {
          authoredOn: event.encounterDateTime,
          code: {
            coding: [{ code: med.code, display: med.display, system: med.system }],
            text: med.display,
          },
          ...(med.dosageText === undefined ? {} : { dosageInstruction: [{ text: med.dosageText }] }),
          encounter: { reference: encRef },
          id: medId,
          intent: 'order',
          medicationCodeableConcept: {
            coding: [{ code: med.code, display: med.display, system: med.system }],
            text: med.display,
          },
          resourceType: 'MedicationRequest',
          status: 'completed',
          subject: { reference: patientRef },
        },
      })
    }
  }

  entries.push({
    fullUrl: indexEncounterRef,
    resource: {
      id: indexEncounterId,
      period: { end: definition.indexDateTime, start: definition.indexDateTime },
      reasonCode: [{ text: definition.chiefComplaint }],
      resourceType: 'Encounter',
      status: 'finished',
      subject: { reference: patientRef },
    },
  })

  for (const condition of definition.indexConditions) {
    const condId = `${definition.id}-index-cond-${condition.id}`
    entries.push({
      fullUrl: `urn:uuid:${condId}`,
      resource: {
        code: {
          coding: [{
            code: condition.code,
            display: condition.display,
            system: condition.system,
            ...(condition.version === undefined ? {} : { version: condition.version }),
          }],
          text: condition.display,
        },
        encounter: { reference: indexEncounterRef },
        id: condId,
        ...(condition.note === undefined ? {} : { note: [{ text: condition.note }] }),
        recordedDate: definition.indexDateTime,
        resourceType: 'Condition',
        subject: { reference: patientRef },
      },
    })
  }

  for (const obs of definition.laboratories) {
    entries.push(buildLabObservationResource({
      encounterRef: indexEncounterRef,
      fallbackTime: definition.indexDateTime,
      observation: obs,
      patientRef,
      prefix: `${definition.id}-lab`,
    }))
  }

  for (const [index, ecg] of definition.ecgs.entries()) {
    entries.push(...buildEcgEntries({
      caseId: definition.id,
      ecg,
      encounterRef: indexEncounterRef,
      fallbackTime: definition.indexDateTime,
      index,
      patientRef,
    }))
  }

  for (const [index, tte] of definition.ttes.entries()) {
    entries.push(...buildTteEntries({
      caseId: definition.id,
      encounterRef: indexEncounterRef,
      fallbackTime: definition.indexDateTime,
      index,
      patientRef,
      tte,
    }))
  }

  if (definition.angiography !== undefined) {
    entries.push(...buildAngiographyEntries({
      angiography: definition.angiography,
      caseId: definition.id,
      encounterRef: indexEncounterRef,
      fallbackTime: definition.indexDateTime,
      patientRef,
    }))
  }

  const raw = { entry: entries, resourceType: 'Bundle' as const, type: 'collection' as const }
  const compiled = compileSyntheaIndexCase(raw)
  if (compiled.indexEncounterReference !== indexEncounterRef) {
    throw new AuthoredCasePackCompileError(
      'INDEX_ENCOUNTER_MISMATCH',
      `Case ${definition.id} compiled unexpected index encounter ${compiled.indexEncounterReference}`,
    )
  }

  const hiddenSet = new Set(compiled.hiddenResourceReferences)
  const visibleSet = new Set(compiled.visibleResourceReferences)
  const hiddenResources = entries
    .filter(item => hiddenSet.has(item.fullUrl))
    .map(item => item.resource as { code?: unknown; id: string; resourceType: string })
  const visibleResources = entries
    .filter(item => visibleSet.has(item.fullUrl))
    .map(item => item.resource as { code?: unknown; id: string; resourceType: string })

  if (personaLeaksDiagnosis(definition.persona.content, hiddenResources, visibleResources)) {
    throw new AuthoredCasePackCompileError(
      'PERSONA_LEAKS_HIDDEN_DIAGNOSIS',
      `Case ${definition.id} persona leaks an undiagnosed hidden condition`,
    )
  }

  const hash = canonicalJsonHash(raw)
  return {
    compiled,
    definition,
    persona: {
      content: definition.persona.content,
      promptHash: canonicalJsonHash(definition.persona),
      version: definition.persona.version,
    },
    source: {
      format: 'fhir-r4-bundle',
      hash,
      patientId: definition.patient.id,
      raw,
    },
  }
}

export function compileAuthoredCasePack(rawPack: AuthoredCasePackDefinitionInput): CompiledAuthoredCasePack {
  const pack = authoredCasePackDefinitionSchema.parse(rawPack)
  const caseIds = new Set<string>()
  const patientIds = new Set<string>()
  for (const item of pack.cases) {
    if (caseIds.has(item.id)) {
      throw new AuthoredCasePackCompileError('DUPLICATE_CASE_ID', `Duplicate authored case id: ${item.id}`)
    }
    if (patientIds.has(item.patient.id)) {
      throw new AuthoredCasePackCompileError('DUPLICATE_PATIENT_ID', `Duplicate authored patient id: ${item.patient.id}`)
    }
    caseIds.add(item.id)
    patientIds.add(item.patient.id)
  }
  const cases = pack.cases.map(compileAuthoredCase)
  return {
    cases,
    contentHash: canonicalJsonHash({
      cases: cases.map(item => ({
        draftId: item.definition.id,
        personaHash: item.persona.promptHash,
        sourceHash: item.source.hash,
      })),
      id: pack.id,
      version: pack.version,
    }),
    id: pack.id,
    name: pack.name,
    nameEn: pack.nameEn,
    version: pack.version,
  }
}

export function buildAuthoredCaseProfile(input: {
  compiledCase: CompiledAuthoredCase
  createdAt: string
  pack: Pick<CompiledAuthoredCasePack, 'id' | 'name' | 'version'>
  workspaceId: string
}): SyntheticPatientProfile {
  return createSyntheticPatientProfiles({
    authoring: {
      draftId: input.compiledCase.definition.id,
      packageId: input.pack.id,
      packageVersion: input.pack.version,
    },
    batchId: `${input.pack.id}:${input.pack.version}`,
    batchName: input.pack.name,
    createdAt: input.createdAt,
    sources: [input.compiledCase.source],
    workspaceId: input.workspaceId,
  })[0]!
}
