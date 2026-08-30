import type {
  ScenarioGenerationRequest,
  ScenarioProviderCapabilities,
} from '@clinmesh/contracts/scenario'
import {
  syntheaModuleFilterSchema,
  syntheaCnLocalizationProvenanceSchema,
} from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import {
  ScenarioGenerationProviderError,
  sourceArtifactHash,
  type ScenarioGenerationProvider,
  type SourcePatientCorpus,
} from '../../application/scenario-data/provider.ts'
import { syntheaR4ResourceTypes } from '../../application/scenario-data/synthea-r4.ts'
import {
  localizedSyntheaPatientIdentity,
  SyntheaLocalizationValidationError,
} from '../../application/scenario-data/synthea-localized-identity.ts'

const SYNTHEA_COMMIT = 'd9d07a6eef91ee5144293b42ab64224d84d124f8'
const SYNTHEA_CONFIG_HASH = '81c9b79f5426b85244f42275f98d2f9e161a4c502980d9cde8d027cdda6ef103'
const allowedR4ResourceTypes = syntheaR4ResourceTypes

const r4ResourceSchema = z.object({
  id: z.string().min(1),
  resourceType: z.enum(allowedR4ResourceTypes),
}).passthrough()

const r4BundleSchema = z.object({
  entry: z.array(z.object({
    fullUrl: z.string().min(1).optional(),
    resource: r4ResourceSchema,
  }).passthrough()).min(1).max(20_000),
  resourceType: z.literal('Bundle'),
  type: z.literal('collection'),
}).passthrough()

const providerResponseSchema = z.object({
  bundles: z.array(r4BundleSchema).min(1).max(10),
  metadata: z.object({
    clinicalSeed: z.number().int(),
    configHash: z.string().regex(/^[a-f0-9]{64}$/),
    localization: syntheaCnLocalizationProvenanceSchema,
    moduleMode: z.enum(['all', 'filter']).optional(),
    modules: z.array(syntheaModuleFilterSchema).max(32),
    populationSeed: z.number().int(),
    syntheaCommit: z.literal(SYNTHEA_COMMIT),
    timeRange: z.object({ end: z.iso.date(), start: z.iso.date() }).strict(),
    timeZone: z.literal('Asia/Shanghai'),
  }).strict(),
}).strict()

const providerHealthSchema = z.object({
  localization: syntheaCnLocalizationProvenanceSchema,
  modules: z.array(syntheaModuleFilterSchema).min(1).max(2_000),
  status: z.literal('ok'),
  syntheaCommit: z.literal(SYNTHEA_COMMIT),
}).strict()

const r4PatientSchema = r4ResourceSchema.extend({
  birthDate: z.iso.date(),
  gender: z.enum(['female', 'male', 'other', 'unknown']),
  resourceType: z.literal('Patient'),
})

const patientOwnedReferenceFields: Partial<Record<
  (typeof allowedR4ResourceTypes)[number],
  'beneficiary' | 'patient' | 'subject'
>> = {
  AllergyIntolerance: 'patient',
  CarePlan: 'subject',
  CareTeam: 'subject',
  Claim: 'patient',
  Condition: 'subject',
  Coverage: 'beneficiary',
  Device: 'patient',
  DiagnosticReport: 'subject',
  Encounter: 'subject',
  ExplanationOfBenefit: 'patient',
  Goal: 'subject',
  ImagingStudy: 'subject',
  Immunization: 'patient',
  MedicationAdministration: 'subject',
  MedicationRequest: 'subject',
  Observation: 'subject',
  Procedure: 'subject',
  SupplyDelivery: 'patient',
}

