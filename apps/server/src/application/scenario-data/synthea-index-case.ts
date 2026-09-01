import { z } from 'zod'

const referenceSchema = z.object({ reference: z.string().min(1).max(512) }).passthrough()
const resourceSchema = z.object({
  id: z.string().min(1),
  resourceType: z.string().min(1),
}).passthrough()
const bundleSchema = z.object({
  entry: z.array(z.object({
    fullUrl: z.string().min(1).max(512).optional(),
    resource: resourceSchema,
  }).passthrough()).min(1).max(20_000),
  resourceType: z.literal('Bundle'),
  type: z.literal('collection'),
}).passthrough()

const clinicalResourceTypes = new Set([
  'Condition',
  'MedicationRequest',
  'Observation',
  'Procedure',
])
const sharedResourceTypes = new Set([
  'Location',
  'Organization',
  'Patient',
  'Practitioner',
])
const excludedResourceTypes = new Set(['Claim', 'ExplanationOfBenefit'])

type Bundle = z.infer<typeof bundleSchema>
type Resource = z.infer<typeof resourceSchema>

export interface SyntheaVisibleHistoryItem {
  clinicalDate: string
  resourceType: string
  sourceReference: string
  title: string
}

export interface CompiledSyntheaIndexCase {
  caseType: 'follow-up' | 'new-problem' | 'preventive'
  hiddenResourceReferences: string[]
  indexEncounterReference: string
  visibleHistory: SyntheaVisibleHistoryItem[]
  visibleResourceReferences: string[]
}

export class SyntheaIndexCaseError extends Error {
  readonly code = 'INDEX_ENCOUNTER_NOT_FOUND'

  constructor() {
    super('The Synthea Bundle has no qualifying clinical Encounter')
    this.name = 'SyntheaIndexCaseError'
  }
}

export class SyntheaIndexCaseReferenceError extends Error {
  readonly code = 'FHIR_R4_REFERENCE_INVALID'

  constructor() {
    super('The Synthea Bundle contains an unresolved local reference')
    this.name = 'SyntheaIndexCaseReferenceError'
  }
}

function entryReference(entry: Bundle['entry'][number]): string {
  return entry.fullUrl ?? `${entry.resource.resourceType}/${entry.resource.id}`
}

function encounterAliases(entry: Bundle['entry'][number]): Set<string> {
  return new Set([entryReference(entry), `Encounter/${entry.resource.id}`])
}

function nestedString(value: unknown, ...path: string[]): string | undefined {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'string' && current.length > 0 ? current : undefined
}

function resourceEncounterReference(resource: Resource): string | undefined {
  return referenceSchema.safeParse(resource.encounter).data?.reference
}

function clinicalDate(resource: Resource): string | undefined {
  const candidates = resource.resourceType === 'Encounter'
    ? [nestedString(resource, 'period', 'start'), nestedString(resource, 'period', 'end')]
    : [
        nestedString(resource, 'recordedDate'),
        nestedString(resource, 'created'),
        nestedString(resource, 'effectiveDateTime'),
        nestedString(resource, 'effectivePeriod', 'start'),
        nestedString(resource, 'authoredOn'),
        nestedString(resource, 'performedDateTime'),
        nestedString(resource, 'performedPeriod', 'start'),
        nestedString(resource, 'occurrenceDateTime'),
        nestedString(resource, 'occurrencePeriod', 'start'),
        nestedString(resource, 'onsetDateTime'),
        nestedString(resource, 'onsetPeriod', 'start'),
        nestedString(resource, 'issued'),
        nestedString(resource, 'started'),
        nestedString(resource, 'statusDate'),
        nestedString(resource, 'period', 'start'),
        nestedString(resource, 'manufactureDate'),
      ]
  return candidates.find(value => value !== undefined)
}

function reasonPresent(encounter: Resource): boolean {
  return (Array.isArray(encounter.reasonCode) && encounter.reasonCode.length > 0)
    || (Array.isArray(encounter.reasonReference) && encounter.reasonReference.length > 0)
}

function firstConceptDisplay(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const concept = value as Record<string, unknown>
  if (typeof concept.text === 'string' && concept.text.length > 0) return concept.text
  if (!Array.isArray(concept.coding)) return undefined
  for (const candidate of concept.coding) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue
    const display = (candidate as Record<string, unknown>).display
    if (typeof display === 'string' && display.length > 0) return display
  }
  return undefined
}

function historyTitle(resource: Resource): string {
  const code = firstConceptDisplay(resource.code)
  if (code !== undefined) return code
  if (resource.resourceType === 'Encounter' && Array.isArray(resource.reasonCode)) {
    for (const reason of resource.reasonCode) {
      const display = firstConceptDisplay(reason)
      if (display !== undefined) return display
    }
  }
  return resource.resourceType === 'Encounter' ? '就诊' : resource.resourceType
}

