import { scenarioGenerationRequestSchema } from '@clinmesh/contracts/scenario'
import { describe, expect, it } from 'vitest'
import { BuiltInScenarioGenerationProvider } from '../src/infrastructure/scenario-generation/builtin-provider.ts'

describe('Scenario generation Provider contract', () => {
  it('replays a fixed built-in population without changing clinical facts', async () => {
    const provider = new BuiltInScenarioGenerationProvider()
    const request = scenarioGenerationRequestSchema.parse({
      modules: ['fever'],
      name: '合成发热门诊数据',
      population: {
        age: { maximum: 65, minimum: 18 },
        count: 1,
        gender: 'any',
      },
      providerId: 'builtin',
      seeds: { clinical: 7331, population: 4242 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    })

    const first = await provider.generate(request)
    const replay = await provider.generate(request)

    expect(replay).toEqual(first)
    expect(first.content.patients[0]).toMatchObject({
      birthDate: '1962-01-01',
      gender: 'male',
      id: 'synthetic-patient-5eb27dffe7f2',
      name: '王晓明',
      physiologyBaseline: {
        vitalSigns: {
          oxygenSaturationPct: 98,
          temperatureC: 38.6,
        },
      },
    })
    const acetaminophen = first.content.catalog.medications.find(item => (
      item.id === 'medication-acetaminophen'
    ))
    expect(acetaminophen).toMatchObject({
      availableScopes: ['outpatient'],
      code: 'ACETAMINOPHEN',
      drugConcept: {
        conceptId: 'drug-concept-acetaminophen-500mg-oral-tablet',
        kind: 'drug-concept',
      },
      id: 'medication-acetaminophen',
      product: {
        approvalNumber: 'CM-APPROVAL-ACETAMINOPHEN',
        code: 'CM-NHSA-PRODUCT-ACETAMINOPHEN',
        id: 'nhsa-medication-product:nhsa-medication-products-2026-08-07:CM-NHSA-PRODUCT-ACETAMINOPHEN',
      },
      regulatoryVerification: {
        result: 'synthetic-match',
        source: 'nmpa-manual-check',
        verifiedFieldsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
    expect(new Set([
      acetaminophen?.drugConcept.conceptId,
      acetaminophen?.product.id,
      acetaminophen?.id,
      first.content.inventory.find(lot => lot.itemId === acetaminophen?.id)?.lotId,
    ]).size).toBe(4)
    expect(first.content.simulatorRules).toEqual([
      { code: 'success', outcome: 'success', simulator: 'payment' },
      { code: 'decline', outcome: 'declined', simulator: 'payment' },
      { code: 'ambiguous', outcome: 'ambiguous', simulator: 'payment' },
      { code: 'default-success', outcome: 'success', simulator: 'lis' },
    ])
    expect(first.content.reproduction).toEqual({
      clinicalSeed: 7331,
      generator: 'clinmesh-builtin-v1',
      modules: ['fever'],
      populationSeed: 4242,
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    })
  })
})