export type SyntheaProviderErrorCode =
  | 'FHIR_R4_BUNDLE_INVALID'
  | 'FHIR_R4_HISTORY_OUT_OF_RANGE'
  | 'FHIR_R4_LOCALIZATION_INVALID'
  | 'FHIR_R4_PATIENT_OWNERSHIP_INVALID'
  | 'FHIR_R4_REFERENCE_INVALID'
  | 'FHIR_R4_RESOURCE_NOT_ALLOWED'
  | 'PROVIDER_REQUEST_FAILED'
  | 'PROVIDER_RESPONSE_TOO_LARGE'
  | 'PROVIDER_TIMEOUT'
  | 'REPRODUCTION_METADATA_MISMATCH'

export class SyntheaProviderError extends ScenarioGenerationProviderError {
  declare readonly code: SyntheaProviderErrorCode

  constructor(code: SyntheaProviderErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, options)
    this.name = 'SyntheaProviderError'
  }
}

interface R4Reference {
  path: string
  value: string
}

function collectReferences(value: unknown, path = '$'): R4Reference[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectReferences(entry, `${path}[${index}]`))
  }
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, entry]) => {
    const entryPath = `${path}.${key}`
    if (key === 'reference' && typeof entry === 'string') {
      return [{ path: entryPath, value: entry }]
    }
    return collectReferences(entry, entryPath)
  })
}

function referenceValue(resource: z.infer<typeof r4ResourceSchema>, field: string): string | undefined {
  const reference = resource[field]
  if (typeof reference !== 'object' || reference === null) return undefined
  const value = (reference as Record<string, unknown>).reference
  return typeof value === 'string' ? value : undefined
}

const clinicalDatePaths: Partial<Record<
  (typeof allowedR4ResourceTypes)[number],
  readonly (readonly string[])[]
>> = {
  AllergyIntolerance: [['recordedDate']],
  Condition: [['onsetDateTime'], ['recordedDate']],
  Encounter: [['period', 'start'], ['period', 'end']],
  MedicationRequest: [['authoredOn']],
  Observation: [['effectiveDateTime']],
}

function nestedString(value: unknown, path: readonly string[]): string | undefined {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'string' ? current : undefined
}

function validateClinicalDates(
  resource: z.infer<typeof r4ResourceSchema>,
  request: ScenarioGenerationRequest,
): void {
  const rangeStart = Date.parse(`${request.timeRange.start}T00:00:00+08:00`)
  const rangeEnd = Date.parse(`${request.timeRange.end}T23:59:59.999+08:00`)
  for (const path of clinicalDatePaths[resource.resourceType] ?? []) {
    const value = nestedString(resource, path)
    if (value === undefined) continue
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) {
      throw new SyntheaProviderError(
        'FHIR_R4_BUNDLE_INVALID',
        `${resource.resourceType}/${resource.id} contains an invalid clinical date`,
      )
    }
    if (timestamp < rangeStart || timestamp > rangeEnd) {
      throw new SyntheaProviderError(
        'FHIR_R4_HISTORY_OUT_OF_RANGE',
        `${resource.resourceType}/${resource.id} falls outside the requested history range`,
      )
    }
  }
}

