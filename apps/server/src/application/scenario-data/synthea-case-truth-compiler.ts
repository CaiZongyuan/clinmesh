import { createHash } from 'node:crypto'
import {
  scenarioPatientSchema,
  type ScenarioGenerationRequest,
  type ScenarioInvestigationResult,
  type ScenarioPatient,
} from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import { resolveDiagnosisMapping } from './diagnosis-coding-package.ts'
import {
  isMedicationMappingSourceSystem,
  medicationMappingSourceVersion,
  resolveMedicationMapping,
} from './medication-coding-package.ts'
import {
  isKnownObservationMappingCode,
  resolveObservationMapping,
  resolveUcumUnit,
} from './reference-coding-package.ts'
import { scenarioCaseDefinitions } from './scenario-case-definitions.ts'

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
  version: z.string().min(1).optional(),
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

const medicationSchema = z.object({
  code: conceptSchema.optional(),
  id: z.string().min(1),
  resourceType: z.literal('Medication'),
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
  medicationSchema,
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
type R4MedicationRequest = z.infer<typeof medicationRequestSchema>

type SyntheaCaseTruthCompilerErrorCode =
  | 'MEDICATION_SOURCE_INVALID'
  | 'OBSERVATION_CODING_MISMATCH'
  | 'OBSERVATION_UNIT_INVALID'

export class SyntheaCaseTruthCompilerError extends Error {
  readonly code: SyntheaCaseTruthCompilerErrorCode
  readonly sourceResourceId: string

  constructor(
    code: SyntheaCaseTruthCompilerErrorCode,
    sourceResourceId: string,
    message: string,
  ) {
    super(message)
    this.name = 'SyntheaCaseTruthCompilerError'
    this.code = code
    this.sourceResourceId = sourceResourceId
  }
}

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

function firstCoding(concept: Concept | undefined): z.infer<typeof codingSchema> | undefined {
  return concept?.coding?.find(coding => coding.code !== undefined || coding.display !== undefined)
}

function observationMapping(observation: R4Observation) {
  const coding = firstCoding(observation.code)
  const mapping = resolveObservationMapping({
    ...(coding?.code === undefined ? {} : { code: coding.code }),
    ...(coding?.display === undefined ? {} : { display: coding.display }),
    ...(coding?.system === undefined ? {} : { system: coding.system }),
    ...(coding?.version === undefined ? {} : { version: coding.version }),
  })
  if (mapping === undefined && coding?.code !== undefined && isKnownObservationMappingCode(coding.code)) {
    throw new SyntheaCaseTruthCompilerError(
      'OBSERVATION_CODING_MISMATCH',
      observation.id,
      `Observation/${observation.id} has a mismatched reference coding`,
    )
  }
  return mapping
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

function medicationSourceConcept(
  request: R4MedicationRequest,
  bundle: R4Bundle,
): Concept | undefined {
  if (
    (request.medicationCodeableConcept === undefined)
    === (request.medicationReference === undefined)
  ) {
    throw new SyntheaCaseTruthCompilerError(
      'MEDICATION_SOURCE_INVALID',
      request.id,
      `MedicationRequest/${request.id} must provide exactly one medication source`,
    )
  }
  if (request.medicationCodeableConcept !== undefined) return request.medicationCodeableConcept
  const reference = request.medicationReference?.reference
  const exactEntry = bundle.entry.find(entry => entry.fullUrl === reference)
  if (exactEntry !== undefined) {
    if (exactEntry.resource.resourceType === 'Medication') return exactEntry.resource.code
    throw new SyntheaCaseTruthCompilerError(
      'MEDICATION_SOURCE_INVALID',
      request.id,
      `MedicationRequest/${request.id} references a non-Medication resource`,
    )
  }
  const relativeMatch = /^Medication\/([^/]+)$/.exec(reference ?? '')
  const medication = relativeMatch === null
    ? undefined
    : bundle.entry.map(entry => entry.resource).find(resource => (
        resource.resourceType === 'Medication' && resource.id === relativeMatch[1]
      ))
  if (medication?.resourceType === 'Medication') return medication.code
  throw new SyntheaCaseTruthCompilerError(
    'MEDICATION_SOURCE_INVALID',
    request.id,
    `MedicationRequest/${request.id} references an unavailable Medication`,
  )
}

function medicationSourceCodings(concept: Concept | undefined) {
  const rxNormCodings = concept?.coding?.filter(coding => (
    coding.code !== undefined && isMedicationMappingSourceSystem(coding.system)
  )) ?? []
  if (rxNormCodings.length > 0) return rxNormCodings
  const fallback = firstCoding(concept)
  return fallback === undefined ? [] : [fallback]
}

export function pinSyntheaSourceVersions(rawBundle: unknown, patient: ScenarioPatient) {
  const bundle = syntheaR4BundleSchema.parse(structuredClone(rawBundle))
  const eventBySourceId = new Map(patient.longitudinalHistory.flatMap(event => (
    event.sourceResourceType === 'Condition' || event.sourceResourceType === 'MedicationRequest'
      ? [[event.sourceResourceId, event] as const]
      : []
  )))
  const medicationHistoryById = new Map(patient.fhirHistory.flatMap(resource => (
    resource.resourceType === 'MedicationRequest' ? [[resource.id, resource] as const] : []
  )))
  for (const entry of bundle.entry) {
    const resource = entry.resource
    const event = eventBySourceId.get(resource.id)
    if (event === undefined) continue
    const concept = resource.resourceType === 'Condition'
      ? resource.code
      : resource.resourceType === 'MedicationRequest'
        ? medicationSourceConcept(resource, bundle)
        : undefined
    const medicationHistory = medicationHistoryById.get(stableHistoryId(
      'MedicationRequest',
      event.sourceResourceId,
    ))
    const pinnedSources = medicationHistory !== undefined
      && 'sourceCodings' in medicationHistory.medication
      ? medicationHistory.medication.sourceCodings
      : [{
          code: event.code,
          display: event.sourceDisplay ?? event.display,
          ...(event.sourceSystem === undefined ? {} : { system: event.sourceSystem }),
          ...(event.sourceVersion === undefined ? {} : { version: event.sourceVersion }),
        }]
    for (const source of pinnedSources) {
      if (source.version === undefined) continue
      const coding = concept?.coding?.find(candidate => (
        candidate.code === source.code
        && (source.system === undefined || candidate.system === source.system)
      ))
      if (coding !== undefined && coding.version === undefined) coding.version = source.version
    }
  }
  return bundle
}

function mappedMedication(request: R4MedicationRequest, bundle: R4Bundle) {
  const sourceConcept = medicationSourceConcept(request, bundle)
  const sourceDisplay = conceptDisplay(sourceConcept, '历史用药')
  const sources = medicationSourceCodings(sourceConcept).map((source) => {
    const sourceVersion = medicationMappingSourceVersion({
      ...(source.system === undefined ? {} : { system: source.system }),
      ...(source.version === undefined ? {} : { version: source.version }),
    })
    return {
      resolution: resolveMedicationMapping({
        ...(source.code === undefined ? {} : { code: source.code }),
        ...(source.display === undefined ? {} : { display: source.display }),
        ...(source.system === undefined ? {} : { system: source.system }),
        ...(source.version === undefined ? {} : { version: source.version }),
      }),
      source,
      sourceVersion,
    }
  })
  const applicable = sources.flatMap(item => (
    item.resolution.status === 'mapped'
      ? [{ ...item, mapping: item.resolution.mapping }]
      : []
  ))
  if (applicable.length === 1) {
    const selected = applicable[0]!
    return {
      mappedCode: selected.mapping.target.code,
      medication: selected.mapping.target,
      source: selected.source,
      sourceDisplay,
      sourceVersion: selected.sourceVersion,
    }
  }
  const primary = sources[0]
  const sourceCodings = sources.flatMap(({ source, sourceVersion }) => (
    source.code === undefined
      ? []
      : [{
          code: source.code,
          display: source.display ?? sourceDisplay,
          ...(source.system === undefined ? {} : { system: source.system }),
          ...(sourceVersion === undefined ? {} : { version: sourceVersion }),
        }]
  ))
  return {
    mappedCode: null,
    medication: {
      ...(primary?.source.code === undefined ? {} : { code: primary.source.code }),
      display: primary?.source.display ?? sourceDisplay,
      ...(primary?.source.system === undefined ? {} : { system: primary.source.system }),
      ...(primary?.sourceVersion === undefined ? {} : { version: primary.sourceVersion }),
      ...(sourceCodings.length < 2 ? {} : { sourceCodings }),
    },
    source: primary?.source,
    sourceDisplay,
    sourceVersion: primary?.sourceVersion,
  }
}

export function stableHistoryId(resourceType: string, id: string): string {
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
    const unit = resolveUcumUnit({
      ...(observation.valueQuantity.code === undefined ? {} : { code: observation.valueQuantity.code }),
      ...(observation.valueQuantity.system === undefined ? {} : { system: observation.valueQuantity.system }),
      ...(observation.valueQuantity.unit === undefined ? {} : { display: observation.valueQuantity.unit }),
    })
    return {
      ...(interpretation === undefined ? {} : { flag: interpretation }),
      outcome: 'reported',
      ...(referenceRange === undefined ? {} : { referenceRange }),
      ...(unit === undefined ? {} : { unit }),
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

function mappedObservedResult(observation: R4Observation) {
  const mapping = observationMapping(observation)
  const result = observedResult(observation)
  if (mapping === undefined || result === undefined || result.outcome !== 'reported') return undefined
  if (typeof result.value !== 'number') return { ...result, unit: mapping.unit }
  const sourceUnitCode = result.unit?.code
  if (sourceUnitCode === undefined) {
    throw new SyntheaCaseTruthCompilerError(
      'OBSERVATION_UNIT_INVALID',
      observation.id,
      `Observation/${observation.id} has a missing, unknown, or inconsistent UCUM unit`,
    )
  }
  const conversion = mapping.sourceUnits.find(source => source.unitCode === sourceUnitCode)
  if (conversion === undefined) {
    throw new SyntheaCaseTruthCompilerError(
      'OBSERVATION_UNIT_INVALID',
      observation.id,
      `Observation/${observation.id} uses an unsupported UCUM unit for its mapping`,
    )
  }
  return {
    ...result,
    unit: mapping.unit,
    value: Number((result.value * conversion.multiplier).toFixed(2)),
  }
}

function currentMappedObservations(observations: R4Observation[]): R4Observation[] {
  const currentByCatalogItem = new Map<string, R4Observation>()
  for (const observation of observations) {
    const mapping = observationMapping(observation)
    if (mapping === undefined || mappedObservedResult(observation) === undefined) continue

    const current = currentByCatalogItem.get(mapping.catalogItemId)
    const observationTime = observation.effectiveDateTime === undefined
      ? Number.NEGATIVE_INFINITY
      : Date.parse(observation.effectiveDateTime)
    const currentTime = current?.effectiveDateTime === undefined
      ? Number.NEGATIVE_INFINITY
      : Date.parse(current.effectiveDateTime)
    if (
      current === undefined
      || observationTime > currentTime
      || (observationTime === currentTime && observation.id.localeCompare(current.id) < 0)
    ) {
      currentByCatalogItem.set(mapping.catalogItemId, observation)
    }
  }

  return [...currentByCatalogItem.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, observation]) => observation)
}

function dateAtEnd(request: ScenarioGenerationRequest): string {
  return `${request.timeRange.end}T09:00:00+08:00`
}

function formatResultValue(result: ScenarioInvestigationResult): string {
  return result.outcome === 'reported' ? String(result.value) : result.message
}

function compileCurrentInvestigation(
  resource: R4Observation,
): ScenarioPatient['investigations'][number] | undefined {
  const mapping = observationMapping(resource)
  const result = mappedObservedResult(resource)
  if (mapping === undefined || result === undefined) return undefined
  const formattedValue = formatResultValue(result)
  const normalizedResult: ScenarioInvestigationResult = result.outcome === 'reported'
    ? {
        ...result,
        flag: result.flag ?? (typeof result.value !== 'number'
          ? 'N'
          : mapping.referenceMaximum !== undefined && result.value > mapping.referenceMaximum
            ? 'H'
            : mapping.referenceMinimum !== undefined && result.value < mapping.referenceMinimum ? 'L' : 'N'),
        referenceRange: result.referenceRange ?? mapping.referenceRange,
      }
    : result
  return {
    catalogItemId: mapping.catalogItemId,
    critical: false,
    feeFen: mapping.feeFen,
    id: `investigation-${resource.id}`,
    name: mapping.name,
    report: mapping.reportTemplate
      .replace('{value}', formattedValue)
      .replace('{unit}', mapping.unit.display),
    result: normalizedResult,
    sourceLevel: 'L1',
    tatMinutes: mapping.tatMinutes,
  }
}

function mappedCondition(condition: z.infer<typeof conditionSchema>) {
  const source = firstCoding(condition.code)
  const sourceDisplay = conceptDisplay(condition.code, '未命名临床问题')
  const resolution = resolveDiagnosisMapping({
    ...(source?.code === undefined ? {} : { code: source.code }),
    ...(source?.display === undefined ? {} : { display: source.display }),
    ...(source?.system === undefined ? {} : { system: source.system }),
    ...(source?.version === undefined ? {} : { version: source.version }),
  })
  if (resolution.status === 'mapped') {
    return {
      ...resolution.mapping.target,
      sourceVersion: resolution.mapping.source.version,
    }
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
  const currentObservations = currentMappedObservations(observations)
  const medicationRequests = bundle.entry.flatMap(entry => entry.resource.resourceType === 'MedicationRequest' ? [entry.resource] : [])
  const medicationByRequestId = new Map(medicationRequests.map(request => (
    [request.id, mappedMedication(request, bundle)] as const
  )))
  const allergies = bundle.entry.flatMap(entry => entry.resource.resourceType === 'AllergyIntolerance' ? [entry.resource] : [])
  const fallbackDateTime = dateAtEnd(input.request)
  const module = input.request.modules[input.ordinal % input.request.modules.length] ?? 'fever'
  const definition = scenarioCaseDefinitions[module]
  const currentInvestigations = currentObservations.flatMap((resource) => {
    const investigation = compileCurrentInvestigation(resource)
    return investigation === undefined ? [] : [investigation]
  })
  const authored = definition.buildCaseTruth({
    conditions: conditions.map(mappedCondition),
    observations: new Map(currentInvestigations.map(investigation => (
      [investigation.catalogItemId, investigation.result] as const
    ))),
  })

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
          ...(mapped.code === null
            ? (coding?.code === undefined ? {} : { code: coding.code })
            : { code: mapped.code }),
          display: mapped.display,
          ...(mapped.code === null
            ? (coding?.system === undefined ? {} : { system: coding.system })
            : { system: mapped.system }),
          ...(mapped.code === null
            ? (coding?.version === undefined ? {} : { version: coding.version })
            : { version: mapped.version }),
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
      const mappedCoding = observationMapping(resource)?.coding
      return [{
        code: {
          ...(mappedCoding?.code === undefined
            ? (coding?.code === undefined ? {} : { code: coding.code })
            : { code: mappedCoding.code }),
          display: mappedCoding?.display ?? conceptDisplay(resource.code, '未命名观察'),
          ...(mappedCoding?.system === undefined
            ? (coding?.system === undefined ? {} : { system: coding.system })
            : { system: mappedCoding.system }),
          ...(mappedCoding?.version === undefined ? {} : { version: mappedCoding.version }),
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
      const mapped = medicationByRequestId.get(resource.id)!
      return [{
        ...(resource.authoredOn === undefined ? {} : { authoredOn: resource.authoredOn }),
        ...(localReferenceId(resource.encounter?.reference, bundle) === undefined
          ? {}
          : { encounterId: stableHistoryId('Encounter', localReferenceId(resource.encounter?.reference, bundle)!) }),
        id: stableHistoryId(resource.resourceType, resource.id),
        intent: resource.intent,
        medication: mapped.medication,
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
      mappedCode: resource.class?.code === 'AMB' ? 'AMB' : null,
      occurredAt: resource.period?.start ?? fallbackDateTime,
      sourceResourceId: resource.id,
      sourceResourceType: resource.resourceType,
      status: resource.status ?? 'finished',
    })),
    ...conditions.map(resource => {
      const source = firstCoding(resource.code)
      const mapped = mappedCondition(resource)
      const sourceVersion = source?.version ?? (mapped.code === null ? undefined : mapped.sourceVersion)
      return {
        code: conceptCode(resource.code) ?? 'unmapped',
        display: mapped.display,
        id: `history-event-${resource.id}`,
        kind: 'condition' as const,
        mappedCode: mapped.code,
        occurredAt: resource.onsetDateTime ?? resource.recordedDate ?? fallbackDateTime,
        sourceResourceId: resource.id,
        sourceResourceType: resource.resourceType,
        ...(source?.display === undefined ? {} : { sourceDisplay: source.display }),
        ...(source?.system === undefined ? {} : { sourceSystem: source.system }),
        ...(sourceVersion === undefined ? {} : { sourceVersion }),
        status: clinicalStatus(resource.clinicalStatus, 'active'),
      }
    }),
    ...observations.map(resource => ({
      code: conceptCode(resource.code) ?? 'unmapped',
      display: conceptDisplay(resource.code, '未命名观察'),
      id: `history-event-${resource.id}`,
      kind: 'observation' as const,
      mappedCode: observationMapping(resource)?.code ?? null,
      occurredAt: resource.effectiveDateTime ?? fallbackDateTime,
      sourceResourceId: resource.id,
      sourceResourceType: resource.resourceType,
      status: resource.status,
    })),
    ...medicationRequests.map((resource) => {
      const mapped = medicationByRequestId.get(resource.id)!
      return {
        code: mapped.source?.code ?? 'unmapped',
        display: mapped.medication.display,
        id: `history-event-${resource.id}`,
        kind: 'medication' as const,
        mappedCode: mapped.mappedCode,
        occurredAt: resource.authoredOn ?? fallbackDateTime,
        sourceResourceId: resource.id,
        sourceResourceType: resource.resourceType,
        ...(mapped.source?.display === undefined ? {} : { sourceDisplay: mapped.source.display }),
        ...(mapped.source?.system === undefined ? {} : { sourceSystem: mapped.source.system }),
        ...(mapped.sourceVersion === undefined ? {} : { sourceVersion: mapped.sourceVersion }),
        status: resource.status,
      }
    }),
    ...allergies.map(resource => ({
      code: conceptCode(resource.code) ?? 'unmapped',
      display: conceptDisplay(resource.code, '未说明过敏原'),
      id: `history-event-${resource.id}`,
      kind: 'allergy' as const,
      mappedCode: null,
      occurredAt: resource.recordedDate ?? fallbackDateTime,
      sourceResourceId: resource.id,
      sourceResourceType: resource.resourceType,
      status: clinicalStatus(resource.clinicalStatus, 'active'),
    })),
  ].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id))

  const currentInvestigationByCatalog = new Map(currentInvestigations.map(investigation => (
    [investigation.catalogItemId, investigation] as const
  )))
  const investigations: ScenarioPatient['investigations'] = definition.investigationTruth.map((fallback) => (
    currentInvestigationByCatalog.get(fallback.catalogItemId) ?? fallback
  ))

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
