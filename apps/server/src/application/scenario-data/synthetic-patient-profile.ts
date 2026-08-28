import { createHash } from 'node:crypto'
import {
  syntheticPatientProfileSchema,
  type ScenarioDataset,
  type SyntheticPatientIdentity,
  type SyntheticPatientProfile,
} from '@clinmesh/contracts/scenario'
import type { SourcePatientArtifact } from './provider.ts'
import {
  diagnosisMappingPackageProvenance,
  resolveDiagnosisMapping,
} from './diagnosis-coding-package.ts'
import { stableHistoryId } from './synthea-case-truth-compiler.ts'

const idCardWeights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const
const idCardChecks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'] as const
const syntheticAddresses = [
  '江苏省苏州市张家港市合成路',
  '浙江省杭州市拱墅区仿真路',
  '四川省成都市武侯区模拟路',
  '湖北省武汉市江岸区测试路',
] as const
const syntheticInsurance = ['模拟城镇职工医保', '模拟城乡居民医保', '模拟自费'] as const
const initialCatalogVersion = 1

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

export function applySyntheticPatientProfileMappings(
  patient: SyntheticPatientProfile['patient'],
  mappings: SyntheticPatientProfile['mappings'],
): SyntheticPatientProfile['patient'] {
  const mappingBySourceId = new Map(mappings.map(mapping => (
    [mapping.sourceResourceId, mapping] as const
  )))
  const targetByHistoryId = new Map(mappings.map(mapping => (
    [stableHistoryId(mapping.sourceResourceType, mapping.sourceResourceId), mapping.target] as const
  )))
  return {
    ...patient,
    fhirHistory: patient.fhirHistory.map((resource) => {
      const target = targetByHistoryId.get(resource.id)
      if (target === undefined) return resource
      if (resource.resourceType === 'Encounter') {
        return { ...resource, classCode: target.code }
      }
      if (resource.resourceType === 'MedicationRequest') {
        return {
          ...resource,
          medication: {
            code: target.code,
            display: resource.medication.display,
            ...(target.system === undefined ? {} : { system: target.system }),
          },
        }
      }
      return {
        ...resource,
        code: {
          code: target.code,
          display: resource.code.display,
          ...(target.system === undefined ? {} : { system: target.system }),
        },
      }
    }),
    longitudinalHistory: patient.longitudinalHistory.map(event => ({
      ...event,
      mappedCode: mappingBySourceId.get(event.sourceResourceId)?.target.code ?? null,
    })),
  }
}

function reviewedDiagnosisMappings(
  dataset: ScenarioDataset,
  patient: SyntheticPatientProfile['patient'],
): SyntheticPatientProfile['mappings'] {
  const diagnosisById = new Map(dataset.content.catalog.diagnoses
    .filter(diagnosis => diagnosis.active && diagnosis.status === 'active')
    .map(diagnosis => [diagnosis.id, diagnosis]))
  const conditionByHistoryId = new Map(patient.fhirHistory.flatMap(resource => (
    resource.resourceType === 'Condition' ? [[resource.id, resource] as const] : []
  )))
  return patient.longitudinalHistory.flatMap((event) => {
    if (event.sourceResourceType !== 'Condition' || event.mappedCode === null) return []
    const condition = conditionByHistoryId.get(stableHistoryId('Condition', event.sourceResourceId))
    const resolution = resolveDiagnosisMapping({
      code: event.code,
      ...(event.sourceDisplay === undefined ? {} : { display: event.sourceDisplay }),
      ...(event.sourceSystem === undefined ? {} : { system: event.sourceSystem }),
      ...(event.sourceVersion === undefined ? {} : { version: event.sourceVersion }),
    })
    if (resolution.status !== 'mapped' || resolution.mapping.target.code !== event.mappedCode) {
      throw new Error(`Condition/${event.sourceResourceId} has no reviewed diagnosis mapping`)
    }
    const mappingTarget = resolution.mapping.target
    if (
      condition?.code.code !== mappingTarget.code
      || condition.code.display !== mappingTarget.display
      || condition.code.system !== mappingTarget.system
      || condition.code.version !== mappingTarget.version
    ) {
      throw new Error(`Condition/${event.sourceResourceId} does not match its diagnosis mapping target`)
    }
    const diagnosis = diagnosisById.get(mappingTarget.catalogItemId)
    if (
      diagnosis === undefined
      || diagnosis.code !== mappingTarget.code
      || diagnosis.name !== mappingTarget.display
    ) {
      throw new Error(`Diagnosis mapping target ${mappingTarget.catalogItemId} is unavailable`)
    }
    return [{
      sourceResourceId: event.sourceResourceId,
      sourceResourceType: event.sourceResourceType,
      target: {
        catalogItemId: diagnosis.id,
        code: diagnosis.code,
        system: diagnosis.codeSystem,
        version: initialCatalogVersion,
      },
    }]
  })
}

function compiledMappingProvenance(providerId: ScenarioDataset['providerId']) {
  const compilerId = providerId === 'synthea' ? 'synthea-case-truth' : 'builtin-case-truth'
  return {
    compiler: { id: compilerId, version: '2' },
    packages: [diagnosisMappingPackageProvenance()],
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
    const mappings = reviewedDiagnosisMappings(input.dataset, patient)
    const mappingProvenance = compiledMappingProvenance(input.dataset.providerId)
    return syntheticPatientProfileSchema.parse({
      createdAt: input.dataset.createdAt,
      identity: syntheticIdentity(identitySeed, patient),
      mappings,
      patient: applySyntheticPatientProfileMappings(patient, mappings),
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
        ...(source.format === 'legacy-compiled-profile' ? {} : { mappingProvenance }),
        mappingVersion: source.format === 'legacy-compiled-profile'
          ? 'legacy-case-truth-v1'
          : `${mappingProvenance.compiler.id}-v${mappingProvenance.compiler.version}`,
        patientId: source.patientId,
        providerId: input.dataset.providerId,
        ...(input.dataset.content.reproduction.referenceData === undefined
          ? {}
          : { referenceData: input.dataset.content.reproduction.referenceData }),
        raw: source.raw,
      },
      updatedAt: input.dataset.updatedAt,
      workspaceId: input.dataset.workspaceId,
    })
  })
}