function validateBundle(
  bundle: z.infer<typeof r4BundleSchema>,
  request: ScenarioGenerationRequest,
): z.infer<typeof r4PatientSchema> {
  const patients = bundle.entry
    .filter(entry => entry.resource.resourceType === 'Patient')
    .map(entry => r4PatientSchema.parse(entry.resource))
  if (patients.length !== 1) {
    throw new SyntheaProviderError(
      'FHIR_R4_PATIENT_OWNERSHIP_INVALID',
      'Each Synthea Bundle must contain exactly one Patient',
    )
  }
  const patient = patients[0]!
  const patientEntry = bundle.entry.find(entry => entry.resource === patient)
    ?? bundle.entry.find(entry => entry.resource.resourceType === 'Patient')!
  const patientReferences = new Set([
    `Patient/${patient.id}`,
    ...(patientEntry.fullUrl === undefined ? [] : [patientEntry.fullUrl]),
  ])
  for (const entry of bundle.entry) {
    validateClinicalDates(entry.resource, request)
    const ownershipField = patientOwnedReferenceFields[entry.resource.resourceType]
    if (ownershipField !== undefined) {
      const owner = referenceValue(entry.resource, ownershipField)
      if (owner === undefined || !patientReferences.has(owner)) {
        throw new SyntheaProviderError(
          'FHIR_R4_PATIENT_OWNERSHIP_INVALID',
          `${entry.resource.resourceType}/${entry.resource.id} is not owned by the Bundle Patient`,
        )
      }
    }
  }

  const validReferences = new Set(bundle.entry.flatMap(entry => [
    `${entry.resource.resourceType}/${entry.resource.id}`,
    ...(entry.fullUrl === undefined ? [] : [entry.fullUrl]),
  ]))
  for (const reference of collectReferences(bundle)) {
    if (!reference.value.startsWith('#') && !validReferences.has(reference.value)) {
      throw new SyntheaProviderError(
        'FHIR_R4_REFERENCE_INVALID',
        `Unresolved R4 reference at ${reference.path}`,
      )
    }
  }
  return patient
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && Number(declaredLength) > maximumBytes) {
    throw new SyntheaProviderError(
      'PROVIDER_RESPONSE_TOO_LARGE',
      'The Synthea Provider response exceeds the configured size limit',
    )
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > maximumBytes) {
      await reader.cancel()
      throw new SyntheaProviderError(
        'PROVIDER_RESPONSE_TOO_LARGE',
        'The Synthea Provider response exceeds the configured size limit',
      )
    }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function assertReproductionMetadata(
  metadata: z.infer<typeof providerResponseSchema>['metadata'],
  request: ScenarioGenerationRequest,
): void {
  if (
    metadata.clinicalSeed !== request.seeds.clinical
    || metadata.configHash !== SYNTHEA_CONFIG_HASH
    || metadata.localization.syntheaCommit !== metadata.syntheaCommit
    || metadata.populationSeed !== request.seeds.population
    || metadata.timeZone !== request.timeZone
    || metadata.timeRange.start !== request.timeRange.start
    || metadata.timeRange.end !== request.timeRange.end
    || (metadata.moduleMode ?? (metadata.modules.length === 0 ? 'all' : 'filter')) !== request.moduleMode
    || metadata.modules.length !== request.modules.length
    || metadata.modules.some((module, index) => module !== request.modules[index])
  ) {
    throw new SyntheaProviderError(
      'REPRODUCTION_METADATA_MISMATCH',
      'The Synthea Provider response does not match the requested reproduction parameters',
    )
  }
}

export class SyntheaScenarioGenerationProvider implements ScenarioGenerationProvider {
  readonly #endpoint: URL
  readonly #fetch: typeof fetch
  readonly #healthEndpoint: URL
  readonly #maxResponseBytes: number
  readonly #timeoutMs: number

