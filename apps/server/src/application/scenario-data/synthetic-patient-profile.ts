import { createHash } from 'node:crypto'
import {
  syntheticPatientProfileSchema,
  type ScenarioGenerationRequest,
  type SyntheticPatientIdentity,
  type SyntheticPatientProfile,
} from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import type { SourcePatientArtifact } from './provider.ts'
import { localizedSyntheaPatientIdentity } from './synthea-localized-identity.ts'
import { withResidentIdChecksum } from './synthetic-resident-id.ts'

const sourcePatientSchema = z.object({
  birthDate: z.iso.date(),
  gender: z.enum(['female', 'male', 'other', 'unknown']),
  id: z.string().min(1),
  name: z.array(z.object({
    text: z.string().min(1).optional(),
  }).passthrough()).optional(),
  resourceType: z.literal('Patient'),
}).passthrough()

const bundleSchema = z.object({
  entry: z.array(z.object({
    resource: z.object({
      id: z.string().min(1),
      resourceType: z.string().min(1),
    }).passthrough(),
  }).passthrough()).min(1).max(20_000),
  resourceType: z.literal('Bundle'),
  type: z.literal('collection'),
}).passthrough()

function digestNumber(input: string): number {
  return Number.parseInt(createHash('sha256').update(input).digest('hex').slice(0, 8), 16)
}

function syntheticNationalId(
  birthDate: string,
  gender: 'female' | 'male' | 'other' | 'unknown',
  seed: string,
): string {
  let sequence = digestNumber(`${seed}:national-id`) % 1_000
  if (gender === 'male' && sequence % 2 === 0) sequence = (sequence + 1) % 1_000
  if (gender === 'female' && sequence % 2 === 1) sequence = (sequence + 1) % 1_000
  return withResidentIdChecksum(
    `990000${birthDate.replaceAll('-', '')}${String(sequence).padStart(3, '0')}`,
  )
}

function syntheticIdentity(input: {
  birthDate: string
  gender: 'female' | 'male' | 'other' | 'unknown'
  name: string
  seed: string
}): SyntheticPatientIdentity {
  const number = digestNumber(input.seed)
  const mrn = `CMSYN${createHash('sha256').update(input.seed).digest('hex').slice(0, 10).toUpperCase()}`
  const phoneSuffix = String(number % 100_000_000).padStart(8, '0')
  return {
    address: `虚构测试地址 ${phoneSuffix} 号`,
    displayName: input.name,
    email: `${mrn.toLowerCase()}@example.test`,
    insuranceDisplay: '合成医疗保障',
    mrn,
    nationalId: syntheticNationalId(input.birthDate, input.gender, input.seed),
    phone: `100${phoneSuffix}`,
  }
}

function sourcePatient(source: SourcePatientArtifact) {
  const bundle = bundleSchema.parse(source.raw)
  const patients = bundle.entry.flatMap(entry => (
    entry.resource.resourceType === 'Patient'
      ? [sourcePatientSchema.parse(entry.resource)]
      : []
  ))
  if (patients.length !== 1) throw new Error('Each Synthea source Bundle must contain one Patient')
  return patients[0]!
}

export function createSyntheticPatientProfiles(input: {
  batchId: string
  batchName: string
  createdAt: string
  request: ScenarioGenerationRequest
  sources: readonly SourcePatientArtifact[]
  workspaceId: string
}): SyntheticPatientProfile[] {
  const sourceIds = new Set<string>()
  return input.sources.map((source, ordinal) => {
    if (sourceIds.has(source.patientId)) {
      throw new Error('Every generated patient must have one unique source artifact')
    }
    sourceIds.add(source.patientId)
    const patient = sourcePatient(source)
    const seed = `${input.workspaceId}:${source.hash}:${source.patientId}`
    const fallbackName = patient.name?.find(name => name.text !== undefined)?.text
      ?? `合成患者 ${createHash('sha256').update(seed).digest('hex').slice(0, 8)}`
    const localized = source.localization === undefined
      ? undefined
      : localizedSyntheaPatientIdentity({
          bundle: source.raw,
          expectedPatientId: source.patientId,
          provenance: source.localization,
        })
    const identity = localized?.identity ?? syntheticIdentity({
      birthDate: patient.birthDate,
      gender: patient.gender,
      name: fallbackName,
      seed,
    })
    return syntheticPatientProfileSchema.parse({
      createdAt: input.createdAt,
      demographics: {
        birthDate: patient.birthDate,
        gender: patient.gender,
      },
      identity,
      profileId: `synthetic-patient-profile-${createHash('sha256')
        .update(seed)
        .digest('hex')
        .slice(0, 32)}`,
      revision: 1,
      source: {
        batchId: input.batchId,
        batchName: input.batchName,
        format: source.format,
        generation: {
          moduleMode: input.request.moduleMode,
          modules: input.request.modules,
          ordinal,
          seeds: input.request.seeds,
          timeRange: input.request.timeRange,
          timeZone: input.request.timeZone,
        },
        hash: source.hash,
        ...(localized === undefined ? {} : { localization: localized.provenance }),
        patientId: source.patientId,
        providerId: 'synthea',
        raw: source.raw,
        ...(source.translationWarning === undefined
          ? {}
          : { translationWarning: source.translationWarning }),
      },
      updatedAt: input.createdAt,
      workspaceId: input.workspaceId,
    })
  })
}