function conditionCodes(entries: Bundle['entry']): Set<string> {
  const codes = new Set<string>()
  for (const entry of entries) {
    if (entry.resource.resourceType !== 'Condition') continue
    const concept = entry.resource.code
    if (typeof concept !== 'object' || concept === null || Array.isArray(concept)) continue
    const coding = (concept as Record<string, unknown>).coding
    if (!Array.isArray(coding)) continue
    for (const value of coding) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const code = (value as Record<string, unknown>).code
      if (typeof code === 'string' && code.length > 0) codes.add(code)
    }
  }
  return codes
}

function collectReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectReferences)
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => (
    key === 'reference' && typeof entry === 'string'
      ? [entry]
      : collectReferences(entry)
  ))
}

function referencedClosure(
  bundle: Bundle,
  initial: Bundle['entry'],
): Bundle['entry'] {
  const entriesByAlias = new Map<string, Bundle['entry'][number]>()
  for (const entry of bundle.entry) {
    entriesByAlias.set(entryReference(entry), entry)
    entriesByAlias.set(`${entry.resource.resourceType}/${entry.resource.id}`, entry)
  }
  const selected = new Map(initial.map(entry => [entryReference(entry), entry]))
  const pending = [...initial]
  while (pending.length > 0) {
    const current = pending.shift()!
    for (const reference of collectReferences(current.resource)) {
      const target = entriesByAlias.get(reference)
      if (
        target === undefined
        || sharedResourceTypes.has(target.resource.resourceType)
        || excludedResourceTypes.has(target.resource.resourceType)
        || selected.has(entryReference(target))
      ) continue
      selected.set(entryReference(target), target)
      pending.push(target)
    }
  }
  return [...selected.values()]
}

export function compileSyntheaIndexCase(input: unknown): CompiledSyntheaIndexCase {
  const bundle = bundleSchema.parse(input)
  const knownReferences = new Set(bundle.entry.flatMap(entry => [
    entryReference(entry),
    `${entry.resource.resourceType}/${entry.resource.id}`,
  ]))
  if (bundle.entry.some(entry => collectReferences(entry.resource).some(reference => (
    !reference.startsWith('#') && !knownReferences.has(reference)
  )))) {
    throw new SyntheaIndexCaseReferenceError()
  }
  const candidates = bundle.entry.flatMap((entry) => {
    if (entry.resource.resourceType !== 'Encounter') return []
    const aliases = encounterAliases(entry)
    const directlyRelated = bundle.entry.filter(candidate => (
      !excludedResourceTypes.has(candidate.resource.resourceType)
      && aliases.has(resourceEncounterReference(candidate.resource) ?? '')
    ))
    const qualifying = directlyRelated.filter(candidate => (
      clinicalResourceTypes.has(candidate.resource.resourceType)
    ))
    if (!reasonPresent(entry.resource) && qualifying.length === 0) return []
    const date = clinicalDate(entry.resource)
    if (date === undefined || !Number.isFinite(Date.parse(date))) return []
    return [{ aliases, date, directlyRelated, entry }]
  }).toSorted((left, right) => (
    Date.parse(right.date) - Date.parse(left.date)
    || entryReference(left.entry).localeCompare(entryReference(right.entry))
  ))
  const index = candidates[0]
  if (index === undefined) throw new SyntheaIndexCaseError()

  const hiddenEntries = referencedClosure(bundle, [index.entry, ...index.directlyRelated])
  const hiddenReferences = new Set(hiddenEntries.map(entryReference))
  const indexTimestamp = Date.parse(index.date)
  const visibleEntries = bundle.entry.filter((entry) => {
    if (hiddenReferences.has(entryReference(entry))) return false
    if (sharedResourceTypes.has(entry.resource.resourceType)) return true
    const date = clinicalDate(entry.resource)
    return date !== undefined
      && Number.isFinite(Date.parse(date))
      && Date.parse(date) < indexTimestamp
  })
  const visibleHistory = visibleEntries.flatMap((entry) => {
    if (sharedResourceTypes.has(entry.resource.resourceType)) return []
    const date = clinicalDate(entry.resource)
    if (date === undefined) return []
    return [{
      clinicalDate: date,
      resourceType: entry.resource.resourceType,
      sourceReference: entryReference(entry),
      title: historyTitle(entry.resource),
    }]
  }).toSorted((left, right) => (
    Date.parse(left.clinicalDate) - Date.parse(right.clinicalDate)
    || left.sourceReference.localeCompare(right.sourceReference)
  ))
  const currentConditions = conditionCodes(hiddenEntries)
  const previousConditions = conditionCodes(visibleEntries)
  const caseType = currentConditions.size === 0
    ? 'preventive'
    : [...currentConditions].some(code => previousConditions.has(code))
      ? 'follow-up'
      : 'new-problem'

  return {
    caseType,
    hiddenResourceReferences: [...hiddenReferences].sort(),
    indexEncounterReference: entryReference(index.entry),
    visibleHistory,
    visibleResourceReferences: visibleEntries.map(entryReference).sort(),
  }
}
