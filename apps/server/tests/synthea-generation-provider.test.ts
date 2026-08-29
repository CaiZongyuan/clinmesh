import {
  scenarioGenerationRequestSchema,
  syntheaCnLocalizationProvenanceSchema,
} from '@clinmesh/contracts/scenario'
import { describe, expect, it } from 'vitest'
import {
  SyntheaScenarioGenerationProvider,
} from '../src/infrastructure/scenario-generation/synthea-provider.ts'

const syntheaCommit = 'd9d07a6eef91ee5144293b42ab64224d84d124f8'
const configHash = '81c9b79f5426b85244f42275f98d2f9e161a4c502980d9cde8d027cdda6ef103'
const profileContentHash = 'd8a4ef19561434cb66c8a391aebfcf6a4dc5f14baf4d4171eac3b8c340b5dd12'
const localization = syntheaCnLocalizationProvenanceSchema.parse({
  dependencies: [{
    canonicalSha256: '3c632be160c5a3d6e3196b8e95a0b33a25e9f35bcee506b25d7305345c50957a',
    datasetId: 'geography-cn',
    releaseId: 'geography-cn@2026-08-29.r1',
    sqliteSha256: '5ca7121046d49a80b0da38e2b3413a1bc1a7b1040382903ba1d516793e5c5bc7',
  }, {
    canonicalSha256: '4f66c18be0ab19e515927953bd741a1476584f2bdac3d8e6d67221232a31468d',
    datasetId: 'names-cn',
    releaseId: 'names-cn@40.37.0.r1',
    sqliteSha256: '20fc1bc0a0c38b7122635d00aecb710a0ecf1892d91d3c3c190cc9213c2bb0ae',
  }, {
    canonicalSha256: '371dde5944505c426a8ad39be21f647921e754366cb410c0529176d2b6ebfb8a',
    datasetId: 'population-cn',
    releaseId: 'population-cn@WPP2024.r1',
    sqliteSha256: '89858f25d5e898df32f896e8f12b7daf2bc569abb55f8bf69b3f21e988a50a05',
  }],
  identityAlgorithm: 'synthetic-identity-v1',
  profileContentHash,
  profileId: 'synthea-cn@2026-08-29.r3',
  syntheaCommit,
})
const request = scenarioGenerationRequestSchema.parse({
  modules: ['fever'],
  name: 'Synthea 发热病史',
  population: {
    age: { maximum: 65, minimum: 18 },
    count: 1,
    gender: 'female',
  },
  providerId: 'synthea',
  seeds: { clinical: 7331, population: 4242 },
  timeRange: { end: '2026-08-01', start: '2020-01-01' },
  timeZone: 'Asia/Shanghai',
})

function patientBundle(extraResources: unknown[] = []) {
  const patientReference = 'urn:uuid:patient-1'
  return {
    entry: [{
      fullUrl: patientReference,
      resource: {
        address: [{
          city: '渭南市',
          country: 'CN',
          line: ['陕西省渭南市合成路178号'],
          postalCode: '715300',
          state: '陕西省',
        }],
        birthDate: '1988-03-16',
        gender: 'female',
        id: 'patient-1',
        identifier: [{
          system: 'https://github.com/synthetichealth/synthea',
          value: 'patient-1',
        }, {
          system: 'urn:cn-health-data:synthetic-person',
          value: 'urn:uuid:13b0d528-f28a-5bef-a5ad-1a3bdb700d9a',
        }, {
          system: 'urn:cn-health-data:synthetic-mrn',
          value: 'CNH4E13CCB7CC71',
        }, {
          extension: [{ url: 'urn:cn-health-data:synthetic', valueBoolean: true }],
          system: 'urn:cn-health-data:simulated-resident-id',
          value: '990000198803168903',
        }],
        name: [{ family: '杨', given: ['秀珍'], text: '杨秀珍', use: 'official' }],
        resourceType: 'Patient',
        telecom: [{ system: 'phone', value: '10093284819' }, {
          system: 'email',
          value: 'cnh4e13ccb7cc71@example.test',
        }],
      },
    }, {
      fullUrl: 'urn:uuid:encounter-1',
      resource: {
        id: 'encounter-1',
        resourceType: 'Encounter',
        subject: { reference: patientReference },
      },
    }, ...extraResources.map((resource, index) => ({
      fullUrl: `urn:uuid:extra-${index + 1}`,
      resource,
    }))],
    meta: {
      tag: [{
        code: localization.profileId,
        display: localization.profileContentHash,
        system: 'urn:cn-health-data:synthea-profile',
      }],
    },
    resourceType: 'Bundle',
    type: 'collection',
  }
}