  constructor(options: {
    baseUrl: string
    fetch?: typeof fetch
    maxResponseBytes?: number
    timeoutMs?: number
  }) {
    const baseUrl = new URL(options.baseUrl)
    if (!['http:', 'https:'].includes(baseUrl.protocol)) {
      throw new Error('The Synthea Provider URL must use HTTP or HTTPS')
    }
    const endpoint = new URL(baseUrl)
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/v1/generate`
    endpoint.search = ''
    endpoint.hash = ''
    const healthEndpoint = new URL(baseUrl)
    healthEndpoint.pathname = `${healthEndpoint.pathname.replace(/\/$/, '')}/health`
    healthEndpoint.search = ''
    healthEndpoint.hash = ''
    this.#endpoint = endpoint
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#healthEndpoint = healthEndpoint
    this.#maxResponseBytes = options.maxResponseBytes ?? 64 * 1024 * 1024
    this.#timeoutMs = options.timeoutMs ?? 5 * 60 * 1_000
  }

  async capabilities(): Promise<ScenarioProviderCapabilities> {
    try {
      const response = await this.#fetch(this.#healthEndpoint, {
        headers: { accept: 'application/json' },
        method: 'GET',
        signal: AbortSignal.timeout(Math.min(this.#timeoutMs, 5_000)),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const health = providerHealthSchema.parse(JSON.parse(
        await readBoundedResponse(response, 256 * 1024),
      ))
      return {
        available: true,
        maxPopulation: 10,
        modules: health.modules,
        providerId: 'synthea',
        providerName: 'Synthea',
      }
    } catch {
      return {
        available: false,
        maxPopulation: 10,
        modules: [],
        providerId: 'synthea',
        providerName: 'Synthea',
        unavailableReason: 'Synthea Provider 不可用',
      }
    }
  }

  async generate(
    request: ScenarioGenerationRequest,
    signal?: AbortSignal,
  ): Promise<SourcePatientCorpus> {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs)
    const requestSignal = signal === undefined
      ? timeoutSignal
      : AbortSignal.any([signal, timeoutSignal])
    let response: Response
    try {
      response = await this.#fetch(this.#endpoint, {
        body: JSON.stringify(request),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: requestSignal,
      })
    } catch (error) {
      if (requestSignal.aborted) {
        throw new SyntheaProviderError('PROVIDER_TIMEOUT', 'The Synthea Provider request timed out', {
          cause: error,
        })
      }
      throw new SyntheaProviderError('PROVIDER_REQUEST_FAILED', 'The Synthea Provider request failed', {
        cause: error,
      })
    }
    if (!response.ok) {
      throw new SyntheaProviderError(
        'PROVIDER_REQUEST_FAILED',
        `The Synthea Provider returned HTTP ${response.status}`,
      )
    }
    let parsed: z.infer<typeof providerResponseSchema>
    try {
      parsed = providerResponseSchema.parse(JSON.parse(
        await readBoundedResponse(response, this.#maxResponseBytes),
      ))
    } catch (error) {
      if (error instanceof SyntheaProviderError) throw error
      if (error instanceof z.ZodError && error.issues.some(issue => (
        issue.path[0] === 'metadata' && issue.path[1] === 'localization'
      ))) {
        throw new SyntheaProviderError(
          'FHIR_R4_LOCALIZATION_INVALID',
          'The Synthea Provider returned invalid localization metadata',
          { cause: error },
        )
      }
      if (error instanceof z.ZodError && error.issues.some(issue => (
        issue.code === 'invalid_value'
        && issue.path.at(-1) === 'resourceType'
      ))) {
        throw new SyntheaProviderError(
          'FHIR_R4_RESOURCE_NOT_ALLOWED',
          'The Synthea Provider returned an unsupported R4 resource type',
          { cause: error },
        )
      }
      throw new SyntheaProviderError(
        'FHIR_R4_BUNDLE_INVALID',
        'The Synthea Provider returned invalid R4 data',
        { cause: error },
      )
    }
    assertReproductionMetadata(parsed.metadata, request)
    if (parsed.bundles.length !== request.population.count) {
      throw new SyntheaProviderError(
        'FHIR_R4_PATIENT_OWNERSHIP_INVALID',
        'The Synthea Provider returned an unexpected number of Patient Bundles',
      )
    }

    const sources = parsed.bundles.map((bundle) => {
      const patient = validateBundle(bundle, request)
      const patientId = `synthea-patient-${patient.id}`
      try {
        localizedSyntheaPatientIdentity({
          bundle,
          expectedPatientId: patientId,
          provenance: parsed.metadata.localization,
        })
      } catch (error) {
        if (!(error instanceof SyntheaLocalizationValidationError)) throw error
        throw new SyntheaProviderError(
          'FHIR_R4_LOCALIZATION_INVALID',
          'The Synthea Provider returned an invalid localized Patient',
          { cause: error },
        )
      }
      return {
        format: 'fhir-r4-bundle' as const,
        hash: sourceArtifactHash(bundle),
        localization: parsed.metadata.localization,
        patientId,
        raw: bundle,
      }
    })
    return { kind: 'synthea-r4', sources }
  }
}
