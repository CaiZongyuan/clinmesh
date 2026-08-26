import { scenarioGenerationRequestSchema } from '@clinmesh/contracts/scenario'
import { describe, expect, it } from 'vitest'
import {
  SyntheaScenarioGenerationProvider,
} from '../src/infrastructure/scenario-generation/synthea-provider.ts'

const syntheaCommit = 'd9d07a6eef91ee5144293b42ab64224d84d124f8'
const configHash = 'a'.repeat(64)
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
        birthDate: '1988-03-16',
        gender: 'female',
        id: 'patient-1',
        name: [{ given: ['Alice'], family: 'Synthetic' }],
        resourceType: 'Patient',
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
    resourceType: 'Bundle',
    type: 'transaction',
  }
}

function providerResponse(bundles: unknown[]) {
  return {
    bundles,
    metadata: {
      clinicalSeed: request.seeds.clinical,
      configHash,
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
    baseUrl: 'http://synthea.internal:8080',
    fetch: async () => Response.json(body),
    maxResponseBytes: options.maxResponseBytes ?? 1_000_000,
    timeoutMs: 1_000,
  })
}

describe('Synthea Scenario generation Provider contract', () => {
  it('accepts an owned R4 patient history and preserves complete reproduction metadata', async () => {
    const provider = providerFor(providerResponse([patientBundle([{
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
    }])]))

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
      name: '林安宁',
    })
    expect(corpus.content.reproduction).toEqual({
      clinicalSeed: 7331,
      configHash,
      generator: 'synthea-fhir-r4',
      generatorVersion: syntheaCommit,
      modules: ['fever'],
      populationSeed: 4242,
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    })
  })

  it.each([
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