function patientBundleWithRealMobileNumber() {
  const bundle = structuredClone(patientBundle())
  const patient = bundle.entry.find(entry => (
    typeof entry.resource === 'object'
    && entry.resource !== null
    && 'resourceType' in entry.resource
    && entry.resource.resourceType === 'Patient'
  ))?.resource
  if (typeof patient !== 'object' || patient === null) throw new Error('Patient fixture is missing')
  const patientRecord = patient as Record<string, unknown>
  patientRecord.telecom = [{ system: 'phone', value: '13800000000' }]
  return bundle
}

function patientBundleWithWrongProfileTag() {
  const bundle = structuredClone(patientBundle())
  return {
    ...bundle,
    meta: {
      ...bundle.meta,
      tag: [{ ...bundle.meta.tag[0]!, display: 'f'.repeat(64) }],
    },
  }
}

function providerResponse(bundles: unknown[]) {
  return {
    bundles,
    metadata: {
      clinicalSeed: request.seeds.clinical,
      configHash,
      localization,
      modules: request.modules,
      populationSeed: request.seeds.population,
      syntheaCommit,
      timeRange: request.timeRange,
      timeZone: request.timeZone,
    },
  }
}

function providerFor(body: unknown, options: { maxResponseBytes?: number } = {}) {
  return new SyntheaScenarioGenerationProvider({
    baseUrl: 'http://synthea.internal:51878',
    fetch: async () => Response.json(body),
    maxResponseBytes: options.maxResponseBytes ?? 1_000_000,
    timeoutMs: 1_000,
  })
}

