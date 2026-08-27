import { createHash } from 'node:crypto'
import {
  syntheticPatientProfileSchema,
  type ScenarioDataset,
  type SyntheticPatientIdentity,
  type SyntheticPatientProfile,
} from '@clinmesh/contracts/scenario'
import type { SourcePatientArtifact } from './provider.ts'

const idCardWeights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const
const idCardChecks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'] as const
const syntheticAddresses = [
  '江苏省苏州市张家港市合成路',
  '浙江省杭州市拱墅区仿真路',
  '四川省成都市武侯区模拟路',
  '湖北省武汉市江岸区测试路',
] as const
const syntheticInsurance = ['模拟城镇职工医保', '模拟城乡居民医保', '模拟自费'] as const

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
  const body = `320582${birthDate.replaceAll('-', '')}${String(sequence).padStart(3, '0')}`
  const checksum = body.split('').reduce((sum, digit, index) => (
    sum + Number(digit) * (idCardWeights[index] ?? 0)
  ), 0) % 11
  return `${body}${idCardChecks[checksum]}`
}

function syntheticIdentity(
  seed: string,
  patient: ScenarioDataset['content']['patients'][number],
): SyntheticPatientIdentity {
  const number = digestNumber(seed)
  const mrn = `CMSYN${createHash('sha256').update(seed).digest('hex').slice(0, 10).toUpperCase()}`
  const phoneSuffix = String(number % 100_000_000).padStart(8, '0')
  const address = syntheticAddresses[number % syntheticAddresses.length] ?? syntheticAddresses[0]
  return {
    address: `${address} ${number % 900 + 100} 号（合成地址）`,
    displayName: patient.name,
    email: `${mrn.toLowerCase()}@example.test`,
    insuranceDisplay: syntheticInsurance[number % syntheticInsurance.length] ?? syntheticInsurance[0],
    mrn,
    nationalId: syntheticNationalId(patient.birthDate, patient.gender, seed),
    phone: `13${phoneSuffix.slice(0, 1)}${phoneSuffix}`,
  }
}

export function createSyntheticPatientProfiles(input: {
  dataset: ScenarioDataset
  sources: readonly SourcePatientArtifact[]
}): SyntheticPatientProfile[] {
  const sourceByPatientId = new Map(input.sources.map(source => [source.patientId, source]))
  if (
    input.sources.length !== input.dataset.content.patients.length
    || sourceByPatientId.size !== input.sources.length
  ) {
    throw new Error('Every generated patient must have exactly one source artifact')
  }
  return input.dataset.content.patients.map((patient, ordinal) => {
    const source = sourceByPatientId.get(patient.id)
    if (source === undefined) throw new Error(`Generated patient ${patient.id} has no source artifact`)
    const identitySeed = `${input.dataset.contentHash}:${patient.id}`
    const profileId = `synthetic-patient-profile-${createHash('sha256')
      .update(`${input.dataset.workspaceId}:${identitySeed}`)
      .digest('hex')
      .slice(0, 32)}`
    return syntheticPatientProfileSchema.parse({
      createdAt: input.dataset.createdAt,
      identity: syntheticIdentity(identitySeed, patient),
      mappings: [],
      patient: {
        ...patient,
        longitudinalHistory: patient.longitudinalHistory.map(event => ({
          ...event,
          mappedCode: null,
        })),
      },
      profileId,
      revision: 1,
      source: {
        batchId: input.dataset.datasetId,
        batchName: input.dataset.name,
        compilation: source.format === 'legacy-compiled-profile'
          ? null
          : {
              modules: input.dataset.content.reproduction.modules,
              ordinal,
              seeds: {
                clinical: input.dataset.content.reproduction.clinicalSeed,
                population: input.dataset.content.reproduction.populationSeed,
              },
              timeRange: input.dataset.content.reproduction.timeRange,
              timeZone: input.dataset.content.reproduction.timeZone,
            },
        format: source.format,
        hash: source.hash,
        mappingVersion: source.format === 'legacy-compiled-profile'
          ? 'legacy-case-truth-v1'
          : input.dataset.providerId === 'synthea'
            ? 'synthea-case-truth-v1'
            : 'builtin-case-truth-v1',
        patientId: source.patientId,
        providerId: input.dataset.providerId,
        raw: source.raw,
      },
      updatedAt: input.dataset.updatedAt,
      workspaceId: input.dataset.workspaceId,
    })
  })
}
