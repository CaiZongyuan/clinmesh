import { createHash } from 'node:crypto'
import type { LaboratoryServiceSnapshot } from '@clinmesh/contracts/his'
import type { InvestigationResultContent } from '@clinmesh/contracts/scenario'

export const adultReferenceGenerationPolicyVersion = 'clinmesh-adult-reference-v1'

type ResultDefinition = LaboratoryServiceSnapshot['reportDefinition']['results'][number]
type AdultRule = NonNullable<ResultDefinition['adultReferenceRules']>[number]

export class AdultReferenceApplicabilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdultReferenceApplicabilityError'
  }
}

function ageOnDate(birthDate: string, authoredAt: string): number {
  const birth = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate)
  const authored = /^(\d{4})-(\d{2})-(\d{2})T/.exec(authoredAt)
  if (birth === null || authored === null) {
    throw new AdultReferenceApplicabilityError('Patient age cannot be resolved')
  }
  const birthYear = Number(birth[1])
  const birthMonth = Number(birth[2])
  const birthDay = Number(birth[3])
  const year = Number(authored[1])
  const month = Number(authored[2])
  const day = Number(authored[3])
  return year - birthYear - (month < birthMonth || (month === birthMonth && day < birthDay) ? 1 : 0)
}

export function selectAdultReferenceRule(
  definition: ResultDefinition,
  demographics: { birthDate: string; gender: string },
  authoredAt: string,
): AdultRule {
  if (ageOnDate(demographics.birthDate, authoredAt) < 18) {
    throw new AdultReferenceApplicabilityError('The Laboratory Service is available only to adults')
  }
  const rules = definition.adultReferenceRules
  if (rules === undefined) {
    throw new AdultReferenceApplicabilityError('The Laboratory Service has no adult reference rules')
  }
  const exactSex = demographics.gender === 'male' || demographics.gender === 'female'
    ? demographics.gender
    : undefined
  const selected = (exactSex === undefined ? undefined : rules.find(rule => rule.sex === exactSex))
    ?? rules.find(rule => rule.sex === 'all')
  if (selected === undefined) {
    throw new AdultReferenceApplicabilityError(
      'No adult reference rule applies to the Patient administrative gender',
    )
  }
  return selected
}

export function assertAdultReferenceServiceApplicable(
  service: LaboratoryServiceSnapshot,
  demographics: { birthDate: string; gender: string },
  authoredAt: string,
): AdultRule[] {
  if (service.sourceDataset?.datasetId !== 'laboratory-cn') return []
  return service.reportDefinition.results.map(definition => (
    selectAdultReferenceRule(definition, demographics, authoredAt)
  ))
}

export function adultReferenceRange(
  rule: AdultRule,
  unit: ResultDefinition['unit'],
): InvestigationResultContent['results'][number]['referenceRange'] {
  const suffix = unit === undefined ? '' : ` ${unit.display}`
  if (rule.referenceKind === 'range') {
    return { high: rule.high!, low: rule.low!, text: `${rule.low}-${rule.high}${suffix}` }
  }
  if (rule.referenceKind === 'upper-bound') {
    return { high: rule.high!, text: `≤${rule.high}${suffix}` }
  }
  if (rule.referenceKind === 'lower-bound') {
    return { low: rule.low!, text: `≥${rule.low}${suffix}` }
  }
  return { text: rule.normalValue! }
}

function deterministicUnitInterval(input: string): number {
  const digest = createHash('sha256').update(input).digest()
  const first53Bits = digest.readBigUInt64BE(0) >> 11n
  return Number(first53Bits) / 2 ** 53
}

export function generateAdultReferenceResult(input: {
  definition: ResultDefinition
  inputHash: string
  rule: AdultRule
  serviceVersion: number
}): InvestigationResultContent['results'][number] {
  const { definition, rule } = input
  const resultRange = adultReferenceRange(rule, definition.unit)
  if (definition.healthyStrategy === 'fixed-normal') {
    if (rule.normalValue === undefined) {
      throw new AdultReferenceApplicabilityError('The fixed adult reference rule has no value')
    }
    return {
      code: definition.referenceConcept.code,
      display: definition.referenceConcept.display,
      interpretation: 'normal',
      referenceRange: resultRange,
      source: 'adult-reference-baseline',
      value: rule.normalValue,
    }
  }
  if (definition.healthyStrategy !== 'uniform'
    || definition.precision === undefined
    || definition.unit === undefined
    || rule.simulationLow === undefined
    || rule.simulationHigh === undefined) {
    throw new AdultReferenceApplicabilityError('The adult Quantity generation policy is incomplete')
  }
  const interval = deterministicUnitInterval([
    adultReferenceGenerationPolicyVersion,
    input.inputHash,
    String(input.serviceVersion),
    definition.referenceConcept.id,
  ].join('\0'))
  const raw = rule.simulationLow + (rule.simulationHigh - rule.simulationLow) * interval
  const factor = 10 ** definition.precision
  const rounded = Math.round((raw + Number.EPSILON) * factor) / factor
  const value = Math.min(rule.simulationHigh, Math.max(rule.simulationLow, rounded))
  return {
    code: definition.referenceConcept.code,
    display: definition.referenceConcept.display,
    interpretation: 'normal',
    referenceRange: resultRange,
    source: 'adult-reference-baseline',
    unit: definition.unit,
    value,
  }
}

export function adultRuleProvenance(conceptId: string, rule: AdultRule) {
  return {
    conceptId,
    sex: rule.sex,
    sourceLocation: rule.sourceLocation,
    sourceStandard: rule.sourceStandard,
    sourceType: rule.sourceType,
    sourceVersion: rule.sourceVersion,
  }
}