describe('Synthea Scenario generation Provider contract', () => {
  it('accepts an owned R4 patient history and preserves complete reproduction metadata', async () => {
    const bundle = patientBundle([{
      code: { text: 'Viral sinusitis' },
      id: 'condition-1',
      resourceType: 'Condition',
      subject: { reference: 'urn:uuid:patient-1' },
    }, {
      description: { text: 'Maintain target glucose range' },
      id: 'goal-1',
      lifecycleStatus: 'active',
      resourceType: 'Goal',
      subject: { reference: 'urn:uuid:patient-1' },
    }])
    const provider = providerFor(providerResponse([bundle]))

    expect(await provider.capabilities()).toMatchObject({
      modules: ['fever', 'type-2-diabetes', 'hypertension'],
    })

    const corpus = await provider.generate(request)

    expect(corpus.content.patients[0]).toMatchObject({
      birthDate: '1988-03-16',
      fhirHistory: [
        expect.objectContaining({ resourceType: 'Encounter' }),
        expect.objectContaining({ resourceType: 'Condition' }),
      ],
      gender: 'female',
      id: 'synthea-patient-patient-1',
      longitudinalHistory: expect.arrayContaining([
        expect.objectContaining({ kind: 'condition', mappedCode: null }),
      ]),
      name: '合成患者 be1c7ce7',
    })
    expect(corpus.content.reproduction).toMatchObject({
      catalogCompilation: { blockers: [], supported: true },
      clinicalSeed: 7331,
      configHash,
      generator: 'synthea-fhir-r4',
      generatorVersion: syntheaCommit,
      modules: ['fever'],
      populationSeed: 4242,
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    })
    expect(corpus).toMatchObject({
      sources: [{
        format: 'fhir-r4-bundle',
        localization,
        patientId: 'synthea-patient-patient-1',
        raw: bundle,
      }],
    })
    expect(corpus.content.simulatorRules).toEqual([
      { code: 'success', outcome: 'success', simulator: 'payment' },
      { code: 'decline', outcome: 'declined', simulator: 'payment' },
      { code: 'ambiguous', outcome: 'ambiguous', simulator: 'payment' },
      { code: 'default-success', outcome: 'success', simulator: 'lis' },
    ])
    expect(corpus.sources[0]?.hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each([
    {
      body: {
        ...providerResponse([patientBundle()]),
        metadata: {
          ...providerResponse([]).metadata,
          localization: undefined,
        },
      },
      code: 'FHIR_R4_LOCALIZATION_INVALID',
      name: 'missing localization metadata',
    },
    {
      body: providerResponse([patientBundleWithWrongProfileTag()]),
      code: 'FHIR_R4_LOCALIZATION_INVALID',
      name: 'mismatched localization tag',
    },
    {
      body: providerResponse([patientBundleWithRealMobileNumber()]),
      code: 'FHIR_R4_LOCALIZATION_INVALID',
      name: 'real mobile-looking Patient identity',
    },
    {
      body: providerResponse([patientBundle([{
        id: 'questionnaire-1',
        resourceType: 'Questionnaire',
      }])]),
      code: 'FHIR_R4_RESOURCE_NOT_ALLOWED',
      name: 'unknown resource type',
    },
    {
      body: providerResponse([patientBundle([{
        id: 'organization-1',
        partOf: { reference: 'Organization/missing' },
        resourceType: 'Organization',
      }])]),
      code: 'FHIR_R4_REFERENCE_INVALID',
      name: 'unresolved reference',
    },
    {
      body: providerResponse([patientBundle([{
        id: 'device-1',
        patient: { reference: 'Patient/external' },
        resourceType: 'Device',
      }])]),
      code: 'FHIR_R4_PATIENT_OWNERSHIP_INVALID',
      name: 'foreign Device owner',
    },
    {
      body: providerResponse([patientBundle([{
        id: 'condition-1',
        resourceType: 'Condition',
        subject: { reference: 'urn:uuid:patient-2' },
      }, {
        birthDate: '1970-01-01',
        gender: 'male',
        id: 'patient-2',
        resourceType: 'Patient',
      }])]),
      code: 'FHIR_R4_PATIENT_OWNERSHIP_INVALID',
      name: 'second patient owner',
    },
    {
      body: providerResponse([{ ...patientBundle(), type: 'transaction' }]),
      code: 'FHIR_R4_BUNDLE_INVALID',
      name: 'transaction Bundle',
    },
    {
      body: providerResponse([patientBundle([{
        id: 'condition-before-range',
        recordedDate: '2019-12-31T23:59:59+08:00',
        resourceType: 'Condition',
        subject: { reference: 'urn:uuid:patient-1' },
      }])]),
      code: 'FHIR_R4_HISTORY_OUT_OF_RANGE',
      name: 'clinical history before the requested range',
    },
    {
      body: {
        ...providerResponse([patientBundle()]),
        metadata: {
          ...providerResponse([]).metadata,
          configHash: 'b'.repeat(64),
        },
      },
      code: 'REPRODUCTION_METADATA_MISMATCH',
      name: 'unexpected Provider config hash',
    },
  ])('rejects $name before it enters a Dataset', async ({ body, code }) => {
    await expect(providerFor(body).generate(request)).rejects.toMatchObject({
      code,
    })
  })

  it('rejects a response beyond the configured byte limit', async () => {
    await expect(providerFor(providerResponse([patientBundle()]), {
      maxResponseBytes: 100,
    }).generate(request)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE_TOO_LARGE',
    })
  })
})
